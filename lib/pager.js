'use strict'
const crypto = require('node:crypto')
const Store = require('./store')
const defaultProviders = require('./providers')

const PRIORITY = { info: null, warning: 0, urgent: 1, wake: 2 }
const RANK = { info: 0, warning: 1, urgent: 2, wake: 3 }
const LIMITS = { maxEvents: 5000, maxJobs: 1000, maxIncidents: 1000 }
const clean = (value, max) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max)

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid event')
  const event = {
    source: clean(input.source, 64), event_id: clean(input.event_id, 128),
    fingerprint: clean(input.fingerprint, 128), status: input.status,
    severity: input.severity, title: clean(input.title, 180),
    summary: clean(input.summary, 900), observed_at: input.observed_at
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(event.source) ||
      !/^[A-Za-z0-9_.:-]+$/.test(event.event_id) ||
      !/^[A-Za-z0-9_.:-]+$/.test(event.fingerprint) ||
      !['firing', 'resolved'].includes(event.status) ||
      !(event.severity in PRIORITY) || !event.title || !event.summary) throw new Error('Invalid event')
  if (typeof event.observed_at !== 'string' || !Number.isFinite(Date.parse(event.observed_at))) throw new Error('Invalid timestamp')
  const time = Date.parse(event.observed_at)
  if (time > Date.now() + 300000) throw new Error('Timestamp in future')
  event.observed_at = new Date(time).toISOString()
  return event
}

class Pager {
  constructor(directory, options, providers = defaultProviders, logger = () => {}, notificationApi = null) {
    this.store = new Store(directory)
    this.options = { mode: 'shadow', ...options }
    this.providers = providers
    this.logger = logger
    this.notificationApi = notificationApi
    this.running = false
    this.processing = false
    this.lastError = null
    this.lastProviderSuccess = null
  }

