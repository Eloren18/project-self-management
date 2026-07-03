# Architecture Notes — Personal Life Platform

## Existing Work app (discovered)
- **Single file**: `index.html` — vanilla JS ES module, no framework, no router. "Pages" are `<section class="page">` toggled by `switchTab()`. Rendering = innerHTML template literals + rebinding.
- **State**: one module-scope `data` object. Persistence: `localStorage["psmData_v1"]` + InstantDB `workspaces` row (whole-blob JSON, last-write-wins by `updatedAt`). `save()` → localStorage + `push()` to cloud.
- **Styling**: CSS custom properties on `html[data-theme]`; components are plain classes (`.btn`, `.chip`, `.trow`, `.modal-back/.modal`, `.empty`, `.section-h`).
- **Docs editor** (`renderDocs`): contenteditable + `sanitizeDocHTML` whitelist + toolbar of execCommand ops. Reused for Self Notes.
- **Calendar**: month grid built from date cells; deadline-driven. Personal adapts the grid/drag patterns with start-time + duration semantics instead (deadline code untouched).
- **Pomodoro engine** (from `../Claude Pomodoro App/index.html`): focus 25m / short 5m / long 15m, long break every 4 focus blocks; `endAt`-anchored 250ms ticker; `complete()` cycles focus→break→focus and credits the active task. Adapted 1:1 into the Now view (same durations, same cycle logic).

## Personal platform integration
- **Mode switch**: `localStorage["psm_mode_v1"]` (device-level UI preference; not in the synced blob). Sets `html[data-mode]`, swaps sidebar nav + page set. Theme toggle relocated into the Security modal (header spot now holds the Work ⇄ Personal pill).
- **Namespace isolation**: ALL personal data lives under **one additive key `data.personal`** inside the existing blob, normalized exclusively by `normalizePersonal()`. No existing Work key/shape/behavior is read or written by Personal code; Work code never reads `data.personal`. Rationale for sharing the blob: it inherits the existing InstantDB sync (personal data follows the user across trusted devices) with zero schema/auth changes — "no cloud sync beyond what exists". Older deployed clients preserve unknown keys (normalize mutates in place, never strips), so `personal` survives round-trips through old versions.
- **Visual identity**: `html[data-mode="personal"]` overrides the palette vars (warm cream neutrals, amber/coral primary `#d97742`, sage `#63886f` for the "I need to" lane) — same components, personal theme.
- **Entities** (under `data.personal`): `items` (PersonalItem: type responsibility|forMe, timeEstimate, energy, tags, isRest, intention, recurringRule, personId, bucketId/stepId), `dayPlans` keyed by ISO date (entries {itemId,time,dur,done}, firstThing, committed, bestMoment, heavy, energy, dots[3], triaged), `bucket` (why, steps[], status dream|active|done, pinned, memory{text,photos}), `notes` (Work-doc shape), `people` (lastSeen, freqWeeks), `dotDefs` (≤3), `templates`, `weekAnchors`, `settings` (free-time window).
- **Rollover**: plans are date-keyed, so "tomorrow becomes today" is intrinsic; Today runs a one-time triage over yesterday's committed, unfinished entries.
- **Recurring**: `recurringRule` {type: daily|weekly, weekday}; matching items are seeded into a day's plan when that plan is first created.

## Phases / commits
1. Shell: mode switch, palette, nav, page skeletons, data layer.
2. Today (dots, first thing, triage, quick-plan) + Tomorrow ritual (time-box, templates, commit rule, intentions).
3. Backlogs (The Good Stuff + rest menu + starvation, Need To) + Now view/pomodoro.
4. Week + season bar + People + Bucket List (steps→pipeline→memory vault) + Self Notes + Reflect + polish.
