# Tests

## `e2e-sync.mjs` — sync & data-safety end-to-end tests

Guards the data-loss incident of Jul 2026 (a fresh phone login overwriting the
cloud) and the defense-in-depth layers added afterwards.

```sh
node tests/e2e-sync.mjs      # exit 0 = all pass, 1 = a failure
```

It does **not** reimplement the logic — it extracts the *real* persistence/sync
functions (`seed`, `normalize`, `save`, `adoptRemote`, `startWorkspaceSync`,
`mirrorRestoreIfNewer`, `restoreData`, the shrink guards, …) live from
`../index.html` and runs them against an in-memory InstantDB "cloud",
per-device `localStorage`, and a per-device IndexedDB mirror. If those functions
change shape, the test follows automatically.

### Scenarios

| # | What it proves |
|---|----------------|
| S0 | `seed()` stamps `updatedAt: 0` — the regression anchor for the phone-login bug |
| S1 | A fresh phone login **adopts** the cloud instead of overwriting it |
| S1b | Reproduces the *original* bug (seed stamped `Date.now()`) and shows the shrink guard alone would have stayed silent for a work-only wipe — which is why `updatedAt: 0` is the essential fix |
| S2 | Two devices converge (last-write-wins); the monotonic clock prevents lost edits under a frozen/backward clock |
| S3 | The shrink guard catches a mass-delete but ignores a normal small edit |
| S4 | A restore replaces data everywhere, keeps a pre-restore safety copy, and propagates to other devices |
| S5 | The IndexedDB mirror recovers data after `localStorage` is cleared |
| S6 | A corrupt remote is quarantined; a broken **personal** namespace can't take down **work** data |
| S7 | Concurrent edits resolve deterministically by last-write-wins (documents the whole-blob limitation) |
| S8 | A returning device with older local data adopts the cloud, never clobbers it |
| S9 | Monotonic high-water: after adopting a far-future `updatedAt`, later local edits still win |
| S10 | Cross-tab storage events adopt a newer copy and ignore an older one |
| S11 | Degenerate/corrupt remotes (empty-but-newer, garbage JSON) never crash or wipe unrecoverably |
| S12 | `normalize` is idempotent — sync round-trips never drift item counts |
| S13 | A full local disk (quota exceeded) still syncs to the cloud and warns the user |
| S14 | The sync indicator tells the truth: "Synced" only after the cloud acknowledges (else "could be lost") |
| S15 | A throwing cloud query can never kill a UI path (the dead shield/account-buttons regression) |
| S16 | *Static:* every InstantDB entity used in code exists in ALL 4 schema/perms layers (index.html, instant.schema.ts, instant.perms.ts, SETUP.txt) |

Re-run this after any change to `seed`, `save`, `adoptRemote`, `normalize`,
`startWorkspaceSync`, the mirror, `restoreData`, `push`, the sync pill, or the
InstantDB schema. For the full manual checklist (every feature of the site),
see [`../FEATURES.md`](../FEATURES.md).
