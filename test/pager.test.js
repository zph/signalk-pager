'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Pager, validate } = require('../lib/pager')

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-pager-'))
  const calls = []
  const providers = {
    pushover: async (_options, fields) => { calls.push(['pushover', fields]); return { status: 1, receipt: fields.priority === 2 ? 'receipt-1' : undefined } },
    receipt: async () => { calls.push(['receipt']); return { status: 1, acknowledged: 0, expired: 0 } },
    cancel: async (_options, receipt) => { calls.push(['cancel', receipt]); return { status: 1 } },
    telegram: async (_options, method, fields) => { calls.push([method, fields]); return { ok: true, result: { message_id: 42 } } },
    updates: async () => []
  }
  const options = { mode: 'active', pushoverToken: 'test', pushoverUser: 'test', telegramToken: 'test', telegramChatId: '123', allowedTelegramUsers: ['9'], retrySeconds: 60, expireSeconds: 3600 }
  const pager = new Pager(directory, options, providers)
  pager.running = true
  return { pager, calls, providers, directory }
}

function event(status, event_id = 'a', severity = 'wake') {
  return { source: 'test', event_id, fingerprint: 'engine-hot', status, severity,
    title: 'Engine hot', summary: 'Temperature above threshold', observed_at: new Date().toISOString() }
}

test('validates event identity and timestamp', () => {
  assert.equal(validate(event('firing')).severity, 'wake')
  assert.throws(() => validate({ ...event('firing'), source: '../../bad' }))
  assert.throws(() => validate({ ...event('firing'), observed_at: 'invalid' }))
})

test('duplicate event sends one emergency page and persists receipt', async () => {
  const { pager, calls, directory } = fixture()
  const first = await pager.submit(event('firing'))
  const second = await pager.submit(event('firing'))
  assert.equal(first.id, second.id)
  assert.equal(second.deduplicated, true)
  await pager.tick()
  assert.equal(calls.filter(c => c[0] === 'pushover').length, 1)
  assert.equal(calls.find(c => c[0] === 'pushover')[1].priority, 2)
  const restored = new Pager(directory, pager.options, pager.providers)
  assert.equal(Object.values(restored.store.state.incidents)[0].receipt, 'receipt-1')
})

test('Telegram acknowledgement cancels retries but does not resolve incident', async () => {
  const { pager, calls } = fixture()
  const { id } = await pager.submit(event('firing'))
  await pager.tick()
  const result = await pager.acknowledge(id, 'telegram:9')
  assert.equal(result.state, 'open_acked')
  for (let i = 0; i < 4; i++) await pager.tick()
  assert.equal(calls.filter(c => c[0] === 'cancel').length, 1)
  assert.equal(pager.status().open, 1)
})

test('resolution closes and cancels an unacknowledged page', async () => {
  const { pager, calls } = fixture()
  await pager.submit(event('firing'))
  await pager.tick()
  await pager.submit(event('resolved', 'b'))
  for (let i = 0; i < 4; i++) await pager.tick()
  assert.equal(calls.filter(c => c[0] === 'cancel').length, 1)
  assert.equal(pager.status().open, 0)
})

test('Telegram acknowledgement requires allowed chat and user', async () => {
  const { pager, providers } = fixture()
  const { id } = await pager.submit(event('firing'))
  providers.updates = async () => [
    { update_id: 1, callback_query: { id: 'bad', from: { id: 8 }, message: { chat: { id: 123 } }, data: `ack:${id}` } },
    { update_id: 2, callback_query: { id: 'good', from: { id: 9 }, message: { chat: { id: 123 } }, data: `ack:${id}` } }
  ]
  await pager.tick()
  assert.equal(Object.values(pager.store.state.incidents)[0].state, 'open_acked')
  assert.equal(pager.store.state.telegramOffset, 3)
})

test('repeated firing leaves one pager job and stale clear cannot close it', async () => {
  const { pager } = fixture()
  const first = event('firing')
  const older = new Date(Date.parse(first.observed_at) - 1000).toISOString()
  await pager.submit(first)
  await pager.submit({ ...event('firing', 'b'), observed_at: first.observed_at })
  assert.equal(pager.store.state.jobs.filter(j => j.type === 'pushover-send').length, 1)
  await pager.submit({ ...event('resolved', 'c'), observed_at: older })
  assert.equal(Object.values(pager.store.state.incidents)[0].state, 'open_unacked')
})

test('Pushover receipt acknowledgement silences incident without resolving fault', async () => {
  const { pager, providers } = fixture()
  await pager.submit(event('firing'))
  await pager.tick()
  providers.receipt = async () => ({ status: 1, acknowledged: 1, acknowledged_at: Math.floor(Date.now() / 1000), expired: 0 })
  await pager.store.transaction(state => { Object.values(state.incidents)[0].lastReceiptPoll = 0 })
  await pager.tick()
  assert.equal(Object.values(pager.store.state.incidents)[0].state, 'open_acked')
  assert.equal(pager.status().open, 1)
})

