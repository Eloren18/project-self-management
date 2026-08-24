/*
  End-to-end sync & data-safety tests for Project Self-Management
  ==============================================================
  These tests run the REAL persistence/sync functions (seed, normalize, save,
  adoptRemote, startWorkspaceSync, mirrorRestoreIfNewer, restoreData, the shrink
  guards, …) extracted live from ../index.html at runtime — so the test can never
  silently drift from the shipped code. They exercise those functions against an
  in-memory InstantDB "cloud", per-device localStorage, and a per-device IndexedDB
  mirror, simulating multiple devices (laptop + phone) syncing through the cloud.

  Scenarios:
    S0  seed() stamps updatedAt:0            (source anchor for the phone-login bug)
    S1  Fresh phone login never wipes cloud  (THE bug we faced) + old-bug reproduction
    S2  Two devices converge; monotonic clock (last-write-wins, no lost edits)
    S3  Shrink guard catches a real mass-delete but ignores a normal small edit
    S4  Restore is authoritative and propagates to other devices
    S5  IndexedDB mirror recovers data after localStorage is wiped
    S6  Corrupt remote is quarantined; a broken personal namespace can't kill work

  Run:  node tests/e2e-sync.mjs      (exit code 0 = all pass, 1 = a failure)
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

/* ---- extract the real source blocks from index.html by stable markers ---- */
function fullLine(re) {
  const m = src.match(re);
  if (!m) throw new Error('marker line not found: ' + re);
  const start = src.lastIndexOf('\n', m.index) + 1;
  let end = src.indexOf('\n', m.index);
  if (end < 0) end = src.length;
  return src.slice(start, end);
}
function slice(startMarker, endMarker, inclusiveEnd = false) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('start marker not found: ' + startMarker);
  const j = src.indexOf(endMarker, i + startMarker.length);
  if (j < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(i, inclusiveEnd ? j + endMarker.length : j);
}

