// instant.perms.ts
// Server-enforced permission rules. Push with:
//   npx instant-cli@latest push perms
// (Or paste the equivalent JSON from SETUP.txt into the dashboard's Permissions tab.)
//
// SECURITY MODEL (see SECURITY.md for the full write-up):
//   Every rule below requires the signed-in account to be the ONE authorized
//   email AND to own the row. Because the email is verified by Google + Instant
//   on the SERVER, no client tampering can bypass these checks. Any other Google
//   account that signs in can read and write NOTHING.
import type { InstantRules } from "@instantdb/core";

const ADMIN = "keremladkeholland@gmail.com";
const isOwnerAndAdmin = `auth.id != null && '${ADMIN}' in auth.ref('$user.email') && auth.id in data.ref('owner.id')`;
const isAdmin = `auth.id != null && '${ADMIN}' in auth.ref('$user.email')`;

const rules = {
  workspaces: {
    allow: {
      view: isOwnerAndAdmin,
      create: isAdmin,
      update: isOwnerAndAdmin,
      delete: "false",
    },
  },
  devices: {
    allow: {
      view: isOwnerAndAdmin,
      create: isAdmin,
      update: isOwnerAndAdmin,
      delete: isOwnerAndAdmin,
    },
  },
  securityLog: {
    allow: {
      view: isOwnerAndAdmin,
      create: isAdmin,
      update: "false", // append-only
      delete: "false", // append-only
    },
  },
  snapshots: {
    allow: {
      view: isOwnerAndAdmin,
      create: isAdmin,
      update: "false",          // snapshots are immutable once written
      delete: isOwnerAndAdmin,  // the app prunes to the most recent 30
    },
  },
} satisfies InstantRules;

export default rules;