test('provider failure keeps a durable retry job', async () => {
  const { pager, providers, directory } = fixture()
  providers.pushover = async () => { throw new Error('offline') }
  await pager.submit(event('firing'))
  await pager.tick()
  assert.equal(pager.status().pendingJobs, 2)
  assert.match(pager.status().lastError, /offline/)
  const restored = new Pager(directory, pager.options, providers)
  assert.equal(restored.store.state.jobs.find(j => j.type === 'pushover-send').attempts, 1)
})

test('severity promotion from info sends first Pushover page', async () => {
  const { pager, calls } = fixture()
  await pager.submit(event('firing', 'one', 'info'))
  await pager.tick()
  assert.equal(calls.filter(c => c[0] === 'pushover').length, 0)
  await pager.submit(event('firing', 'two', 'warning'))
  await pager.tick()
  assert.equal(calls.filter(c => c[0] === 'pushover').length, 1)
  assert.equal(calls.find(c => c[0] === 'pushover')[1].priority, 0)
})

test('default shadow mode sends Telegram, logs proposed pages and never enqueues a page', async () => {
  const { directory, providers, calls, pager: active } = fixture()
  active.stop()
  const logs = []
  const { mode, ...options } = active.options
  const pager = new Pager(directory, options, providers, line => logs.push(line))
  assert.equal(pager.options.mode, 'shadow')
  pager.running = true
  await pager.submit(event('firing', 'one'))
  await pager.tick()
  assert.equal(calls.some(c => c[0] === 'pushover'), false)
  assert.equal(calls.some(c => c[0] === 'sendMessage'), true)
  assert.equal(pager.store.state.jobs.some(j => j.type === 'pushover-send'), false)
  assert.match(logs[0], /would-send-priority-2 retry=60s expire=3600s/)
  await pager.submit(event('resolved', 'two'))
  assert.match(logs[1], /would-cancel-active-retries/)
  pager.stop()
})

test('shadow promotion logs the proposed higher priority', async () => {
  const { directory, providers, pager: active } = fixture()
  active.stop()
  const logs = []
  const pager = new Pager(directory, { ...active.options, mode: 'shadow' }, providers, line => logs.push(line))
  await pager.submit(event('firing', 'one', 'warning'))
  await pager.submit(event('firing', 'two', 'wake'))
  assert.match(logs[1], /shadow promote .*would-send-priority-2 retry=60s expire=3600s/)
  assert.equal(pager.store.state.jobs.some(j => j.type === 'pushover-send'), false)
})

test('activating after shadow only pages on a fresh firing observation', async () => {
  const { directory, providers, calls, pager: initial } = fixture()
  initial.stop()
  const shadow = new Pager(directory, { ...initial.options, mode: 'shadow' }, providers)
  await shadow.submit(event('firing', 'one'))
  const active = new Pager(directory, initial.options, providers)
  active.running = true
  await active.tick()
  assert.equal(calls.some(c => c[0] === 'pushover'), false)
  await active.submit(event('firing', 'two'))
  await active.tick()
  assert.equal(calls.filter(c => c[0] === 'pushover').length, 1)
  active.stop()
})

test('switching from active to shadow cancels an outstanding emergency retry', async () => {
  const { directory, providers, calls, pager: active } = fixture()
  await active.submit(event('firing', 'one'))
  await active.tick()
  active.stop()
  const shadow = new Pager(directory, { ...active.options, mode: 'shadow' }, providers)
  await shadow.start()
  await new Promise(resolve => setImmediate(resolve))
  await shadow.tick()
  assert.equal(calls.filter(c => c[0] === 'cancel').length, 1)
  assert.equal(calls.filter(c => c[0] === 'pushover').length, 1)
  shadow.stop()
})

test('Signal K server acknowledgement cancels the matching notification page', async () => {
  const { pager, calls } = fixture()
  const raised = { ...event('firing', 'one'), source: 'signalk', fingerprint: 'notifications.navigation.anchor' }
  await pager.submit(raised)
  await pager.tick()
  await pager.acknowledgeNotification('notifications.navigation.anchor')
  for (let i = 0; i < 3; i++) await pager.tick()
  assert.equal(calls.filter(c => c[0] === 'cancel').length, 1)
  assert.equal(pager.store.state.incidents[JSON.stringify(['signalk', raised.fingerprint])].state, 'open_acked')
  assert.equal(pager.status().open, 1)
  pager.stop()
})
