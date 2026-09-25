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
