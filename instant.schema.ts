// instant.schema.ts
// Data model for the Project Self-Management app.
// The running app (index.html) declares this SAME schema inline, so you do NOT
// need a build step. This file is here only if you prefer to manage the schema
// with the Instant CLI:   npx instant-cli@latest push schema
import { i } from "@instantdb/core";

const _schema = i.schema({
  entities: {
    // System users namespace. Google sign-in populates `email` (server-verified).
    $users: i.entity({
      email: i.string().unique().indexed(),
    }),
    // One row per user holds the entire workspace document as JSON.
    workspaces: i.entity({
      data: i.json(),
      updatedAt: i.number().indexed(),
    }),
    // Trusted-device registry. One row per browser/device that has signed in.
    devices: i.entity({
      deviceId: i.string().unique().indexed(), // 256-bit random id kept in localStorage
      label: i.string(),                       // e.g. "Chrome on Windows"
      platform: i.string(),
      status: i.string().indexed(),            // "trusted" | "pending" | "revoked"
      firstSeen: i.number().indexed(),
      lastSeen: i.number().indexed(),
      approvedBy: i.string(),                  // deviceId of approver, or "bootstrap"
      approvedAt: i.number(),
    }),
    // Append-only security audit log.
    securityLog: i.entity({
      ts: i.number().indexed(),
      event: i.string(),
      detail: i.string(),
      deviceId: i.string(),
    }),
    // Full-workspace safety copies (cloud snapshot history, pruned to the
    // most recent 30 by the app). Each row holds the entire workspace JSON.
    snapshots: i.entity({
      ts: i.number().indexed(),   // when the snapshot was taken
      updatedAt: i.number(),      // the workspace updatedAt it captured
      label: i.string(),          // human summary, e.g. "12 projects · 20 tasks · …"
      data: i.json(),             // the full workspace blob
    }),
  },
  links: {
    workspaceOwner: {
      forward: { on: "workspaces", has: "one", label: "owner" },
      reverse: { on: "$users", has: "one", label: "workspace" },
    },
    deviceOwner: {
      forward: { on: "devices", has: "one", label: "owner" },
      reverse: { on: "$users", has: "many", label: "devices" },
    },
    logOwner: {
      forward: { on: "securityLog", has: "one", label: "owner" },
      reverse: { on: "$users", has: "many", label: "logs" },
    },
    snapshotOwner: {
      forward: { on: "snapshots", has: "one", label: "owner" },
      reverse: { on: "$users", has: "many", label: "snapshots" },
    },
  },
});

type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
