import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { MAX_BLOB_BYTES, byteLen, requireTrusted, trustedOrNull } from "./lib";

// What devices SUBSCRIBE to: a few dozen bytes instead of the whole workspace.
// A change made on this device shows up here with our own writerDeviceId (the push
// ack already confirmed it); a change made elsewhere is what triggers a one-shot
// `get`. Before the first save on the new backend there is no meta row yet, so the
// stamp is read from the blob row once.
export const version = query({
  args: { token: v.string(), deviceId: v.string() },
  returns: v.union(v.null(), v.object({ updatedAt: v.number(), writerDeviceId: v.string() })),
  handler: async (ctx, { token, deviceId }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    const meta = await ctx.db
      .query("workspaceMeta")
      .withIndex("by_email", (q) => q.eq("email", ok.session.email))
      .first();
    if (meta) return { updatedAt: meta.updatedAt, writerDeviceId: meta.writerDeviceId };
    const row = await ctx.db
      .query("workspaces")
      .withIndex("by_email", (q) => q.eq("email", ok.session.email))
      .first();
    return { updatedAt: row ? row.updatedAt : 0, writerDeviceId: "" };
  },
});

// The signed-in user's workspace, readable only from a TRUSTED device. Fetched on
// demand (not subscribed). null = not signed in / device not approved;
// {data:null} = approved, nothing stored yet.
export const get = query({
  args: { token: v.string(), deviceId: v.string() },
  returns: v.union(v.null(), v.object({ data: v.union(v.string(), v.null()), updatedAt: v.number() })),
  handler: async (ctx, { token, deviceId }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    const row = await ctx.db
      .query("workspaces")
      .withIndex("by_email", (q) => q.eq("email", ok.session.email))
      .first();
    return row ? { data: row.data, updatedAt: row.updatedAt } : { data: null, updatedAt: 0 };
  },
});

// Whole-blob upsert, last-write-wins by the client's updatedAt stamp. Decides on
// the tiny meta row and patches the blob by id, so the 80 KB row is never read
// here; an unchanged re-push (same stamp) writes nothing at all.
export const save = mutation({
  args: { token: v.string(), deviceId: v.string(), data: v.string(), updatedAt: v.number() },
  returns: v.object({ accepted: v.boolean(), updatedAt: v.number() }),
  handler: async (ctx, { token, deviceId, data, updatedAt }) => {
    const { session } = await requireTrusted(ctx, token, deviceId);
    const bytes = byteLen(data);
    if (bytes > MAX_BLOB_BYTES) throw new ConvexError("Workspace too large to sync.");
    let meta = await ctx.db
      .query("workspaceMeta")
      .withIndex("by_email", (q) => q.eq("email", session.email))
      .first();
    if (!meta) {
      // One-time adoption of the pre-existing blob row (or creation of a fresh one).
      const row = await ctx.db
        .query("workspaces")
        .withIndex("by_email", (q) => q.eq("email", session.email))
        .first();
      if (!row) {
        const blobId = await ctx.db.insert("workspaces", { email: session.email, data, updatedAt });
        await ctx.db.insert("workspaceMeta", { email: session.email, blobId, updatedAt, writerDeviceId: deviceId, bytes });
        return { accepted: true, updatedAt };
      }
      const metaId = await ctx.db.insert("workspaceMeta", {
        email: session.email, blobId: row._id, updatedAt: row.updatedAt, writerDeviceId: "", bytes: byteLen(row.data),
      });
      meta = (await ctx.db.get(metaId))!;
    }
    if (updatedAt < meta.updatedAt) {
      // Stale write from an out-of-date device — ignored; the version tick hands that device the newer copy.
      return { accepted: false, updatedAt: meta.updatedAt };
    }
    if (updatedAt === meta.updatedAt) return { accepted: true, updatedAt }; // idempotent re-push: nothing to write
    await ctx.db.patch(meta.blobId, { data, updatedAt });
    await ctx.db.patch(meta._id, { updatedAt, writerDeviceId: deviceId, bytes });
    return { accepted: true, updatedAt };
  },
});
