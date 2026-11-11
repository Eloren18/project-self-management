import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { ADMIN_EMAIL, SNAPSHOT_KEEP, byteLen } from "./lib";
import {
  type Enc, allChunks, assembleDocs, encodeWorkspace, legacyRowOf, metaOf, pullWorkspace, readWorkspaceJSON,
  reconcileChunks, saveWorkspace, writeDelta,
} from "./chunkStore";
import { wsHash, wsOverlay } from "./chunks";

// CLI-only diagnostics and one-off maintenance. Every scan is index-bounded to the single
// account (ADMIN_EMAIL) and capped: workspace chunks (a few hundred small rows), meta
// (1 row), snapshots (≤ 30 metadata rows — the blobs live in snapshotBlobs and are never
// read here), devices (≤ 20), sessions (≤ 10). Nothing here ever prints workspace contents:
// counts, sizes, stamps and yes/no answers only.
//   npx convex run admin:stats            (dev)
//   npx convex run admin:stats --prod     (production)
export const stats = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const email = ADMIN_EMAIL;
    const ws = await ctx.db.query("workspaces").withIndex("by_email", (q) => q.eq("email", email)).take(5);
    const metas = await ctx.db.query("workspaceMeta").withIndex("by_email", (q) => q.eq("email", email)).take(5);
    const chunks = await allChunks(ctx, email);
    const snaps = await ctx.db.query("snapshots").withIndex("by_email_ts", (q) => q.eq("email", email)).order("desc").take(SNAPSHOT_KEEP + 10);
    const devices = await ctx.db.query("devices").withIndex("by_email_device", (q) => q.eq("email", email)).take(100);
    const sessions = await ctx.db.query("sessions").withIndex("by_email", (q) => q.eq("email", email)).take(100);
    const log = await ctx.db.query("securityLog").withIndex("by_email_ts", (q) => q.eq("email", email)).order("desc").take(1000);
    const counts = (json: string | null) => {
      if (json === null) return null;
      try {
        const d = JSON.parse(json); const per = d.personal || {};
        return {
          projects: (d.projects || []).length,
          tasks: (d.tasks || []).length + (d.projects || []).reduce((a: number, p: any) => a + ((p && p.tasks) || []).length, 0) + (d.meetings || []).reduce((a: number, m: any) => a + ((m && m.tasks) || []).length, 0),
          glossary: (d.glossary || []).length, meetings: (d.meetings || []).length, docs: (d.docs || []).length,
          personalItems: (per.items || []).length, dayPlans: Object.keys(per.dayPlans || {}).length,
        };
      } catch { return null; }
    };
    let live: string | null = null;
    if (chunks.length) { try { live = assembleDocs(chunks); } catch { live = null; } }
    const sizes = chunks.map((c) => byteLen(c.data));
    return {
      workspace: metas.map((m) => ({
        updatedAt: new Date(m.updatedAt).toISOString(), writerDeviceId: m.writerDeviceId.slice(0, 8), bytes: m.bytes,
        storage: m.chunked ? "chunks" : "legacy blob row",
      })),
      chunks: {
        count: chunks.length, totalBytes: sizes.reduce((a, b) => a + b, 0), largestBytes: sizes.length ? Math.max(...sizes) : 0,
        readable: chunks.length ? live !== null : null, counts: counts(live),
      },
      legacyBlobRows: ws.map((r) => ({ updatedAt: new Date(r.updatedAt).toISOString(), bytes: byteLen(r.data), counts: counts(r.data) })),
      snapshots: {
        count: snaps.length,
        totalBytes: snaps.reduce((a, s) => a + (s.bytes ?? (s.data ? s.data.length : 0)), 0),
        legacyInline: snaps.filter((s) => s.data !== undefined).length,
        newest: snaps.length ? new Date(snaps[0].ts).toISOString() : null,
      },
      devices: devices.map((d) => ({ label: d.label, status: d.status, lastSeen: new Date(d.lastSeen).toISOString() })),
      sessions: { count: sessions.length, hashed: sessions.filter((s) => !!s.tokenHash).length, legacyRaw: sessions.filter((s) => !!s.token).length },
      securityLog: log.length >= 1000 ? "1000+" : log.length,
    };
  },
});

