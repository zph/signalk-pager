'use strict'

async function jsonPost(url, body, timeoutMs = 10000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.status === 0 || data.ok === false) {
    const error = new Error(data.description === 'Bad Request: message is not modified'
      ? 'message is not modified' : `Provider HTTP ${response.status}`)
    error.retryAfter = Number(response.headers.get('retry-after')) || 0
    throw error
  }
  return data
}

function pushover(options, fields) {
  return jsonPost('https://api.pushover.net/1/messages.json', {
    token: options.pushoverToken, user: options.pushoverUser, ...fields
  })
}
function receipt(options, id) {
  return fetch(`https://api.pushover.net/1/receipts/${encodeURIComponent(id)}.json?token=${encodeURIComponent(options.pushoverToken)}`, {
    signal: AbortSignal.timeout(10000)
  }).then(async response => {
    const data = await response.json()
    if (!response.ok || data.status !== 1) throw new Error(`Receipt HTTP ${response.status}`)
    return data
  })
}
function cancel(options, id) {
  return jsonPost(`https://api.pushover.net/1/receipts/${encodeURIComponent(id)}/cancel.json`, {
    token: options.pushoverToken
  })
}
function telegram(options, method, fields) {
  return jsonPost(`https://api.telegram.org/bot${options.telegramToken}/${method}`, fields, 15000)
}
async function updates(options, offset) {
  const response = await telegram(options, 'getUpdates', {
    offset, timeout: 0, allowed_updates: ['message', 'callback_query']
  })
  return response.result || []
}
module.exports = { pushover, receipt, cancel, telegram, updates }
