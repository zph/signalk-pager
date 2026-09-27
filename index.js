'use strict'
const crypto = require('node:crypto')
const { Pager } = require('./lib/pager')

const DEFAULT_NOTIFICATION_SEVERITY = {
  alert: 'info',
  warn: 'warning',
  alarm: 'urgent',
  emergency: 'wake'
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

function createNotificationApi(app) {
  return {
    acknowledge(id, path) {
      if (!app.notifications?.getPath || !app.notifications?.acknowledge) throw new Error('Signal K notification management is unavailable')
      const current = app.notifications.getPath(path)?.[id]
      if (!current || current.path !== path || current.context !== 'vessels.self' ||
          ['normal', 'nominal'].includes(current.value?.state)) throw new Error('Signal K notification is no longer active at this path')
      if (current.value?.status?.acknowledged === true) return
      if (current.value?.status?.canAcknowledge !== true) throw new Error('Signal K notification cannot be acknowledged')
      app.notifications.acknowledge(id)
    },
    idForPath(path, value) {
      if (!app.notifications?.getPath) return null
      const matches = Object.entries(app.notifications.getPath(path) || {})
        .filter(([, item]) => item.path === path && item.context === 'vessels.self' && !['normal', 'nominal'].includes(item.value?.state))
      if (value?.id && matches.some(([id]) => id === value.id)) return value.id
      return matches.length === 1 ? matches[0][0] : null
    }
  }
}

function notificationSeverity(path, value, routeAllNotifications, rules) {
  if (typeof path !== 'string' || !path.startsWith('notifications.')) return null
  if (path.startsWith('notifications.plugins.signalkPager')) return null
  const override = rules.get(path)
  if (override) return override === 'off' ? null : override
  return routeAllNotifications ? DEFAULT_NOTIFICATION_SEVERITY[value?.state] || null : null
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
        telegramEnabled: { type: 'boolean', title: 'Send incidents to Telegram', default: true, description: 'Enabled by default. Disable explicitly to operate without Telegram; shadow mode still requires Telegram.' },
        retrySeconds: { type: 'integer', title: 'Emergency retry seconds', default: 60, minimum: 30, maximum: 3600 },
        expireSeconds: { type: 'integer', title: 'Emergency expiry seconds', default: 3600, minimum: 60, maximum: 10800 },
        routeAllNotifications: { type: 'boolean', title: 'Route all Signal K notifications', default: true, description: 'Alert goes to Telegram; warn, alarm, and emergency also go to Pushover in active mode. Disable for configured paths only.' },
        notificationRules: { type: 'array', title: 'Signal K notification overrides', default: [], maxItems: 30,
          items: { type: 'object', required: ['path', 'severity'], properties: {
            path: { type: 'string', title: 'Exact notifications.* path' },
            severity: { type: 'string', title: 'Delivery override', enum: ['info', 'warning', 'urgent', 'wake', 'off'] }
          } }
        }
      }
    },
    start(input = {}) {
      if (pager) return
      const options = { mode: 'shadow', ...input,
        allowedTelegramUsers: String(input.allowedTelegramUsers || '').split(',').map(s => s.trim()).filter(Boolean),
        telegramEnabled: input.telegramEnabled !== false,
        routeAllNotifications: input.routeAllNotifications !== false,
        retrySeconds: input.retrySeconds || 60, expireSeconds: input.expireSeconds || 3600 }
      if (!options.intakeToken || options.intakeToken.length < 24) throw new Error('Configure a 24+ character event API token')
      if (options.mode === 'active' && (!options.pushoverToken || !options.pushoverUser)) throw new Error('Configure Pushover application and user keys before activating')
      if (!['shadow', 'active'].includes(options.mode)) throw new Error('Invalid operating mode')
      if (options.mode === 'shadow' && !options.telegramEnabled) throw new Error('Shadow mode requires Telegram')
      if (options.telegramEnabled && (!options.telegramToken || !options.telegramChatId || !options.allowedTelegramUsers.length)) throw new Error('Configure Telegram token, chat, and allowed user IDs, or disable Telegram explicitly')
      if (options.retrySeconds < 30 || options.expireSeconds > 10800 || options.expireSeconds < options.retrySeconds) throw new Error('Invalid emergency retry settings')
      rules = new Map()
      for (const rule of options.notificationRules || []) {
        if (!/^notifications\.[A-Za-z0-9_.-]+$/.test(rule.path) || !['info', 'warning', 'urgent', 'wake', 'off'].includes(rule.severity)) throw new Error('Invalid notification rule')
        if (rule.path.startsWith('notifications.plugins.signalkPager')) throw new Error('Cannot page on own status')
        rules.set(rule.path, rule.severity)
      }
      const notificationApi = createNotificationApi(app)
      pager = new Pager(app.getDataDirPath(), options, undefined, line => console.info(`[signalk-pager] ${line}`), notificationApi)
      pager.start().catch(error => app.setPluginError?.(`Pager startup: ${error.message}`))
      if ((options.routeAllNotifications || rules.size) && app.subscriptionmanager?.subscribe) {
        app.subscriptionmanager.subscribe({ context: 'vessels.self', sourcePolicy: 'preferred',
          subscribe: (options.routeAllNotifications ? ['notifications.*'] : [...rules.keys()]).map(path => ({ path, policy: 'instant' })) },
        unsubscribes, error => app.setPluginError?.(`Pager subscription failed: ${String(error)}`),
        delta => {
          for (const update of delta.updates || []) for (const item of update.values || []) {
            const currentPager = pager
            if (!currentPager) continue
            const active = item.value && !['normal', 'nominal'].includes(item.value.state)
            const severity = notificationSeverity(item.path, item.value, options.routeAllNotifications, rules)
            if (active && !severity) continue
            if (active && severity === 'info' && !options.telegramEnabled) continue
            if (!active && !severity && !currentPager.hasOpenIncident('signalk', item.path)) continue
            const event = { source: 'signalk', event_id: crypto.randomUUID(), fingerprint: item.path,
              status: active ? 'firing' : 'resolved', severity: severity || 'info',
              title: item.path, summary: String(item.value?.message || item.value?.state || 'Cleared'),
              observed_at: update.timestamp || new Date().toISOString() }
            let notificationId = null
            try { if (active) notificationId = notificationApi?.idForPath(item.path, item.value) || null }
            catch (error) { app.setPluginError?.(`Pager notification lookup: ${error.message}`) }
            currentPager.submit(event, notificationId)
              .then(() => active && item.value?.status?.acknowledged === true
                ? currentPager.acknowledgeNotification(item.path) : undefined)
              .catch(error => app.setPluginError?.(`Pager intake: ${error.message}`))
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
        if (req.body?.source === 'signalk') return res.status(400).json({ error: 'Signal K source is reserved for the notification subscription' })
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
module.exports.createNotificationApi = createNotificationApi
module.exports.notificationSeverity = notificationSeverity