// Snapshot metadata only (labels carry counts, never contents) — for loss investigations.
export const snapshotIndex = internalQuery({
  args: {},
  returns: v.array(v.object({ ts: v.string(), updatedAt: v.string(), bytes: v.number(), label: v.string() })),
  handler: async (ctx) => {
    const snaps = await ctx.db.query("snapshots").withIndex("by_email_ts", (q) => q.eq("email", ADMIN_EMAIL)).order("desc").take(SNAPSHOT_KEEP + 10);
    return snaps.map((s) => ({ ts: new Date(s.ts).toISOString(), updatedAt: new Date(s.updatedAt).toISOString(), bytes: s.bytes ?? (s.data ? s.data.length : 0), label: s.label }));
  },
});

export const recentLog = internalQuery({
  args: {},
  returns: v.array(v.object({ ts: v.string(), event: v.string(), detail: v.string(), device: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("securityLog").withIndex("by_email_ts", (q) => q.eq("email", ADMIN_EMAIL)).order("desc").take(30);
    return rows.map((l) => ({ ts: new Date(l.ts).toISOString(), event: l.event, detail: l.detail, device: (l.deviceId || "").slice(0, 8) }));
  },
});

// ---------------------------------------------------------------------------------------
// Chunked storage (Nov 2026). A workspace moves to chunks by itself on its first accepted
// save; this does the same move without waiting for one, keeping the stamp, so no device
// sees a change. The old blob row is NOT touched — it stays as a frozen copy.
//   npx convex run admin:migrateToChunks [--prod]
export const migrateToChunks = internalMutation({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const email = ADMIN_EMAIL;
    const meta = await metaOf(ctx, email);
    if (meta && meta.chunked) return { migrated: false, reason: "already stored as chunks" };
    const row = await legacyRowOf(ctx, email);
    if (!row) return { migrated: false, reason: "nothing stored yet" };
    if (meta && meta.updatedAt !== row.updatedAt) return { migrated: false, reason: "meta and blob row disagree on the stamp — not touching anything" };
    const inc = encodeWorkspace(row.data);
    const r = await reconcileChunks(ctx, email, inc);
    const bytes = byteLen(row.data);
    const checkedAt = Date.now();
    if (meta) await ctx.db.patch(meta._id, { bytes, chunked: true, rootHash: inc.rootHash, checkedAt }); // stamp + writer unchanged
    else await ctx.db.insert("workspaceMeta", { email, blobId: row._id, updatedAt: row.updatedAt, writerDeviceId: "", bytes, chunked: true, rootHash: inc.rootHash, checkedAt });
    return { migrated: true, updatedAt: new Date(row.updatedAt).toISOString(), bytes, chunks: inc.chunks.size + 1, storedWhole: !!inc.root.whole, ...r };
  },
});

// Rollback aid. Returns the account to the pre-Nov-2026 shape: the live (chunked) workspace
// is copied back into the old blob row and the meta row loses its chunk fields (the older
// schema does not know them, so an older deploy would be refused while they exist). Run it
// ONLY right before deploying that older code — with the current code still deployed, the
// next save simply moves the workspace to chunks again. Works while the workspace still fits
// one document.
//   npx convex run admin:refreshLegacyRow [--prod]
export const refreshLegacyRow = internalMutation({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const email = ADMIN_EMAIL;
    const meta = await metaOf(ctx, email);
    if (!meta || !meta.chunked) return { refreshed: false, reason: "the workspace is not stored as chunks" };
    const json = await readWorkspaceJSON(ctx, email);
    const bytes = byteLen(json);
    if (bytes > 900_000) return { refreshed: false, reason: "too large for a single document", bytes };
    const row = await legacyRowOf(ctx, email);
    let blobId = row ? row._id : null;
    if (row) await ctx.db.patch(row._id, { data: json, updatedAt: meta.updatedAt });
    else blobId = await ctx.db.insert("workspaces", { email, data: json, updatedAt: meta.updatedAt });
    // replace (not patch): drops chunked / rootHash / checkedAt, leaving exactly the older schema's fields
    await ctx.db.replace(meta._id, { email, blobId: blobId!, updatedAt: meta.updatedAt, writerDeviceId: meta.writerDeviceId, bytes });
    return { refreshed: true, bytes, updatedAt: new Date(meta.updatedAt).toISOString(), storage: "legacy blob row (chunks are ignored until the next save)" };
  },
});