  async submit(input, notificationId = null) {
    const event = validate(input)
    const active = this.options.mode === 'active'
    if (active && event.severity === 'info' && !this.hasTelegram()) throw new Error('Info events require Telegram')
    const result = await this.store.transaction(state => {
      const eventKey = JSON.stringify([event.source, event.event_id])
      if (state.events[eventKey]) return { id: state.events[eventKey], deduplicated: true }
      if (Object.keys(state.events).length >= LIMITS.maxEvents || state.jobs.length >= LIMITS.maxJobs) throw new Error('Pager queue full')
      const key = JSON.stringify([event.source, event.fingerprint])
      let incident = state.incidents[key]
      if (!incident && Object.keys(state.incidents).length >= LIMITS.maxIncidents) throw new Error('Incident store full')
      if (incident && (Date.parse(event.observed_at) < Date.parse(incident.observed_at) ||
          (incident.state === 'resolved' && Date.parse(event.observed_at) <= Date.parse(incident.observed_at)))) {
        state.events[eventKey] = incident.id
        return { id: incident.id, stale: true }
      }
      if (incident?.state === 'resolved' && event.status === 'firing' && state.jobs.some(item => item.key === key)) throw new Error('Previous incident still closing')
      const now = new Date().toISOString()
      if (event.status === 'firing') {
        if (!incident || incident.state === 'resolved') {
          incident = { id: crypto.randomUUID(), key, source: event.source, fingerprint: event.fingerprint,
            state: 'open_unacked', severity: event.severity, title: event.title, summary: event.summary,
            observed_at: event.observed_at, opened_at: now, updated_at: now, count: 1,
            receipt: null, pagedPriority: -1, telegramMessageId: null, pageExpired: false, shadow: !active }
          state.incidents[key] = incident
          if (event.source === 'signalk') incident.notificationId = notificationId
          if (active && event.severity !== 'info') enqueueJob(state, 'pushover-send', key)
          if (!active) incident.shadowAction = 'open'
          if (this.hasTelegram()) enqueueJob(state, 'telegram-sync', key)
        } else {
          if (event.source === 'signalk' && notificationId &&
              (incident.notificationId && notificationId !== incident.notificationId ||
               !incident.notificationId && incident.state === 'open_acked')) {
            // A fresh server notification at the same path is a new alarm to acknowledge.
            if (incident.receipt) enqueueJob(state, 'pushover-cancel', key, incident.receipt)
            incident.id = crypto.randomUUID()
            incident.notificationId = notificationId
            incident.state = 'open_unacked'
            incident.opened_at = now
            incident.telegramMessageId = null
            incident.count = 0
            delete incident.acknowledged_at
            delete incident.acknowledged_by
            incident.receipt = null
            incident.pagedPriority = -1
            incident.pageExpired = false
            if (active && event.severity !== 'info') enqueueJob(state, 'pushover-send', key)
          } else if (event.source === 'signalk' && notificationId) incident.notificationId = notificationId
          const firstActiveObservation = active && incident.shadow
          const promoted = RANK[event.severity] > RANK[incident.severity]
          if (firstActiveObservation) {
            incident.shadow = false
            incident.state = 'open_unacked'
            incident.receipt = null
            incident.pagedPriority = -1
            incident.pageExpired = false
          }
          incident.count++
          incident.observed_at = event.observed_at
          incident.updated_at = now
          incident.title = event.title
          incident.summary = event.summary
          if (promoted) {
            incident.severity = event.severity
            if (event.severity === 'wake' && incident.state === 'open_acked') {
              incident.state = 'open_unacked'
              delete incident.acknowledged_at
              delete incident.acknowledged_by
            }
            if (active && event.severity !== 'info' && incident.state === 'open_unacked') enqueueJob(state, 'pushover-send', key)
          }
          if (firstActiveObservation && event.severity !== 'info') enqueueJob(state, 'pushover-send', key)
          if (!active && promoted) incident.shadowAction = 'promote'
          if (this.hasTelegram()) enqueueJob(state, 'telegram-sync', key)
        }
      } else if (incident && incident.state !== 'resolved') {
        incident.state = 'resolved'
        incident.observed_at = event.observed_at
        incident.updated_at = now
        incident.resolved_at = now
        if (incident.receipt) enqueueJob(state, 'pushover-cancel', key, incident.receipt)
        if (!active) incident.shadowAction = 'resolve'
        if (this.hasTelegram()) enqueueJob(state, 'telegram-sync', key)
      }
      state.events[eventKey] = incident?.id || 'no-open-incident'
      const shadowAction = incident?.shadowAction
      if (incident) delete incident.shadowAction
      return { id: state.events[eventKey], state: incident?.state || 'no-open-incident', shadowAction, severity: incident?.severity }
    })
    if (result.shadowAction) {
      const priority = PRIORITY[result.severity]
      const detail = priority === 2 ? ` retry=${this.options.retrySeconds || 60}s expire=${this.options.expireSeconds || 3600}s` : ''
      const action = result.shadowAction === 'resolve' ? 'would-cancel-active-retries' : priority === null ? 'none' : `would-send-priority-${priority}${detail}`
      this.logger(`shadow ${result.shadowAction} incident=${result.id} pushover=${action}`)
    }
    const { shadowAction, severity, ...publicResult } = result
    return publicResult
  }

  async acknowledge(id, by, serverAcknowledged = false) {
    const current = Object.values(this.store.state.incidents).find(item => item.id === id)
    if (!current) throw new Error('Incident not found')
    if (current.state === 'open_unacked' && current.source === 'signalk' && !serverAcknowledged && this.notificationApi) {
      if (!current.notificationId) throw new Error('Signal K notification has no unique server ID')
      await this.notificationApi.acknowledge(current.notificationId, current.fingerprint)
    }
    return this.store.transaction(state => {
      const incident = Object.values(state.incidents).find(item => item.id === id)
      if (!incident) throw new Error('Incident not found')
      if (incident.state !== 'open_unacked') return { id, state: incident.state }
      incident.state = 'open_acked'
      incident.acknowledged_by = clean(by, 100)
      incident.acknowledged_at = new Date().toISOString()
      incident.updated_at = incident.acknowledged_at
      if (by === 'pushover') incident.receipt = null
      else if (incident.receipt) enqueueJob(state, 'pushover-cancel', incident.key, incident.receipt)
      if (this.hasTelegram()) enqueueJob(state, 'telegram-sync', incident.key)
      return { id, state: incident.state }
    })
  }

