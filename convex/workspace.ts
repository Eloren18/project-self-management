import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { MAX_BLOB_BYTES, requireTrusted, trustedOrNull } from "./lib";

// The signed-in user's workspace, readable only from a TRUSTED device.
// null = not signed in / device not approved; {data:null} = approved, nothing stored yet.
export const get = query({
  args: { token: v.string(), deviceId: v.string() },
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

// Whole-blob upsert, last-write-wins by the client's updatedAt stamp.
// Returns what the cloud holds afterwards so the client can confirm its ack.
export const save = mutation({
  args: { token: v.string(), deviceId: v.string(), data: v.string(), updatedAt: v.number() },
  handler: async (ctx, { token, deviceId, data, updatedAt }) => {
    const { session } = await requireTrusted(ctx, token, deviceId);
    if (data.length > MAX_BLOB_BYTES) throw new ConvexError("Workspace too large to sync.");
    const row = await ctx.db
      .query("workspaces")
      .withIndex("by_email", (q) => q.eq("email", session.email))
      .first();
    if (!row) {
      await ctx.db.insert("workspaces", { email: session.email, data, updatedAt });
      return { accepted: true, updatedAt };
    }
    if (updatedAt >= row.updatedAt) {
      await ctx.db.patch(row._id, { data, updatedAt });
      return { accepted: true, updatedAt };
    }
    // Stale write from an out-of-date device — ignored; the subscription hands
    // that device the newer copy.
    return { accepted: false, updatedAt: row.updatedAt };
  },
});
