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
const noteBlock = slice('/* ---- note text ⇄ HTML converters', '/* ---- end note converters ---- */'); // pure note converters (plainToHTML / htmlToText / noteText)

const REAL_CODE = consts + '\n' + dataLayer + '\n' + syncBlock + '\n' + noteBlock;

/* ---- the harness: prelude shims + scenarios; real code injected at the marker ---- */
async function HARNESS() {
  /*__REAL__*/

  // ===== harness state / spies =====
  let data = null, booting = false, granted = true, authedUser = { email: 'keremladkeholland@gmail.com' },
      workspaceId = null, workspaceSub = null, devicesSub = null, logSub = null;
  let sessionToken = 'tok_test'; let deviceId = 'dev_test';     // a signed-in, trusted test device (useDevice gives each simulated device its own id)
  let __toasts = [], __sec = [];
  const __clock = { t: 1000 };
  Date.now = () => __clock.t;                       // deterministic, tie-free virtual clock
  const clone = x => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const toast = m => { __toasts.push(String(m)); };
  const logSec = (t, info) => { __sec.push({ t, info }); };
  const applyTheme = () => {};
  const renderAll = () => {};
  const setSync = () => {};
  const __realSchedulePush = schedulePush; schedulePush = () => push();   // most scenarios want the old immediate push; S22 restores the real batching scheduler

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
  const verRow = () => cloud.workspace ? { updatedAt: cloud.workspace.updatedAt, writerDeviceId: cloud.workspace.writerDeviceId || '' } : { updatedAt: 0, writerDeviceId: '' };
  const convex = {
    mutation(name, args) {
      try {
        if (name === 'workspace:save') {
          const row = cloud.workspace;
          if (!row) { cloud.workspace = { data: args.data, updatedAt: args.updatedAt, writerDeviceId: args.deviceId }; return Promise.resolve({ accepted: true, updatedAt: args.updatedAt }); }
          if (args.updatedAt === row.updatedAt) return Promise.resolve({ accepted: true, updatedAt: args.updatedAt });   // idempotent re-push: the server writes nothing
          if (args.updatedAt > row.updatedAt) { row.data = args.data; row.updatedAt = args.updatedAt; row.writerDeviceId = args.deviceId; return Promise.resolve({ accepted: true, updatedAt: args.updatedAt }); }
          return Promise.resolve({ accepted: false, updatedAt: row.updatedAt });   // stale write ignored, like the server
        }
        if (name === 'snapshots:add') { cloud.snapshots.push({ id: newId('snap'), ts: args.ts, updatedAt: args.updatedAt, label: args.label, data: args.data, bytes: args.data.length, force: !!args.force }); cloud.snapshots.sort((a, b) => b.ts - a.ts); cloud.snapshots = cloud.snapshots.slice(0, 30); return Promise.resolve({ kept: cloud.snapshots.length }); }
        if (name === 'securityLog:add') { cloud.securityLog.push({ id: newId('log'), ts: Date.now(), event: args.event, detail: args.detail, deviceId: args.deviceId }); return Promise.resolve(); }
        return Promise.resolve();
      } catch (e) { return Promise.reject(e); }
    },
    query(name, args) {
      if (name === 'workspace:get') return Promise.resolve(wsRow());          // one-shot blob fetch (only after a foreign version tick)
      if (name === 'workspace:version') return Promise.resolve(verRow());
      if (name === 'snapshots:list') return Promise.resolve(cloud.snapshots.map(s => ({ id: s.id, ts: s.ts, updatedAt: s.updatedAt, label: s.label, bytes: s.data.length })));
      if (name === 'snapshots:get') { const s = cloud.snapshots.find(x => x.id === (args && args.id)); return Promise.resolve(s ? { data: s.data, ts: s.ts, updatedAt: s.updatedAt, label: s.label } : null); }
      return Promise.resolve(null);
    },
    action() { return Promise.resolve({}); },
    onUpdate(name, args, cb) {   // a real subscription fires immediately with the current value
      if (name === 'workspace:version') { cloud.verCb = cb; cb(verRow()); }   // devices subscribe to the tiny version record; verCb lets a test replay a later tick
      else if (name === 'workspace:get') { cloud.wsCb = cb; cb(wsRow()); }        // (legacy shape — the app no longer subscribes to the blob)
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
  function useDevice(d) { data = d.data; localStorage = d.ls; indexedDB = d.idb; window.indexedDB = d.idb; workspaceId = d.workspaceId; workspaceSub = null; booting = false; granted = true; authedUser = { id: 'kerem' };
    deviceId = d.name; verSeen = 0; lastSyncedUp = 0; pushInFlight = 0; pushDirty = false; pushDirtySince = 0; pushTimer = 0; }   // per-device runtime state (in the real app each browser has its own)
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
  async function setupSynced() {
    cloud.workspace = null; cloud.snapshots = [];
    const laptop = newDevice('laptop');
    __clock.t += 1000; await flush(); boot(laptop); startWorkspaceSync(); await flush();          // cloud seeded with laptop's seed
    __clock.t += 1000; data = normalize(clone(REAL)); save();       // cloud <- REAL (authoritative)
    saveDevice(laptop);
    const phone = newDevice('phone');
    __clock.t += 1000; await flush(); boot(phone); startWorkspaceSync(); await flush();           // phone adopts REAL from cloud
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
  __clock.t += 1000; await flush(); boot(lap); startWorkspaceSync(); await flush();
  __clock.t += 1000; data = normalize(clone(REAL)); save(); saveDevice(lap);
  const cloudUpBefore = cloudWs().updatedAt;
  const cloudScoreBefore = wScore(cloudWs().data);

  const phone = newDevice('phone-fresh');
  __clock.t += 5000; await flush(); boot(phone);
  check('fresh phone seeds at updatedAt 0', data.updatedAt === 0);
  startWorkspaceSync(); await flush();                                              // <-- the moment the bug happened
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
  __clock.t += 1000; await flush(); boot(lap2); startWorkspaceSync(); await flush();
  __clock.t += 1000; data = normalize(clone(REALwork)); save(); saveDevice(lap2);
  const phoneOld = newDevice('phone-OLD-seed');
  __clock.t += 1000; await flush(); boot(phoneOld);
  data.updatedAt = __clock.t;                                       // the old bug: seed stamped "now"
  const lostBefore = stashCount(phoneOld, 'lost');
  const toastsBefore = __toasts.length;
  startWorkspaceSync(); await flush();
  check('the stale-stamp overwrite is now BLOCKED — cloud survives untouched', wScore(cloudWs().data) === wScore(normalize(clone(REALwork))), 'cloud=' + wScore(cloudWs().data));
  check('the blocked device kept its own copy as a restore point + was warned', stashCount(phoneOld, 'lost') === lostBefore + 1 && __toasts.length > toastsBefore);
  check('…and the blocked device adopted the cloud copy', wScore(data) === wScore(normalize(clone(REALwork))));
  // once the device HAS seen the cloud, a later edit pushes normally again
  __clock.t += 1000; data.glossary.push({ id: 'gAFTER', term: 'post-block edit', definition: 'x' }); save();
  check('after adopting, normal edits push to the cloud again', cloudWs().data.glossary.some(g => g.id === 'gAFTER'));

  // ============================================================
  //  S2 — convergence + monotonic clock
  // ============================================================
  scen('S2  Two devices converge; monotonic clock prevents lost edits');
  {
    const { laptop, phone } = await setupSynced();
    // laptop adds a project
    await flush(); useDevice(laptop); __clock.t += 1000; data.projects.push({ id: 'pNEW', name: 'Laptop project', category: CATEGORIES[0], tasks: [] }); save(); saveDevice(laptop);
    // phone syncs -> should pick it up
    await flush(); useDevice(phone); startWorkspaceSync(); await flush(); saveDevice(phone);
    check('phone adopted the laptop’s new project', data.projects.some(p => p.id === 'pNEW'));
    // phone adds a glossary term
    __clock.t += 1000; data.glossary.push({ id: 'gNEW', term: 'Phone term', definition: 'x' }); save(); saveDevice(phone);
    // laptop syncs -> converges with BOTH changes
    await flush(); useDevice(laptop); startWorkspaceSync(); await flush(); saveDevice(laptop);
    check('laptop converged: has both the new project AND the new glossary term',
      data.projects.some(p => p.id === 'pNEW') && data.glossary.some(g => g.id === 'gNEW'));

    // monotonic clock: frozen/backward clock still yields strictly increasing updatedAt
    await flush(); useDevice(laptop); __clock.t = 999999; data.updatedAt = 999999;
    const u0 = data.updatedAt; save(); const u1 = data.updatedAt; save(); const u2 = data.updatedAt;
    check('updatedAt strictly increases even with a frozen clock', u1 > u0 && u2 > u1, u0 + '->' + u1 + '->' + u2);
  }

  // ============================================================
  //  S3 — shrink guard: sensitive to real wipes, quiet on normal edits
  // ============================================================
  scen('S3  Shrink guard catches a mass-delete but ignores a normal small edit');
  {
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop);
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
    const { laptop: laptop2 } = await setupSynced();
    await flush(); useDevice(laptop2);
    const p0 = stashCount(laptop2, 'prewipe');
    __clock.t += 1000; data.projects[0].tasks.pop(); save();       // delete a single task
    check('a normal small edit does NOT trip the shrink guard', stashCount(laptop2, 'prewipe') === p0);
  }

  // ============================================================
  //  S4 — restore is authoritative and propagates
  // ============================================================
  scen('S4  Restore replaces data everywhere, keeps a pre-restore copy, and propagates');
  {
    const { laptop, phone } = await setupSynced();
    await flush(); useDevice(laptop);
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
    await flush(); useDevice(phone); startWorkspaceSync(); await flush(); saveDevice(phone);
    check('phone adopts the restored copy on next sync', data.projects.some(p => p.name === 'RESTORED-MARKER') && data.glossary.some(g => g.id === 'gRESTORE'));
  }

  // ============================================================
  //  S5 — IndexedDB mirror recovers after localStorage is wiped
  // ============================================================
  scen('S5  IndexedDB mirror recovers data after localStorage is cleared');
  {
    const C = newDevice('device-C');
    __clock.t += 1000; await flush(); boot(C); startWorkspaceSync(); await flush();
    __clock.t += 1000; data = normalize(clone(REAL)); save();       // writes localStorage + IDB mirror
    saveDevice(C);
    await flush();                                                  // let the async mirror write land
    check('localStorage main copy exists before the wipe', !!C.ls.getItem(STORAGE_KEY));

    C.ls = makeLS();                                                // simulate "clear site data" (localStorage only)
    await flush(); boot(C);                                                        // reload -> localStorage empty -> non-authoritative seed
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
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop);
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
    const { laptop, phone } = await setupSynced();
    await flush(); useDevice(phone); granted = false; __clock.t += 1000;          // phone edits OFFLINE (won't push)
    data.projects[0].tasks.push({ id: 'tPHONE', text: 'Phone-only task', done: false });
    save(); saveDevice(phone);
    await flush(); useDevice(laptop); granted = true; __clock.t += 1000;          // laptop edits ONLINE, later
    data.glossary.push({ id: 'gLAP', term: 'Laptop term', definition: 'x' });
    save(); saveDevice(laptop);
    check('the online edit reached the cloud', cloudWs().data.glossary.some(g => g.id === 'gLAP'));
    await flush(); useDevice(phone); granted = true; startWorkspaceSync(); await flush(); saveDevice(phone);   // phone reconnects
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
    const { laptop, phone } = await setupSynced();
    await flush(); useDevice(phone); __clock.t += 1000; data.glossary.push({ id: 'gADV', term: 'advanced', definition: 'x' }); save(); saveDevice(phone);
    const cloudUp = cloudWs().updatedAt, cloudScore = wScore(cloudWs().data);
    await flush(); useDevice(laptop); startWorkspaceSync(); await flush(); saveDevice(laptop);   // laptop still holds its OLD copy
    check('stale laptop adopted the advanced cloud copy', data.glossary.some(g => g.id === 'gADV'));
    check('cloud was NOT overwritten by the stale device', cloudWs().updatedAt === cloudUp && wScore(cloudWs().data) === cloudScore);
  }

  // ============================================================
  //  S9 — monotonic high-water beats a stale-but-future timestamp
  // ============================================================
  scen('S9  After adopting a far-future updatedAt, local edits still win (monotonic high-water)');
  {
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop);
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
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop);
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
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop);
    const good = wScore(data);
    const beforeLost = stashCount(laptop, 'lost');
    adoptRemote({ updatedAt: 9e15 });                              // an empty "newer" copy (a real "deleted everything")
    check('empty "newer" copy kept a recovery copy of the previous data', stashCount(laptop, 'lost') === beforeLost + 1);
    const lostKeys = Object.keys(laptop.ls).filter(k => k.startsWith(STORAGE_KEY + '_lost_')).sort();
    const lastLost = JSON.parse(laptop.ls[lostKeys[lostKeys.length - 1]]);
    check('the recovery copy actually contains the previous work data', scoreWork(blobCounts(lastLost)) === good);
    // garbage cross-tab messages must not crash or wipe
    await flush(); useDevice(laptop); data = normalize(clone(REAL));
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
    const { laptop, phone } = await setupSynced();
    await flush(); useDevice(laptop); const lc = blobCounts(data);
    await flush(); useDevice(phone); startWorkspaceSync(); await flush();
    check('a save→push→adopt round-trip preserves item counts exactly', JSON.stringify(blobCounts(data)) === JSON.stringify(lc), JSON.stringify(blobCounts(data)));

    // quarter goals (Year Plan): sanitized by normalize, counted by the shrink guard, synced with the blob
    const qd = normalize({ quarterGoals: { '2026-Q1': [{ text: 'Ship X' }, { id: 'g2', done: 1 }], '2026-Q2': 'garbage', '2026-Q3': [] } });
    check('quarterGoals entries are sanitized (id/text/done filled in)', qd.quarterGoals['2026-Q1'].every(g => typeof g.id === 'string' && g.id && typeof g.text === 'string' && typeof g.done === 'boolean'));
    check('a non-array quarter bucket is dropped, arrays survive', qd.quarterGoals['2026-Q2'] === undefined && Array.isArray(qd.quarterGoals['2026-Q3']));
    check('quarter goals count toward the work score (shrink guard covers them)', blobCounts(qd).qGoals === 2 && scoreWork(blobCounts(qd)) >= 2);
    await flush(); useDevice(laptop);
    data.quarterGoals['2026-Q4'] = [{ id: 'gq', text: 'Year-end review', done: false }]; save();
    await flush(); useDevice(phone); startWorkspaceSync(); await flush();
    check('quarter goals sync to other devices with the blob', (data.quarterGoals['2026-Q4'] || []).some(g => g.id === 'gq'));

    // mandatory/optional label on tasks (To-Do columns): defaults to mandatory, survives normalize + sync
    const tk = normalize({ projects: [{ id: 'pX', name: 'X', tasks: [{ id: 'tM', text: 'm' }, { id: 'tO', text: 'o', optional: 1 }] }], tasks: [{ id: 'tA', text: 'a', optional: true }] });
    check('tasks default to mandatory (optional:false); a truthy flag becomes true', tk.projects[0].tasks[0].optional === false && tk.projects[0].tasks[1].optional === true && tk.tasks[0].optional === true);
    const tk2 = normalize(tk);
    check('the label is stable through repeated normalize', tk2.tasks[0].optional === true && tk2.projects[0].tasks[0].optional === false);
    await flush(); useDevice(laptop); data.tasks.push({ id: 'tOPT', text: 'optional one', optional: true }); save();
    await flush(); useDevice(phone); startWorkspaceSync(); await flush();
    check('the label syncs to other devices with the blob', data.tasks.some(t => t.id === 'tOPT' && t.optional === true));
  }

  // ============================================================
  //  S13 — a full local disk (quota) still syncs to the cloud
  // ============================================================
  scen('S13 A full local disk (quota exceeded) still syncs to the cloud — nothing lost');
  {
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop);
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
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop); await flush();
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
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop);
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
    check('legacy meeting-entry "notes" end up in the AGENDA (entries have one text section now), existing agenda text first', e.agenda.startsWith('agenda kept') && e.agenda.includes('legacy meeting notes') && e.discussed === '' && !('notes' in e));
    // idempotency: normalizing again must not duplicate migrated text or re-split steps
    const twice = normalize(clone(blob));
    const b2 = twice.projects[0].meetingNotes.find(n => n.id === 'b');
    const c2 = twice.projects[0].meetingNotes.find(n => n.id === 'c');
    check('re-normalizing does NOT duplicate migrated text', (b2.discussed.match(/from the old field/g) || []).length === 1);
    check('re-normalizing keeps steps as a stable 2-item checklist (no re-split)', c2.steps.length === 2 && c2.steps[1].done === true);
    // meeting entries fold "What was discussed?" + "Next jumps" into the single agenda section — never dropped, never duplicated
    const NL17 = String.fromCharCode(10);
    const fold = normalize(clone({ meetings: [{ id: 'f', name: 'F', entries: [
      { id: 'x', date: '2026-08-01', agenda: 'Agenda line', discussed: 'We decided A', jumps: 'Go bigger', steps: [{ id: 's1', text: 'do it', done: false }] },
      { id: 'y', date: '2026-08-02', agenda: '', discussed: 'Only discussion' },
      { id: 'z', date: '2026-08-03', agenda: 'Untouched', discussed: '', jumps: '' },
    ] }] }));
    const fx = fold.meetings[0].entries.find(n => n.id === 'x'), fy = fold.meetings[0].entries.find(n => n.id === 'y'), fz = fold.meetings[0].entries.find(n => n.id === 'z');
    check('discussed + jumps fold into the agenda after the existing agenda text, jumps labelled', fx.agenda.startsWith('Agenda line') && fx.agenda.includes('We decided A') && fx.agenda.includes('Next jumps:' + NL17 + 'Go bigger') && fx.discussed === '' && fx.jumps === '');
    check('next steps are untouched by the fold', fx.steps.length === 1 && fx.steps[0].text === 'do it');
    check('an entry with only discussion becomes an agenda holding exactly that text', fy.agenda === 'Only discussion' && fy.discussed === '');
    check('an entry with nothing to fold is left alone', fz.agenda === 'Untouched');
    const fold2 = normalize(clone(fold));
    check('folding is idempotent — re-normalizing never duplicates the moved text', (fold2.meetings[0].entries.find(n => n.id === 'x').agenda.match(/We decided A/g) || []).length === 1);
    const pn = normalize(clone({ projects: [{ id: 'pp', name: 'P', meetingNotes: [{ id: 'q', date: '2026-08-01', discussed: 'project note stays', jumps: 'keep' }] }] })).projects[0].meetingNotes[0];
    check('project meeting notes are NOT folded (they keep their own sections)', pn.discussed === 'project note stays' && pn.jumps === 'keep');
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
  //  S20 — note converters: plain text (incl. the old "  • " / "  1) " smart-list lines) ⇄ rich HTML
  // ============================================================
  scen('S20 Note converters: old plain-text lists become real lists; HTML reads back as text');
  {
    const NL = String.fromCharCode(10);
    check('bullet lines become a <ul>', plainToHTML('  • a' + NL + '  • b') === '<ul><li>a</li><li>b</li></ul>', plainToHTML('  • a' + NL + '  • b'));
    check('numbered lines become an <ol> (any numbering, "." or ")")', plainToHTML('1) x' + NL + '2. y') === '<ol><li>x</li><li>y</li></ol>');
    check('a deeper indent nests the list inside the item', plainToHTML('  • a' + NL + '    • b' + NL + '  • c') === '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>', plainToHTML('  • a' + NL + '    • b' + NL + '  • c'));
    check('switching marker type at the same level starts a new list', plainToHTML('- a' + NL + '1. b') === '<ul><li>a</li></ul><ol><li>b</li></ol>');
    check('the old inconsistent indents (col-0 first item, 2-space siblings, 4-space child) read as ONE flat list with a nested child', plainToHTML('1) a' + NL + '  2) b' + NL + '    - c' + NL + '  3) d') === '<ol><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ol>', plainToHTML('1) a' + NL + '  2) b' + NL + '    - c' + NL + '  3) d'));
    check('plain lines become paragraphs, blank lines empty paragraphs (Tiptap\'s block shape), and lists close before them', plainToHTML('Questions:' + NL + '  1) one' + NL + '' + NL + 'after') === '<p>Questions:</p><ol><li>one</li></ol><p></p><p>after</p>', plainToHTML('Questions:' + NL + '  1) one' + NL + '' + NL + 'after'));
    check('text is escaped — no HTML injection from old notes', plainToHTML('a <b> & c') === '<p>a &lt;b&gt; &amp; c</p>');
    check('empty text gives an empty editor (placeholder shows)', plainToHTML('') === '' && plainToHTML(undefined) === '');
    check('the agenda fold output converts line by line', plainToHTML('Agenda line' + NL + NL + 'Next jumps:' + NL + 'Go bigger') === '<p>Agenda line</p><p></p><p>Next jumps:</p><p>Go bigger</p>');
    const back = htmlToText('<div>Head</div><ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>');
    check('htmlToText restores bullets, numbers and line breaks (lists are separated from other blocks by a blank line)', back === 'Head' + NL + NL + '• a' + NL + '• b' + NL + NL + '1. x' + NL + '2. y', JSON.stringify(back));
    const nested = htmlToText('<ol><li>a<ul><li>c</li></ul></li><li>b</li></ol>');
    check('nested lists read back indented under their parent item, numbering stays with the parent list', nested === '1. a' + NL + '  • c' + NL + '2. b', JSON.stringify(nested));
    check('htmlToText decodes entities and drops unknown tags', htmlToText('<p>a &amp; b &lt;c&gt;</p><span>d</span>') === 'a & b <c>' + NL + 'd');
    // what Tiptap actually stores: every list item's text sits in a <p>, line breaks are <br>
    const tt = htmlToText('<p>Head</p><ul><li><p>a</p></li><li><p>b<br>more</p></li></ul>');
    check('Tiptap list items (<li><p>…</p></li>) read back as plain bullets, a soft break indents under its item', tt === 'Head' + NL + NL + '• a' + NL + '• b' + NL + '  more', JSON.stringify(tt));
    const ttn = htmlToText('<ol><li><p>a</p><ul><li><p>c</p></li></ul></li><li><p>b</p></li></ol>');
    check('nested Tiptap lists read back indented under their parent item with no blank line in between', ttn === '1. a' + NL + '  • c' + NL + '2. b', JSON.stringify(ttn));
    check('an empty Tiptap paragraph is one blank line', htmlToText('<p>a</p><p></p><p>b</p>') === 'a' + NL + NL + 'b');
    // directly nested lists (an item indented without a previous sibling: <ul><ul>…) read back one level deeper
    const dn1 = htmlToText('<ul><ul><li><p>b</p></li></ul><li><p>a</p></li></ul>');
    check('a list nested directly at the START of a list reads back indented', dn1 === '  • b' + NL + '• a', JSON.stringify(dn1));
    const dn2 = htmlToText('<ul><li><p>a</p></li><ul><li><p>b</p></li><ul><li><p>c</p></li></ul></ul><li><p>d</p></li></ul>');
    check('directly nested lists after an item read back as deeper levels', dn2 === '• a' + NL + '  • b' + NL + '    • c' + NL + '• d', JSON.stringify(dn2));
    check('an indented paragraph keeps its text', htmlToText('<p style="margin-left: 56px">deep</p>') === 'deep');
    const cont = htmlToText('<ol><li><p>a</p></li></ol><p></p><ol start="2"><li><p>b</p></li><li><p>c</p></li></ol>');
    check('a continued numbered list (<ol start>) keeps its numbers in text', cont === '1. a' + NL + NL + '2. b' + NL + '3. c', JSON.stringify(cont));
    check('a Tiptap → text → html round trip keeps the list structure', plainToHTML(htmlToText('<ul><li><p>a</p></li><li><p>b</p></li></ul>')) === '<ul><li>a</li><li>b</li></ul>');
    // paste mode (zeroBase): column 0 is the top level and every 2 spaces / tab nest one level — what other apps produce
    check('pasted text nests on 2-space indents from column 0 (zeroBase)', plainToHTML('- a' + NL + '  - b' + NL + '- c', { zeroBase: true }) === '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>', plainToHTML('- a' + NL + '  - b' + NL + '- c', { zeroBase: true }));
    check('…tabs count as one level and a jump of several levels nests once', plainToHTML('1. a' + NL + '\t\t1. b' + NL + '2. c', { zeroBase: true }) === '<ol><li>a<ol><li>b</li></ol></li><li>c</li></ol>', plainToHTML('1. a' + NL + '\t\t1. b' + NL + '2. c', { zeroBase: true }));
    check('an indent between two open levels joins the shallower list instead of opening a stray one', plainToHTML('- a' + NL + '        - b' + NL + '    - c', { zeroBase: true }) === '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>', plainToHTML('- a' + NL + '        - b' + NL + '    - c', { zeroBase: true }));
    check('legacy mode is unchanged: 0 and 2 spaces are both the top level', plainToHTML('- a' + NL + '  - b') === '<ul><li>a</li><li>b</li></ul>');
    check('Word-style glyph bullets (· ▪ ◦) are list markers too', plainToHTML('· a' + NL + '▪ b' + NL + '◦ c') === '<ul><li>a</li><li>b</li><li>c</li></ul>');
    check('a rich → text → html round trip keeps the list structure', plainToHTML(htmlToText('<ul><li>a</li><li>b</li></ul>')) === '<ul><li>a</li><li>b</li></ul>');
    check('noteText passes plain values through and converts rich ones', noteText('  • keep', false) === '  • keep' && noteText('<ul><li>k</li></ul>', true) === '• k');
    check('noteHTML converts plain values and passes rich ones through', noteHTML('- a', false) === '<ul><li>a</li></ul>' && noteHTML('<div>x</div>', true) === '<div>x</div>');
    // the rich flags exist on every note-bearing object after normalize
    const rf = normalize({ projects: [{ id: 'p', name: 'P', notes: 'n', meetingNotes: [{ id: 'm', date: '2026-09-01', discussed: 'd' }] }], meetings: [{ id: 'mm', name: 'M', entries: [{ id: 'e', date: '2026-09-01', agenda: 'a' }] }], weekPrep: [{ id: 'w', weekStart: '2026-09-07', notes: 'x' }] });
    check('normalize gives every note-bearing object a boolean rich flag (false = still plain text)', rf.projects[0].notesRich === false && rf.projects[0].meetingNotes[0].rich === false && rf.meetings[0].entries[0].rich === false && rf.weekPrep[0].rich === false);
  }

  // ============================================================
  //  S21 — fast typing. The cloud echoes every write back through the subscription BEFORE
  //  acknowledging it, so the echo of letter 1 arrives while the device already holds letter 2
  //  and nothing is marked "seen" yet. That echo is OUR OWN write, never an unseen foreign
  //  version — the stale-device barrier must not revert letter 2.
  //  (regression, live 2026-08-30: every second keystroke was reverted with a
  //   "this device was behind" toast — typing in a document became impossible)
  // ============================================================
  scen('S21 Fast typing: our own write echoing back mid-edit never trips the stale-device barrier');
  {
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop); await flush();
    const origMut = convex.mutation; const held = [];
    convex.mutation = (name, args) => { const p = origMut(name, args); if (name !== 'workspace:save') return p; return new Promise(res => held.push(() => p.then(res))); }; // the cloud applies each write at once; its ack is released later
    let __fetched = 0; const origQ21 = convex.query; convex.query = (name, args) => { if (name === 'workspace:get') __fetched++; return origQ21(name, args); };
    const lostBefore = stashCount(laptop, 'lost'), toastsBefore = __toasts.length, logBefore = cloud.securityLog.length;
    __clock.t += 1000; data.docs[0].body = 'a';  save(); const T1 = data.updatedAt; const echoT1 = wsRow();   // letter 1 → in flight
    __clock.t += 60;   data.docs[0].body = 'ab'; save(); const T2 = data.updatedAt;                          // letter 2 → in flight
    check('setup: two writes in flight, the cloud already holds the second', T2 > T1 && cloudWs().updatedAt === T2 && echoT1.updatedAt === T1);
    cloud.verCb({ updatedAt: T1, writerDeviceId: deviceId });                                            // the version tick for letter 1: our own write → no blob fetch at all
    onRemoteRow(echoT1);                                                                                   // …and even if a stale own ROW arrived (out-of-order fetch), the barrier must not bite                                                                                     // the echo of letter 1 arrives now (acks still pending)
    check('letter 2 survives the echo of letter 1 (nothing reverted)', data.docs[0].body === 'ab' && data.updatedAt === T2, JSON.stringify({ body: data.docs[0].body }));
    check('no false "device was behind" warning, no restore point, no security-log entry', __toasts.length === toastsBefore && stashCount(laptop, 'lost') === lostBefore && cloud.securityLog.length === logBefore);
    check('the echo did not trigger a duplicate push while letter 2 was already in flight', held.length === 2, 'pushes=' + held.length);
    check('an own-device version tick never fetches the blob (no workspace:get call)', !__fetched, 'fetched=' + __fetched);
    held.forEach(f => f()); await flush();
    check('after the acks land: cloud holds letter 2, device marked synced', cloudWs().data.docs[0].body === 'ab' && seenUp() === T2 && lastSyncedUp === T2);
    convex.mutation = origMut; convex.query = origQ21;

    // own stamps are persisted: the same echo after an instant close/reopen is still recognized
    cloud.workspace = { data: echoT1.data, updatedAt: echoT1.updatedAt };   // letter 2 never reached the cloud (tab closed at once)…
    localStorage.setItem(STORAGE_KEY + '_synced', '' + (T1 - 1));           // …and no ack was ever recorded
    saveDevice(laptop); await flush(); boot(laptop); startWorkspaceSync(); await flush();
    check('after a reload, the device pushes letter 2 instead of being "blocked" by its own earlier write', data.docs[0].body === 'ab' && cloudWs().data.docs[0].body === 'ab');
    await flush();

    // a REJECTED push (another device moved the cloud on meanwhile) must NOT mark that unseen
    // cloud version as "seen" — the delivery that follows has to keep our edit as a restore point
    const foreign = JSON.parse(cloud.workspace.data); foreign.docs[0].body = 'other device'; foreign.updatedAt = __clock.t + 5000;
    cloud.workspace = { data: JSON.stringify(foreign), updatedAt: foreign.updatedAt };                     // written by another device, not delivered to us yet
    __clock.t += 100; data.docs[0].body = 'abx'; save(); await flush();                                     // our push is rejected (older stamp)
    check('a rejected push leaves the unseen cloud version unmarked', seenUp() < foreign.updatedAt && data.updatedAt < foreign.updatedAt);
    const lost0 = stashCount(laptop, 'lost'), toasts0 = __toasts.length;
    onRemoteRow(wsRow());
    check('…so the delivery that follows keeps our edit as a restore point before adopting', stashCount(laptop, 'lost') === lost0 + 1 && __toasts.length > toasts0 && data.docs[0].body === 'other device', JSON.stringify({ body: data.docs[0].body, lost: stashCount(laptop, 'lost') - lost0 }));
  }

  // ============================================================
  //  S22 — push batching. Local saves stay instant; the cloud gets one push per pause in typing,
  //  never more than PUSH_MAX_WAIT_MS behind during continuous typing, single-flight, and
  //  flushPush() (tab hidden / page closing / back online / restore) sends immediately.
  //  (This is the bandwidth fix: 500 MB/day came from one 83 KB push per keystroke.)
  // ============================================================
  scen('S22 Push batching: keystrokes coalesce into one push per pause; single-flight; flush sends now');
  {
    const { laptop } = await setupSynced();
    await flush(); useDevice(laptop); await flush(); __runTimers(); await flush();        // drain stale timers from earlier scenarios
    schedulePush = __realSchedulePush;                                      // the real scheduler for this scenario
    let saves = 0; const origMut = convex.mutation;
    convex.mutation = (name, args) => { if (name === 'workspace:save') saves++; return origMut(name, args); };
    __clock.t += 1000;
    for (let i = 0; i < 5; i++) { data.docs[0].body = 'typing ' + i; save(); __clock.t += 100; }
    check('five quick saves send nothing until the pause timer fires', saves === 0, 'saves=' + saves);
    check('meanwhile the pill is truthfully PENDING (newer than anything confirmed)', data.updatedAt > lastSyncedUp);
    check('only one push timer is pending (each save reschedules the same one)', __timers.length === 1, 'timers=' + __timers.length);
    __runTimers(); await flush();
    check('…then exactly ONE push carries the latest copy', saves === 1 && cloudWs().data.docs[0].body === 'typing 4', 'saves=' + saves);
    check('…and the device is marked synced after the ack', lastSyncedUp === data.updatedAt);
    // continuous typing never waits longer than PUSH_MAX_WAIT_MS
    saves = 0; __clock.t += 1000; data.docs[0].body = 'burst 0'; save();
    let savesAt8s = -1;
    for (let i = 1; i <= 12; i++) { __clock.t += 800; data.docs[0].body = 'burst ' + i; save(); if (i === 10) savesAt8s = saves; }
    check('during continuous typing a push goes out synchronously at the 8 s mark (no timer to cancel)', savesAt8s === 1 && saves === 1, 'savesAt8s=' + savesAt8s + ' saves=' + saves);
    await flush();                                                                    // the ack of that push finds the flag dirty again (saves 11, 12) → sends the tail at once
    check('…and its ack immediately sends the tail of the burst (single-flight re-push)', saves === 2 && cloudWs().data.docs[0].body === 'burst 12', 'saves=' + saves + ' body=' + cloudWs().data.docs[0].body);
    __runTimers(); await flush();
    check('…with nothing left to send afterwards', saves === 2 && lastSyncedUp === data.updatedAt, 'saves=' + saves);
    // single-flight: a save during an in-flight push waits for the ack, then goes out
    saves = 0; const held = [];
    convex.mutation = (name, args) => { const p = origMut(name, args); if (name !== 'workspace:save') return p; saves++; return new Promise(res => held.push(() => p.then(res))); };
    __clock.t += 1000; data.docs[0].body = 'first'; save(); __runTimers();          // push #1 leaves, ack held
    __clock.t += 1000; data.docs[0].body = 'second'; save(); __runTimers();         // only marks dirty
    check('a save during an in-flight push does not start a second push', saves === 1, 'saves=' + saves);
    held.forEach(fn => fn()); await flush();                                          // ack #1 → sends the newer copy
    check('the ack sends the newer copy as the next push', saves === 2, 'saves=' + saves);
    held.forEach(fn => fn()); await flush();
    check('the cloud ends with the latest edit and the device is marked synced', cloudWs().data.docs[0].body === 'second' && lastSyncedUp === data.updatedAt);
    // flush on hide / close / online
    saves = 0; convex.mutation = (name, args) => { if (name === 'workspace:save') saves++; return origMut(name, args); };
    __clock.t += 1000; data.docs[0].body = 'closing'; save();
    check('nothing is sent yet after a lone keystroke', saves === 0);
    flushPush(); await flush();
    check('flushPush() sends immediately and cancels the pending timer', saves === 1 && cloudWs().data.docs[0].body === 'closing' && __timers.every(x => x.fn !== flushPush));
    // an idempotent re-push (same stamp) is accepted without a write
    saves = 0; pushDirty = true; flushPush(); await flush();
    check('re-pushing an unchanged stamp is accepted (no-op on the server) and stays synced', saves === 1 && lastSyncedUp === data.updatedAt);
    convex.mutation = origMut; schedulePush = () => push();
  }

  // ===== report =====
  __log.push('\n' + '─'.repeat(60));
  __log.push('  ' + __pass + ' passed, ' + __fail + ' failed');
  console.log(__log.join('\n'));
  return { pass: __pass, fail: __fail };
}