  async acknowledgeNotification(path) {
    const incident = this.store.state.incidents[JSON.stringify(['signalk', path])]
    if (!incident || incident.state !== 'open_unacked') return
    return this.acknowledge(incident.id, 'signalk', true)
  }

  hasOpenIncident(source, fingerprint) {
    const incident = this.store.state.incidents[JSON.stringify([source, fingerprint])]
    return Boolean(incident && incident.state !== 'resolved')
  }

  hasTelegram() {
    return this.options.telegramEnabled !== false && Boolean(this.options.telegramToken && this.options.telegramChatId)
  }

  async start() {
    if (this.running) return
    if (this.options.mode === 'shadow') {
      await this.store.transaction(state => {
        state.jobs = state.jobs.filter(item => ['pushover-cancel', 'telegram-sync'].includes(item.type))
        for (const incident of Object.values(state.incidents)) {
          if (incident.state === 'resolved') continue
          incident.shadow = true
          if (incident.receipt) enqueueJob(state, 'pushover-cancel', incident.key, incident.receipt)
        }
      })
    }
    this.running = true
    this.timer = setInterval(() => this.tick().catch(error => { this.lastError = error.message }), 10000)
    this.tick().catch(error => { this.lastError = error.message })
  }

  stop() { this.running = false; clearInterval(this.timer) }

  async tick() {
    if (!this.running || this.processing) return
    this.processing = true
    try {
      const due = this.store.state.jobs.find(item => item.nextAt <= Date.now() &&
        (this.options.mode === 'active' || ['pushover-cancel', 'telegram-sync'].includes(item.type)))
      if (due) await this.processJob(due)
      if (this.options.mode === 'active') {
        await this.pollReceipts()
      }
      if (this.hasTelegram()) await this.pollTelegram()
    } finally { this.processing = false }
  }

  async processJob(item) {
    const incident = this.store.state.incidents[item.key]
    if (!incident) return this.finishJob(item.id)
    try {
      let result
      if (item.type === 'pushover-send') {
        if (incident.state !== 'open_unacked' || incident.receipt || incident.severity === 'info' ||
            (incident.pagedPriority ?? -1) >= PRIORITY[incident.severity]) return this.finishJob(item.id)
        const priority = PRIORITY[incident.severity]
        const fields = { title: incident.title, message: `${incident.summary}\nIncident ${incident.id}`.slice(0, 1024), priority }
        if (priority === 2) Object.assign(fields, { retry: this.options.retrySeconds || 60, expire: this.options.expireSeconds || 3600 })
        result = await this.providers.pushover(this.options, fields)
        if (priority === 2 && !result.receipt) throw new Error('Pushover did not return emergency receipt')
        await this.store.transaction(state => {
          const current = state.incidents[item.key]
          current.pagedPriority = priority
          if (priority === 2 && result.receipt) {
            current.receipt = result.receipt
            current.lastReceiptPoll = 0
            if (current.state !== 'open_unacked') enqueueJob(state, 'pushover-cancel', item.key, result.receipt)
          }
          removeJob(state, item.id)
        })
      } else if (item.type === 'pushover-cancel') {
        await this.providers.cancel(this.options, item.receipt)
        await this.store.transaction(state => {
          const current = state.incidents[item.key]
          if (current?.receipt === item.receipt) current.receipt = null
          removeJob(state, item.id)
        })
      } else if (item.type === 'telegram-sync') {
        const text = formatTelegram(incident)
        if (incident.telegramMessageId) {
          await this.providers.telegram(this.options, 'editMessageText', {
            chat_id: this.options.telegramChatId, message_id: incident.telegramMessageId,
            text, reply_markup: incident.state === 'open_unacked' ? keyboard(incident.id) : { inline_keyboard: [] }
          }).catch(error => { if (!/message is not modified/i.test(error.message)) throw error })
          await this.finishJob(item.id)
        } else {
          result = await this.providers.telegram(this.options, 'sendMessage', {
            chat_id: this.options.telegramChatId, text,
            reply_markup: incident.state === 'open_unacked' ? keyboard(incident.id) : undefined
          })
          await this.store.transaction(state => {
            state.incidents[item.key].telegramMessageId = result.result.message_id
            removeJob(state, item.id)
          })
        }
      }
      this.lastProviderSuccess = new Date().toISOString()
      this.lastError = null
    } catch (error) {
      this.lastError = `${item.type}: ${error.message}`
      await this.store.transaction(state => {
        const pending = state.jobs.find(job => job.id === item.id)
        if (pending) { pending.attempts++; pending.nextAt = Date.now() + Math.min(300000, 10000 * 2 ** Math.min(pending.attempts, 5)) }
      })
    }
  }

