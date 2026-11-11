import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTrusted, trustedOrNull } from "./lib";
import { legacyRowOf, metaOf, pullWorkspace, readWorkspaceJSON, saveWorkspace } from "./chunkStore";

// What devices SUBSCRIBE to: a few dozen bytes instead of the whole workspace.
// A change made on this device shows up here with our own writerDeviceId (the push
// ack already confirmed it); a change made elsewhere is what triggers a one-shot
// `pull`. Before the first save on the new backend there is no meta row yet, so the
// stamp is read from the blob row once.
export const version = query({
  args: { token: v.string(), deviceId: v.string() },
  returns: v.union(v.null(), v.object({ updatedAt: v.number(), writerDeviceId: v.string() })),
  handler: async (ctx, { token, deviceId }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    const meta = await metaOf(ctx, ok.session.email);
    if (meta) return { updatedAt: meta.updatedAt, writerDeviceId: meta.writerDeviceId };
    const row = await legacyRowOf(ctx, ok.session.email);
    return { updatedAt: row ? row.updatedAt : 0, writerDeviceId: "" };
  },
});

// The signed-in user's WHOLE workspace as one JSON string, readable only from a TRUSTED
// device. Reads every chunk, so the app uses it only as the fallback of `pull` (and pages
// cached from before Nov 2026 still call it). null = not signed in / device not approved;
// {data:null} = approved, nothing stored yet.
export const get = query({
  args: { token: v.string(), deviceId: v.string() },
  returns: v.union(v.null(), v.object({ data: v.union(v.string(), v.null()), updatedAt: v.number() })),
  handler: async (ctx, { token, deviceId }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    const email = ok.session.email;
    const meta = await metaOf(ctx, email);
    if (meta && meta.chunked) return { data: await readWorkspaceJSON(ctx, email), updatedAt: meta.updatedAt };
    const row = await legacyRowOf(ctx, email);
    return row ? { data: row.data, updatedAt: row.updatedAt } : { data: null, updatedAt: 0 };
  },
});

// Delta fetch: the device says what it holds (`have` = JSON {rootHash, root, idx} of its own
// chunk encoding) and gets back only the chunks that differ — nothing at all when it is
// already current. mode "legacy" → use `get`. See chunkStore.ts.
export const pull = query({
  args: { token: v.string(), deviceId: v.string(), have: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      mode: v.union(v.literal("legacy"), v.literal("delta")),
      updatedAt: v.number(),
      rootHash: v.optional(v.string()),
      root: v.optional(v.string()),
      chunks: v.optional(v.array(v.object({ k: v.string(), d: v.string() }))),
    }),
  ),
  handler: async (ctx, { token, deviceId, have }) => {
    const ok = await trustedOrNull(ctx, token, deviceId);
    if (!ok) return null;
    return await pullWorkspace(ctx, ok.session.email, have);
  },
});

// Whole-workspace upsert, last-write-wins by the client's updatedAt stamp. Decides on the
// tiny meta row; an unchanged re-push (same stamp) writes nothing at all; an accepted save
// writes only the chunks whose content changed.
export const save = mutation({
  args: { token: v.string(), deviceId: v.string(), data: v.string(), updatedAt: v.number() },
  returns: v.object({ accepted: v.boolean(), updatedAt: v.number() }),
  handler: async (ctx, { token, deviceId, data, updatedAt }) => {
    const { session } = await requireTrusted(ctx, token, deviceId);
    return await saveWorkspace(ctx, session.email, deviceId, data, updatedAt);
  },
});