// Integrity report of the stored chunks: yes/no answers and counts only.
//   npx convex run admin:verifyChunks [--prod]
export const verifyChunks = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const email = ADMIN_EMAIL;
    const meta = await metaOf(ctx, email);
    const row = await legacyRowOf(ctx, email);
    const docs = await allChunks(ctx, email);
    const keys = new Set(docs.map((d) => d.key));
    let json: string | null = null, error: string | null = null;
    try { json = assembleDocs(docs); } catch (e: any) { error = String((e && (e.data || e.message)) || e); }
    const enc = json !== null ? encodeWorkspace(json) : null;
    const rootDoc = docs.find((d) => d.key === "$root") || null;
    let legacy: any = null;
    if (row) {
      const sameStamp = !!meta && meta.updatedAt === row.updatedAt;
      legacy = {
        updatedAt: new Date(row.updatedAt).toISOString(), bytes: byteLen(row.data), sameStampAsLive: sameStamp,
        // only meaningful while nothing was saved since the migration:
        identicalToLive: sameStamp && json !== null ? row.data === json : null,
      };
    }
    return {
      storage: meta ? (meta.chunked ? "chunks" : "legacy blob row") : "none",
      updatedAt: meta ? new Date(meta.updatedAt).toISOString() : null,
      chunks: docs.length, storedBytes: docs.reduce((a, d) => a + byteLen(d.data), 0),
      readable: json !== null, error,
      workspaceBytes: json !== null ? byteLen(json) : null,
      bytesMatchMeta: json !== null && !!meta ? byteLen(json) === meta.bytes : null,
      stampInsideMatchesMeta: json !== null && !!meta ? JSON.parse(json).updatedAt === meta.updatedAt : null,
      everyHashMatchesItsData: docs.every((d) => d.hash === wsHash(d.data)),
      rootHashMatchesMeta: !!rootDoc && !!meta ? rootDoc.hash === meta.rootHash : null,
      layoutIsCanonical: enc && rootDoc ? enc.rootJSON === rootDoc.data && enc.chunks.size + 1 === docs.length : null,
      leftoverChunks: enc ? docs.filter((d) => d.key !== "$root" && !enc.chunks.has(d.key)).length : null,
      duplicateKeys: docs.length - keys.size,
      legacyBlobRow: legacy,
    };
  },
});

