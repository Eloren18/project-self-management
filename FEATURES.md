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
on `data.updatedAt` via **Convex** (`workspaces` row keyed by email; the blob is a JSON
string; `workspace:get` is a live subscription, `workspace:save` an LWW mutation that
returns `{accepted, updatedAt}` so the sync pill's "Synced" is a real acknowledgement).
Backend code lives in `convex/` (see `SETUP-Convex.txt`); prod `cheerful-rat-350`, dev `hearty-jay-608`.

| # | Behavior | Verified by |
|---|----------|-------------|
| 1.1 | **A fresh device seeds at `updatedAt: 0`** and can NEVER outrank/overwrite the cloud — it must adopt it. **[ALWAYS CHECK]** (the Jul 2026 phone-login data loss) | S0, S1, S1b |
| 1.2 | Every save bumps a **monotonic clock**: `updatedAt = max(now, prev+1)` — a backwards/frozen device clock can't win a sync race | S2, S9 |
| 1.3 | Two devices **converge**: each adopts the other's newer copy; edits from both survive sequential syncs | S2 |
| 1.4 | A returning **stale device adopts** the newer cloud copy and never clobbers it | S8 |
| 1.5 | **Offline edits** push to the cloud on reconnect (`online` event) | S7 + code |
| 1.6 | **Concurrent edits / true conflicts**: higher `updatedAt` wins the whole blob, BUT no side is ever silently dropped — the **stale-device barrier** (each device persists the newest cloud version it has SEEN in `psmData_v1_synced`): a device whose stamp is newer but whose base was never seen (long-offline device, the Aug-2026 phone incident) does NOT push; it stashes its copy (`_lost_`), adopts the cloud, warns, and logs `stale_overwrite_blocked`. Mirror-side: adopting a newer cloud while holding unsynced local edits stashes them first. Normal offline edits (base was seen) push as before | S1b, S7 |
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
| 2.1 | Sign-in gate: **email + 6-digit code** (Convex action `auth:requestCode` → Resend email → `auth:verifyCode` → session token in localStorage `psmSession_v1`), locked to the single `ADMIN_EMAIL` **server-side**; codes hashed, 10-min TTL, 5 tries, 30s cooldown, 15/day; sessions ~6 months. The email field is prefilled; "← different email / resend" goes back. A remembered device boots straight in; if the session is gone the server answers `null` and the gate reappears with "Your sign-in expired". Offline with a remembered session: after 6s the local copy opens and syncs when back online. **[ALWAYS CHECK]** |
| 2.2 | Unconfigured/local mode: "Continue without sync" → `Local only` pill, everything works locally |
| 2.3 | Device trust: first device bootstraps as trusted; every new browser/device becomes **pending** and must be approved from an already-trusted device; pending devices see a waiting screen |
| 2.4 | **The Security modal opens from BOTH the 🛡 shield button AND the account/email button** (they share `openSec`). **[ALWAYS CHECK — signed in!]** Regression: a schema error in the cloud-snapshots query once killed `openSec` for signed-in users only — both buttons appeared dead (fixed + hardened: `openSec` try/catches its renderers, `queryOnceSafe` can never throw; guarded by S15/S16) |
| 2.5 | Security modal contents: authorized email; pending devices (Approve/Reject); trusted devices with "This device" badge + last-active + Revoke; **Sign out all other devices**; **Sign out this device** |
| 2.6 | 🔴 `secDot` on the shield button when a device awaits approval |
| 2.7 | **Security log**: append-only, newest 30 (sign-ins, device events, `data_restored`, `data_shrunk`) with friendly labels |
| 2.8 | **Backups**: ⤓ Download full backup (one JSON = work + personal, records `_lastdl`); ⤒ Restore from backup file (styled confirm shows the backup's exact counts first); ⛅ Snapshot to cloud now |
| 2.9 | **Restore points list**: merges 💾 weekday backups + 🛟 all stash families + ⛅ cloud snapshots, sorted newest-first, each with timestamp/label/counts and a one-click **Restore** (goes through the same guarded `restoreData` path) |
| 2.10 | **Server-side authorization (Convex)**: every data function takes `token` + `deviceId`; `workspace:*`, `snapshots:*`, `securityLog:list` answer only a valid session on a **trusted** device (`requireTrusted` / `trustedOrNull`); `devices:setStatus/remove/revokeOthers` require a trusted *caller*; `devices:list` shows a pending device only itself. Tables: `workspaces`, `snapshots` (server-pruned to 30), `securityLog`, `devices`, `otps`, `sessions`. **Every `"module:function"` the app calls must exist in `convex/<module>.ts`** and `ADMIN_EMAIL` must match between index.html and `convex/lib.ts` (S16 enforces). Migration history: `legacy-instantdb/`. |

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
- Click a card/row → full **project page**: editable name, description, **category select (never silently empty — `normalize` coerces "" to the first option)**, progress, priority, deadline (date or week-type), color swatches + custom color, involved/informed stakeholders, value proposition, doc link, notes, **structured meeting-notes log** (see 4.10), **tasks** (add / inline edit / done / deadline / notes post-it / delete), complete ⇄ reopen, delete (styled confirm).

### 4.2 To-Do
- **Quick-add bar**: text (Enter adds), project selector (or Ad-hoc), deadline picker (calendar + quick options incl. `+3 business days`, week-type deadlines).
- Sections: **⚠ Overdue** (tasks AND overdue projects — project rows show 🚩 name + `Project` chip + **category chip** + reschedulable deadline chip + complete-check), **Today**, **This week**, **Upcoming**, **No date**, **Completed** (toggle; includes completed projects with restore).
- Task rows everywhere: done check, inline text edit, project tag (click = jump to project/meeting), deadline chip picker (`· overdue` state), 🗒 notes post-it, delete. Search filters tasks + notes + project names.

### 4.3 Meetings
- Recurring meetings: name, cadence, attendees. Meeting page: **action items** (tasks that flow into To-Do/Calendar tinted with the meeting accent), a searchable **meeting log** of dated entries (see 4.10), delete with confirm.

### 4.10 Meeting notes — structured editor (shared: project pages **and** the meeting log)
One component (`mnoteCardHTML` / `bindMnoteCards`) renders meeting notes in both places. **[ALWAYS CHECK — both surfaces]**
- **Three fixed sections** auto-titled: **What was discussed?**, **Next steps**, **Next Jumps** (meeting-log entries also keep an **Agenda** section on top).
- **Natural editing**: seamless borderless textareas that **auto-grow** as you type (no fixed rows, no manual resize), with **plain-text smart lists** (`bulletKeys` → pure `listAutoFormat`/`listEnter`/`listTab`/`listBackspace`, tested in S20): **typing `- ` / `* ` at a line start instantly becomes an indented `• `, and `1. ` / `1) ` (1–2 digits) an indented numbered item — Word-style**; bullets (`- ` `* ` `• ` `– `) **and numbered lists** (`1. ` / `1) `) auto-continue on Enter — numbers increment and the lines below **renumber**; Enter on an empty item ends the list; **Tab / Shift+Tab** indent / outdent (multi-line selections too); **Backspace** on an empty item removes the marker; Shift+Enter is a plain newline. The same behaviour is wired into the **project-page Notes** textarea and **Week Prep notes**.
- **Collapsible cards** with a date header, a one-line snippet preview when collapsed, a `⇢ N` chip showing unconverted next-steps, and a relative "edited …" time when open.
- **Next steps is a checkbox checklist** (`{id,text,done}`): tick items off with a real checkbox, edit text inline, add via the "＋ Add a next step" input (Enter), delete per row; done items strike through.
- **Next steps → tasks**: a button turns each **un-ticked** step into a real task (on the project or meeting) that flows into To-Do, then **ticks that step's checkbox** so re-running never duplicates. Confirm dialog previews exactly what will be created.
- **Pin** (★, sorts to top), **Copy** (⧉, whole note to clipboard as text), **Delete** (styled confirm).
- Meeting-log extras: **search** the log, **⤓ Last agenda** (copy previous entry's agenda), **⤓ Carry over open steps** (pull the previous entry's un-ticked next-step items into this entry's Next-steps checklist), single-open accordion, "Latest" badge.
- **Migration [ALWAYS CHECK — data safety]**: legacy free-text (`text` on project notes, `notes` on meeting entries) moves into **What was discussed?** and is NEVER dropped — if that section already had content the legacy text is appended; idempotent, never duplicates (S17).

### 4.4 Calendar — month grid; shows project deadlines, task deadlines, meetings; month navigation; overdue tint; click-through to items.

### 4.5 Year Plan — the year's 52 weeks grouped into **four corporate quarters**, with **goals per quarter**, for long-range planning.
- Four sections (Q1 Jan–Mar … Q4 Oct–Dec), each headed by a bar with the quarter name, month range, a `done/total goals` counter, and a **+ Goal** button; the current quarter's bar (and week) is highlighted. A week belongs to the quarter holding its **Thursday** (majority-day rule — boundary weeks like W1 starting in the previous December land correctly); every year splits 13/13/13/13, 52 total.
- **Quarter goals**: check-off rows (inline text edit, Enter commits, delete on hover) stored per year+quarter in `data.quarterGoals` (`"2026-Q3"` → `[{id,text,done}]`) — each year keeps its own goals; navigating years switches them. Normalized (garbage buckets dropped, entries repaired), **counted by the shrink guard** (`scoreWork` includes `qGoals`), included in the backend merge helper's WORK list, and synced with the blob (S12 checks).
- Week grid behaviour unchanged: drag items between weeks, click a week to add, click an item to open it.

### 4.6 Week Prep — per-week preparation: notes (with the plain-text smart-list behaviour from §4.10) + check-off item list, week navigation.

### 4.7 Documents — rich-text documents (title + formatted body), create/edit/delete.
- **Shared rich editor** (`bindRichEditor`, also used by Self Notes) **[ALWAYS CHECK]**: Word-style **autoformat while typing** — `- ` / `* ` / `• ` → bullet list, `1. ` / `1) ` → numbered list, `# ` / `## ` / `### ` → headers, `> ` → quote (all at the start of a line; Ctrl+Z undoes the conversion). **Tab / Shift+Tab** indent / outdent list items (nested bullets get circle/square markers, nested numbers a./i.), Enter on an empty item ends the list, **Enter after a header returns to normal text**, **Ctrl+Shift+8 / Ctrl+Shift+7** toggle bullet / numbered lists. **Smart paste**: pasted plain text whose lines look like a list becomes a real list (everything else pastes as plain text, never messy markup). Toolbar: Header/Sub/Text, B/I/U/S, highlight, bullet + numbered lists, **Quote**, indent/outdent, align, undo/redo, Clear. Output is sanitized to a fixed tag whitelist on every save.

### 4.8 Glossary
- Terms with definition, **source** (Jumbo = yellow, NIQ = blue, AH Data = teal, custom sources get stable palette colors), optional category grouping with collapsible headers and per-category ordering, add/edit/delete. **[ALWAYS CHECK after sync work — glossary was lost in the Jul 2026 incident]**

### 4.9 Archive
- Completed projects and tasks with completion dates; search; **restore** anything back to active (round-trips cleanly).

---

## 5. Personal Life platform — 10 tabs

### 5.1 Overview (hub) — day flags, overdue people, missed for-me items this week, weekly main things, stats, jump-offs into the other tabs.
- **Finalization stats [ALWAYS CHECK]**: a "◷ N recent days still open" nudge (jumps to the latest unclosed day), plus **Days closed · this week**, **Days recorded · this month %**, **🔥 Finalize streak**, and **▶ Morning wins · this week** KPI tiles, and a "most common first-thing blocker this month" line (barrier-tag patterns).
### 5.2 Today — 4-box layout + collapsible log **[ALWAYS CHECK]**
- **Top: exactly 4 boxes** (the `.day4` grid): **① First activity** (`firstThing`, set the night before on the Tomorrow page — the "determined from the day prior" flow), **② Tasks for today** (open responsibility entries + add + import-from-Need-To), **③ Things for me 🧡** (open for-me entries + add), **④ Who I'm meeting** (meetups + add).
- **Below: one collapsible `<details>` panel** ("📓 What happened & how I felt"), **collapsed by default**, whose open/closed state persists across re-renders (`dayLogOpen`). Contains everything retrospective: **habits/dots** (up to 3 trackers), **gym** (plan/went + weekly count), **What happened** (done tasks + done for-me, with "log what you did" inputs), **How I felt** (mood 1–7 + free-text reflection).
- **Gym plan** (planned/not) sits in a slim planning strip under the 4 boxes; whether you actually **went** is logged inside the collapsible (plan vs. reality kept separate).
- **First activity loop [ALWAYS CHECK]** — the ▶ First-activity box shows the activity, a **prep checklist** (`firstPrep`, `{id,text,done}` — the steps you set up the night before, ticked = done), a **Did it?** toggle (`firstDone`), and if not done, **barrier tags** (`firstBarrier`: 😴 tired / 🧰 not ready / ⚡ interrupted / 🌀 forgot / 🔀 changed). A separate **🌙 Set up tomorrow** box (Today only) writes *tomorrow's* first activity + prep checklist (editing tomorrow's plan), so the nightly loop is: set & prep tomorrow tonight → do it (or tag why not) in the morning. `firstPrep` migrated from a legacy string to a checklist (S18). The finalized-day recap shows the first activity with ✓ or its blocker.
- **Finalize bar** (bottom of each today/past day): "◷ This day isn't closed yet → ✓ Finalize day", or "✓ Day finalized · <time> · Reopen" once closed. Sets `finalized`/`finalizedAt`; drives the Overview streak/nudge, the Journal "◷ open" marker, and the Calendar heatmap. Future days (Tomorrow) show no finalize bar.
- **Locked recap** — a finalized day renders a **read-only recap card** (first activity, tasks/for-me done, gym, mood, habits, people + their notes, the feeling) instead of the editable planner; **Reopen to edit** returns to editing.
- **Growing write-fields**: meetup notes (day page + Journal), the day-feeling, and People notes are all auto-growing textareas — text wraps and extends **downward**, never overflowing sideways.
- Day-page entries keep time/duration/note/drag-reorder; responsibilities/for-me items still have the full editor (type, energy, tags, recurring rule, links). Backward day navigation; past days show the same 4-box + log + finalize.
### 5.2b To-Do tab **[ALWAYS CHECK]**
- A cross-day list of **every open actionable thing** — tasks, for-me items, and **planned (unmet) meetups** — each tagged with **how long it's been on your plate** (↪ from yesterday / N days ago / 1 week ago / 1 month ago, from the entry's `since`). Sorted oldest-first; a quick-add creates an unscheduled task.
- **Removal rule:** an item leaves only once it's **checked off AND its day is finalized**; done-but-not-yet-closed items sit in a "Done — clears when you close their day" group. **Un-scheduled tasks:** checking one **files it as a completed task on today** (so it's recorded), then it clears when today is finalized. Recurring items are excluded.
- **Carry-over [ALWAYS CHECK]:** when a day is finalized, its unfinished tasks/for-me/planned-meetups **auto-move to the next day** (`rollOverDay`), preserving each item's `since` (so the age keeps counting). The finalized day's recap shows **"↪ N rolled over"** and an honest done-count; carried tasks show the age badge on the day page too. Model migration (entry `since`, dayPlan `rolledCount`, meetup `since`) is guarded by S19.
- **Per-task actions [ALWAYS CHECK]:** each task row has a **✕ delete** (confirmed; removes it from every day) and a **📅 plan…** menu: **Today / Tomorrow** and **Pick a date…** (single-day, via a date modal), **This week / Next week / This weekend / Custom period…** (a *period*), or **Someday** (clears scheduling). The row badge shows the assigned day, or **◷ this week / next week / …** for a period, or "unscheduled".
- **Period tasks ("anytime in a span") [ALWAYS CHECK]:** an item with `period:{start,end}` shows as a **virtual row on every day** from today through the span's end (`periodItemsForDay` → `perRowHTML`, not a real entry). **Completing it on ONE day** (`completePeriodOnDay`) files a done entry on that day, finishes the task, and **clears `period` → it vanishes from all the other days**, leaving only the completed day. ✕ on a period row takes it back to the To-Do list (clears `period`). If the span **ends unfinished**, it stops appearing on day pages and stays in the To-Do list as unscheduled (per design). This is distinct from **⧉ Spread over days** (separate work-*blocks* each completed independently), which is kept. `item.period` is normalized/synced.