const consts = [
  fullLine(/const STORAGE_KEY = /),
  fullLine(/const CATEGORIES = /),
  fullLine(/const PROGRESS\s*=/),
  fullLine(/const PRIORITIES = /),
  fullLine(/const GLOSSARY_SOURCES = /),
  fullLine(/const PPROJ_PALETTE=/),
  fullLine(/const uid = \(\) =>/),
  fullLine(/function errText\(e, fallback\)\{/),
  slice('const SEED_PROJECTS = [', '\n];', true),
].join('\n');

const dataLayer = slice('function seed(){', 'let data = load();'); // seed, normTask, normalize, normalizePersonal, load
const syncBlock = slice('const STASH_FAMILIES=', 'function setSync'); // counts, shrink guards, save, mirror, adopt, sync, restore
const listBlock = slice('/* ---- plain-text smart lists', '/* ---- end smart lists ---- */'); // pure textarea list helpers (listEnter/listTab/listBackspace)

const REAL_CODE = consts + '\n' + dataLayer + '\n' + syncBlock + '\n' + listBlock;

/* ---- the harness: prelude shims + scenarios; real code injected at the marker ---- */
async function HARNESS() {
  /*__REAL__*/

  // ===== harness state / spies =====
  let data = null, booting = false, granted = true, authedUser = { email: 'keremladkeholland@gmail.com' },
      workspaceId = null, workspaceSub = null, devicesSub = null, logSub = null;
  let sessionToken = 'tok_test'; const deviceId = 'dev_test';   // a signed-in, trusted test device
  let __toasts = [], __sec = [];
  const __clock = { t: 1000 };
  Date.now = () => __clock.t;                       // deterministic, tie-free virtual clock
  const clone = x => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const toast = m => { __toasts.push(String(m)); };
  const logSec = (t, info) => { __sec.push({ t, info }); };
  const applyTheme = () => {};
  const renderAll = () => {};
  const setSync = () => {};

  // ---- localStorage mock (Object.keys returns only data keys → pruneStash works) ----
  function makeLS() {
    const proto = {
      getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; },
      setItem(k, v) { this[k] = String(v); },
      removeItem(k) { delete this[k]; },
    };
    return Object.create(proto);
  }
  let localStorage = makeLS();

  // ---- IndexedDB mock (event-based, matches the real mirror* code) ----
  function makeIDB() {
    const stores = {};
    const idb = {
      __created: false,
      open() {
        const rq = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
        queueMicrotask(() => {
          const dbi = {
            createObjectStore(n) { stores[n] = stores[n] || new Map(); return {}; },
            transaction(n) {
              const store = stores[n] = stores[n] || new Map();
              const tx = {
                oncomplete: null, onerror: null,
                objectStore() {
                  return {
                    put(v, k) { store.set(k, v); queueMicrotask(() => tx.oncomplete && tx.oncomplete()); return {}; },
                    get(k) { const gr = { result: undefined, onsuccess: null, onerror: null }; queueMicrotask(() => { gr.result = store.get(k); gr.onsuccess && gr.onsuccess(); }); return gr; },
                  };
                },
              };
              return tx;
            },
            close() {},
          };
          rq.result = dbi;
          if (!idb.__created) { idb.__created = true; rq.onupgradeneeded && rq.onupgradeneeded(); }
          rq.onsuccess && rq.onsuccess();
        });
        return rq;
      },
      deleteDatabase() { for (const k in stores) delete stores[k]; const rq = { onsuccess: null, onerror: null, onblocked: null }; queueMicrotask(() => rq.onsuccess && rq.onsuccess()); return rq; },
    };
    return idb;
  }
  let indexedDB = makeIDB();
  let window = { indexedDB };
  let navigator = { onLine: true };                 // drives the sync indicator's offline state

  // ---- Convex "cloud" mock (shared across devices; mirrors the server's rules:
  //      whole-blob LWW on updatedAt, snapshots pruned to 30, one workspace row) ----
  const cloud = { workspace: null, snapshots: [], devices: [], securityLog: [] };
  let __idc = 0; const newId = p => p + '_' + (++__idc);
  const wsRow = () => cloud.workspace ? { data: cloud.workspace.data, updatedAt: cloud.workspace.updatedAt } : { data: null, updatedAt: 0 };
  const convex = {
    mutation(name, args) {
      try {
        if (name === 'workspace:save') {
          const row = cloud.workspace;
          if (!row) { cloud.workspace = { data: args.data, updatedAt: args.updatedAt }; return Promise.resolve({ accepted: true, updatedAt: args.updatedAt }); }
          if (args.updatedAt >= row.updatedAt) { row.data = args.data; row.updatedAt = args.updatedAt; return Promise.resolve({ accepted: true, updatedAt: args.updatedAt }); }
          return Promise.resolve({ accepted: false, updatedAt: row.updatedAt });   // stale write ignored, like the server
        }
        if (name === 'snapshots:add') { cloud.snapshots.push({ id: newId('snap'), ts: args.ts, updatedAt: args.updatedAt, label: args.label, data: args.data }); cloud.snapshots.sort((a, b) => b.ts - a.ts); cloud.snapshots = cloud.snapshots.slice(0, 30); return Promise.resolve({ kept: cloud.snapshots.length }); }
        if (name === 'securityLog:add') { cloud.securityLog.push({ id: newId('log'), ts: Date.now(), event: args.event, detail: args.detail, deviceId: args.deviceId }); return Promise.resolve(); }
        return Promise.resolve();
      } catch (e) { return Promise.reject(e); }
    },
    query(name, args) {
      if (name === 'workspace:get') return Promise.resolve(wsRow());
      if (name === 'snapshots:list') return Promise.resolve(cloud.snapshots.map(s => ({ id: s.id, ts: s.ts, updatedAt: s.updatedAt, label: s.label, bytes: s.data.length })));
      if (name === 'snapshots:get') { const s = cloud.snapshots.find(x => x.id === (args && args.id)); return Promise.resolve(s ? { data: s.data, ts: s.ts, updatedAt: s.updatedAt, label: s.label } : null); }
      return Promise.resolve(null);
    },
    action() { return Promise.resolve({}); },
    onUpdate(name, args, cb) {   // a real subscription fires immediately with the current value
      if (name === 'workspace:get') cb(wsRow());
      else if (name === 'devices:list') cb(cloud.devices.slice());
      else if (name === 'securityLog:list') cb(cloud.securityLog.slice());
      return () => {};
    },
  };

  // ===== tiny test framework =====
  let __pass = 0, __fail = 0; const __log = [];
  const check = (n, c, d) => { if (c) { __pass++; __log.push('  ✓ ' + n); } else { __fail++; __log.push('  ✗ FAIL: ' + n + (d ? '   [' + d + ']' : '')); } };
  const scen = t => __log.push('\n' + t);

  // ===== device helpers =====
  const newDevice = n => ({ name: n, ls: makeLS(), idb: makeIDB(), data: null, workspaceId: null });
  function useDevice(d) { data = d.data; localStorage = d.ls; indexedDB = d.idb; window.indexedDB = d.idb; workspaceId = d.workspaceId; workspaceSub = null; booting = false; granted = true; authedUser = { id: 'kerem' }; }
  function saveDevice(d) { d.data = data; d.workspaceId = workspaceId; }
  function boot(d) { useDevice(d); data = load(); d.data = data; }
  const cloudWs = () => cloud.workspace ? { data: JSON.parse(cloud.workspace.data), updatedAt: cloud.workspace.updatedAt } : undefined;
  const stashCount = (d, tag) => Object.keys(d.ls).filter(k => k.startsWith(STORAGE_KEY + '_' + tag + '_')).length;
  const wScore = d => scoreWork(blobCounts(d));
  const pScore = d => scorePersonal(blobCounts(d));
  const flush = async (n = 14) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

  // ===== datasets =====
  function makeReal() {
    const projects = [];
    for (let i = 0; i < 12; i++) projects.push({ id: 'p' + i, name: 'Project ' + i, category: CATEGORIES[i % 3], progress: 'In Progress', priority: 'Medium', deadline: '2026-07-1' + (i % 9), tasks: [] });
    let n = 20, k = 0; while (n > 0) { projects[k % 12].tasks.push({ id: 't' + n, text: 'Task ' + n, done: false }); n--; k++; } // 20 tasks
    const glossary = []; for (let i = 0; i < 10; i++) glossary.push({ id: 'g' + i, term: 'Term ' + i, definition: 'Def ' + i, source: GLOSSARY_SOURCES[i % 3] });
    const meetings = [{ id: 'm1', name: 'Weekly Sync', cadence: 'weekly', entries: [], tasks: [] }];
    const docs = [{ id: 'd1', title: 'Playbook', body: 'notes' }];
    const personal = { items: [], dayPlans: {} };
    for (let i = 0; i < 7; i++) personal.items.push({ id: 'pi' + i, title: 'Personal ' + i, type: 'responsibility' });
    for (let i = 0; i < 8; i++) personal.dayPlans['2026-07-0' + (i + 1)] = { entries: [], feeling: 'ok' };
    return { projects, tasks: [], glossary, meetings, docs, personal, updatedAt: 0 };
  }
  const REAL = makeReal();
  const REALn = normalize(clone(REAL));
  const seedN = normalize(seed());

  // a laptop that already holds REAL data, pushed to a populated cloud
  function setupSynced() {
    cloud.workspace = null; cloud.snapshots = [];
    const laptop = newDevice('laptop');
    __clock.t += 1000; boot(laptop); startWorkspaceSync();          // cloud seeded with laptop's seed
    __clock.t += 1000; data = normalize(clone(REAL)); save();       // cloud <- REAL (authoritative)
    saveDevice(laptop);
    const phone = newDevice('phone');
    __clock.t += 1000; boot(phone); startWorkspaceSync();           // phone adopts REAL from cloud
    saveDevice(phone);
    return { laptop, phone };
  }

  // ============================================================
  //  S0 — source anchor
  // ============================================================
  scen('S0  seed() must stamp updatedAt:0 (regression anchor for the phone-login bug)');
  check('seed().updatedAt === 0', seed().updatedAt === 0, 'got ' + seed().updatedAt);
  check('a fresh seed scores less than the real data on work (13 vs 44)', wScore(seedN) < wScore(REALn), 'seed=' + wScore(seedN) + ' real=' + wScore(REALn));

  // ============================================================
  //  S1 — THE phone-login bug: a fresh device must never overwrite the cloud
  // ============================================================
  scen('S1  Fresh phone login adopts the cloud instead of wiping it');
  cloud.workspace = null; cloud.snapshots = [];
  const lap = newDevice('laptop');
  __clock.t += 1000; boot(lap); startWorkspaceSync();
  __clock.t += 1000; data = normalize(clone(REAL)); save(); saveDevice(lap);
  const cloudUpBefore = cloudWs().updatedAt;
  const cloudScoreBefore = wScore(cloudWs().data);

  const phone = newDevice('phone-fresh');
  __clock.t += 5000; boot(phone);
  check('fresh phone seeds at updatedAt 0', data.updatedAt === 0);
  startWorkspaceSync();                                              // <-- the moment the bug happened
  check('phone ADOPTS the cloud (work data intact)', wScore(data) === wScore(REALn), 'phone=' + wScore(data));
  check('phone got the personal data too', pScore(data) === pScore(REALn));
  check('cloud is UNCHANGED after the phone login', wScore(cloudWs().data) === cloudScoreBefore && cloudWs().updatedAt === cloudUpBefore);
  saveDevice(phone);

  // --- prove the OLD behaviour (seed stamped with Date.now()) would have lost the data,
  //     and that the shrink guard alone would NOT have caught it. We model the actual
  //     incident: WORK data (glossary / tasks / meetings) with no personal data, so the
  //     personal shrink guard can't fire — leaving the loss completely silent. (With
  //     personal data present the personal guard would keep a 'lost' copy, but the
  //     work-only path is exactly the one that bit, which is why updatedAt:0 is the fix.)
  scen('S1b Reproduce the ORIGINAL bug to prove updatedAt:0 is the essential fix');
  cloud.workspace = null; cloud.snapshots = [];
  const REALwork = clone(REAL); delete REALwork.personal;          // work-only, like the lost glossary/tasks/meetings
  const lap2 = newDevice('laptop2');
  __clock.t += 1000; boot(lap2); startWorkspaceSync();
  __clock.t += 1000; data = normalize(clone(REALwork)); save(); saveDevice(lap2);
  const phoneOld = newDevice('phone-OLD-seed');
  __clock.t += 1000; boot(phoneOld);
  data.updatedAt = __clock.t;                                       // the old bug: seed stamped "now"
  const lostBefore = stashCount(phoneOld, 'lost');
  const toastsBefore = __toasts.length;
  startWorkspaceSync();
  check('OLD seed overwrites the cloud → work data loss reproduced', wScore(cloudWs().data) <= wScore(seedN), 'cloud=' + wScore(cloudWs().data));
  check('shrink guard stays SILENT for a work-only seed-overwrite (no safety net) → why the timestamp fix matters', stashCount(phoneOld, 'lost') === lostBefore && __toasts.length === toastsBefore);

  // ============================================================
  //  S2 — convergence + monotonic clock
  // ============================================================
  scen('S2  Two devices converge; monotonic clock prevents lost edits');
  {
    const { laptop, phone } = setupSynced();
    // laptop adds a project
    useDevice(laptop); __clock.t += 1000; data.projects.push({ id: 'pNEW', name: 'Laptop project', category: CATEGORIES[0], tasks: [] }); save(); saveDevice(laptop);
    // phone syncs -> should pick it up
    useDevice(phone); startWorkspaceSync(); saveDevice(phone);
    check('phone adopted the laptop’s new project', data.projects.some(p => p.id === 'pNEW'));
    // phone adds a glossary term
    __clock.t += 1000; data.glossary.push({ id: 'gNEW', term: 'Phone term', definition: 'x' }); save(); saveDevice(phone);
    // laptop syncs -> converges with BOTH changes
    useDevice(laptop); startWorkspaceSync(); saveDevice(laptop);
    check('laptop converged: has both the new project AND the new glossary term',
      data.projects.some(p => p.id === 'pNEW') && data.glossary.some(g => g.id === 'gNEW'));

    // monotonic clock: frozen/backward clock still yields strictly increasing updatedAt
    useDevice(laptop); __clock.t = 999999; data.updatedAt = 999999;
    const u0 = data.updatedAt; save(); const u1 = data.updatedAt; save(); const u2 = data.updatedAt;
    check('updatedAt strictly increases even with a frozen clock', u1 > u0 && u2 > u1, u0 + '->' + u1 + '->' + u2);
  }

  // ============================================================
  //  S3 — shrink guard: sensitive to real wipes, quiet on normal edits
  // ============================================================
  scen('S3  Shrink guard catches a mass-delete but ignores a normal small edit');
  {
    const { laptop } = setupSynced();
    useDevice(laptop);
    const beforePrewipe = stashCount(laptop, 'prewipe');
    __toasts.length = 0; __sec.length = 0;
    __clock.t += 1000;
    data.projects = data.projects.slice(0, 1); data.glossary = []; data.meetings = []; data.tasks = []; // catastrophic delete
    data.projects[0].tasks = [];
    save();
    check('mass-delete triggers the shrink guard (prewipe safety copy kept)', stashCount(laptop, 'prewipe') === beforePrewipe + 1);
    check('user was warned about the large removal', __toasts.some(t => /removal|safety copy/i.test(t)));
    check('event logged as data_shrunk', __sec.some(e => e.t === 'data_shrunk'));

    // now a NORMAL edit must not trip the guard
    const { laptop: laptop2 } = setupSynced();
    useDevice(laptop2);
    const p0 = stashCount(laptop2, 'prewipe');
    __clock.t += 1000; data.projects[0].tasks.pop(); save();       // delete a single task
    check('a normal small edit does NOT trip the shrink guard', stashCount(laptop2, 'prewipe') === p0);
  }

  // ============================================================
  //  S4 — restore is authoritative and propagates
  // ============================================================
  scen('S4  Restore replaces data everywhere, keeps a pre-restore copy, and propagates');
  {
    const { laptop, phone } = setupSynced();
    useDevice(laptop);
    const prevUp = data.updatedAt;
    const beforePre = stashCount(laptop, 'prerestore');
    __toasts.length = 0;
    // a distinctive backup (similar size, different content — e.g. a recovered file)
    const backup = clone(REAL);
    backup.projects[0].name = 'RESTORED-MARKER';
    backup.glossary.push({ id: 'gRESTORE', term: 'restored-term', definition: 'x' });
    __clock.t += 1000;
    await restoreData(backup, 'file: RECOVERED.json');
    check('restore kept a pre-restore safety copy', stashCount(laptop, 'prerestore') === beforePre + 1);
    check('restore replaced the live data (marker present)', data.projects.some(p => p.name === 'RESTORED-MARKER'));
    check('restore did NOT raise a false shrink warning (expectedShrink)', !__toasts.some(t => /removal|smaller/i.test(t)));
    check('restore is authoritative (fresh, higher updatedAt)', data.updatedAt > prevUp);
    saveDevice(laptop);
    check('cloud now holds the restored copy', cloudWs().data.projects.some(p => p.name === 'RESTORED-MARKER'));
    // other device adopts the restored copy on next sync
    useDevice(phone); startWorkspaceSync(); saveDevice(phone);
    check('phone adopts the restored copy on next sync', data.projects.some(p => p.name === 'RESTORED-MARKER') && data.glossary.some(g => g.id === 'gRESTORE'));
  }

  // ============================================================
  //  S5 — IndexedDB mirror recovers after localStorage is wiped
  // ============================================================
  scen('S5  IndexedDB mirror recovers data after localStorage is cleared');
  {
    const C = newDevice('device-C');
    __clock.t += 1000; boot(C); startWorkspaceSync();
    __clock.t += 1000; data = normalize(clone(REAL)); save();       // writes localStorage + IDB mirror
    saveDevice(C);
    await flush();                                                  // let the async mirror write land
    check('localStorage main copy exists before the wipe', !!C.ls.getItem(STORAGE_KEY));

    C.ls = makeLS();                                                // simulate "clear site data" (localStorage only)
    boot(C);                                                        // reload -> localStorage empty -> non-authoritative seed
    check('after wipe, localStorage reseeds empty (updatedAt 0)', data.updatedAt === 0);
    await mirrorRestoreIfNewer();                                   // the boot-time recovery step
    check('data recovered from the IndexedDB mirror', wScore(data) === wScore(REALn), 'recovered=' + wScore(data));
    check('localStorage main copy was rewritten from the mirror', !!C.ls.getItem(STORAGE_KEY));
    check('user was told about the mirror recovery', __toasts.some(t => /mirror/i.test(t)));
  }

  // ============================================================
  //  S6 — bad-remote quarantine + personal-namespace isolation
  // ============================================================
  scen('S6  A corrupt remote is quarantined; a broken personal namespace can’t kill work');
  {
    const { laptop } = setupSynced();
    useDevice(laptop);
    const goodScore = wScore(data);
    const beforeBad = stashCount(laptop, 'badremote');
    // (a) a remote copy that fails to normalize (a null project row) must NOT replace working data
    const corrupt = { projects: [null], glossary: [], updatedAt: 9e15 };
    adoptRemote(corrupt);
    check('corrupt remote did NOT replace the working data', wScore(data) === goodScore);
    check('corrupt remote was quarantined as a badremote stash', stashCount(laptop, 'badremote') === beforeBad + 1);

    // (b) a remote whose PERSONAL namespace is corrupt must still load work fine (isolation)
    const badPersonal = clone(REAL);
    badPersonal.personal = { items: [null] };                       // would throw inside normalizePersonal
    badPersonal.updatedAt = 9e15;
    adoptRemote(badPersonal);
    check('work data adopted despite a corrupt personal namespace', wScore(data) === wScore(REALn));
    check('personal namespace preserved (not silently dropped)', data.personal && Array.isArray(data.personal.items));
  }

  // ============================================================
  //  S7 — concurrent edits resolve by last-write-wins (recoverability probe)
  // ============================================================
  scen('S7  Concurrent edits resolve by last-write-wins (+ recoverability probe)');
  {
    const { laptop, phone } = setupSynced();
    useDevice(phone); granted = false; __clock.t += 1000;          // phone edits OFFLINE (won't push)
    data.projects[0].tasks.push({ id: 'tPHONE', text: 'Phone-only task', done: false });
    save(); saveDevice(phone);
    useDevice(laptop); granted = true; __clock.t += 1000;          // laptop edits ONLINE, later
    data.glossary.push({ id: 'gLAP', term: 'Laptop term', definition: 'x' });
    save(); saveDevice(laptop);
    check('the online edit reached the cloud', cloudWs().data.glossary.some(g => g.id === 'gLAP'));
    useDevice(phone); granted = true; startWorkspaceSync(); saveDevice(phone);   // phone reconnects
    check('resolution is deterministic (phone adopted the newer cloud copy)', data.glossary.some(g => g.id === 'gLAP'));
    const phoneKept = data.projects[0].tasks.some(t => t.id === 'tPHONE');
    const recoverable = stashCount(phone, 'lost') > 0 || stashCount(phone, 'prewipe') > 0;
    if (!phoneKept && !recoverable) {
      __log.push('    ⚠ LIMITATION: the phone’s concurrent offline edit (to a *different* field) was dropped with NO local recovery copy.');
      __log.push('      Whole-blob last-write-wins + similar sizes don’t trip the shrink guard. Fix candidate: on every adopt, stash a pruned rolling copy of the replaced blob.');
    } else if (phoneKept) {
      __log.push('    ✓ note: the concurrent offline edit happened to survive this ordering.');
    } else {
      __log.push('    ✓ note: the concurrent edit was replaced, but a recovery copy was kept.');
    }
  }

  // ============================================================
  //  S8 — a returning stale device adopts the cloud, never clobbers it
  // ============================================================
  scen('S8  A returning device with OLDER local data adopts the cloud (never clobbers it)');
  {
    const { laptop, phone } = setupSynced();
    useDevice(phone); __clock.t += 1000; data.glossary.push({ id: 'gADV', term: 'advanced', definition: 'x' }); save(); saveDevice(phone);
    const cloudUp = cloudWs().updatedAt, cloudScore = wScore(cloudWs().data);
    useDevice(laptop); startWorkspaceSync(); saveDevice(laptop);   // laptop still holds its OLD copy
    check('stale laptop adopted the advanced cloud copy', data.glossary.some(g => g.id === 'gADV'));
    check('cloud was NOT overwritten by the stale device', cloudWs().updatedAt === cloudUp && wScore(cloudWs().data) === cloudScore);
  }

  // ============================================================
  //  S9 — monotonic high-water beats a stale-but-future timestamp
  // ============================================================
  scen('S9  After adopting a far-future updatedAt, local edits still win (monotonic high-water)');
  {
    const { laptop } = setupSynced();
    useDevice(laptop);
    const future = 4102444800000;                                  // year 2100
    adoptRemote({ ...clone(REAL), updatedAt: future });
    check('device adopted the far-future copy', data.updatedAt === future);
    __clock.t = 1000;                                              // our real clock is far behind
    data.glossary.push({ id: 'gFUT', term: 'after-future', definition: 'x' });
    save();
    check('a later local edit still gets a HIGHER updatedAt than the future copy', data.updatedAt > future, 'got ' + data.updatedAt);
  }

  // ============================================================
  //  S10 — cross-tab: newer wins, older ignored
  // ============================================================
  scen('S10 Cross-tab storage events adopt a newer copy and ignore an older one');
  {
    const { laptop } = setupSynced();
    useDevice(laptop);
    const storageEvent = json => { try { const d = JSON.parse(json); if ((d.updatedAt || 0) > (data.updatedAt || 0)) adoptRemote(d); } catch (e) {} };
    const newer = clone(data); newer.updatedAt = data.updatedAt + 5000; newer.glossary.push({ id: 'gTAB', term: 'from other tab', definition: 'x' });
    storageEvent(JSON.stringify(newer));
    check('a newer sibling tab’s copy is adopted', data.glossary.some(g => g.id === 'gTAB'));
    const older = clone(data); older.updatedAt = data.updatedAt - 5000; older.glossary = [];
    const scoreNow = wScore(data);
    storageEvent(JSON.stringify(older));
    check('an older sibling tab’s copy is ignored', wScore(data) === scoreNow);
  }

  // ============================================================
  //  S11 — degenerate / corrupt remotes never crash or wipe unrecoverably
  // ============================================================
  scen('S11 Degenerate / corrupt remotes never crash or silently wipe unrecoverably');
  {
    const { laptop } = setupSynced();
    useDevice(laptop);
    const good = wScore(data);
    const beforeLost = stashCount(laptop, 'lost');
    adoptRemote({ updatedAt: 9e15 });                              // an empty "newer" copy (a real "deleted everything")
    check('empty "newer" copy kept a recovery copy of the previous data', stashCount(laptop, 'lost') === beforeLost + 1);
    const lostKeys = Object.keys(laptop.ls).filter(k => k.startsWith(STORAGE_KEY + '_lost_')).sort();
    const lastLost = JSON.parse(laptop.ls[lostKeys[lostKeys.length - 1]]);
    check('the recovery copy actually contains the previous work data', scoreWork(blobCounts(lastLost)) === good);
    // garbage cross-tab messages must not crash or wipe
    useDevice(laptop); data = normalize(clone(REAL));
    const storageEvent = json => { try { const d = JSON.parse(json); if ((d.updatedAt || 0) > (data.updatedAt || 0)) adoptRemote(d); } catch (e) {} };
    const scoreNow = wScore(data);
    ['not json at all', '', 'null', '12345', '[]'].forEach(storageEvent);
    check('garbage cross-tab messages are ignored (data unchanged)', wScore(data) === scoreNow);
  }

  // ============================================================
  //  S12 — normalize is idempotent; round-trips don't drift the data
  // ============================================================
  scen('S12 normalize is idempotent — repeated syncs never drift item counts');
  {
    const once = blobCounts(normalize(clone(REAL)));
    const twice = blobCounts(normalize(normalize(clone(REAL))));
    check('normalize(normalize(x)) has identical counts to normalize(x)', JSON.stringify(once) === JSON.stringify(twice));
    const { laptop, phone } = setupSynced();
    useDevice(laptop); const lc = blobCounts(data);
    useDevice(phone); startWorkspaceSync();
    check('a save→push→adopt round-trip preserves item counts exactly', JSON.stringify(blobCounts(data)) === JSON.stringify(lc), JSON.stringify(blobCounts(data)));
  }

  // ============================================================
  //  S13 — a full local disk (quota) still syncs to the cloud
  // ============================================================
  scen('S13 A full local disk (quota exceeded) still syncs to the cloud — nothing lost');
  {
    const { laptop } = setupSynced();
    useDevice(laptop);
    const qLS = makeLS();
    qLS.setItem = function (k, v) { if (k === STORAGE_KEY) { const e = new Error('QuotaExceeded'); e.name = 'QuotaExceededError'; throw e; } this[k] = String(v); };
    // seed the quota-LS with the current main copy path minus the main key (so shrink-guard read is clean)
    localStorage = qLS; laptop.ls = qLS;
    __toasts.length = 0; __clock.t += 1000;
    data.glossary.push({ id: 'gQUOTA', term: 'Quota term', definition: 'x' });
    save();
    check('data still synced to the cloud despite the full local disk', cloudWs().data.glossary.some(g => g.id === 'gQUOTA'));
    check('user was warned the device storage is full', __toasts.some(t => /full/i.test(t)));
    check('in-memory data is intact (not lost by the failed write)', data.glossary.some(g => g.id === 'gQUOTA'));
  }

  // ============================================================
  //  S14 — the sync indicator tells the truth
  // ============================================================
  scen('S14 Sync indicator: "Synced" only after the cloud confirms (else "could be lost")');
  {
    check('signed-out → "Local only"', syncView(false, true, false, false).text === 'Local only');
    check('no pending changes → "Synced" (green)', syncView(false, true, false, true).cls === 'ok');
    check('pending + offline → "Not synced" (could be lost)', syncView(true, false, false, true).cls === 'err' && /not synced/i.test(syncView(true, false, false, true).text));
    check('pending + online → "Saving…"', syncView(true, true, false, true).cls === 'sync');
    check('pending + push error → "Not synced" (retrying)', syncView(true, true, true, true).cls === 'err');
    // end-to-end: an edit stays PENDING until the cloud transaction is acknowledged
    const { laptop } = setupSynced();
    useDevice(laptop); await flush();
    lastSyncedUp = data.updatedAt;                    // baseline: fully synced
    __clock.t += 1000; data.glossary.push({ id: 'gIND', term: 'indicator', definition: 'x' });
    save();                                           // local edit + push (ack resolves async)
    check('right after an edit, state is PENDING (not yet confirmed in the cloud)', data.updatedAt > lastSyncedUp);
    await flush();
    check('after the cloud acknowledges the write, state becomes SYNCED', lastSyncedUp >= data.updatedAt);
  }

  // ============================================================
  //  S15 — cloud/schema failures can never kill UI paths
  //  (regression: the `snapshots` entity was missing from the InstantDB schema,
  //   so queryOnce threw synchronously inside openSec → the Security modal never
  //   opened → the shield AND account buttons both appeared dead when signed in)
  // ============================================================
  scen('S15 A throwing cloud call can never kill a UI path (dead shield/account buttons regression)');
  {
    const { laptop } = setupSynced();
    useDevice(laptop);
    const origQ = convex.query;
    convex.query = () => { throw new Error('validation: could not find function "snapshots:list"'); };
    let threw = false, result = 'unset';
    try { result = await cloudQuery('snapshots:list'); } catch (e) { threw = true; }
    check('cloudQuery does NOT throw when the underlying query throws synchronously', !threw);
    check('…and resolves to null so callers degrade gracefully', result === null, String(result));
    convex.query = () => Promise.reject(new Error('Not signed in.'));
    let threw2 = false, result2 = 'unset';
    try { result2 = await cloudQuery('snapshots:list'); } catch (e) { threw2 = true; }
    check('cloudQuery also absorbs async rejections (e.g. permission denied)', !threw2 && result2 === null);
    convex.query = origQ;
    // a snapshot attempt against a broken cloud must fail soft, not crash
    const okBefore = wScore(data);
    const origM = convex.mutation;
    convex.mutation = () => { throw new Error('validation: unknown function snapshots:add'); };
    let snapThrew = false, snapOk = 'unset';
    try { snapOk = await maybeCloudSnapshot(true); } catch (e) { snapThrew = true; }
    check('maybeCloudSnapshot fails SOFT when the cloud rejects it', !snapThrew && snapOk === false);
    check('…and the working data is untouched', wScore(data) === okBefore);
    // and push() against a failing cloud never throws (the pill just shows "retrying")
    convex.mutation = () => Promise.reject(new Error('boom'));
    let pushThrew = false; try { push(); await flush(); } catch (e) { pushThrew = true; }
    convex.mutation = origM;
    check('push() against a failing cloud never throws', !pushThrew);
  }

  // ============================================================
  //  S17 — structured meeting notes migrate legacy text without EVER losing it
  // ============================================================
  scen('S17 Meeting-notes migration: legacy free-text → "What was discussed?", never dropped');
  {
    const blob = normalize(clone({
      projects: [{ id: 'mp', name: 'M', meetingNotes: [
        { id: 'a', date: '2026-07-01', text: 'legacy project note\n- do X' },                 // legacy → discussed
        { id: 'b', date: '2026-07-02', text: 'from the old field', discussed: 'already here' }, // must APPEND, not overwrite
        { id: 'c', date: '2026-07-03', discussed: 'new fmt', steps: '- s1\n✓ done one', jumps: 'j1' }, // string steps → checklist
        { id: 'd', date: '2026-07-05', steps: [{ id: 's', text: 'already an item', done: true }] },     // array steps kept
      ] }],
      meetings: [{ id: 'mm', name: 'MM', entries: [
        { id: 'e', date: '2026-07-04', agenda: 'agenda kept', notes: 'legacy meeting notes' },   // legacy notes → discussed, agenda kept
      ] }],
    }));
    const a = blob.projects[0].meetingNotes.find(n => n.id === 'a');
    const b = blob.projects[0].meetingNotes.find(n => n.id === 'b');
    const c = blob.projects[0].meetingNotes.find(n => n.id === 'c');
    const d = blob.projects[0].meetingNotes.find(n => n.id === 'd');
    const e = blob.meetings[0].entries.find(n => n.id === 'e');
    check('legacy project "text" moved into discussed', a.discussed.includes('legacy project note'));
    check('legacy "text" key is removed (idempotent)', !('text' in a));
    check('every note gains the three sections; steps is now a checklist array', ['discussed', 'jumps'].every(k => k in a) && Array.isArray(a.steps) && Array.isArray(e.steps));
    check('legacy text APPENDS when discussed already had content (no overwrite, no loss)', b.discussed.includes('already here') && b.discussed.includes('from the old field'));
    check('string "steps" migrate to checklist items, preserving ✓ done-state', c.steps.length === 2 && c.steps[0].text === 's1' && c.steps[0].done === false && c.steps[1].text === 'done one' && c.steps[1].done === true);
    check('array "steps" are kept as-is (id/text/done)', d.steps.length === 1 && d.steps[0].text === 'already an item' && d.steps[0].done === true);
    check('legacy meeting-entry "notes" moved into discussed, agenda preserved', e.discussed.includes('legacy meeting notes') && e.agenda === 'agenda kept' && !('notes' in e));
    // idempotency: normalizing again must not duplicate migrated text or re-split steps
    const twice = normalize(clone(blob));
    const b2 = twice.projects[0].meetingNotes.find(n => n.id === 'b');
    const c2 = twice.projects[0].meetingNotes.find(n => n.id === 'c');
    check('re-normalizing does NOT duplicate migrated text', (b2.discussed.match(/from the old field/g) || []).length === 1);
    check('re-normalizing keeps steps as a stable 2-item checklist (no re-split)', c2.steps.length === 2 && c2.steps[1].done === true);
  }

  // ============================================================
  //  S18 — first-activity prep migrates from legacy string to a checklist (never lost)
  // ============================================================
  scen('S18 First-activity prep: legacy string → checklist, firstDone/firstBarrier preserved');
  {
    const blob = normalize(clone({
      personal: { dayPlans: {
        '2026-07-01': { firstThing: 'Write', firstPrep: 'open doc\nphone away', firstDone: true, firstBarrier: '' },
        '2026-07-02': { firstThing: 'Run', firstPrep: [{ id: 'x', text: 'shoes out', done: true }], firstDone: false, firstBarrier: 'tired' },
      } },
    }));
    const d1 = blob.personal.dayPlans['2026-07-01'];
    const d2 = blob.personal.dayPlans['2026-07-02'];
    check('legacy string firstPrep becomes a 2-item checklist', Array.isArray(d1.firstPrep) && d1.firstPrep.length === 2 && d1.firstPrep[0].text === 'open doc' && d1.firstPrep[1].text === 'phone away');
    check('firstDone and firstBarrier are preserved', d1.firstDone === true && d2.firstDone === false && d2.firstBarrier === 'tired');
    check('an already-array firstPrep is kept as-is (id/text/done)', d2.firstPrep.length === 1 && d2.firstPrep[0].text === 'shoes out' && d2.firstPrep[0].done === true);
    const twice = normalize(clone(blob));
    check('re-normalizing keeps the checklist stable (no re-split, no loss)', twice.personal.dayPlans['2026-07-01'].firstPrep.length === 2);
  }

  // ============================================================
  //  S19 — carry-over model: entries get a `since` origin; dayPlans get rolledCount
  // ============================================================
  scen('S19 Carry-over model: entry `since` origin date + dayPlan rolledCount');
  {
    const blob = normalize(clone({
      personal: { dayPlans: {
        '2026-07-10': { entries: [{ id: 'e1', itemId: 'i1', done: false }, { id: 'e2', itemId: 'i2', done: false, since: '2026-07-05' }] },
        '2026-07-11': { meetups: [{ id: 'm', personId: 'p', status: 'planned' }] },
      } },
    }));
    const d = blob.personal.dayPlans['2026-07-10'];
    check('an entry with no `since` defaults to its own day', d.entries[0].since === '2026-07-10');
    check('an entry with an existing `since` is preserved (age origin never lost)', d.entries[1].since === '2026-07-05');
    check('every dayPlan gains rolledCount:0', d.rolledCount === 0);
    check('meetups also get a `since`', blob.personal.dayPlans['2026-07-11'].meetups[0].since === '2026-07-11');
  }

  // ============================================================
  //  S20 — plain-text smart lists (meeting notes / project notes / week prep textareas)
  // ============================================================
  scen('S20 Plain-text smart lists: Enter continues + renumbers, Tab indents, Backspace removes an empty marker');
  {
    const r1 = listEnter('- apple', 7);           check('bullet continues on Enter', !!r1 && r1.value === '- apple\n- ' && r1.pos === 10, r1 && JSON.stringify(r1));
    const r2 = listEnter('1. one', 6);            check('numbered list increments (1. → 2.)', !!r2 && r2.value === '1. one\n2. ');
    const r3 = listEnter('1) one', 6);            check('"1)" style increments too', !!r3 && r3.value === '1) one\n2) ');
    const r4 = listEnter('- ', 2);                check('Enter on an empty item ends the list', !!r4 && r4.value === '' && r4.pos === 0);
    const r5 = listEnter('1. a\n2. b\n3. c', 4);  check('inserting mid-list renumbers the lines below', !!r5 && r5.value === '1. a\n2. \n3. b\n4. c', r5 && JSON.stringify(r5.value));
    const r6 = listEnter('  - x', 5);             check('indentation is preserved on the new item', !!r6 && r6.value === '  - x\n  - ');
    const r7 = listEnter('- hello world', 7);     check('splitting mid-line moves the rest onto the new item', !!r7 && r7.value === '- hello\n- world' && r7.pos === 10, r7 && JSON.stringify(r7));
    check('a normal line is left alone on Enter', listEnter('plain text', 10) === null);
    const t1 = listTab('- a', 3, 3, false);        check('Tab indents a list line', !!t1 && t1.value === '  - a' && t1.selStart === 5);
    const t2 = listTab('  - a', 5, 5, true);       check('Shift+Tab outdents', !!t2 && t2.value === '- a' && t2.selStart === 3);
    check('Tab on a non-list line is not intercepted', listTab('plain', 5, 5, false) === null);
    const t3 = listTab('- a\n- b', 0, 7, false);   check('Tab with a multi-line selection indents every line', !!t3 && t3.value === '  - a\n  - b', t3 && JSON.stringify(t3.value));
    const b1 = listBackspace('- ', 2);             check('Backspace on an empty item removes the marker', !!b1 && b1.value === '' && b1.pos === 0);
    check('Backspace inside a real item behaves normally', listBackspace('- a', 3) === null);
    const a1 = listAutoFormat('- ', 2);           check('typing "- " becomes an indented bullet "  • "', !!a1 && a1.value === '  • ' && a1.pos === 4, a1 && JSON.stringify(a1));
    const a2 = listAutoFormat('* ', 2);           check('"* " becomes a bullet too', !!a2 && a2.value === '  • ');
    const a3 = listAutoFormat('1. ', 3);          check('"1. " becomes an indented numbered item', !!a3 && a3.value === '  1. ' && a3.pos === 5);
    const a4 = listAutoFormat('1) ', 3);          check('"1) " style works too', !!a4 && a4.value === '  1) ');
    const a5 = listAutoFormat('    - ', 6);       check('an existing indent is respected (no extra indent)', !!a5 && a5.value === '    • ');
    const a6 = listAutoFormat('- hello', 2);      check('converting before existing text keeps the text', !!a6 && a6.value === '  • hello' && a6.pos === 4);
    check('mid-line "- " is NOT a list trigger', listAutoFormat('say - ', 6) === null);
    check('a year like "2026. " does NOT become a list', listAutoFormat('2026. ', 6) === null);
    check('already-formatted "  • " does not re-trigger', listAutoFormat('  • ', 4) === null);
    const chain = listEnter('  • first', 9);      check('the converted bullet then continues on Enter', !!chain && chain.value === '  • first' + String.fromCharCode(10) + '  • ');
  }

  // ===== report =====
  __log.push('\n' + '─'.repeat(60));
  __log.push('  ' + __pass + ' passed, ' + __fail + ' failed');
  console.log(__log.join('\n'));
  return { pass: __pass, fail: __fail };
}