// Exercises the REAL save / pull / heal code against this deployment's database, on a
// scratch account that no one can sign in to. Everything it writes is deleted before it
// returns (and if a step throws, the whole transaction rolls back), so it is safe on prod.
//   npx convex run admin:chunkSelfTest [--prod]
export const chunkSelfTest = internalMutation({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const email = "chunk-selftest@invalid.local";
    const wipe = async () => {
      for (const d of await allChunks(ctx, email)) await ctx.db.delete(d._id);
      for (const m of await ctx.db.query("workspaceMeta").withIndex("by_email", (q) => q.eq("email", email)).collect()) await ctx.db.delete(m._id);
      for (const r of await ctx.db.query("workspaces").withIndex("by_email", (q) => q.eq("email", email)).collect()) await ctx.db.delete(r._id);
      for (const l of await ctx.db.query("securityLog").withIndex("by_email_ts", (q) => q.eq("email", email)).collect()) await ctx.db.delete(l._id);
    };
    const logRows = async () => (await ctx.db.query("securityLog").withIndex("by_email_ts", (q) => q.eq("email", email)).collect()).filter((l) => l.event === "storage_repaired").length;
    const ageCheck = async (ms: number) => { const m = await metaOf(ctx, email); if (m) await ctx.db.patch(m._id, { checkedAt: Date.now() - ms }); };
    await wipe();
    const failures: string[] = [];
    let checks = 0;
    const check = (name: string, cond: boolean) => { checks++; if (!cond) failures.push(name); };
    const big = (n: number) => "x".repeat(n);
    let cur: any = {
      updatedAt: 10, settings: { theme: "dark" },
      tasks: Array.from({ length: 30 }, (_, i) => ({ id: "t" + i, text: "task " + i + " " + big(300), done: false })),
      docs: Array.from({ length: 4 }, (_, i) => ({ id: "d" + i, title: "doc " + i, body: big(3000) })),
      glossary: [{ id: "g1", term: "a" }],
      personal: {
        items: [{ id: "p1", title: "x" }],
        dayPlans: Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["2026-10-" + String(i + 1).padStart(2, "0"), { entries: [{ id: "e" + i, text: big(400) }] }])),
      },
    };
    // the stored state must be EXACTLY the encoding of `expected`
    const exact = async (name: string, expected: any): Promise<Enc> => {
      const json = JSON.stringify(expected);
      const enc = encodeWorkspace(json);
      const docs = await allChunks(ctx, email);
      const stored = new Map(docs.map((d) => [d.key, d.data] as [string, string]));
      let same = docs.length === enc.chunks.size + 1 && stored.get("$root") === enc.rootJSON;
      for (const [k, c] of enc.chunks) if (stored.get(k) !== c.d) same = false;
      check(name + ": stored chunks are exactly the encoding", same);
      check(name + ": every stored hash matches its data", docs.every((d) => d.hash === wsHash(d.data)));
      let back = "";
      try { back = await readWorkspaceJSON(ctx, email); } catch { back = ""; }
      check(name + ": reassembles to the saved JSON", back === json);
      const meta = await metaOf(ctx, email);
      check(name + ": meta carries the stamp and the root hash", !!meta && meta.chunked === true && meta.rootHash === enc.rootHash && meta.updatedAt === expected.updatedAt);
      check(name + ": stored state is diffable (delta path)", await writeDelta(ctx, email, enc));
      return enc;
    };
    // a device holding `local` pulls; the rebuilt workspace must be the stored one and verify by root hash
    const empty = encodeWorkspace("{}");
    const pulls = async (name: string, local: Enc | null, expected: any, haveStr?: string) => {
      const base = local ?? empty;
      const r = await pullWorkspace(ctx, email, haveStr ?? JSON.stringify({ rootHash: base.rootHash, root: base.root, idx: base.idx }));
      if (r.mode !== "delta") { check(name + ": pull answered with a delta", false); return r; }
      const sent: Record<string, string> = {};
      for (const c of r.chunks) sent[c.k] = c.d;
      let json = "", verified = false;
      try {
        const obj = wsOverlay(base as any, r.root ? JSON.parse(r.root) : base.root, sent);
        json = JSON.stringify(obj);
        verified = encodeWorkspace(json).rootHash === r.rootHash;
      } catch { json = ""; }
      check(name + ": pull rebuilds the stored workspace", json === JSON.stringify(expected) && verified && r.updatedAt === expected.updatedAt);
      return r;
    };

    // ---- A. the pre-chunk state (blob row + meta, as production was before the migration)
    const legacyJson = JSON.stringify(cur);
    const rowId = await ctx.db.insert("workspaces", { email, data: legacyJson, updatedAt: 10 });
    await ctx.db.insert("workspaceMeta", { email, blobId: rowId, updatedAt: 10, writerDeviceId: "old", bytes: byteLen(legacyJson) });
    const p0 = await pullWorkspace(ctx, email, "{}");
    check("legacy: pull says legacy", p0.mode === "legacy" && p0.updatedAt === 10);
    let s = await saveWorkspace(ctx, email, "devA", JSON.stringify({ ...cur, updatedAt: 5 }), 5);
    check("legacy: a stale save is rejected", s.accepted === false && s.updatedAt === 10);
    s = await saveWorkspace(ctx, email, "devA", legacyJson, 10);
    check("legacy: an equal stamp writes nothing", s.accepted === true && (await allChunks(ctx, email)).length === 0);

    // ---- B. the first accepted save moves the workspace to chunks; the blob row stays frozen
    const step = async (name: string, mutate: (d: any) => any) => {
      const next = JSON.parse(JSON.stringify(cur));
      const out = mutate(next) ?? next;
      out.updatedAt = cur.updatedAt + 10;
      const r = await saveWorkspace(ctx, email, "devA", JSON.stringify(out), out.updatedAt);
      check(name + ": save accepted", r.accepted === true && r.updatedAt === out.updatedAt);
      cur = out;
      return await exact(name, cur);
    };
    let enc = await step("first chunked save", (d) => { d.tasks[3].text += "!"; });
    const row = await ctx.db.get(rowId);
    check("the old blob row is left untouched", !!row && row.data === legacyJson && row.updatedAt === 10);
    await pulls("fresh device", null, cur);

    // ---- C. ordinary edits: each one must leave the store exact, and a device one step behind must catch up
    const edits: [string, (d: any) => any][] = [
      ["edit one task", (d) => { d.tasks[7].done = true; }],
      ["add and delete a task", (d) => { d.tasks.push({ id: "tNew", text: big(200) }); d.tasks.splice(2, 1); }],
      ["reorder tasks", (d) => { d.tasks.unshift(d.tasks.pop()); }],
      ["edit a day and add a day", (d) => { d.personal.dayPlans["2026-10-05"].feeling = "ok"; d.personal.dayPlans["2026-11-01"] = { entries: [] }; }],
      ["type in a doc", (d) => { d.docs[1].body += " more"; }],
      ["tasks shrink to a small list", (d) => { d.tasks = d.tasks.slice(0, 2); }],
      ["tasks grow back", (d) => { for (let i = 0; i < 40; i++) d.tasks.push({ id: "g" + i, text: big(250) }); }],
      ["a key disappears and another appears", (d) => { delete d.docs; d.quarterGoals = [{ id: "q1", text: "x" }]; }],
      ["personal disappears", (d) => { delete d.personal; }],
      ["personal comes back", (d) => { d.personal = { items: [], dayPlans: { "2026-11-02": { entries: [] } } }; }],
      ["personal changes shape: a list whose ids equal the old key names", (d) => { d.personal = [{ id: "items", text: big(3500) }, { id: "dayPlans", text: big(3500) }]; }],
      ["personal changes shape back: keys equal to the old list ids", (d) => { d.personal = { items: [{ id: "p9", title: "y" }], dayPlans: { "2026-11-03": { entries: [] }, "2026-11-04": { entries: [] } } }; }],
      ["a value the codec cannot split", (d) => JSON.parse(JSON.stringify(d).replace(/^\{/, '{"__proto__":{"a":1},'))],
      ["back to a normal workspace", (d) => { const o: any = {}; for (const k of Object.keys(d)) if (k !== "__proto__") o[k] = d[k]; return o; }],
      ["stamp only", () => undefined],
    ];
    for (const [name, mutate] of edits) {
      const before = enc;
      enc = await step(name, mutate);
      const r = await pulls(name, before, cur);
      // (moving between the whole form and chunks has nothing in common to reuse)
      if (r.mode === "delta" && !before.root.whole && !enc.root.whole) check(name + ": the device was not sent everything", r.chunks.length < enc.chunks.size);
      if (name === "a value the codec cannot split") check("the unsplittable value was stored whole", !!enc.root.whole && enc.chunks.size === 1);
      const same = await pulls(name + " (already current)", enc, cur);
      check(name + ": a current device is sent nothing", same.mode === "delta" && same.chunks.length === 0 && same.root === undefined);
    }

    // ---- D. last-write-wins is unchanged
    const snapshot = await readWorkspaceJSON(ctx, email);
    s = await saveWorkspace(ctx, email, "devB", JSON.stringify({ ...cur, updatedAt: cur.updatedAt - 5, extra: 1 }), cur.updatedAt - 5);
    check("a stale save is rejected", s.accepted === false && s.updatedAt === cur.updatedAt);
    s = await saveWorkspace(ctx, email, "devB", JSON.stringify({ ...cur, extra: 2 }), cur.updatedAt);
    check("an equal stamp is accepted and writes nothing", s.accepted === true && (await readWorkspaceJSON(ctx, email)) === snapshot);
    const metaD = await metaOf(ctx, email);
    check("the writer is the device whose save was stored", !!metaD && metaD.writerDeviceId === "devA");

    // ---- E. a device that sends nonsense about what it holds still gets a correct answer
    for (const [i, have] of ["not json", "[]", "5", '{"root":5,"idx":7}', '{"root":{"e":{"~tasks":["c","zz"]}},"idx":{"~tasks":{"ids":5}}}', '{"rootHash":"nope","root":{"whole":"x"}}'].entries())
      await pulls("nonsense have #" + i, null, cur, have);

    // ---- F. self-heal: damaged storage is repaired by the next save
    const drop = async (key: string) => { for (const d of await allChunks(ctx, email)) if (d.key === key) await ctx.db.delete(d._id); };
    await drop("~tasks#");
    let broke = false;
    try { await readWorkspaceJSON(ctx, email); } catch { broke = true; }
    check("a missing index is detected, never read as a partial workspace", broke);
    enc = await step("heal a missing index", (d) => { d.tasks[0].text += "?"; });
    await drop("$root");
    const pr = await pullWorkspace(ctx, email, "{}");
    check("a missing root makes pull fall back", pr.mode === "legacy");
    enc = await step("heal a missing root", (d) => { d.settings.theme = "light"; });
    const anyDoc = (await allChunks(ctx, email)).find((d) => d.key.startsWith("~tasks/"));
    if (anyDoc) await ctx.db.insert("workspaceChunks", { email, key: "~stray/leftover", data: "1", hash: wsHash("1") });
    await drop("$root");
    enc = await step("heal leftovers", (d) => { d.settings.theme = "dark"; });

    // ---- G. the periodic full check: damage the delta path cannot see is repaired by the first save after the interval
    const logsBefore = await logRows();
    const victim = (await allChunks(ctx, email)).find((d) => d.key.startsWith("~tasks/"));
    check("there is an unchanged element chunk to remove", !!victim);
    if (victim) await ctx.db.delete(victim._id);
    const m1 = await metaOf(ctx, email);
    check("a full check was stamped by the last repair", !!m1 && typeof m1.checkedAt === "number");
    {
      // inside the interval: an edit elsewhere takes the delta path and cannot see the missing chunk
      const next = JSON.parse(JSON.stringify(cur)); next.settings.theme = "sepia"; next.updatedAt = cur.updatedAt + 10;
      const r = await saveWorkspace(ctx, email, "devA", JSON.stringify(next), next.updatedAt);
      cur = next;
      let unreadable = false;
      try { await readWorkspaceJSON(ctx, email); } catch { unreadable = true; }
      check("inside the interval a save elsewhere does not notice the damage (delta path)", r.accepted === true && unreadable);
    }
    await ageCheck(13 * 60 * 60 * 1000); // 13 h since the last full check
    enc = await step("periodic full check repairs unseen damage", (d) => { d.settings.theme = "dark"; });
    check("the repair is recorded in the security log", (await logRows()) === logsBefore + 1);
    const m2 = await metaOf(ctx, email);
    check("the full check is stamped again", !!m2 && !!m2.checkedAt && Date.now() - m2.checkedAt < 60_000);
    const logsMid = await logRows();
    await ageCheck(13 * 60 * 60 * 1000);
    enc = await step("a full check on healthy storage changes nothing else", (d) => { d.settings.theme = "light"; });
    check("a full check on healthy storage logs nothing", (await logRows()) === logsMid);

    await wipe();
    const left = (await allChunks(ctx, email)).length + (await ctx.db.query("workspaceMeta").withIndex("by_email", (q) => q.eq("email", email)).collect()).length
      + (await ctx.db.query("securityLog").withIndex("by_email_ts", (q) => q.eq("email", email)).collect()).length;
    check("the scratch account is empty again", left === 0);
    return { ok: failures.length === 0, checks, failures };
  },
});

