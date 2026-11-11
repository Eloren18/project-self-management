// The workspace as CHUNKS (not Convex endpoints — shared by workspace.ts and admin.ts).
//
// Until Nov 2026 the whole workspace was one document: every save rewrote all of it and
// every fetch re-read all of it, so database I/O grew with everything ever written (and
// the 250 KB cap was a few weeks away). It is now stored as small documents in
// `workspaceChunks`, split and addressed by the shared codec in chunks.js:
//   • a save writes only the chunks whose content changed (plus the small root / index);
//   • a device fetches only the chunks it does not already hold (`pullWorkspace`);
//   • the rules did not change: one whole workspace per save, last-write-wins on the
//     client's updatedAt stamp, decided on the tiny meta row, all in one transaction.
// Invariant after every accepted save: the stored chunks are EXACTLY wsEncode(workspace)
// — nothing missing, nothing left over — and meta.rootHash is that encoding's root hash.
// The delta path keeps that invariant by construction; as a second line of defence, one
// save every FULL_CHECK_EVERY_MS takes the reconcile path instead: it reads every stored
// chunk, compares it with the copy being saved (every save carries the whole workspace)
// and rewrites whatever differs — so damaged storage repairs itself from the next save.
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { FULL_CHECK_EVERY_MS, MAX_CHUNK_BYTES, MAX_CHUNKS, MAX_WORKSPACE_BYTES, byteLen } from "./lib";
import * as C from "./chunks";

type Ctx = QueryCtx | MutationCtx;
export type Enc = {
  root: any;
  rootJSON: string;
  rootHash: string;
  chunks: Map<string, { d: string; h: string }>;
  idx: Record<string, any>;
};

// Above this many single-chunk operations it is cheaper (and safely inside the per-function
// limits) to read every chunk once than to look them up one by one.
const POINT_OPS_MAX = 400;

export async function metaOf(ctx: Ctx, email: string): Promise<Doc<"workspaceMeta"> | null> {
  return await ctx.db
    .query("workspaceMeta")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
}

// The pre-chunk blob row. Never written again once a workspace is chunked: it stays as a
// frozen copy of the last pre-migration state.
export async function legacyRowOf(ctx: Ctx, email: string): Promise<Doc<"workspaces"> | null> {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
}

export async function chunkOf(ctx: Ctx, email: string, key: string): Promise<Doc<"workspaceChunks"> | null> {
  return await ctx.db
    .query("workspaceChunks")
    .withIndex("by_email_key", (q) => q.eq("email", email).eq("key", key))
    .first();
}

export async function allChunks(ctx: Ctx, email: string): Promise<Doc<"workspaceChunks">[]> {
  return await ctx.db
    .query("workspaceChunks")
    .withIndex("by_email_key", (q) => q.eq("email", email))
    .collect();
}

// Parse + chunk a workspace JSON string. Refuses anything that is not a JSON object or
// that cannot be stored (one chunk = one document, capped by Convex at 1 MiB).
export function encodeWorkspace(json: string): Enc {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new ConvexError("Workspace data is not valid JSON.");
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new ConvexError("Workspace data is not an object.");
  const inc = C.wsEncode(obj) as unknown as Enc;
  if (inc.chunks.size > MAX_CHUNKS) throw new ConvexError("Workspace too large to sync.");
  if (inc.rootJSON.length * 3 > MAX_CHUNK_BYTES && byteLen(inc.rootJSON) > MAX_CHUNK_BYTES) throw new ConvexError("Workspace too large to sync.");
  for (const c of inc.chunks.values()) {
    if (c.d.length * 3 > MAX_CHUNK_BYTES && byteLen(c.d) > MAX_CHUNK_BYTES) throw new ConvexError("Workspace too large to sync.");
  }
  return inc;
}

// Make the stored chunks exactly `inc`, whatever is there now: reads every chunk once,
// writes only the ones that differ, deletes leftovers and duplicates. Used for the first
// chunked save (migration), for very large changes, and as the self-heal path.
export async function reconcileChunks(ctx: MutationCtx, email: string, inc: Enc) {
  const existing = await allChunks(ctx, email);
  const byKey = new Map<string, Doc<"workspaceChunks">>();
  let written = 0, deleted = 0, kept = 0;
  // Was what is stored now a complete, readable workspace? (false → this call is a repair)
  let damaged = false;
  if (existing.length) { try { assembleDocs(existing); } catch { damaged = true; } }
  for (const d of existing) {
    if (byKey.has(d.key)) { await ctx.db.delete(d._id); deleted++; continue; }
    byKey.set(d.key, d);
  }
  const want = new Map<string, { d: string; h: string }>(inc.chunks);
  want.set("$root", { d: inc.rootJSON, h: inc.rootHash });
  for (const [key, c] of want) {
    const ex = byKey.get(key);
    if (!ex) { await ctx.db.insert("workspaceChunks", { email, key, data: c.d, hash: c.h }); written++; }
    else if (ex.hash !== c.h || ex.data !== c.d) { await ctx.db.patch(ex._id, { data: c.d, hash: c.h }); written++; }
    else kept++;
  }
  for (const [key, ex] of byKey) {
    if (!want.has(key)) { await ctx.db.delete(ex._id); deleted++; }
  }
  return { written, deleted, kept, damaged };
}

