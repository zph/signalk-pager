'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const makePlugin = require('../index')

function response() {
  return { code: 200, status(code) { this.code = code; return this }, json(value) { this.body = value; return this } }
}

test('event route rejects missing token and accepts valid event durably', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-plugin-'))
  const app = { getDataDirPath: () => directory, setPluginStatus: () => {}, setPluginError: () => {} }
  const plugin = makePlugin(app)
  const routes = {}
  plugin.registerWithRouter({ post: (p, handler) => { routes[p] = handler }, get: (p, handler) => { routes[p] = handler } })
  assert.throws(() => plugin.start({ intakeToken: 'a'.repeat(32) }), /Configure Telegram/)
  plugin.start({ mode: 'active', intakeToken: 'a'.repeat(32), pushoverToken: 'app', pushoverUser: 'user', telegramEnabled: false })
  const body = { source: 'script', event_id: '1', fingerprint: 'fault', status: 'firing', severity: 'warning', title: 'Fault', summary: 'Check it', observed_at: new Date().toISOString() }
  const unauthorized = response()
  await routes['/v1/events']({ headers: {}, body }, unauthorized)
  assert.equal(unauthorized.code, 401)
  const accepted = response()
  await routes['/v1/events']({ headers: { authorization: `Bearer ${'a'.repeat(32)}` }, body }, accepted)
  assert.equal(accepted.code, 202)
  const status = response()
  routes['/v1/status']({ headers: { authorization: `Bearer ${'a'.repeat(32)}` } }, status)
  assert.equal(status.body.open, 1)
  plugin.stop()
})

test('Signal K acknowledgement is reconciled while silence alone does not acknowledge', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-plugin-notifications-'))
  let onDelta
  const app = { getDataDirPath: () => directory, setPluginStatus: () => {}, setPluginError: () => {},
    subscriptionmanager: { subscribe: (_spec, _unsubscribes, _error, callback) => { onDelta = callback } } }
  const plugin = makePlugin(app)
  plugin.start({ mode: 'active', intakeToken: 'a'.repeat(32), pushoverToken: 'app', pushoverUser: 'user', telegramEnabled: false,
    notificationRules: [
      { path: 'notifications.navigation.anchor', severity: 'wake' },
      { path: 'notifications.environment.wind', severity: 'warning' }
    ] })
  onDelta({ updates: [{ values: [
    { path: 'notifications.navigation.anchor', value: { state: 'alarm', status: { acknowledged: true } } },
    { path: 'notifications.environment.wind', value: { state: 'warn', status: { silenced: true } } }
  ] }] })
  let state
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    const file = path.join(directory, 'pager-state.json')
    if (!fs.existsSync(file)) continue
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Object.keys(state.incidents).length === 2 && state.incidents[JSON.stringify(['signalk', 'notifications.navigation.anchor'])].state === 'open_acked') break
  }
  assert.equal(state.incidents[JSON.stringify(['signalk', 'notifications.navigation.anchor'])].state, 'open_acked')
  assert.equal(state.incidents[JSON.stringify(['signalk', 'notifications.environment.wind'])].state, 'open_unacked')
  plugin.stop()
})

test('notification adapter binds a unique server ID and rejects a replaced notification', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-plugin-id-'))
  const notificationPath = 'notifications.navigation.anchor'
  let onDelta
  let currentId = 'server-1'
  const acknowledgements = []
  const app = { getDataDirPath: () => directory, setPluginStatus: () => {}, setPluginError: () => {},
    notifications: {
      getPath: () => ({ [currentId]: { path: notificationPath, context: 'vessels.self', value: { state: 'alarm', id: currentId } } }),
      acknowledge: id => acknowledgements.push(id)
    },
    subscriptionmanager: { subscribe: (_spec, _unsubscribes, _error, callback) => { onDelta = callback } } }
  const plugin = makePlugin(app)
  plugin.start({ mode: 'active', intakeToken: 'a'.repeat(32), pushoverToken: 'app', pushoverUser: 'user', telegramEnabled: false,
    notificationRules: [{ path: notificationPath, severity: 'wake' }] })
  onDelta({ updates: [{ values: [{ path: notificationPath, value: { state: 'alarm', id: currentId } }] }] })
  const stateFile = path.join(directory, 'pager-state.json')
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(stateFile) && JSON.parse(fs.readFileSync(stateFile, 'utf8')).incidents[JSON.stringify(['signalk', notificationPath])]?.notificationId) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(state.incidents[JSON.stringify(['signalk', notificationPath])].notificationId, 'server-1')
  const { Pager } = require('../lib/pager')
  plugin.stop()
  const pager = new Pager(directory, { mode: 'active' }, undefined, undefined, makePlugin.createNotificationApi(app))
  currentId = 'server-2'
  await assert.rejects(() => pager.acknowledge(state.incidents[JSON.stringify(['signalk', notificationPath])].id, 'telegram:9'), /no longer active/)
  assert.deepEqual(acknowledgements, [])
})