*(The old "Need To" backlog was removed from the Overview — the To-Do tab is now the single home for these tasks.)*

### 5.3 Tomorrow — the SAME 4-box day page fixed on tomorrow (this is where you set tomorrow's **First activity**). Future days hide the retrospective sections — the collapsible only offers gym planning.
### 5.4 Calendar (personal) — month view of day plans / items / gym / mood; **finalization heatmap** (finalized days get a green inset bar + ✓; past days left open are faded with a ◷) and a "✓ N closed" month header.
### 5.5 Focus
- Pomodoro: editable focus/short/long/long-every settings (clamped sane ranges), sound + notification toggles, **multi-task session selection**, checkbox task completion from BOTH the main tab and the **compact pop-out** (centered, no resize needed, scrollable task list), session counts per item (`focusSessions`).
### 5.6 Bucket List — dream capture bar; dreams with **why**, steps checklist, dream → active → done lifecycle, pinned, tags, **memory** attached on completion; bigger **personal projects** (color, notes, lifecycle) that items can link to.
### 5.7 People — keep-in-touch list (name, last seen, frequency in weeks, notes); **overdue people** highlighted (drives hub + Log filter); meetups update last-seen.
### 5.8 Journal (internal id still `log`)
- Reverse-chronological history with an **All / ☀ Reflections** toggle (`.seg`):
  - **All**: **any** day with something (feeling, mood, done items, gym) appears **[regression: used to show only days with a feeling]** — `✓ N done` chip, 🏋️ gym chip, mood, feeling; plus meetup rows filterable by person.
  - **☀ Reflections**: only the days you actually **wrote a feeling or set a mood** — meetup rows and the person filter are hidden.
