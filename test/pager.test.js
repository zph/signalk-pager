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
  const options = { pushoverToken: 'test', pushoverUser: 'test', telegramToken: 'test', telegramChatId: '123', allowedTelegramUsers: ['9'], retrySeconds: 60, expireSeconds: 3600 }
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
