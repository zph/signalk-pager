# Security policy

## Supported versions

Security fixes are made on the latest release and the `main` branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not include bearer tokens, provider credentials, chat IDs, notification contents, or other operational data in a public issue.

If private vulnerability reporting is unavailable, open a public issue containing no sensitive details and ask the maintainer for a private contact channel.

## Operational scope

Signal K Pager is an alert-delivery aid, not a distress system or a substitute for vessel alarms, watchkeeping, or emergency equipment. Keep its event endpoint on a private network or authenticated tunnel, use a unique random bearer token, and complete a real-device alert drill before relying on it.