- Day rows show a **◷ open** chip when a past day was never finalized.
- "+ log a past day" opens any date. (The tab and page title read **Journal**; the People tab's "Log →" still jumps here for a person's meetups.)
### 5.9 Self Notes — notes with folders + the same **shared rich editor** as Documents (§4.7): autoformat lists/headers/quotes while typing, Tab-indent, smart paste, Ctrl+Shift+8/7; toolbar has Header/Sub/Text, B/I/U/S, HL, lists, indent/outdent, quote, undo/redo, Clear.

### 5.11 Detox (addiction / dopamine-detox) **[ALWAYS CHECK]**
- **Three rule tiers**, each an editable list (add via input+Enter, inline edit, ✕ delete): **🚫 Never do**, **⚠️ Try to avoid**, **〜 Not ideal**. Stored in `data.personal.detox.rules.{never,avoid,notideal}`.
- **One shared 30-day counter** (`detoxCleanDays`): **days clean since the last "Never do" slip** (or since `detox.startedAt` if none) — counts **up and keeps going** past 30; the Detox tab shows the big number + a "N days to your 30-day milestone" line (🏆 once cleared) + a progress bar.
- **Daily tracker on Today**, right next to the mini-habits (`detoxTrackHTML`, in the collapsible log): defaults to "🔥 N days clean · ＋ log a slip". Logging asks for a **free-text note** (a "Never do" infraction on that day) → resets the counter; an **undo** removes today's slip. Works on past days too (retroactive).
- **Addiction journal** — the infraction log (`detox.log`: `{id,ts,date,tier,note}`), reverse-chron in the Detox tab, each row date + tier badge + note + ✕ delete. **Avoid / Not-ideal are also loggable** (a "＋ log a slip" per tier) — tagged in the journal but they **never reset the 30-day counter** (only "Never do" does). `detox` is normalized/synced.

