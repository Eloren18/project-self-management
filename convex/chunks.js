// Workspace chunk codec — shared VERBATIM by the backend (this file) and the app (index.html, between the
// "ws-codec" markers; tests/e2e-sync.mjs fails when the two copies differ, tools/sync-codec.mjs re-copies it).
// Pure functions, no imports.
//
// The workspace is ONE JSON object. Stored as a single 200 KB document, every save rewrote all of it and every
// fetch re-read all of it. The codec splits it into small chunks addressed by path, each with a content hash, so
// a save writes only the chunks that changed and a device fetches only the chunks it does not already hold:
//   leaf chunk        "~tasks"                 the JSON of a small value
//   split collection  "~docs#"                 index {kind:"a"|"m", ids:[…], h:[…element hashes…]}
//                     "~docs/<id>"             one element (array item with an id, or one entry of a map)
//   namespace         "personal": its keys are chunked like top-level keys ("~personal/dayPlans#", …)
//   root              {v:1, keys:[…], ns:{…}, e:{path: ["l", hash] | ["c", indexHash]}}   stored as chunk "$root"
// The root hash covers every leaf hash and every index hash (which cover the element hashes), so two encodings
// with the same root hash are the same workspace. A value the codec cannot reproduce exactly (it checks itself
// on every encode) is stored whole, as the single chunk "$whole".
export const WS_SPLIT_MIN = 6000; // collections whose JSON is smaller than this stay one chunk
export const WS_NS = ["personal"]; // namespace objects: one level of nesting that is chunked key by key
export const WS_ID_MAX = 96; // ids / key names longer than this are never used in a chunk key (the value is kept whole instead)
export function wsHash(s) { // 96-bit non-cryptographic content hash + length, e.g. "9f2c41aa07be13d5c0ffee11.2k1"
  let h1 = 0xdeadbeef ^ s.length, h2 = 0x41c6ce57 ^ s.length, h3 = 0x9e3779b9 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); h3 = Math.imul(h3 ^ c, 2246822519);
    h3 = (h3 << 13) | (h3 >>> 19);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h1) + hex(h2) + hex(h3) + "." + s.length.toString(36);
}
export function wsEnc(s) { return encodeURIComponent(String(s)); } // path segment: "/", "#", "$", "~" never appear raw… except "~", which only ever leads a path
export function wsPlain(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
export function wsSplitKind(v, json) { // "a" = array of objects with unique string ids, "m" = map of objects, "" = keep whole
  if (json.length < WS_SPLIT_MIN) return "";
  if (Array.isArray(v)) {
    if (v.length < 2) return "";
    const seen = new Set();
    for (const x of v) { if (!wsPlain(x) || typeof x.id !== "string" || !x.id || x.id.length > WS_ID_MAX || seen.has(x.id)) return ""; seen.add(x.id); }
    return "a";
  }
  if (wsPlain(v)) {
    const ks = Object.keys(v);
    if (ks.length < 2) return "";
    for (const k of ks) { if (!k || k.length > WS_ID_MAX || !wsPlain(v[k])) return ""; }
    return "m";
  }
  return "";
}
export function wsChunkify(obj) { // obj must be plain JSON data (the result of JSON.parse)
  if (!wsPlain(obj)) throw new Error("ws: the workspace must be an object");
  const chunks = new Map(), e = {}, ns = {}, idx = {};
  const put = (key, d) => { const h = wsHash(d); chunks.set(key, { d, h }); return h; };
  const node = (path, v) => {
    const json = JSON.stringify(v), kind = wsSplitKind(v, json);
    if (!kind) { e[path] = ["l", put(path, json)]; return; }
    const ids = kind === "a" ? v.map((x) => x.id) : Object.keys(v);
    const h = ids.map((id, i) => put(path + "/" + wsEnc(id), JSON.stringify(kind === "a" ? v[i] : v[id])));
    const index = { kind, ids, h };
    idx[path] = index;
    e[path] = ["c", put(path + "#", JSON.stringify(index))];
  };
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (k.length > WS_ID_MAX) throw new Error("ws: key name too long");
    const v = obj[k], p = "~" + wsEnc(k);
    if (WS_NS.includes(k) && wsPlain(v)) {
      const sub = Object.keys(v); ns[p] = sub;
      for (const sk of sub) { if (sk.length > WS_ID_MAX) throw new Error("ws: key name too long"); node(p + "/" + wsEnc(sk), v[sk]); }
    }
    else node(p, v);
  }
  const root = { v: 1, keys, ns, e }, rootJSON = JSON.stringify(root);
  return { root, rootJSON, rootHash: wsHash(rootJSON), chunks, idx };
}
export function wsAssemble(root, getChunk) { // getChunk(key) → the chunk's JSON string (must throw when it has none)
  const val = (path) => {
    const en = root.e[path];
    if (!en) throw new Error("ws: no entry for " + path);
    if (en[0] === "l") return JSON.parse(getChunk(path));
    const index = JSON.parse(getChunk(path + "#"));
    if (index.kind === "a") return index.ids.map((id) => JSON.parse(getChunk(path + "/" + wsEnc(id))));
    const o = {};
    for (const id of index.ids) o[id] = JSON.parse(getChunk(path + "/" + wsEnc(id)));
    return o;
  };
  const out = {};
  for (const k of root.keys) {
    const p = "~" + wsEnc(k);
    if (root.ns && Object.prototype.hasOwnProperty.call(root.ns, p)) { const o = {}; for (const sk of root.ns[p]) o[sk] = val(p + "/" + wsEnc(sk)); out[k] = o; }
    else out[k] = val(p);
  }
  return out;
}
export function wsEncode(obj) { // chunkify + self-check: anything that does not round-trip EXACTLY is stored as one chunk
  const json = JSON.stringify(obj);
  try {
    const c = wsChunkify(obj);
    if (JSON.stringify(wsAssemble(c.root, (k) => c.chunks.get(k).d)) === json) return c;
  } catch (_e) { /* fall through to the whole form */ }
  const chunks = new Map(), h = wsHash(json);
  chunks.set("$whole", { d: json, h });
  const root = { v: 1, whole: h }, rootJSON = JSON.stringify(root);
  return { root, rootJSON, rootHash: wsHash(rootJSON), chunks, idx: {} };
}
export function wsDecode(root, getChunk) { return root.whole ? JSON.parse(getChunk("$whole")) : wsAssemble(root, getChunk); }
// ---- save planning: which stored indexes must be read, then the exact puts / deletes that turn the stored chunks into `inc`
export function wsNeedIdx(prevRoot, incRoot) {
  const out = [];
  if (!prevRoot || prevRoot.whole) return out;
  const pe = prevRoot.e || {}, ie = (incRoot && !incRoot.whole && incRoot.e) || {};
  for (const p of Object.keys(pe)) { if (pe[p][0] === "c" && !(ie[p] && ie[p][0] === "c" && ie[p][1] === pe[p][1])) out.push(p); }
  return out;
}
export function wsPlanSave(prevRoot, prevIdx, inc) { // → { put: [[key, data, hash], …], del: [key, …] } (the root chunk itself is handled by the caller)
  const put = [], del = [];
  const pe = (prevRoot && !prevRoot.whole && prevRoot.e) || {}, ie = (!inc.root.whole && inc.root.e) || {};
  const dropCol = (p) => { del.push(p + "#"); const old = prevIdx[p]; if (old) for (const id of old.ids) del.push(p + "/" + wsEnc(id)); };
  for (const p of Object.keys(ie)) {
    const en = ie[p], pr = pe[p];
    if (en[0] === "l") {
      if (!(pr && pr[0] === "l" && pr[1] === en[1])) put.push(p);
      if (pr && pr[0] === "c") dropCol(p);
      continue;
    }
    if (pr && pr[0] === "c" && pr[1] === en[1]) continue; // identical collection: nothing to touch
    const ix = inc.idx[p], old = pr && pr[0] === "c" ? prevIdx[p] : null, oldH = new Map();
    if (old) old.ids.forEach((id, i) => oldH.set(id, old.h[i]));
    ix.ids.forEach((id, i) => { if (oldH.get(id) !== ix.h[i]) put.push(p + "/" + wsEnc(id)); });
    put.push(p + "#");
    if (old) { const now = new Set(ix.ids); for (const id of old.ids) if (!now.has(id)) del.push(p + "/" + wsEnc(id)); }
    if (pr && pr[0] === "l") del.push(p);
  }
  for (const p of Object.keys(pe)) { if (ie[p]) continue; if (pe[p][0] === "l") del.push(p); else dropCol(p); }
  if (inc.root.whole) { if (!(prevRoot && prevRoot.whole === inc.root.whole)) put.push("$whole"); }
  else if (prevRoot && prevRoot.whole) del.push("$whole");
  // A key that is written always stays: when a value changes SHAPE (e.g. "personal" turning from an object of
  // keys into a list whose element id equals an old key name) the same chunk key can be both a leftover of the
  // old layout and a chunk of the new one.
  const keep = new Set(put);
  return { put: [...keep].map((k) => [k, inc.chunks.get(k).d, inc.chunks.get(k).h]), del: [...new Set(del)].filter((k) => !keep.has(k)) };
}
// ---- pull planning: `have` is what the asking device holds ({root, idx} of its own encoding); the answer lists the chunk keys it lacks
export function wsNeedIdxPull(storedRoot, haveRoot) {
  const out = [];
  if (!storedRoot || storedRoot.whole) return out;
  const se = storedRoot.e || {}, he = (haveRoot && !haveRoot.whole && haveRoot.e) || {};
  for (const p of Object.keys(se)) { if (se[p][0] === "c" && !(he[p] && he[p][0] === "c" && he[p][1] === se[p][1])) out.push(p); }
  return out;
}
export function wsPlanPull(storedRoot, storedIdx, have) { // → [chunk keys to send] (index chunks "path#" included)
  const keys = [], hr = have && have.root ? have.root : null;
  if (storedRoot.whole) { if (!(hr && hr.whole === storedRoot.whole)) keys.push("$whole"); return keys; }
  const se = storedRoot.e || {}, he = (hr && !hr.whole && hr.e) || {}, hidx = (have && have.idx) || {};
  for (const p of Object.keys(se)) {
    const en = se[p], hv = he[p];
    if (en[0] === "l") { if (!(hv && hv[0] === "l" && hv[1] === en[1])) keys.push(p); continue; }
    if (hv && hv[0] === "c" && hv[1] === en[1]) continue;
    const ix = storedIdx[p];
    if (!ix) throw new Error("ws: stored index missing for " + p);
    keys.push(p + "#");
    const mine = new Map(), hx = hv && hv[0] === "c" ? hidx[p] : null;
    if (hx && Array.isArray(hx.ids) && Array.isArray(hx.h)) hx.ids.forEach((id, i) => mine.set(id, hx.h[i]));
    ix.ids.forEach((id, i) => { if (mine.get(id) !== ix.h[i]) keys.push(p + "/" + wsEnc(id)); });
  }
  return keys;
}
export function wsOverlay(local, storedRoot, sent) { // the stored workspace, rebuilt from the chunks that were sent + this device's own identical ones
  return wsDecode(storedRoot, (key) => {
    if (Object.prototype.hasOwnProperty.call(sent, key)) return sent[key];
    const c = local.chunks.get(key);
    if (!c) throw new Error("ws: chunk not available: " + key);
    return c.d;
  });
}