// Size test of the storage code on the scratch account: builds a workspace of about `bytes`
// (non-Latin text included, so UTF-8 size and string handling are realistic), then runs the
// first save (full write), a small edit (delta), a full reassembly and a pull for a device
// that holds nothing — and removes everything again. Throws if any step hits a Convex limit.
//   npx convex run admin:chunkLoadTest '{"bytes":1900000}'
export const chunkLoadTest = internalMutation({
  args: { bytes: v.number() },
  returns: v.any(),
  handler: async (ctx, { bytes }) => {
    const email = "chunk-selftest@invalid.local";
    const wipe = async () => {
      for (const d of await allChunks(ctx, email)) await ctx.db.delete(d._id);
      for (const m of await ctx.db.query("workspaceMeta").withIndex("by_email", (q) => q.eq("email", email)).collect()) await ctx.db.delete(m._id);
    };
    await wipe();
    const text = "Überblick — заметка 메모 ノート ".repeat(12); // ~300 chars, mostly multi-byte
    const d: any = { updatedAt: 10, settings: { theme: "dark" }, tasks: [], docs: [], personal: { items: [], dayPlans: {} } };
    let size = byteLen(JSON.stringify(d));
    const grow = (o: any) => { size += byteLen(JSON.stringify(o)) + 12; return o; }; // running size: no need to re-serialise everything per element
    for (let n = 0; size < bytes; n++) {
      d.tasks.push(grow({ id: "t" + n, text: text + n, done: false }));
      d.personal.dayPlans["d" + n] = grow({ entries: [{ id: "e" + n, text }] });
      if (n % 10 === 0) d.docs.push(grow({ id: "doc" + n, title: "Doc " + n, body: text.repeat(20) }));
    }
    const json0 = JSON.stringify(d);
    const s0 = await saveWorkspace(ctx, email, "load", json0, 10);
    const chunks = (await allChunks(ctx, email)).length;
    d.tasks[5].text += " edited"; d.updatedAt = 20;
    const json1 = JSON.stringify(d);
    const s1 = await saveWorkspace(ctx, email, "load", json1, 20);
    const back = await readWorkspaceJSON(ctx, email);
    const p = await pullWorkspace(ctx, email, "{}");
    const pulled = p.mode === "delta" ? p.chunks.length : -1;
    await wipe();
    return {
      ok: s0.accepted && s1.accepted && back === json1 && pulled > 0,
      workspaceBytes: byteLen(json1), chunks, pulledChunks: pulled, reassembledExactly: back === json1,
    };
  },
});

// Earlier one-off helpers (admin:migrateSnapshots — inline snapshot blobs → snapshotBlobs —
// and admin:devTrustDevice for the dev end-to-end test) were removed after they ran; git
// history has them.
