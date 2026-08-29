# Architecture — Project Self-Management

One frontend file (index.html, vanilla ES module, no build) + one Convex backend
(convex/). The design currency is the **deep module**: a lot of behaviour behind a
small interface, tested through that interface. The test suite extracts the REAL
code blocks out of index.html and drives them through these interfaces only.

## The deep modules (seam → what hides behind it → tested by)

| Module | Interface (the seam) | Hidden behind it | Tested by |
|---|---|---|---|
| Data layer | normalize(blob), load() | every migration/coercion ever shipped (legacy fields, checklists, detox, periods); personal namespace isolated so one side can never corrupt the other | S12, S17–S19 |
| Sync & safety | save() — the ONE call every feature makes | monotonic clock, localStorage + IndexedDB mirror + weekday backups, per-namespace shrink guards, LWW push with real ack, bad-remote quarantine, cloud snapshots, truthful pill | S0–S15 |
| Cloud transport | push() / cloudQuery() over convex.* string names | the SERVER enforces session + trusted device (convex/lib.ts requireTrusted); the client never authorizes | S16 (static) + convex/ |
| Smart lists | pure listAutoFormat/listEnter/listTab/listBackspace + bulletKeys(ta, onChange) | Word-style list starts, continuation, renumbering, indent, marker removal — for every plain textarea | S20 |
| Rich editor | bindRichEditor(body, toolsHost, opts) | autoformat, Tab-nesting, shortcuts, smart paste, toolbar, sanitizer discipline — Documents and Self Notes share it | browser checks |
| Note cards | mnoteCardHTML(o, opts) / bindMnoteCards(host, arr, opts) | the structured meeting-note editor used by project pages AND the meeting log (sections, checklist steps, steps→tasks, pin/copy) | S17 + browser |
| Dialogs & modals | uiConfirm/uiPrompt (Promise) + openPM/closePM | consistent open/close choreography; no native prompt/confirm anywhere | browser checks |

**The rule of the codebase:** features render with innerHTML template literals,
bind events, mutate `data`, and call save(). They never touch persistence, sync,
auth, or the cloud directly. If a change needs to cross that line, the right move
is to deepen one of the modules above, not to add a bypass.

**Deletion test results:** each module above reappears at 10+ call sites if
deleted — they earn their keep. Conversely, per-modal open/close wrappers are
deliberately thin one-liners over the openPM/closePM seam (kept only for their
call-site names).

---

# Architecture Notes — Personal Life Platform

## Existing Work app (discovered)
- **Single file**: `index.html` — vanilla JS ES module, no framework, no router. "Pages" are `<section class="page">` toggled by `switchTab()`. Rendering = innerHTML template literals + rebinding.
- **State**: one module-scope `data` object. Persistence: `localStorage["psmData_v1"]` + Convex `workspaces` row (whole-blob JSON string, last-write-wins by `updatedAt`; InstantDB until Aug 2026). `save()` → localStorage + `push()` to cloud.
- **Styling**: CSS custom properties on `html[data-theme]`; components are plain classes (`.btn`, `.chip`, `.trow`, `.modal-back/.modal`, `.empty`, `.section-h`).
- **Docs editor** (`renderDocs`): contenteditable + `sanitizeDocHTML` whitelist + toolbar of execCommand ops. Reused for Self Notes.
- **Calendar**: month grid built from date cells; deadline-driven. Personal adapts the grid/drag patterns with start-time + duration semantics instead (deadline code untouched).
- **Pomodoro engine** (from `../Claude Pomodoro App/index.html`): focus 25m / short 5m / long 15m, long break every 4 focus blocks; `endAt`-anchored 250ms ticker; `complete()` cycles focus→break→focus and credits the active task. Adapted 1:1 into the Now view (same durations, same cycle logic).

## Personal platform integration
- **Mode switch**: `localStorage["psm_mode_v1"]` (device-level UI preference; not in the synced blob). Sets `html[data-mode]`, swaps sidebar nav + page set. Theme toggle relocated into the Security modal (header spot now holds the Work ⇄ Personal pill).
- **Namespace isolation**: ALL personal data lives under **one additive key `data.personal`** inside the existing blob, normalized exclusively by `normalizePersonal()`. No existing Work key/shape/behavior is read or written by Personal code; Work code never reads `data.personal`. Rationale for sharing the blob: it inherits the existing cloud sync (personal data follows the user across trusted devices) with zero schema/auth changes — "no cloud sync beyond what exists". Older deployed clients preserve unknown keys (normalize mutates in place, never strips), so `personal` survives round-trips through old versions.
- **Visual identity**: `html[data-mode="personal"]` overrides the palette vars (warm cream neutrals, amber/coral primary `#d97742`, sage `#63886f` for the "I need to" lane) — same components, personal theme.
- **Entities** (under `data.personal`): `items` (PersonalItem: type responsibility|forMe, timeEstimate, energy, tags, isRest, intention, recurringRule, personId, bucketId/stepId), `dayPlans` keyed by ISO date (entries {itemId,time,dur,done}, firstThing, committed, bestMoment, heavy, energy, dots[3], triaged), `bucket` (why, steps[], status dream|active|done, pinned, memory{text,photos}), `notes` (Work-doc shape), `people` (lastSeen, freqWeeks), `dotDefs` (≤3), `templates`, `weekAnchors`, `settings` (free-time window).
- **Rollover**: plans are date-keyed, so "tomorrow becomes today" is intrinsic; Today runs a one-time triage over yesterday's committed, unfinished entries.
- **Recurring**: `recurringRule` {type: daily|weekly, weekday}; matching items are seeded into a day's plan when that plan is first created.

## Phases / commits
1. Shell: mode switch, palette, nav, page skeletons, data layer.
2. Today (dots, first thing, triage, quick-plan) + Tomorrow ritual (time-box, templates, commit rule, intentions).
3. Backlogs (The Good Stuff + rest menu + starvation, Need To) + Now view/pomodoro.
4. Week + season bar + People + Bucket List (steps→pipeline→memory vault) + Self Notes + Reflect + polish.
