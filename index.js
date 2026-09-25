'use strict'
const crypto = require('node:crypto')
const { Pager } = require('./lib/pager')

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

module.exports = function pluginConstructor(app) {
  let pager = null
  let unsubscribes = []
  let rules = new Map()
  const plugin = {
    id: 'signalk-pager', name: 'Pager',
    description: 'Pushover paging with Telegram incident context',
    schema: {
      type: 'object', title: 'Pager', properties: {
        mode: { type: 'string', title: 'Operating mode', enum: ['shadow', 'active'], default: 'shadow', description: 'Shadow sends Telegram context and logs the Pushover page it would send. Active enables Pushover delivery for new alerts.' },
        intakeToken: { type: 'string', title: 'Event API bearer token', format: 'password', description: 'Use a long random secret. Required for POST /plugins/signalk-pager/v1/events.' },
        pushoverToken: { type: 'string', title: 'Pushover application token', format: 'password' },
        pushoverUser: { type: 'string', title: 'Pushover user/group key', format: 'password' },
        telegramToken: { type: 'string', title: 'Telegram bot token', format: 'password' },
        telegramChatId: { type: 'string', title: 'Telegram chat ID' },
        allowedTelegramUsers: { type: 'string', title: 'Telegram user IDs permitted to acknowledge (comma-separated)' },
        retrySeconds: { type: 'integer', title: 'Emergency retry seconds', default: 60, minimum: 30, maximum: 3600 },
        expireSeconds: { type: 'integer', title: 'Emergency expiry seconds', default: 3600, minimum: 60, maximum: 10800 },
        notificationRules: { type: 'array', title: 'Signal K notification routes', default: [], maxItems: 30,
          items: { type: 'object', required: ['path', 'severity'], properties: {
            path: { type: 'string', title: 'Exact notifications.* path' },
            severity: { type: 'string', title: 'Pager severity', enum: ['info', 'warning', 'urgent', 'wake'] }
          } }
        }
      }
    },
    start(input = {}) {
      if (pager) return
      const options = { mode: 'shadow', ...input,
        allowedTelegramUsers: String(input.allowedTelegramUsers || '').split(',').map(s => s.trim()).filter(Boolean),
        retrySeconds: input.retrySeconds || 60, expireSeconds: input.expireSeconds || 3600 }
      if (!options.intakeToken || options.intakeToken.length < 24) throw new Error('Configure a 24+ character event API token')
      if (options.mode === 'active' && (!options.pushoverToken || !options.pushoverUser)) throw new Error('Configure Pushover application and user keys before activating')
      if (!['shadow', 'active'].includes(options.mode)) throw new Error('Invalid operating mode')
      if (options.mode === 'shadow' && !options.telegramToken) throw new Error('Configure Telegram before enabling shadow mode')
      if (options.telegramToken && (!options.telegramChatId || !options.allowedTelegramUsers.length)) throw new Error('Configure Telegram chat and allowed user IDs')
      if (options.retrySeconds < 30 || options.expireSeconds > 10800 || options.expireSeconds < options.retrySeconds) throw new Error('Invalid emergency retry settings')
      rules = new Map()
      for (const rule of options.notificationRules || []) {
        if (!/^notifications\.[A-Za-z0-9_.-]+$/.test(rule.path) || !['info', 'warning', 'urgent', 'wake'].includes(rule.severity)) throw new Error('Invalid notification rule')
        if (rule.path.startsWith('notifications.plugins.signalkPager')) throw new Error('Cannot page on own status')
        rules.set(rule.path, rule.severity)
      }
      pager = new Pager(app.getDataDirPath(), options, undefined, line => console.info(`[signalk-pager] ${line}`))
      pager.start().catch(error => app.setPluginError?.(`Pager startup: ${error.message}`))
      if (rules.size && app.subscriptionmanager?.subscribe) {
        app.subscriptionmanager.subscribe({ context: 'vessels.self', sourcePolicy: 'preferred',
          subscribe: [...rules.keys()].map(path => ({ path, policy: 'instant' })) },
        unsubscribes, error => app.setPluginError?.(`Pager subscription failed: ${String(error)}`),
        delta => {
          for (const update of delta.updates || []) for (const item of update.values || []) {
            if (!rules.has(item.path)) continue
            const active = item.value && !['normal', 'nominal'].includes(item.value.state)
            const event = { source: 'signalk', event_id: crypto.randomUUID(), fingerprint: item.path,
              status: active ? 'firing' : 'resolved', severity: rules.get(item.path),
              title: item.path, summary: String(item.value?.message || item.value?.state || 'Cleared'),
              observed_at: update.timestamp || new Date().toISOString() }
            pager.submit(event).catch(error => app.setPluginError?.(`Pager intake: ${error.message}`))
          }
        })
      }
      app.setPluginStatus?.(`Pager ${options.mode}`)
    },
    stop() {
      while (unsubscribes.length) unsubscribes.pop()?.()
      pager?.stop(); pager = null; rules = new Map()
      app.setPluginStatus?.('Pager stopped')
    },
    registerWithRouter(router) {
      router.post('/v1/events', async (req, res) => {
        if (!pager) return res.status(503).json({ error: 'Pager disabled' })
        if (!safeEqual(req.headers.authorization, `Bearer ${pager.options.intakeToken}`)) return res.status(401).json({ error: 'Unauthorized' })
        if (Number(req.headers['content-length'] || 0) > 8192 || JSON.stringify(req.body || {}).length > 8192) return res.status(413).json({ error: 'Event too large' })
        try { return res.status(202).json(await pager.submit(req.body)) }
        catch (error) { return res.status(['Pager queue full', 'Previous incident still closing'].includes(error.message) ? 503 : 400).json({ error: error.message }) }
      })
      router.get('/v1/status', (req, res) => {
        if (!pager) return res.status(503).json({ running: false })
        if (!safeEqual(req.headers.authorization, `Bearer ${pager.options.intakeToken}`)) return res.status(401).json({ error: 'Unauthorized' })
        return res.json(pager.status())
      })
    }
  }
  return plugin
}
