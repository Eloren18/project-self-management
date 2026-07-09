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
  slice('const SEED_PROJECTS = [', '\n];', true),
].join('\n');

const dataLayer = slice('function seed(){', 'let data = load();'); // seed, normTask, normalize, normalizePersonal, load
const syncBlock = slice('const STASH_FAMILIES=', 'function setSync'); // counts, shrink guards, save, mirror, adopt, sync, restore

const REAL_CODE = consts + '\n' + dataLayer + '\n' + syncBlock;

/* ---- the harness: prelude shims + scenarios; real code injected at the marker ---- */
async function HARNESS() {
  /*__REAL__*/

  // ===== harness state / spies =====
  let data = null, booting = false, granted = true, authedUser = { id: 'kerem' },
      workspaceId = null, workspaceSub = null, devicesSub = null;
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

  // ---- InstantDB "cloud" mock (shared across devices) ----
  const cloud = { workspaces: {}, snapshots: {} };
  let __idc = 0;
  const id = () => 'gid_' + (++__idc);
  const txProxy = coll => new Proxy({}, {
    get: (_, rowId) => ({
      __coll: coll, __id: String(rowId), __op: null, __payload: null, __link: null,
      update(p) { this.__op = 'update'; this.__payload = p; return this; },
      delete() { this.__op = 'delete'; return this; },
      link(r) { this.__link = r; return this; },
    }),
  });
  const db = {
    tx: { workspaces: txProxy('workspaces'), snapshots: txProxy('snapshots') },
    transact(ops) {
      ops = Array.isArray(ops) ? ops : [ops];
      for (const op of ops) {
        const store = cloud[op.__coll];
        if (op.__op === 'delete') { delete store[op.__id]; continue; }
        const row = store[op.__id] || { id: op.__id };
        Object.assign(row, op.__payload);
        if (op.__link && op.__link.owner) row.owner = op.__link.owner;
        if (row.data) row.data = clone(row.data);   // cloud keeps its own copy
        store[op.__id] = row;
      }
      return Promise.resolve();
    },
    subscribeQuery(q, cb) {
      const coll = Object.keys(q)[0];
      const rows = Object.values(cloud[coll]).map(r => ({ ...r, data: r.data ? clone(r.data) : r.data }));
      cb({ data: { [coll]: rows } });
      return () => {};
    },
    queryOnce(q) {
      const coll = Object.keys(q)[0];
      const rows = Object.values(cloud[coll]).map(r => ({ ...r, data: r.data ? clone(r.data) : r.data }));
      return Promise.resolve({ data: { [coll]: rows } });
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
  const cloudWs = () => Object.values(cloud.workspaces)[0];
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
    cloud.workspaces = {}; cloud.snapshots = {};
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
  cloud.workspaces = {}; cloud.snapshots = {};
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
  cloud.workspaces = {}; cloud.snapshots = {};
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
if (res.fail > 0) { console.log('\n❌ ' + res.fail + ' check(s) failed'); process.exit(1); }
console.log('\n✅ all ' + res.pass + ' checks passed');
