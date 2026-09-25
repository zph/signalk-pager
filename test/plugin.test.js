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
  plugin.start({ mode: 'active', intakeToken: 'a'.repeat(32), pushoverToken: 'app', pushoverUser: 'user' })
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
  plugin.start({ mode: 'active', intakeToken: 'a'.repeat(32), pushoverToken: 'app', pushoverUser: 'user',
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
