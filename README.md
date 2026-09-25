# Signal K Pager

Pushover carries urgent and repeating wake alerts once explicitly activated. Telegram carries incident context and an optional restricted acknowledgement button. The plugin also accepts events from other sources through an authenticated route.

This first version runs **inside Signal K**. It cannot report a Signal K or host outage by itself. An independent external monitor is described in [SPEC.md](SPEC.md) as a later improvement.

## Install and configure

Install or sideload this directory as a Signal K plugin, then enable **Pager** in the Signal K plugin configuration. Set:

- A random event API bearer token of at least 24 characters.
- For the bake-in period, a Telegram bot token, chat ID, and comma-separated numeric user IDs allowed to acknowledge.
- Before activation, a Pushover application token and user/group key.
- Optionally, exact Signal K `notifications.*` paths and their pager severities. No Signal K path is routed by default.

For a configured Signal K notification path, a server-side acknowledgement (including Binnacle's generic **Acknowledge** action) acknowledges the matching pager incident and cancels any Pushover emergency retries. A server clear/normal value resolves it. Binnacle's **Silence**, **Mute here**, and device-local collision/MOB/anchor acknowledgements are not pager acknowledgements. Telegram or Pushover acknowledgement currently updates the pager incident only; it does not write acknowledgement back to Signal K or Binnacle.

The plugin is disabled by default. Once enabled, its operating mode defaults to **shadow**: it posts incident context to Telegram and writes a Signal K log entry showing the Pushover priority, retry interval, and expiry it would have used. It does not create Pushover pages. Set **Operating mode** to **active** explicitly to enable Pushover delivery. Existing shadow incidents are not paged simply by changing modes; a new firing observation is required. Returning to shadow cancels any outstanding Pushover emergency retries from active mode. State is written to Signal K's plugin data directory. Keep that directory persistent and private. No image, arbitrary log, or command is sent by this plugin.

## Event API

`POST /plugins/signalk-pager/v1/events` with `Authorization: Bearer <event API token>` and JSON:

```json
{
  "source": "boat-script",
  "event_id": "unique-event-001",
  "fingerprint": "bilge-pump-running-too-long",
  "status": "firing",
  "severity": "wake",
  "title": "Bilge pump running too long",
  "summary": "Port pump has run for 10 minutes",
  "observed_at": "2026-09-24T18:00:00Z"
}
```

Use a **new** `event_id` for each observation, and reuse the same `fingerprint` for repeated observations and the eventual `resolved` event. Retrying the same event ID is idempotent. In active mode, severities are `info` (Telegram only), `warning` (Pushover 0), `urgent` (Pushover 1), and `wake` (Pushover 2, repeating). In shadow mode, all severities go only to Telegram; the Pushover action is logged as a dry run. Pushover priority 2 uses the configured retry and expiry; a Telegram ACK cancels its retries. A `resolved` event cancels retries and closes the incident. ACK alone does not resolve it.

`GET /plugins/signalk-pager/v1/status` uses the same bearer token and reports counts and transport health without credentials or incident details.

Pushover iPhone Critical Alerts and Android DND exceptions must be enabled on the phone. Test a real `wake` event while the phone is muted/under Focus before depending on it.

## Current limits

- The event API inherits Signal K's network exposure. Bind Signal K to a private network or tunnel and guard the bearer token; do not expose this route publicly by default.
- The plugin does not monitor its own host or Signal K process. A standalone receiver or external monitor is a later improvement.
- Provider timeouts can leave delivery uncertain. The status endpoint reports errors; inspect the provider apps before manually replaying an uncertain event.
- State has fixed bounds. When full, the API rejects new events instead of silently dropping them; archive/pruning is a later improvement.
