import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Everything is keyed by the owner's email (lowercased). The app is single-user
// (ADMIN_EMAIL in lib.ts), but every row still carries its owner so the model
// stays correct if access is ever widened.
export default defineSchema({
  // One row per user: the ENTIRE workspace (work + personal) as a JSON string.
  // A stringified blob is safer than nested fields (arbitrary keys, ~hundreds of KB).
  workspaces: defineTable({
    email: v.string(),
    data: v.string(), // JSON.stringify of the whole workspace object
    updatedAt: v.number(), // client clock; last-write-wins, monotonic on the client
  }).index("by_email", ["email"]),

  // Tiny companion row per workspace: what devices SUBSCRIBE to. Holds the version
  // stamp, who wrote it and the size — so a keystroke on one device no longer makes
  // every other device (and the writer itself) re-read the whole blob. The blob is
  // fetched on demand, only when ANOTHER device changed it.
  workspaceMeta: defineTable({
    email: v.string(),
    blobId: v.id("workspaces"),
    updatedAt: v.number(),
    writerDeviceId: v.string(),
    bytes: v.number(),
  }).index("by_email", ["email"]),

  // Cloud snapshot history: metadata rows (cheap to list/prune) …
  snapshots: defineTable({
    email: v.string(),
    ts: v.number(), // when the snapshot was taken
    updatedAt: v.number(), // the workspace updatedAt it captured
    label: v.string(), // human summary, e.g. "12 projects · 20 tasks · …"
    bytes: v.optional(v.number()),
    blobId: v.optional(v.id("snapshotBlobs")),
    data: v.optional(v.string()), // legacy (pre-Sep-2026): blob inline — moved to snapshotBlobs by admin:migrateSnapshots
  }).index("by_email_ts", ["email", "ts"]),
  // … and the blobs themselves, read one at a time only when restoring.
  snapshotBlobs: defineTable({
    email: v.string(),
    data: v.string(),
  }).index("by_email", ["email"]),

  // Append-only security audit log (sign-ins, device events, restores, shrink alerts).
  securityLog: defineTable({
    email: v.string(),
    ts: v.number(),
    event: v.string(),
    detail: v.string(),
    deviceId: v.string(),
  }).index("by_email_ts", ["email", "ts"]),

  // Trusted-device registry: one row per browser/device that has signed in.
  devices: defineTable({
    email: v.string(),
    deviceId: v.string(), // 256-bit random id kept in the browser's localStorage
    label: v.string(), // e.g. "Chrome on Windows"
    platform: v.string(),
    status: v.union(v.literal("trusted"), v.literal("pending"), v.literal("revoked")),
    firstSeen: v.number(),
    lastSeen: v.number(),
    approvedBy: v.string(), // deviceId of the approver, or "bootstrap"
    approvedAt: v.number(),
  }).index("by_email_device", ["email", "deviceId"]),

  // Pending sign-in codes (newest wins; hashed, expiring, attempt-capped). Rows are
  // marked consumed rather than deleted so the resend cooldown and daily cap keep
  // counting; storeCode prunes rows older than 24h.
  otps: defineTable({
    email: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    attempts: v.number(),
    sentAt: v.number(),
    consumedAt: v.optional(v.number()),
  }).index("by_email", ["email"]),

  // Signed-in sessions. The token lives in the browser's localStorage; the server
  // keeps only its SHA-256 (tokenHash). `token` is the legacy raw form, cleared on upgrade.
  sessions: defineTable({
    token: v.optional(v.string()),
    tokenHash: v.optional(v.string()),
    email: v.string(),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_tokenHash", ["tokenHash"])
    .index("by_email", ["email"]),
});
