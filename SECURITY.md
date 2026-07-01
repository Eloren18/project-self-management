# Security Policy — Project Self-Management

This app holds private work information. Its security is built in layers, the
same way major platforms do it: a hard, server-enforced identity boundary, plus
a device-trust layer for defense-in-depth, plus transport and content hardening.

This document is deliberately honest about **what is a hard guarantee vs. what
is a strong-but-not-absolute safeguard**, so there are no surprises.

---

## 1. Who can get in — Identity (HARD, server-enforced)

**Rule:** exactly one Google account — `keremladkeholland@gmail.com` — can read
or write any data. Everyone else gets nothing.

**How it's enforced:** sign-in uses **Google OAuth**. Google verifies the
account and issues a signed token; **InstantDB verifies that token on its
servers** and records the verified email. Every permission rule
(`instant.perms.ts`) then requires:

```
'keremladkeholland@gmail.com' in auth.ref('$user.email')   AND   the row is owned by this user
```

Because this check runs **on the server**, it cannot be bypassed by editing
the page, using the browser console, or calling the API directly. If any other
Google account signs in, every read and every write returns **empty / denied**.

This is the real security boundary, and it is genuinely at "major-platform"
standard: verified federated identity + server-side authorization on every
operation.

---

## 2. Which devices can get in — Device Trust (defense-in-depth)

Even with the right account, a device must be **trusted** before the app opens.

**Policy:**
- Every browser gets a unique **256-bit random device ID** (Web Crypto), stored
  locally. Devices are registered server-side (`devices` table), owned by you.
- **First device ever → automatically trusted** (trust-on-first-use). This
  bootstraps the system so you're never locked out.
- **Every later new device → "pending".** It signs in but is held on an
  "Approval needed" screen. An **already-trusted device** must explicitly
  **Approve** it (shield icon → Awaiting approval). This is the same pattern
  Apple/Signal/WhatsApp use for adding a device.
- **Revoke any time.** From the Security panel you can revoke a device or
  "Sign out all other devices." A revoked device is blocked and, while it's
  online, is signed out within seconds (it watches its own status live).
- **Audit log.** Sign-ins, device requests, approvals, revocations, and
  "sign out others" are recorded in an append-only `securityLog` (update/delete
  are disabled by permission rules).

**Honest limitation (important):** because InstantDB authorizes by *account*,
not by *device*, the pending/approval gate is enforced in the **app code**, not
on the server. Meaning: an attacker who has BOTH (a) full control of your Google
account AND (b) the skill to bypass the app's UI could, in theory, reach data
from an unapproved device. Device-trust therefore raises the bar and gives you
visibility + a kill switch — it is **not** an independent server-side wall on
its own. The independent server-side wall is Layer 1 (the account lock).
If you want device-trust to become a *hard* server-side guarantee too, see
"Optional upgrade: end-to-end encryption" below.

**Practical takeaway:** keep your Google account secure (strong password +
Google 2-Step Verification). That is the lock that Layer 1 depends on, and it's
the single most important thing you can do.

---

## 3. Transport & content hardening

- **HTTPS everywhere.** Hosted on HTTPS (GitHub Pages); all API/websocket
  traffic to InstantDB is TLS-encrypted in transit.
- **Content-Security-Policy (CSP).** A strict allow-list in `index.html` means
  the browser will only run code, load styles/fonts, or open connections to a
  short list of known origins (InstantDB, the SDK CDNs, Google Fonts, and
  Google Sign-In). If a CDN were compromised or malicious HTML were injected,
  the browser blocks it. `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'` close common injection vectors.
- **Referrer policy** is set to `strict-origin-when-cross-origin`.
- **No secrets in the page.** The InstantDB App ID and Google Client ID are
  *public client identifiers* by design (safe to expose). The Google Client
  *secret* lives only in the InstantDB dashboard, never in the page.
- **Least-privilege data rules.** `workspaces` can't be deleted via the API
  (`delete: false`); `securityLog` is append-only. This limits blast radius.

**Not achievable on static hosting:** true HTTP security *headers* (HSTS,
X-Frame-Options as headers) require a server/CDN in front (e.g. Cloudflare).
The `<meta>` CSP is the strong subset that works on GitHub Pages. Adding
Cloudflare later would let you set the full header set — a nice-to-have, not a
gap in the core boundary.

---

## 4. Data ownership & loss

- Your data is one JSON document per account, synced last-write-wins by
  timestamp across your trusted devices, and cached locally so the app works
  offline.
- **There is no third party who can read it** other than InstantDB's
  infrastructure (which stores it to provide sync), and only your account can
  fetch it.
- **Backup:** because sync is last-write-wins, an accidental bad edit
  propagates. If that ever worries you, we can add an "Export JSON" button for
  manual snapshots (recommended if this becomes mission-critical).

---

## 5. Optional upgrade — end-to-end encryption (makes device-trust HARD)

If you want the strongest possible model (and to close the Layer-2 caveat
above), we can add **client-side end-to-end encryption**:

- The workspace JSON is encrypted **in your browser** before it's sent, so
  InstantDB only ever stores ciphertext it cannot read.
- The decryption key lives **only on trusted devices**. A new device receives
  the key **only when an existing trusted device approves it** — so a pending
  or unapproved device (even the attacker's) downloads nothing but unreadable
  ciphertext. That turns device-approval into a real cryptographic wall.
- You'd get a one-time **recovery phrase** to write down.

**The trade-off (why it's opt-in):** if you lose every trusted device AND the
recovery phrase, the data is **unrecoverable by anyone, including you** — that's
the point of E2E encryption, but it's a real data-loss risk for a single user.
For work-project tracking (not passwords/financial data), Layers 1–3 are already
strong. Say the word and I'll add E2E encryption + recovery phrase.

---

## Summary

| Layer | Protects against | Strength |
|------|------------------|----------|
| Google account lock (server rules) | Anyone who isn't you | **Hard** (server-enforced) |
| Device trust + approval + revoke | Unknown devices; lost/stolen device | Strong (app-enforced; visibility + kill switch) |
| HTTPS + CSP + referrer policy | Eavesdropping; injected/compromised code | Hard (browser-enforced) |
| Least-privilege data rules | Accidental/mass deletion | Hard (server-enforced) |
| E2E encryption *(optional)* | Even a compromised account on a new device | Hard (cryptographic) — opt-in |

The one thing only *you* can do: protect the Google account itself with a
strong password and 2-Step Verification. Everything else is built in.