// The normal save path: read the stored root (+ the index of every collection that
// changed), then write only what differs. Returns false — having written NOTHING — when
// the stored chunks cannot be diffed (no root yet, unreadable index, too many operations):
// the caller then reconciles, which is always correct.
export async function writeDelta(ctx: MutationCtx, email: string, inc: Enc): Promise<boolean> {
  const rootDoc = await chunkOf(ctx, email, "$root");
  if (!rootDoc) return false;
  const known = new Map<string, Doc<"workspaceChunks">>(); // documents already read here: no second lookup to patch them
  let plan: { put: [string, string, string][]; del: string[] };
  try {
    const prevRoot = JSON.parse(rootDoc.data);
    if (!prevRoot || typeof prevRoot !== "object" || prevRoot.v !== 1) return false;
    const prevIdx: Record<string, any> = {};
    for (const p of C.wsNeedIdx(prevRoot, inc.root) as string[]) {
      const d = await chunkOf(ctx, email, p + "#");
      if (!d) return false;
      prevIdx[p] = JSON.parse(d.data);
      known.set(p + "#", d);
    }
    plan = C.wsPlanSave(prevRoot, prevIdx, inc) as unknown as { put: [string, string, string][]; del: string[] };
  } catch {
    return false;
  }
  if (plan.put.length + plan.del.length > POINT_OPS_MAX) return false;
  const putKeys = new Set<string>();
  for (const [key, data, hash] of plan.put) {
    if (inc.chunks.get(key)?.d !== data) return false; // a plan that is not about THIS workspace — never apply it (nothing written yet)
    putKeys.add(key);
  }
  for (const [key, data, hash] of plan.put) {
    const ex = known.get(key) ?? (await chunkOf(ctx, email, key));
    if (ex) await ctx.db.patch(ex._id, { data, hash });
    else await ctx.db.insert("workspaceChunks", { email, key, data, hash });
  }
  for (const key of plan.del) {
    if (putKeys.has(key) || inc.chunks.has(key)) continue; // a chunk of the saved workspace is never deleted
    const ex = known.get(key) ?? (await chunkOf(ctx, email, key));
    if (ex) await ctx.db.delete(ex._id);
  }
  if (rootDoc.hash !== inc.rootHash) await ctx.db.patch(rootDoc._id, { data: inc.rootJSON, hash: inc.rootHash });
  return true;
}

// The whole workspace as one JSON string again (old cached pages, the full-fetch fallback,
// diagnostics). Throws when a chunk is missing — never returns a partial workspace.
export function assembleDocs(docs: Doc<"workspaceChunks">[]): string {
  const m = new Map<string, string>();
  for (const d of docs) if (!m.has(d.key)) m.set(d.key, d.data);
  const rootStr = m.get("$root");
  if (rootStr === undefined) throw new ConvexError("Workspace index is missing.");
  const obj = C.wsDecode(JSON.parse(rootStr), (k: string) => {
    const d = m.get(k);
    if (d === undefined) throw new ConvexError("Workspace chunk is missing.");
    return d;
  });
  return JSON.stringify(obj);
}
export async function readWorkspaceJSON(ctx: Ctx, email: string): Promise<string> {
  return assembleDocs(await allChunks(ctx, email));
}