/* ---- run the harness in a vm with the real code injected ---- */
const body = HARNESS.toString().replace('/*__REAL__*/', REAL_CODE);
const ctx = vm.createContext({
  console: { log: console.log, warn: () => {}, error: () => {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
  queueMicrotask,
  crypto: globalThis.crypto,
});
vm.runInContext('var __run = (' + body + ')();', ctx, { filename: 'e2e-harness.js' });
const res = await ctx.__run;

/* ---- S16 (static): every "module:function" the app calls must exist as an export in convex/<module>.ts,
        every table the backend uses must be in convex/schema.ts, and the UI hardening that ended the
        dead-buttons incident must stay. (Replaces the old 4-layer InstantDB schema/perms check.) ---- */
console.log('\nS16 Static: frontend ↔ backend consistency (index.html calls ↔ convex/*.ts exports, schema, hardening)');
let sPass = 0, sFail = 0;
const sCheck = (n, c) => { if (c) { sPass++; console.log('  ✓ ' + n); } else { sFail++; console.log('  ✗ FAIL: ' + n); } };
const calls = [...new Set([
  ...[...src.matchAll(/convex\.(?:mutation|query|action|onUpdate)\(\s*"([a-zA-Z]+):([a-zA-Z]+)"/g)].map(m => m[1] + ':' + m[2]),
  ...[...src.matchAll(/cloudQuery\(\s*"([a-zA-Z]+):([a-zA-Z]+)"/g)].map(m => m[1] + ':' + m[2]),
])].sort();
sCheck('the app calls a realistic number of backend functions (≥ 12)', calls.length >= 12);
const modCache = {};
const modSrc = m => (modCache[m] ??= (() => { try { return readFileSync(join(__dirname, '..', 'convex', m + '.ts'), 'utf8'); } catch { return ''; } })());
for (const fn of calls) {
  const [mod, name] = fn.split(':');
  sCheck(`"${fn}" is exported by convex/${mod}.ts`, new RegExp('export const ' + name + '\\s*=\\s*(query|mutation|action)\\(').test(modSrc(mod)));
}
const schemaTs = readFileSync(join(__dirname, '..', 'convex', 'schema.ts'), 'utf8');
for (const t of ['workspaces', 'snapshots', 'securityLog', 'devices', 'otps', 'sessions']) sCheck(`table "${t}" is defined in convex/schema.ts`, new RegExp(t + ':\\s*defineTable\\(').test(schemaTs));
const libTs = readFileSync(join(__dirname, '..', 'convex', 'lib.ts'), 'utf8');
sCheck('ADMIN_EMAIL matches between index.html and convex/lib.ts', (src.match(/const ADMIN_EMAIL = "([^"]+)"/) || [])[1] === (libTs.match(/ADMIN_EMAIL = "([^"]+)"/) || [])[1]);
sCheck('data functions require a TRUSTED device server-side (requireTrusted/trustedOrNull in workspace.ts & snapshots.ts)', /requireTrusted|trustedOrNull/.test(modSrc('workspace')) && /requireTrusted|trustedOrNull/.test(modSrc('snapshots')));
sCheck('no InstantDB client code remains in index.html', !/\bdb\.(transact|subscribeQuery|queryOnce|auth)\b|instantdb\.com|i\.schema\(|INSTANT_APP_ID/.test(src));
sCheck('CSP allows the Convex backend and no longer InstantDB/Google', /connect-src[^"]*https:\/\/\*\.convex\.cloud wss:\/\/\*\.convex\.cloud/.test(src) && !/instantdb\.com|accounts\.google\.com/.test(src.slice(0, 3000)));
sCheck('openSec() is hardened (renderers wrapped in try/catch)', src.includes('try{ renderSecurity(); }catch') && src.includes('try{ renderRestorePoints(); }catch'));
sCheck('cloudQuery is hardened (synchronous throws absorbed)', /function cloudQuery\(name, args\)\{[^]*?try\{/.test(src));
sCheck('a fresh device never seeds the cloud with an untouched seed (updatedAt 0 guard in startWorkspaceSync)', /if\(\(data\.updatedAt\|\|0\) > 0\) push\(\); else renderSync\(\);/.test(src));
console.log('  ' + sPass + ' passed, ' + sFail + ' failed');

const totalPass = res.pass + sPass, totalFail = res.fail + sFail;
if (totalFail > 0) { console.log('\n❌ ' + totalFail + ' check(s) failed'); process.exit(1); }
console.log('\n✅ all ' + totalPass + ' checks passed');
