# Signal K Pager specification

**Status:** Implemented first slice in this directory; phone delivery not yet verified with live credentials.
**Scope:** A Signal K plugin with one authenticated event endpoint, Pushover paging, Telegram context/ACK, and opt-in exact-path Signal K notification routes.

## Behavior

```text
Configured Signal K notifications ─┐
Authenticated event API ────────────┼── Signal K Pager
                                    ├── durable incident/outbox state
                                    ├── Pushover: audible pager transport
                                    └── Telegram: context and restricted ACK
```

Pushover is the wake-up path. Telegram provides a short incident record and an `Acknowledge` button. Neither transport replaces the other. The plugin does not send camera images, Signal K deltas, arbitrary logs, or credentials. It does not make distress calls or treat an unreviewed visual detection as an automatic emergency.

This first version runs **inside Signal K**. If Signal K or its host stops, the plugin stops too. Independent host/Signal K monitoring belongs in a later improvement; it is not a prerequisite for this plugin.

## Intake

`POST /plugins/signalk-pager/v1/events` requires `Authorization: Bearer <configured token>`. The body is JSON with `source`, unique `event_id`, stable `fingerprint`, `status` (`firing`/`resolved`), `severity` (`info`/`warning`/`urgent`/`wake`), `title`, `summary`, and ISO-8601 `observed_at`. Clients retry one observation with the same event ID. Events sharing `source` and `fingerprint` update one incident. A resolving event uses a new event ID and the same fingerprint. The endpoint returns `202` only after persisting the incident and scheduled delivery jobs. It rejects missing credentials, malformed/oversized payloads, and a full queue. The caller cannot choose recipients or Pushover priority parameters directly.

`GET /plugins/signalk-pager/v1/status` uses the same bearer token and returns open incident, unacknowledged wake, and pending job counts plus transport error status. Both routes inherit Signal K's network exposure; use a private network or authenticated tunnel and a long random bearer token.

The optional Signal K adapter subscribes only to exact configured `notifications.*` paths. Each path has an explicit pager severity. A normal or cleared value resolves the incident; an active value fires it. No paths are routed by default. The path, not changing message text, is the fingerprint. The pager must not subscribe to its own status paths.

## Severity and lifecycle

| Severity | Telegram | Pushover |
| --- | --- | --- |
| `info` | Context message | None |
| `warning` | Context message | Priority `0` |
| `urgent` | Context message | Priority `1` |
| `wake` | Context message | Priority `2`, repeating |

For `wake`, configure retry at least 30 seconds and expiry no more than 10,800 seconds. The default is 60 seconds / one hour. Pushover caps emergency retries at 50. Store the emergency receipt. Poll it for Pushover-device acknowledgement; mark the incident `open_acked` while leaving the fault open. A Telegram ACK is accepted only from configured chat and user IDs; it marks the incident acknowledged and calls Pushover's receipt cancellation endpoint. Record that as a Telegram-origin ACK, not a Pushover-device ACK. A trusted `resolved` event closes the incident and cancels any remaining retries. A receipt that expires without ACK leaves the incident open and unacknowledged. An ACK never implies the fault cleared.

One incident has `open_unacked`, `open_acked`, or `resolved` state. Repeated `firing` events update the incident and Telegram message without sending another Pushover wake alert. A rise to `wake` may send one emergency page. Provider sends happen outside the Signal K event callback; pending jobs, incident state, Pushover receipt, Telegram message ID, and Telegram polling offset survive a restart. The local state file is atomically replaced and synchronized to disk. A provider outage is reported, and one transport does not block the other.

## Configuration and operator drill

- Required: 24+ character event API token; Pushover application token and user/group key.
- Optional: dedicated Telegram bot token, chat ID, and numeric user IDs allowed to ACK. Use a dedicated bot so another integration does not consume its updates.
- Optional: exact-path Signal K notification rules. Review every `wake` rule; never map all Signal K alarms to emergency priority by default.
- Phone setup: enable iOS Critical Alerts for Pushover in both iOS and the app, or configure Android DND exception. Provider priority `2` alone does not guarantee DND bypass.

Before relying on the pager, send a controlled test event, observe the phone under mute/Focus, wait for one repeat, acknowledge it, and verify retries stop. Send a separate resolved event and verify the Telegram incident closes. Test with the actual Pushover destination and Telegram chat; mocks cannot prove a phone wakes a person.

## Current limits and later improvements

The first implementation has a bounded JSON state store and one shared intake token. It intentionally rejects new events when the state store fills instead of deleting incidents silently. Before sustained high-volume use, add archive/pruning, per-source credentials and rate limits, richer delivery reconciliation after an ambiguous provider timeout, and a setup/test UI. It uses Telegram outbound polling, so no public bot webhook is required.

**Later improvement:** Run a separate monitor/receiver outside Signal K if paging on Signal K or host failure becomes important. That component can reuse the event contract, monitor a heartbeat, and remain alive when Signal K is down. It is deliberately outside this release.

## Acceptance checks

1. Idempotent retries, repeated firing, resolution, restart recovery, priority-2 receipt, ACK cancellation, and Telegram user allowlisting pass automated tests.
2. Unauthorized or malformed intake does not schedule a transport job. A full queue reports a failure rather than a false success.
3. Provider failures remain visible; the plugin starts disabled until configured and does not leak tokens in logs/status.
4. A real-device drill verifies DND/mute behavior, repeat, ACK, and clear before operational use.

## Provider references

- [Pushover Message API](https://pushover.net/api) and [Receipts API](https://pushover.net/api/receipts).
- [Pushover iOS Critical Alerts](https://blog.pushover.net/posts/2020/2/ios-critical-alerts).
- [Telegram Bot API](https://core.telegram.org/bots/api).
