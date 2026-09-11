# Security Policy

daybook stores highly private data (a personal journal), so security reports are
welcome and will be taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- **Preferred:** use GitHub's private vulnerability reporting — open the
  **Security** tab of this repository and click **"Report a vulnerability"**.
  Nothing else is needed: no email, no public trace.
- If that option is not available, open a *minimal* public issue saying only that
  you would like a private channel, and wait for a reply. Do not include details.

Please include:

- the affected version/tag (for example `v0.1.2`) and how you deployed it
  (image tag, Compose, reverse proxy, browser or APK);
- a minimal reproduction or proof of concept;
- what you think the impact is (who can read or modify what).

Please **redact** journal text, access/refresh tokens, push-subscription endpoints
and any other personal data.

## What to expect

- Acknowledgement within about **7 days** — this is a personal project with no SLA.
- A fix, or a documented mitigation if the issue is a design trade-off, released
  as a new patch tag. You will be credited in the release notes unless you ask to
  stay anonymous.
- No bug bounty: there is no money behind this project.

## Supported versions

Only the **latest released tag** is supported and patched — currently `v0.1.2`.
Older tags are not maintained; upgrade to get fixes.

## Known design decisions (not vulnerabilities)

These are deliberate, documented trade-offs. Reports that simply restate them are
not security issues — but if you find a way to *break* one of these guarantees,
that is very much a vulnerability:

- **Registration is intentionally disabled.** Accounts are created by the operator
  through a CLI on the server. There is no sign-up surface to abuse.
- **No per-user encryption at rest.** The database is readable by whoever controls
  the host; if you need protection against a compromised host, use full-disk or
  volume encryption (see the deployment docs).
- **Reminders are best-effort.** Web Push delivery time is decided by the browser
  and the OS — the app promises "same day", not an exact minute.
- **No per-user rate limit on read endpoints** beyond ordinary login protection;
  the login limiter keys on username and real client IP behind a trusted proxy.
- **The Android APK is sideload-only by design.** There is no Play Store listing;
  signing keys and their storage are the operator's responsibility.
- **`.env` and backup dumps are excluded from the image and from git**, and hold
  secrets (database password, `JWT_SECRET`, VAPID private key). Protecting them is
  the operator's job.

If you are unsure whether something is a design trade-off or a bug, report it
privately anyway — that is always the safe choice.