  finishJob(id) { return this.store.transaction(state => removeJob(state, id)) }

  async pollReceipts() {
    if (!this.options.pushoverToken) return
    const incident = Object.values(this.store.state.incidents).find(item => item.receipt && item.state === 'open_unacked' && !item.pageExpired && Date.now() - (item.lastReceiptPoll || 0) >= 30000)
    if (!incident) return
    try {
      const result = await this.providers.receipt(this.options, incident.receipt)
      if (result.acknowledged === 1) await this.acknowledge(incident.id, 'pushover')
      await this.store.transaction(state => {
        const current = state.incidents[incident.key]
        current.lastReceiptPoll = Date.now()
        if (current.state !== 'open_unacked') return
        if (result.expired === 1) current.pageExpired = true
      })
    } catch (error) { this.lastError = `receipt: ${error.message}` }
  }

  async pollTelegram() {
    let updates
    try { updates = await this.providers.updates(this.options, this.store.state.telegramOffset) }
    catch (error) { this.lastError = `telegram updates: ${error.message}`; return }
    for (const update of updates) {
      const query = update.callback_query
      const message = update.message
      const chat = query?.message?.chat?.id ?? message?.chat?.id
      const user = query?.from?.id ?? message?.from?.id
      const allowed = String(chat) === String(this.options.telegramChatId) &&
        this.options.allowedTelegramUsers.includes(String(user))
      const command = query?.data || message?.text || ''
      let ackError
      if (allowed && (command.startsWith('ack:') || command.startsWith('/ack '))) {
        try { await this.acknowledge(command.slice(command.startsWith('ack:') ? 4 : 5).trim(), `telegram:${user}`) }
        catch (error) { ackError = error; this.lastError = `Signal K ACK: ${error.message}` }
      }
      if (query) await this.providers.telegram(this.options, 'answerCallbackQuery', {
        callback_query_id: query.id, ...(ackError ? { text: `Acknowledgement failed: ${ackError.message}`.slice(0, 200), show_alert: true } : {})
      }).catch(() => {})
      else if (ackError && allowed) await this.providers.telegram(this.options, 'sendMessage', {
        chat_id: this.options.telegramChatId, text: `Acknowledgement failed: ${ackError.message}`.slice(0, 4096)
      }).catch(() => {})
      await this.store.transaction(state => { state.telegramOffset = Math.max(state.telegramOffset, update.update_id + 1) })
    }
  }

  status() {
    const incidents = Object.values(this.store.state.incidents)
    return { running: this.running, mode: this.options.mode, open: incidents.filter(i => i.state !== 'resolved').length,
      unacknowledgedWake: incidents.filter(i => i.state === 'open_unacked' && i.severity === 'wake').length,
      pendingJobs: this.store.state.jobs.length, lastProviderSuccess: this.lastProviderSuccess,
      lastError: this.lastError }
  }
}

function job(type, key, receipt) { return { id: crypto.randomUUID(), type, key, receipt, attempts: 0, nextAt: Date.now() } }
function enqueueJob(state, type, key, receipt) {
  if (!state.jobs.some(item => item.type === type && item.key === key && item.receipt === receipt)) state.jobs.push(job(type, key, receipt))
}
function removeJob(state, id) { state.jobs = state.jobs.filter(item => item.id !== id) }
function keyboard(id) { return { inline_keyboard: [[{ text: 'Acknowledge', callback_data: `ack:${id}` }]] } }
function formatTelegram(incident) {
  const mark = incident.state === 'resolved' ? 'RESOLVED' : incident.state === 'open_acked' ? 'ACKNOWLEDGED' : incident.severity.toUpperCase()
  return `${mark}: ${incident.title}\n${incident.summary}\nIncident ${incident.id}\nSeen ${incident.count} time(s)`.slice(0, 4096)
}
module.exports = { Pager, validate, PRIORITY }
