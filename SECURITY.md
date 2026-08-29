# Security policy — plain language, honest caveats

This app holds one person's private data (work projects and a personal
journal). Everything below is written for that person, not for auditors.

**Rule:** exactly one email — `keremladkeholland@gmail.com` — can read or
write anything. Enforced **on the server** (Convex functions), not in the
browser, so editing the page can't bypass it.

## Layer 1 — Sign-in (email + code)

Sign-in = enter the email, receive a 6-digit code (sent via Resend), type
it in. On the server: only the admin email may request a code; codes are
stored **hashed**, expire after 10 minutes, allow 5 wrong tries, 30 seconds
between sends, 15 sends per day. A successful code creates a **session
token** (256-bit random) kept in this browser's localStorage; sessions
expire after ~6 months and at most 10 exist at once.

**Honest limitation:** whoever controls that email inbox controls sign-in.
The inbox is the root of trust — keep the Google account that hosts it
locked down (strong password + 2-Step Verification).

## Layer 2 — Device trust

Every browser gets a random 256-bit device id. The first device is trusted
automatically; every later one starts **pending** and must be approved from
an already-trusted device (Security → Devices). This is server-enforced:

- Data functions (workspace, snapshots, security log) answer **only** a
  valid session on a **trusted** device.
- A pending device cannot approve itself, cannot see other devices, and
  cannot read any data — verified by tests including the negative cases.
- "Sign out all other devices" revokes the devices AND deletes their
  sessions.

**Honest limitation:** the session token and device id both live in the
browser. Malware with full access to a trusted device's browser profile
can act as that device. Device trust protects against *new* devices, not
against a compromised trusted one.

## Layer 3 — Transport & page integrity

- All traffic to Convex is TLS-encrypted; data is stored in Convex's
  managed infrastructure.
- A strict Content-Security-Policy allows connections only to
  `*.convex.cloud` (+ the SDK CDNs, Google Fonts, and localhost for local
  testing). Injected HTML can't call anywhere else.
- Rich-text input is sanitized against a fixed tag whitelist on every save.
- **No secrets in the page.** The Convex deployment URL is public by
  design (all authorization happens server-side). The Resend API key lives
  only in Convex environment variables, never in the repo or the page.

## Layer 4 — Data safety (losing data is also a security failure)

Six independent layers guard against loss — untouched-seed guard, shrink
guards, IndexedDB mirror, weekday backups, 30 cloud snapshots, bad-remote
quarantine — plus a truthful "Synced" indicator that only shows green after
the server acknowledges the write. Full detail: FEATURES.md §1; all of it
is covered by `tests/e2e-sync.mjs`.

## Audit trail

Sign-ins, device events, restores, and large-deletion alerts are written to
an append-only security log (Security → Activity log, newest 30 shown).

## What this is NOT hardened against

- A compromised inbox (Layer 1 caveat) or a compromised trusted device
  (Layer 2 caveat).
- Availability: the app depends on GitHub Pages and Convex being up. The
  local copy keeps working offline; edits sync when the connection is back.
- A malicious change committed to this repo would ship to the live site —
  the repo itself is part of the trust boundary.