### 5.10 Isolation rule (hard requirement)
Work code never reads `data.personal`; personal code never reads work keys.
A bug in one namespace must never take the other down (enforced by
`normalize`'s isolated try/catch + per-namespace shrink guards — S3/S6).

---

## 6. Infrastructure

| # | Behavior |
|---|----------|
| 6.1 | Single-file frontend: everything in `index.html` (no build step); the Convex browser client (`convex@1.45.0/browser`) is loaded from esm.sh with CDN fallbacks |
| 6.0 | **Backend = Convex** (`convex/` folder, TypeScript): `npx convex dev --once` pushes to dev, `npx convex deploy -y` (or `Deploy-Backend.bat`) to prod; `npx convex run admin:stats --prod` = safe summary, never contents. Secrets (`RESEND_API_KEY`) live in Convex env, never in the repo. CSP allows only `*.convex.cloud` (+ localhost for testing) as connect targets. |
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
6. **Stale-phone overwrite (Aug 2026, on Convex)**: an iPhone that hadn't opened the app for ~9 days was used before its connection caught up; the monotonic clock stamped its stale copy "newest" and LWW pushed it, silently erasing Aug 24–26 work (9% shrink — under the guard's threshold). Recovered server-side by grafting the work collections back from a cloud snapshot (admin:mergeWorkFromSnapshot). Guard: the **stale-device barrier** + adoption-side stash (see 1.6, S1b/S7) — pushing now requires having SEEN the cloud version being replaced.

---

## 8. Signed-in-only checks (production, Kerem's account)

After any deploy that touches sync, auth, schema, or the Security modal:

1. 🛡 shield button **and** account/email button both open the Security modal.
2. Devices list shows this device + the log loads.
3. **⛅ Snapshot to cloud now** → "Cloud snapshot saved ⛅" toast → a ⛅ row appears in Restore points. (If it ever fails: InstantDB dashboard → Permissions must contain the `snapshots` block from SETUP.txt Part 3.)
4. Sync pill: make an edit → `Saving…` → `Synced`; go offline (airplane mode) + edit → red `Not synced · offline`; back online → `Synced`.
5. Phone + laptop: edit on one → appears on the other within seconds.
6. Download full backup → file contains both work and personal data.
