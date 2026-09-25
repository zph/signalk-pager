'use strict'
const crypto = require('node:crypto')
const Store = require('./store')
const defaultProviders = require('./providers')

const PRIORITY = { info: null, warning: 0, urgent: 1, wake: 2 }
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
  constructor(directory, options, providers = defaultProviders) {
    this.store = new Store(directory)
    this.options = options
    this.providers = providers
    this.running = false
    this.processing = false
    this.lastError = null
    this.lastProviderSuccess = null
  }

  async submit(input) {
    const event = validate(input)
    if (event.severity === 'info' && !(this.options.telegramToken && this.options.telegramChatId)) throw new Error('Info events require Telegram')
    return this.store.transaction(state => {
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
            receipt: null, telegramMessageId: null, pageExpired: false }
          state.incidents[key] = incident
          if (event.severity !== 'info') enqueueJob(state, 'pushover-send', key)
          if (this.options.telegramToken && this.options.telegramChatId) enqueueJob(state, 'telegram-sync', key)
        } else {
          incident.count++
          incident.observed_at = event.observed_at
          incident.updated_at = now
          incident.title = event.title
          incident.summary = event.summary
          if (PRIORITY[event.severity] > PRIORITY[incident.severity]) {
            incident.severity = event.severity
            if (event.severity === 'wake' && !incident.receipt && incident.state === 'open_unacked') enqueueJob(state, 'pushover-send', key)
          }
          if (this.options.telegramToken && this.options.telegramChatId) enqueueJob(state, 'telegram-sync', key)
        }
      } else if (incident && incident.state !== 'resolved') {
        incident.state = 'resolved'
        incident.observed_at = event.observed_at
        incident.updated_at = now
        incident.resolved_at = now
        if (incident.receipt) enqueueJob(state, 'pushover-cancel', key, incident.receipt)
        if (this.options.telegramToken && this.options.telegramChatId) enqueueJob(state, 'telegram-sync', key)
      }
      state.events[eventKey] = incident?.id || 'no-open-incident'
      return { id: state.events[eventKey], state: incident?.state || 'no-open-incident' }
    })
  }

  async acknowledge(id, by) {
    return this.store.transaction(state => {
      const incident = Object.values(state.incidents).find(item => item.id === id)
      if (!incident) throw new Error('Incident not found')
      if (incident.state !== 'open_unacked') return { id, state: incident.state }
      incident.state = 'open_acked'
      incident.acknowledged_by = clean(by, 100)
      incident.acknowledged_at = new Date().toISOString()
      incident.updated_at = incident.acknowledged_at
      if (incident.receipt) enqueueJob(state, 'pushover-cancel', incident.key, incident.receipt)
      if (this.options.telegramToken && this.options.telegramChatId) enqueueJob(state, 'telegram-sync', incident.key)
      return { id, state: incident.state }
    })
  }

  start() {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => this.tick().catch(error => { this.lastError = error.message }), 10000)
    this.tick().catch(error => { this.lastError = error.message })
  }

  stop() { this.running = false; clearInterval(this.timer) }

  async tick() {
    if (!this.running || this.processing) return
    this.processing = true
    try {
      const due = this.store.state.jobs.find(item => item.nextAt <= Date.now())
      if (due) await this.processJob(due)
      await this.pollReceipts()
      if (this.options.telegramToken && this.options.telegramChatId) await this.pollTelegram()
    } finally { this.processing = false }
  }

  async processJob(item) {
    const incident = this.store.state.incidents[item.key]
    if (!incident) return this.finishJob(item.id)
    try {
      let result
      if (item.type === 'pushover-send') {
        if (incident.state !== 'open_unacked' || incident.receipt || incident.severity === 'info') return this.finishJob(item.id)
        const priority = PRIORITY[incident.severity]
        const fields = { title: incident.title, message: `${incident.summary}\nIncident ${incident.id}`.slice(0, 1024), priority }
        if (priority === 2) Object.assign(fields, { retry: this.options.retrySeconds || 60, expire: this.options.expireSeconds || 3600 })
        result = await this.providers.pushover(this.options, fields)
        if (priority === 2 && !result.receipt) throw new Error('Pushover did not return emergency receipt')
        await this.store.transaction(state => {
          const current = state.incidents[item.key]
          if (priority === 2 && result.receipt) {
            current.receipt = result.receipt
            current.lastReceiptPoll = 0
            if (current.state !== 'open_unacked') enqueueJob(state, 'pushover-cancel', item.key, result.receipt)
          }
          removeJob(state, item.id)
        })
      } else if (item.type === 'pushover-cancel') {
        await this.providers.cancel(this.options, item.receipt)
        await this.finishJob(item.id)
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
      await this.store.transaction(state => {
        const current = state.incidents[incident.key]
        current.lastReceiptPoll = Date.now()
        if (current.state !== 'open_unacked') return
        if (result.acknowledged === 1) {
          current.state = 'open_acked'
          current.acknowledged_at = new Date(result.acknowledged_at * 1000).toISOString()
          current.acknowledged_by = 'pushover'
          if (this.options.telegramToken && this.options.telegramChatId) enqueueJob(state, 'telegram-sync', incident.key)
        } else if (result.expired === 1) current.pageExpired = true
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
      if (allowed && command.startsWith('ack:')) {
        try { await this.acknowledge(command.slice(4).trim(), `telegram:${user}`) } catch (_) {}
      } else if (allowed && command.startsWith('/ack ')) {
        try { await this.acknowledge(command.slice(5).trim(), `telegram:${user}`) } catch (_) {}
      }
      if (query) await this.providers.telegram(this.options, 'answerCallbackQuery', { callback_query_id: query.id }).catch(() => {})
      await this.store.transaction(state => { state.telegramOffset = Math.max(state.telegramOffset, update.update_id + 1) })
    }
  }

  status() {
    const incidents = Object.values(this.store.state.incidents)
    return { running: this.running, open: incidents.filter(i => i.state !== 'resolved').length,
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