// workspace:save without the auth step (also driven by admin:chunkSelfTest).
// Whole-workspace upsert, last-write-wins on the client's updatedAt stamp.
export async function saveWorkspace(ctx: MutationCtx, email: string, deviceId: string, data: string, updatedAt: number) {
  const bytes = byteLen(data);
  if (bytes > MAX_WORKSPACE_BYTES) throw new ConvexError("Workspace too large to sync.");
  let meta = await metaOf(ctx, email);
  if (!meta) {
    // A blob row from before the meta row existed: adopt its stamp, so last-write-wins still applies to it.
    const row = await legacyRowOf(ctx, email);
    if (row) {
      const id = await ctx.db.insert("workspaceMeta", {
        email, blobId: row._id, updatedAt: row.updatedAt, writerDeviceId: "", bytes: byteLen(row.data),
      });
      meta = await ctx.db.get(id);
    }
  }
  if (meta) {
    // Stale write from an out-of-date device — ignored; the version tick hands that device the newer copy.
    if (updatedAt < meta.updatedAt) return { accepted: false, updatedAt: meta.updatedAt };
    if (updatedAt === meta.updatedAt) return { accepted: true, updatedAt }; // idempotent re-push: nothing to write
  }
  const inc = encodeWorkspace(data);
  const now = Date.now();
  const chunked = !!(meta && meta.chunked);
  const fullCheckDue = !chunked || !meta!.checkedAt || now - meta!.checkedAt >= FULL_CHECK_EVERY_MS || now < meta!.checkedAt;
  let checkedAt = meta ? meta.checkedAt : undefined;
  const delta = !fullCheckDue && (await writeDelta(ctx, email, inc));
  if (!delta) {
    // First chunked save (the old blob row is left as it was), the periodic full check, or storage the delta
    // path could not work with: read every chunk and make the store exactly this workspace.
    const r = await reconcileChunks(ctx, email, inc);
    checkedAt = now;
    if (chunked && r.damaged)
      await ctx.db.insert("securityLog", {
        email, ts: now, event: "storage_repaired", deviceId,
        detail: "The stored workspace was incomplete; it was rewritten from this device's copy (" + r.written + " chunks written, " + r.deleted + " removed).",
      });
  }
  if (meta) await ctx.db.patch(meta._id, { updatedAt, writerDeviceId: deviceId, bytes, chunked: true, rootHash: inc.rootHash, checkedAt });
  else await ctx.db.insert("workspaceMeta", { email, updatedAt, writerDeviceId: deviceId, bytes, chunked: true, rootHash: inc.rootHash, checkedAt });
  return { accepted: true, updatedAt };
}

export type PullResult =
  | { mode: "legacy"; updatedAt: number }
  | { mode: "delta"; updatedAt: number; rootHash: string; root?: string; chunks: { k: string; d: string }[] };

// workspace:pull without the auth step. `haveStr` is JSON {rootHash, root, idx}: the asking
// device's own encoding of the copy it holds. The answer carries only the chunks that differ
// (none at all — and nothing but the meta row is read — when the device is already current).
// "legacy" = not stored as chunks (yet) or not answerable: the device falls back to workspace:get.
// What the device was told it has is never trusted for correctness: it re-checks the rebuilt
// workspace against rootHash and falls back to the full fetch on any mismatch.
export async function pullWorkspace(ctx: Ctx, email: string, haveStr: string): Promise<PullResult> {
  const meta = await metaOf(ctx, email);
  if (!meta || !meta.chunked) return { mode: "legacy", updatedAt: meta ? meta.updatedAt : 0 };
  const legacy: PullResult = { mode: "legacy", updatedAt: meta.updatedAt };
  let have: any = null;
  try { have = JSON.parse(haveStr); } catch { have = null; }
  if (!have || typeof have !== "object" || Array.isArray(have)) have = null;
  if (have && meta.rootHash && have.rootHash === meta.rootHash)
    return { mode: "delta", updatedAt: meta.updatedAt, rootHash: meta.rootHash, chunks: [] };
  const rootDoc = await chunkOf(ctx, email, "$root");
  if (!rootDoc) return legacy;
  let root: any;
  try { root = JSON.parse(rootDoc.data); } catch { return legacy; }
  if (!root || typeof root !== "object" || root.v !== 1) return legacy;
  const idxData = new Map<string, string>();
  const plan = async (h: any): Promise<string[]> => {
    const haveRoot = h && h.root && typeof h.root === "object" && !Array.isArray(h.root) ? h.root : null;
    const idx: Record<string, any> = {};
    for (const p of C.wsNeedIdxPull(root, haveRoot) as string[]) {
      let data = idxData.get(p + "#");
      if (data === undefined) {
        const d = await chunkOf(ctx, email, p + "#");
        if (!d) throw new Error("index missing");
        data = d.data;
        idxData.set(p + "#", data);
      }
      idx[p] = JSON.parse(data);
    }
    const haveIdx = h && h.idx && typeof h.idx === "object" && !Array.isArray(h.idx) ? h.idx : {};
    return C.wsPlanPull(root, idx, { root: haveRoot, idx: haveIdx }) as string[];
  };
  let keys: string[];
  try { keys = await plan(have); }
  catch {
    try { keys = await plan(null); } catch { return legacy; } // an unusable `have` → send everything
  }
  const rest = keys.filter((k) => !idxData.has(k));
  let bulk: Map<string, string> | null = null;
  if (rest.length > POINT_OPS_MAX) {
    bulk = new Map<string, string>();
    for (const d of await allChunks(ctx, email)) if (!bulk.has(d.key)) bulk.set(d.key, d.data);
  }
  const chunks: { k: string; d: string }[] = [];
  for (const k of keys) {
    let d = idxData.get(k);
    if (d === undefined) d = bulk ? bulk.get(k) : (await chunkOf(ctx, email, k))?.data;
    if (d === undefined) return legacy;
    chunks.push({ k, d });
  }
  return { mode: "delta", updatedAt: meta.updatedAt, rootHash: rootDoc.hash, root: rootDoc.data, chunks };
}
