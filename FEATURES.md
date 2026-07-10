# FEATURES.md — Complete feature inventory & full-check protocol

This is the canonical list of everything the app does. When a **"full website
check"** is requested, walk this document top to bottom: run the automated
suite first, then the preview walkthrough, then the signed-in-only checks.
A feature is "passing" only when its listed behaviors all work.

> ⚠ Items marked **[ALWAYS CHECK]** have bitten us before — never skip them.

---

## 0. Full-check protocol (in this order)

1. **Automated suite** — `node tests/e2e-sync.mjs` → must end `✅ all N checks passed`.
   Covers the whole sync/data-safety system (scenarios S0–S15) plus the
   schema/perms consistency sweep (S16). See `tests/README.md`.
2. **Preview walkthrough** — start the preview server (launch.json
   `self-management`, port 8742), run `window.__psmPreview()` in the console
   to bypass the auth gate, then walk sections 2–7 below. Zero console errors
   allowed. **Afterwards always delete test data**: every `psmData_v1*`
   localStorage key + the `psm_mirror` IndexedDB database.
3. **Signed-in checks** — section 8. These touch the real cloud and Google
   auth, so only Kerem can do them on production.
4. **Deploy verification** — after any push: GitHub Actions must go green,
   then fetch the live `index.html` and grep for a marker unique to the change.

---

## 1. Sync & data safety — THE MOST IMPORTANT SYSTEM

One JSON blob holds **work + personal**. Sync is whole-blob **last-write-wins**
on `data.updatedAt` via InstantDB (`workspaces` row, owner-linked).

| # | Behavior | Verified by |
|---|----------|-------------|
| 1.1 | **A fresh device seeds at `updatedAt: 0`** and can NEVER outrank/overwrite the cloud — it must adopt it. **[ALWAYS CHECK]** (the Jul 2026 phone-login data loss) | S0, S1, S1b |
| 1.2 | Every save bumps a **monotonic clock**: `updatedAt = max(now, prev+1)` — a backwards/frozen device clock can't win a sync race | S2, S9 |
| 1.3 | Two devices **converge**: each adopts the other's newer copy; edits from both survive sequential syncs | S2 |
| 1.4 | A returning **stale device adopts** the newer cloud copy and never clobbers it | S8 |
| 1.5 | **Offline edits** push to the cloud on reconnect (`online` event) | S7 + code |
| 1.6 | **Concurrent edits** (two devices, one offline): higher `updatedAt` wins the whole blob — deterministic, no crash. Known limitation: the loser's concurrent edit is dropped → mitigated by the truthful sync pill (1.13) | S7 |
| 1.7 | **Per-namespace shrink guards**: any save/adopt/reconnect-push that would lose >75% of work OR personal content first stashes the bigger copy (`_prewipe_`/`_lost_`) + warns. Normal small edits never trip it | S3, S11 |
| 1.8 | **Bad-remote quarantine**: a copy that fails `normalize()` is stashed as `_badremote_` and NEVER adopted | S6 |
| 1.9 | **Personal isolation**: a corrupt `data.personal` can't take down work data (isolated normalize try/catch), and raw personal data is preserved, not dropped | S6 |
| 1.10 | **IndexedDB mirror** (`psm_mirror` DB): written on every save; on boot, if newer than localStorage (e.g. after a site-data clear), it auto-restores and rewrites localStorage + toasts | S5 |
| 1.11 | **Weekday backups**: `psmData_v1_bak_0..6`, one rolling slot per weekday, refreshed when >1h stale | code + restore-points list |
| 1.12 | **Cloud snapshot history**: full-workspace copies in the `snapshots` collection every 4h of activity (keep 30, prune oldest); manual "⛅ Snapshot to cloud now" button; never snapshots an untouched seed; **fails soft** if the cloud rejects it | S15 + signed-in 8.3 |
| 1.13 | **Truthful sync pill** (topbar): `Synced` (green) ONLY after the cloud acknowledges our exact `updatedAt` (transact promise + subscription echo — never a blind timer); `Saving…` (blue, pulsing) while in flight; `Not synced · offline / retrying` (**prominent red** + "could be lost" tooltip) when offline or the push failed; `Local only` when signed out. **[ALWAYS CHECK]** | S14 + signed-in 8.4 |
| 1.14 | **Cross-tab**: a sibling tab's newer save is adopted live via the `storage` event; older/garbage payloads are ignored | S10, S11 |
| 1.15 | **Quota pressure**: when localStorage is full, stashes prune to 1 per family and retry; if the main write still fails the user is warned AND the cloud push still happens — nothing silently lost | S13 |
| 1.16 | **Rescue on corrupt local**: unparseable localStorage is stashed as `_rescue_<ts>` and the app boots a NON-authoritative seed (`updatedAt 0` → cloud wins) | code (`load()`) |
| 1.17 | `normalize()` is **idempotent** — sync round-trips never drift/duplicate items | S12 |
| 1.18 | **Restore is authoritative**: `restoreData()` stashes `_prerestore_`, takes a cloud snapshot of the replaced state, stamps a fresh `updatedAt`, syncs everywhere, logs `data_restored`, and never false-fires the shrink guard | S4 |
| 1.19 | `navigator.storage.persist()` requested at boot (anti-eviction) | code |
| 1.20 | **Backup-download reminder** if no file download in ≥14 days (once per session) | code |

