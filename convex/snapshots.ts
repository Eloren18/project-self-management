import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { MAX_SNAPSHOT_BYTES, SNAPSHOT_KEEP, SNAPSHOT_MIN_GAP_MS, SNAPSHOT_PART_CHARS, byteLen, requireTrusted, trustedOrNull } from "./lib";

const item = v.object({ id: v.id("snapshots"), ts: v.number(), updatedAt: v.number(), label: v.string(), bytes: v.number() });

// A snapshot is one whole copy of the workspace (a JSON string). One Convex document
// holds at most 1 MiB, so a copy larger than SNAPSHOT_PART_CHARS is stored as several
// snapshotBlobs rows: the first in `blobId` (exactly as before), the rest in
// `moreBlobIds`, in order. A part never starts in the middle of a surrogate pair, so
// every part is a valid string on its own.
export function splitForDocs(s: string, max: number = SNAPSHOT_PART_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let j = Math.min(s.length, i + max);
    if (j < s.length) {
      const c = s.charCodeAt(j);
      if (c >= 0xdc00 && c <= 0xdfff && j - 1 > i) j--; // keep the pair together in the next part
    }
    out.push(s.slice(i, j));
    i = j;
  }
  return out.length ? out : [""];
}

async function deleteBlobs(ctx: MutationCtx, row: Doc<"snapshots">) {
  if (row.blobId) await ctx.db.delete(row.blobId);
  for (const id of row.moreBlobIds ?? []) await ctx.db.delete(id);
}

// Restore-points list: metadata rows only — the blobs live in snapshotBlobs and are
// never read here. Trusted devices only.
export const list = query({
  args: { token: v.string(), deviceId: v.string() },
  returns: v.union(v.null(), v.array(item)),
  handler: async (ctx, { token, deviceId }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    const rows = await ctx.db
      .query("snapshots")
      .withIndex("by_email_ts", (q) => q.eq("email", ok.session.email))
      .order("desc")
      .take(SNAPSHOT_KEEP);
    return rows.map((r) => ({ id: r._id, ts: r.ts, updatedAt: r.updatedAt, label: r.label, bytes: r.bytes ?? (r.data ? r.data.length : 0) }));
  },
});

// One snapshot's full copy (fetched on demand when restoring). null when any part is
// missing — a partial copy is never returned.
export const get = query({
  args: { token: v.string(), deviceId: v.string(), id: v.id("snapshots") },
  returns: v.union(v.null(), v.object({ data: v.string(), ts: v.number(), updatedAt: v.number(), label: v.string() })),
  handler: async (ctx, { token, deviceId, id }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    const row = await ctx.db.get(id);
    if (!row || row.email !== ok.session.email) return null;
    let data = row.data ?? null;
    if (row.blobId) {
      const blob = await ctx.db.get(row.blobId);
      data = blob && blob.email === ok.session.email ? blob.data : null;
      if (data !== null) {
        for (const partId of row.moreBlobIds ?? []) {
          const part = await ctx.db.get(partId);
          if (!part || part.email !== ok.session.email) { data = null; break; }
          data += part.data;
        }
      }
    }
    if (data === null) return null;
    return { data, ts: row.ts, updatedAt: row.updatedAt, label: row.label };
  },
});

// Take a snapshot; keep only the newest SNAPSHOT_KEEP. Automatic snapshots are
// gated SERVER-side to one per SNAPSHOT_MIN_GAP_MS across all devices (each device
// used to keep its own timer, so N devices produced N× the history churn); a manual
// "Snapshot now" passes force.
export const add = mutation({
  args: {
    token: v.string(), deviceId: v.string(), ts: v.number(), updatedAt: v.number(), label: v.string(), data: v.string(),
    force: v.optional(v.boolean()),
  },
  returns: v.object({ kept: v.number(), skipped: v.boolean() }),
  handler: async (ctx, { token, deviceId, ts, updatedAt, label, data, force }) => {
    const { session } = await requireTrusted(ctx, token, deviceId);
    const bytes = byteLen(data);
    if (bytes > MAX_SNAPSHOT_BYTES) throw new ConvexError("Snapshot too large.");
    const metas = await ctx.db
      .query("snapshots")
      .withIndex("by_email_ts", (q) => q.eq("email", session.email))
      .order("desc")
      .collect(); // metadata only — cheap
    const newest = metas[0];
    if (!force && newest && (ts - newest.ts < SNAPSHOT_MIN_GAP_MS || updatedAt <= newest.updatedAt))
      return { kept: Math.min(metas.length, SNAPSHOT_KEEP), skipped: true };
    const parts = splitForDocs(data);
    const blobId = await ctx.db.insert("snapshotBlobs", { email: session.email, data: parts[0] });
    const moreBlobIds = [];
    for (let i = 1; i < parts.length; i++) moreBlobIds.push(await ctx.db.insert("snapshotBlobs", { email: session.email, data: parts[i] }));
    await ctx.db.insert("snapshots", {
      email: session.email, ts, updatedAt, label: label.slice(0, 200), bytes, blobId,
      ...(moreBlobIds.length ? { moreBlobIds } : {}),
    });
    const excess = metas.slice(SNAPSHOT_KEEP - 1); // room for the one just added
    for (const old of excess) {
      await deleteBlobs(ctx, old);
      await ctx.db.delete(old._id);
    }
    return { kept: Math.min(metas.length + 1, SNAPSHOT_KEEP), skipped: false };
  },
});

export const remove = mutation({
  args: { token: v.string(), deviceId: v.string(), id: v.id("snapshots") },
  returns: v.null(),
  handler: async (ctx, { token, deviceId, id }) => {
    const { session } = await requireTrusted(ctx, token, deviceId);
    const row = await ctx.db.get(id);
    if (row && row.email === session.email) {
      await deleteBlobs(ctx, row);
      await ctx.db.delete(id);
    }
    return null;
  },
});
