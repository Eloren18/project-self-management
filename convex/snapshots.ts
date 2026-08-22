import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { MAX_BLOB_BYTES, SNAPSHOT_KEEP, requireTrusted, trustedOrNull } from "./lib";

// Restore-points list: metadata only (no blobs), newest first. Trusted devices only.
export const list = query({
  args: { token: v.string(), deviceId: v.string() },
  handler: async (ctx, { token, deviceId }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    const rows = await ctx.db
      .query("snapshots")
      .withIndex("by_email_ts", (q) => q.eq("email", ok.session.email))
      .order("desc")
      .take(SNAPSHOT_KEEP);
    return rows.map((r) => ({ id: r._id, ts: r.ts, updatedAt: r.updatedAt, label: r.label, bytes: r.data.length }));
  },
});

// One snapshot's full blob (fetched on demand when restoring).
export const get = query({
  args: { token: v.string(), deviceId: v.string(), id: v.id("snapshots") },
  handler: async (ctx, { token, deviceId, id }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    const row = await ctx.db.get(id);
    if (!row || row.email !== ok.session.email) return null;
    return { data: row.data, ts: row.ts, updatedAt: row.updatedAt, label: row.label };
  },
});

// Take a snapshot; keep only the newest SNAPSHOT_KEEP.
export const add = mutation({
  args: { token: v.string(), deviceId: v.string(), ts: v.number(), updatedAt: v.number(), label: v.string(), data: v.string() },
  handler: async (ctx, { token, deviceId, ts, updatedAt, label, data }) => {
    const { session } = await requireTrusted(ctx, token, deviceId);
    if (data.length > MAX_BLOB_BYTES) throw new ConvexError("Snapshot too large.");
    await ctx.db.insert("snapshots", { email: session.email, ts, updatedAt, label, data });
    const all = await ctx.db
      .query("snapshots")
      .withIndex("by_email_ts", (q) => q.eq("email", session.email))
      .order("desc")
      .collect();
    for (const old of all.slice(SNAPSHOT_KEEP)) await ctx.db.delete(old._id);
    return { kept: Math.min(all.length, SNAPSHOT_KEEP) };
  },
});

export const remove = mutation({
  args: { token: v.string(), deviceId: v.string(), id: v.id("snapshots") },
  handler: async (ctx, { token, deviceId, id }) => {
    const { session } = await requireTrusted(ctx, token, deviceId);
    const row = await ctx.db.get(id);
    if (row && row.email === session.email) await ctx.db.delete(id);
  },
});
