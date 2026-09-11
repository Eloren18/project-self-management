// Shared helpers (not Convex endpoints).
import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

export const ADMIN_EMAIL = "keremladkeholland@gmail.com"; // the ONLY account allowed in (also set in index.html)
export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // sign in again after ~6 months
export const SESSION_MAX_PER_USER = 10;
export const OTP_TTL_MS = 1000 * 60 * 10; // codes valid 10 minutes
export const OTP_RESEND_COOLDOWN_MS = 30_000; // min gap between two code emails
export const OTP_DAILY_CAP = 15; // max code emails per address per 24h
export const OTP_MAX_ATTEMPTS = 5; // wrong guesses before the code is dead
export const SNAPSHOT_KEEP = 30; // cloud snapshot history depth
export const SNAPSHOT_MIN_GAP_MS = 4 * 60 * 60 * 1000; // automatic snapshots at most every 4h (server-enforced across devices)
export const MAX_BLOB_BYTES = 250_000; // UTF-8 bytes. Keeps 30 snapshots inside one function's read budget (~8 MiB) with room to spare
export const MAX_DEVICES = 20; // a session holder can't spam pending devices
export const LOG_RETENTION_MS = 1000 * 60 * 60 * 24 * 90; // security-log rows older than this are pruned by the daily cron
export const LOG_EVENT_MAX = 64;
export const LOG_DETAIL_MAX = 1000;

export const norm = (e: string) => (e || "").trim().toLowerCase();
export const byteLen = (s: string) => new TextEncoder().encode(s).byteLength; // .length counts UTF-16 units, not bytes

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Ctx = QueryCtx | MutationCtx;

// The session row for a valid, unexpired token — else null. Tokens are stored as
// SHA-256 hashes; rows from before Sep 2026 still carry the raw token and are
// matched by it until devices:touch upgrades them on their next use.
export async function sessionOf(ctx: Ctx, token: string): Promise<Doc<"sessions"> | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  let s = await ctx.db
    .query("sessions")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .first();
  if (!s)
    s = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) return null;
  return s;
}

export async function requireSession(ctx: Ctx, token: string): Promise<Doc<"sessions">> {
  const s = await sessionOf(ctx, token);
  if (!s) throw new ConvexError("Not signed in.");
  return s;
}

// This user's device row for a deviceId — else null.
export async function deviceOf(ctx: Ctx, email: string, deviceId: string): Promise<Doc<"devices"> | null> {
  if (!deviceId) return null;
  return await ctx.db
    .query("devices")
    .withIndex("by_email_device", (q) => q.eq("email", email).eq("deviceId", deviceId))
    .first();
}

// Data functions require BOTH a valid session AND a trusted device — so a
// pending/revoked device can never read or write the workspace, even with a token.
export async function requireTrusted(ctx: Ctx, token: string, deviceId: string) {
  const s = await requireSession(ctx, token);
  const d = await deviceOf(ctx, s.email, deviceId);
  if (!d || d.status !== "trusted") throw new ConvexError("This device isn't approved yet.");
  return { session: s, device: d };
}

// Same check, but returns null instead of throwing (for subscribed queries).
export async function trustedOrNull(ctx: Ctx, token: string, deviceId: string) {
  const s = await sessionOf(ctx, token);
  if (!s) return null;
  const d = await deviceOf(ctx, s.email, deviceId);
  if (!d || d.status !== "trusted") return null;
  return { session: s, device: d };
}