/* ---- run the harness in a vm with the real code injected ---- */
const body = HARNESS.toString().replace('/*__REAL__*/', REAL_CODE);
const __timers = []; let __tid = 0; // fake timers: the app's setTimeout calls queue here; __runTimers() fires them (S22 = push batching)
const ctx = vm.createContext({
  console: { log: console.log, warn: () => {}, error: () => {} },
  setTimeout: (fn, ms) => { __timers.push({ id: ++__tid, fn, ms: ms || 0 }); return __tid; },
  clearTimeout: (id) => { const i = __timers.findIndex(x => x.id === id); if (i >= 0) __timers.splice(i, 1); },
  __timers,
  __runTimers: () => { const due = __timers.splice(0, __timers.length); for (const x of due) x.fn(); return due.length; },
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
sCheck('workspaceMeta + snapshotBlobs tables exist (version subscription, snapshot split)', /workspaceMeta:\s*defineTable\(/.test(schemaTs) && /snapshotBlobs:\s*defineTable\(/.test(schemaTs));
sCheck('devices subscribe to workspace:version and fetch the blob one-shot (never subscribe to it)', /onUpdate\("workspace:version"/.test(src) && !/onUpdate\("workspace:get"/.test(src) && /cloudQuery\("workspace:get"\)/.test(src));
sCheck('consumeCode never throws after a write (returns {ok:false} so the attempt counter commits)', (() => { const a = modSrc('auth'); const i = a.indexOf('export const consumeCode'); const j = a.indexOf('export const', i + 10); return i > 0 && !/\bthrow\s+(new|[A-Za-z_$])/.test(a.slice(i, j > 0 ? j : a.length).replace(/\/\/.*$/gm, '')); })());
sCheck('used/dead sign-in codes are marked consumed, never deleted by consumeCode', /consumedAt: Date\.now\(\)/.test(modSrc('auth')) && !/ctx\.db\.delete\(otp\._id\)/.test(modSrc('auth')));
sCheck('session tokens are stored hashed (tokenHash) with a legacy raw-token fallback', /by_tokenHash/.test(libTs) && /tokenHash/.test(modSrc('auth')) && /by_tokenHash/.test(schemaTs));
sCheck('a daily maintenance cron exists', /crons\.daily\(/.test(modSrc('crons')) && /export const cleanup = internalMutation\(/.test(modSrc('maintenance')));
sCheck('securityLog:add bounds its inputs and gates untrusted devices', /LOG_DETAIL_MAX/.test(modSrc('securityLog')) && /UNTRUSTED_EVENTS/.test(modSrc('securityLog')));
sCheck('workspace:save decides on the meta row and patches the blob by id; unchanged re-pushes write nothing', /ctx\.db\.patch\(meta\.blobId/.test(modSrc('workspace')) && /updatedAt === meta\.updatedAt\) return \{ accepted: true/.test(modSrc('workspace')));
sCheck('snapshots:add gates automatic snapshots server-side and prunes via metadata only', /SNAPSHOT_MIN_GAP_MS/.test(modSrc('snapshots')) && /snapshotBlobs/.test(modSrc('snapshots')));
sCheck('the Excel export is gone (no SheetJS, no exportBtn) and the CSP no longer allows its CDNs', !/exportExcel|xlsx|SheetJS|exportBtn/i.test(src) && !/script-src[^;]*unpkg\.com/.test(src));   // jsdelivr/esm.run stay: they are the Convex client's own fallbacks
sCheck('pushes are batched and flushed on hide/close (schedulePush/flushPush wired to visibilitychange + pagehide)', /function schedulePush\(\)/.test(src) && /visibilitychange/.test(src) && /pagehide",\s*\(\)=>flushPush\(\)/.test(src) && /mirrorWrite\(json\);\n  schedulePush\(\);/.test(src));
sCheck('package.json pins convex to the deployed major/minor line (^1.45)', /"convex":\s*"\^1\.45/.test(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')));
// Rich text runs on the vendored Tiptap bundle (Sep 2026): no execCommand editors, no contenteditable templates, the bundle is present and referenced
const tiptapJs = (() => { try { return readFileSync(join(__dirname, '..', 'vendor', 'tiptap.js'), 'utf8'); } catch { return ''; } })();
sCheck('the rich editors run on the vendored Tiptap bundle (vendor/tiptap.js present, > 100 KB, loaded by index.html)', tiptapJs.length > 100000 && /var Tiptap=/.test(tiptapJs) && /<script src="vendor\/tiptap\.js"><\/script>/.test(src));
sCheck('no execCommand editor and no contenteditable template is left in index.html', !/document\.execCommand/.test(src) && !/<div[^>]*contenteditable="true"/.test(src));
sCheck('editors never inject CSS (CSP) and hand back sanitized HTML on every update', /injectCSS:false/.test(src) && /onUpdate:\(\{editor\}\)=>onChange\(editor\.isEmpty \? "" : sanitizeDocHTML\(editor\.getHTML\(\)\)\)/.test(src));
sCheck('every rich surface mounts through bindRichEditor (Docs, Self Notes, note boxes via bindNoteEditor)', (src.match(/bindRichEditor\(/g) || []).length >= 4 && /return bindRichEditor\(ed, ed\.parentElement/.test(src));
sCheck('the CSP still allows only this origin + the Convex CDNs for scripts (the editor is local)', /script-src 'self' 'unsafe-inline' https:\/\/esm\.sh https:\/\/cdn\.jsdelivr\.net https:\/\/esm\.run;/.test(src));
sCheck('indent/outdent work everywhere: lists nest directly (own list nodes), psmIndent + psmListSteps extensions, toolbar buttons call indent()/outdent(), the sanitizer keeps margin-left', /content:LIST_CONTENT/.test(src) && /name:"psmIndent", priority:50/.test(src) && /name:"psmListSteps", priority:1000/.test(src) && /indent:\(\)=>c\(\)\.indent\(\)\.run\(\), outdent:\(\)=>c\(\)\.outdent\(\)\.run\(\)/.test(src) && /bulletList:false, orderedList:false/.test(src) && /\.\.\.psmEditorExtensions\(T\)/.test(src) && /ch\.style\.marginLeft=ml/.test(src));
sCheck('numbered lists separated by blank lines continue their numbering (psmListNumbering plugin, start kept by the sanitizer)', /name:"psmListNumbering"/.test(src) && /appendTransaction:/.test(src) && /a\.name==="start" && ch\.tagName==="OL"/.test(src) && /setMeta\("preventUpdate",true\)/.test(src));
sCheck('smart paste is wired: plain-text lists (zeroBase) and Outlook/Word MsoListParagraph lists become real lists', /clipboardTextParser:/.test(src) && /plainToHTML\(text,\{zeroBase:true\}\)/.test(src) && /transformPastedHTML: html=>msoListsToHTML\(html\)/.test(src) && /function msoListsToHTML\(html\)\{/.test(src));
console.log('  ' + sPass + ' passed, ' + sFail + ' failed');

const totalPass = res.pass + sPass, totalFail = res.fail + sFail;
if (totalFail > 0) { console.log('\n❌ ' + totalFail + ' check(s) failed'); process.exit(1); }
console.log('\n✅ all ' + totalPass + ' checks passed');