test('notification adapter writes only an active exact-path ACK', () => {
  const notificationPath = 'notifications.navigation.anchor'
  const writes = []
  const app = { notifications: {
    getPath: () => ({ 'server-1': { context: 'vessels.self', path: notificationPath,
      value: { state: 'alarm', status: { canAcknowledge: true } } } }),
    acknowledge: id => writes.push(id)
  } }
  const adapter = makePlugin.createNotificationApi(app)
  assert.equal(adapter.idForPath(notificationPath, {}), 'server-1')
  adapter.acknowledge('server-1', notificationPath)
  assert.deepEqual(writes, ['server-1'])
  assert.throws(() => adapter.acknowledge('server-1', 'notifications.environment.wind'), /no longer active/)
  app.notifications.getPath = () => ({ 'server-1': { context: 'vessels.self', path: notificationPath,
    value: { state: 'alarm', status: { canAcknowledge: false } } } })
  assert.throws(() => adapter.acknowledge('server-1', notificationPath), /cannot be acknowledged/)
  app.notifications.getPath = () => ({ 'server-1': { context: 'vessels.self', path: notificationPath, value: { state: 'normal' } } })
  assert.throws(() => adapter.acknowledge('server-1', notificationPath), /no longer active/)
})

test('default notification routing covers every raised grade with exact overrides', () => {
  const severity = makePlugin.notificationSeverity
  const rules = new Map([
    ['notifications.navigation.anchor', 'wake'],
    ['notifications.test.ignored', 'off']
  ])
  assert.equal(severity('notifications.advisory', { state: 'alert' }, true, rules), 'info')
  assert.equal(severity('notifications.weather.wind', { state: 'warn' }, true, rules), 'warning')
  assert.equal(severity('notifications.navigation.depth', { state: 'alarm' }, true, rules), 'urgent')
  assert.equal(severity('notifications.mob', { state: 'emergency' }, true, rules), 'wake')
  assert.equal(severity('notifications.navigation.anchor', { state: 'alert' }, true, rules), 'wake')
  assert.equal(severity('notifications.test.ignored', { state: 'emergency' }, true, rules), null)
  assert.equal(severity('notifications.unconfigured', { state: 'alarm' }, false, rules), null)
  assert.equal(severity('notifications.plugins.signalkPager.health', { state: 'emergency' }, true, rules), null)
})

test('all Signal K notifications are subscribed by default', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-plugin-default-routing-'))
  let subscription
  const app = { getDataDirPath: () => directory, setPluginStatus: () => {}, setPluginError: () => {},
    subscriptionmanager: { subscribe: spec => { subscription = spec } } }
  const plugin = makePlugin(app)
  plugin.start({ mode: 'active', intakeToken: 'a'.repeat(32), pushoverToken: 'app', pushoverUser: 'user', telegramEnabled: false })
  assert.deepEqual(subscription.subscribe, [{ path: 'notifications.*', policy: 'instant' }])
  plugin.stop()
})

test('explicitly disabling Telegram ignores Telegram-only alerts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pager-plugin-no-telegram-'))
  let onDelta
  const errors = []
  const app = { getDataDirPath: () => directory, setPluginStatus: () => {}, setPluginError: error => errors.push(error),
    subscriptionmanager: { subscribe: (_spec, _unsubscribes, _error, callback) => { onDelta = callback } } }
  const plugin = makePlugin(app)
  plugin.start({ mode: 'active', intakeToken: 'a'.repeat(32), pushoverToken: 'app', pushoverUser: 'user', telegramEnabled: false })
  try {
    onDelta({ updates: [{ values: [{ path: 'notifications.advisory', value: { state: 'alert', message: 'Heads up' } }] }] })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(errors, [])
    assert.equal(fs.existsSync(path.join(directory, 'pager-state.json')), false,
      'ignored alerts should not create durable incidents')
  } finally { plugin.stop() }
})
