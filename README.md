# Signal K Pager

Pushover carries urgent and repeating wake alerts. Telegram carries incident context and an optional restricted acknowledgement button. The plugin also accepts events from other sources through an authenticated route.

This first version runs **inside Signal K**. It cannot report a Signal K or host outage by itself. An independent external monitor is described in [SPEC.md](SPEC.md) as a later improvement.

## Install and configure

Install or sideload this directory as a Signal K plugin, then enable **Pager** in the Signal K plugin configuration. Set:

- A random event API bearer token of at least 24 characters.
- Pushover application token and user/group key.
- Optionally, Telegram bot token, chat ID, and comma-separated numeric user IDs allowed to acknowledge.
- Optionally, exact Signal K `notifications.*` paths and their pager severities. No Signal K path is routed by default.

The plugin is disabled by default and sends no alert until configured and enabled. State is written to Signal K's plugin data directory. Keep that directory persistent and private. No image, log, or arbitrary command is sent by this plugin.

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

Use a **new** `event_id` for each observation, and reuse the same `fingerprint` for repeated observations and the eventual `resolved` event. Retrying the same event ID is idempotent. Severities are `info` (Telegram only), `warning` (Pushover 0), `urgent` (Pushover 1), and `wake` (Pushover 2, repeating). Pushover priority 2 uses the configured retry and expiry; a Telegram ACK cancels its retries. A `resolved` event cancels retries and closes the incident. ACK alone does not resolve it.

`GET /plugins/signalk-pager/v1/status` uses the same bearer token and reports counts and transport health without credentials or incident details.

Pushover iPhone Critical Alerts and Android DND exceptions must be enabled on the phone. Test a real `wake` event while the phone is muted/under Focus before depending on it.

## Current limits

- The event API inherits Signal K's network exposure. Bind Signal K to a private network or tunnel and guard the bearer token; do not expose this route publicly by default.
- The plugin does not monitor its own host or Signal K process. A standalone receiver or external monitor is a later improvement.
- Provider timeouts can leave delivery uncertain. The status endpoint reports errors; inspect the provider apps before manually replaying an uncertain event.
- State has fixed bounds. When full, the API rejects new events instead of silently dropping them; archive/pruning is a later improvement.
