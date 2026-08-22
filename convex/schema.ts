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

  // Cloud snapshot history: full-workspace safety copies, pruned to the newest 30.
  snapshots: defineTable({
    email: v.string(),
    ts: v.number(), // when the snapshot was taken
    updatedAt: v.number(), // the workspace updatedAt it captured
    label: v.string(), // human summary, e.g. "12 projects · 20 tasks · …"
    data: v.string(), // the full workspace blob (JSON string)
  })
    .index("by_email", ["email"])
    .index("by_email_ts", ["email", "ts"]),

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
    status: v.string(), // "trusted" | "pending" | "revoked"
    firstSeen: v.number(),
    lastSeen: v.number(),
    approvedBy: v.string(), // deviceId of the approver, or "bootstrap"
    approvedAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_email_device", ["email", "deviceId"]),

  // Pending sign-in codes (newest wins; hashed, expiring, attempt-capped).
  otps: defineTable({
    email: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    attempts: v.number(),
    sentAt: v.number(),
  }).index("by_email", ["email"]),

  // Signed-in sessions. The token lives in the browser's localStorage.
  sessions: defineTable({
    token: v.string(),
    email: v.string(),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_email", ["email"]),
});