---

## 2. Auth, devices & the Security modal

| # | Behavior |
|---|----------|
| 2.1 | Sign-in gate: Google Sign-In only, locked to the single `ADMIN_EMAIL`; any other Google account is denied (client UI + **server-side rules**) |
| 2.2 | Unconfigured/local mode: "Continue without sync" → `Local only` pill, everything works locally |
| 2.3 | Device trust: first device bootstraps as trusted; every new browser/device becomes **pending** and must be approved from an already-trusted device; pending devices see a waiting screen |
| 2.4 | **The Security modal opens from BOTH the 🛡 shield button AND the account/email button** (they share `openSec`). **[ALWAYS CHECK — signed in!]** Regression: a schema error in the cloud-snapshots query once killed `openSec` for signed-in users only — both buttons appeared dead (fixed + hardened: `openSec` try/catches its renderers, `queryOnceSafe` can never throw; guarded by S15/S16) |
| 2.5 | Security modal contents: authorized email; pending devices (Approve/Reject); trusted devices with "This device" badge + last-active + Revoke; **Sign out all other devices**; **Sign out this device** |
| 2.6 | 🔴 `secDot` on the shield button when a device awaits approval |
| 2.7 | **Security log**: append-only, newest 30 (sign-ins, device events, `data_restored`, `data_shrunk`) with friendly labels |
| 2.8 | **Backups**: ⤓ Download full backup (one JSON = work + personal, records `_lastdl`); ⤒ Restore from backup file (styled confirm shows the backup's exact counts first); ⛅ Snapshot to cloud now |
| 2.9 | **Restore points list**: merges 💾 weekday backups + 🛟 all stash families + ⛅ cloud snapshots, sorted newest-first, each with timestamp/label/counts and a one-click **Restore** (goes through the same guarded `restoreData` path) |
| 2.10 | InstantDB entities are locked to owner+admin by server rules — `workspaces`, `devices`, `securityLog` (append-only), `snapshots` (immutable, owner-prunable). **All four schema/perms layers must list every entity**: index.html inline schema, `instant.schema.ts`, `instant.perms.ts`, SETUP.txt dashboard JSON (S16 enforces) |

---

## 3. Shared chrome (topbar, sidebar, global UI)

| # | Behavior |
|---|----------|
| 3.1 | Sidebar: PSM logo, **Workspace** nav (9 work tabs), **Personal Life** nav (9 personal tabs — shown in personal mode), identity footer |
| 3.2 | Topbar: view title, week pill (`W##`), **sync pill** (see 1.13), Excel export, **💼 Work ⇄ 🌞 Personal switch** (restyles the whole app via `data-mode`), theme toggle (sun/moon, persists in settings), shield button, account button (avatar + email) |
| 3.3 | **Export to Excel**: builds `self-management-<date>.xlsx` (Projects + Tasks sheets) via SheetJS loaded from CDN with fallbacks; failure = toast, never a crash |
| 3.4 | **No native dialogs anywhere** — every confirm/prompt is the styled in-app `uiConfirm`/`uiPrompt` (Promise-based modal). **[ALWAYS CHECK when adding flows]** |
| 3.5 | Toasts (bottom, auto-hide) for every notable action; warning toasts for safety events |
| 3.6 | Theming: light/dark via `html[data-theme]` CSS variables; personal mode has its own warm palette via `data-mode="personal"`; **dark mode must look right in both platforms** |

---

## 4. Work platform — 9 tabs

### 4.1 Projects (default tab)
- KPI tiles: Active projects (+completed count), Due this week (projects+tasks), Overdue (needs attention), Tasks done (x/y open).
- **Board view**: projects grouped by progress (Not Started / In Progress / On Hold / Done), colored left borders (custom color or priority fallback), title, **category label with colored dot** (blue = Planned Research / Evaluation, purple = Long-term Business Case, orange = Ad Hoc Request) **[ALWAYS CHECK — regression: cards once rendered without categories]**, deadline flag with overdue state, done cards fade + grayscale.
- **List view**: sortable table — done check, name, **Category**, Progress, Priority, Deadline, Stakeholders.
- Search box, priority filter, category filter, **+ New project**.
- Click a card/row → full **project page**: editable name, description, **category select (never silently empty — `normalize` coerces "" to the first option)**, progress, priority, deadline (date or week-type), color swatches + custom color, involved/informed stakeholders, value proposition, doc link, notes, **meeting-notes log** (dated entries), **tasks** (add / inline edit / done / deadline / notes post-it / delete), complete ⇄ reopen, delete (styled confirm).

### 4.2 To-Do
- **Quick-add bar**: text (Enter adds), project selector (or Ad-hoc), deadline picker (calendar + quick options incl. `+3 business days`, week-type deadlines).
- Sections: **⚠ Overdue** (tasks AND overdue projects — project rows show 🚩 name + `Project` chip + **category chip** + reschedulable deadline chip + complete-check), **Today**, **This week**, **Upcoming**, **No date**, **Completed** (toggle; includes completed projects with restore).
- Task rows everywhere: done check, inline text edit, project tag (click = jump to project/meeting), deadline chip picker (`· overdue` state), 🗒 notes post-it, delete. Search filters tasks + notes + project names.

### 4.3 Meetings
- Recurring meetings: name, cadence, attendees. Meeting page: dated **entries** (agenda + notes), **action items** (tasks that flow into To-Do/Calendar tinted with the meeting accent), delete with confirm.

### 4.4 Calendar — month grid; shows project deadlines, task deadlines, meetings; month navigation; overdue tint; click-through to items.

### 4.5 Year Plan — 12-month overview of all project deadlines/progress for long-range planning.

### 4.6 Week Prep — per-week preparation: notes + check-off item list, week navigation.

### 4.7 Documents — rich-text documents (title + formatted body), create/edit/delete.

### 4.8 Glossary
- Terms with definition, **source** (Jumbo = yellow, NIQ = blue, AH Data = teal, custom sources get stable palette colors), optional category grouping with collapsible headers and per-category ordering, add/edit/delete. **[ALWAYS CHECK after sync work — glossary was lost in the Jul 2026 incident]**

### 4.9 Archive
- Completed projects and tasks with completion dates; search; **restore** anything back to active (round-trips cleanly).

---

## 5. Personal Life platform — 9 tabs

### 5.1 Overview (hub) — day flags, overdue people, missed for-me items this week, stats, jump-offs into the other tabs.
### 5.2 Today
- Day plan **entries** (time, duration, linked item, done check, freeform label), "first thing" intention, energy level, up to 3 custom **dots** (user-defined trackers), triage flow, plan **templates** (save/apply).
- **Meetups** (person, met/planned/missed, note), **feeling** text + **mood 1–7**, **gym** done/planned.
- Responsibilities/for-me items: quick capture bar + full editor (type, time estimate, energy, tags, recurring rule, intention, rest flag, links to person/bucket/project).
### 5.3 Tomorrow — same planner for tomorrow; **commit** marks the plan as set.
### 5.4 Calendar (personal) — month view of day plans / items / gym / mood.
### 5.5 Focus
- Pomodoro: editable focus/short/long/long-every settings (clamped sane ranges), sound + notification toggles, **multi-task session selection**, checkbox task completion from BOTH the main tab and the **compact pop-out** (centered, no resize needed, scrollable task list), session counts per item (`focusSessions`).
### 5.6 Bucket List — dream capture bar; dreams with **why**, steps checklist, dream → active → done lifecycle, pinned, tags, **memory** attached on completion; bigger **personal projects** (color, notes, lifecycle) that items can link to.
### 5.7 People — keep-in-touch list (name, last seen, frequency in weeks, notes); **overdue people** highlighted (drives hub + Log filter); meetups update last-seen.
### 5.8 Log
- Reverse-chronological history: **any** day with something (feeling, mood, done items, gym, meetups) appears **[regression: used to show only days with a feeling]** — shows `✓ N done` chip, 🏋️ gym chip, mood, feeling (placeholder if empty); filter by person to see meetup history.
### 5.9 Self Notes — notes with folders + rich-text editing.

### 5.10 Isolation rule (hard requirement)
Work code never reads `data.personal`; personal code never reads work keys.
A bug in one namespace must never take the other down (enforced by
`normalize`'s isolated try/catch + per-namespace shrink guards — S3/S6).

---

## 6. Infrastructure

| # | Behavior |
|---|----------|
| 6.1 | Single-file app: everything in `index.html` (no build step) |
| 6.2 | Deploy: push to `main` → GitHub Actions Pages workflow (`deploy.yml`, publishes repo root, auto-retry after 90s on Pages flakes) → https://eloren18.github.io/project-self-management/ |
| 6.3 | Preview: `.claude/launch.json` → `self-management` server on port 8742 (`http-server`, no cache); `window.__psmPreview()` bypasses the gate for UI checks |
| 6.4 | Tests: `tests/e2e-sync.mjs` extracts the REAL sync functions from `index.html` (never a reimplementation) — see `tests/README.md` |

---

## 7. Regression list — bugs we've already paid for **[ALWAYS CHECK]**

1. **Phone-login wipe (Jul 2026)**: fresh device seeded "newer" than the cloud and overwrote it → glossary/tasks/meetings lost. Guard: seed `updatedAt: 0` (S0/S1/S1b) + every safety layer in §1.
2. **Dead shield/account buttons (Jul 2026)**: `snapshots` entity missing from the InstantDB schema → signed-in `openSec()` threw before showing the modal → BOTH buttons dead (they share the handler). Guard: 4-layer schema consistency (S16), un-throwable `queryOnceSafe` + hardened `openSec` (S15). **Any new `db.tx.<entity>` or query MUST be added to all four layers.**
3. **Invisible categories**: board cards didn't render the project category; empty-string category displayed as the first option while storing "". Guard: `pc-cat` labels on cards + To-Do project rows + `normalize` coercion.
4. **Log missing days**: personal Log only showed days with a feeling. Guard: day row appears for done/gym/mood/meetup too.
5. **Lying sync pill**: pill said "Synced" on a 500ms timer regardless of the cloud. Guard: ack-driven states only (S14).

---

## 8. Signed-in-only checks (production, Kerem's account)

After any deploy that touches sync, auth, schema, or the Security modal:

1. 🛡 shield button **and** account/email button both open the Security modal.
2. Devices list shows this device + the log loads.
3. **⛅ Snapshot to cloud now** → "Cloud snapshot saved ⛅" toast → a ⛅ row appears in Restore points. (If it ever fails: InstantDB dashboard → Permissions must contain the `snapshots` block from SETUP.txt Part 3.)
4. Sync pill: make an edit → `Saving…` → `Synced`; go offline (airplane mode) + edit → red `Not synced · offline`; back online → `Synced`.
5. Phone + laptop: edit on one → appears on the other within seconds.
6. Download full backup → file contains both work and personal data.
