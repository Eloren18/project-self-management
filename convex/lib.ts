// Shared helpers (not Convex endpoints).
import { ConvexError } from "convex/values";

export const ADMIN_EMAIL = "keremladkeholland@gmail.com"; // the ONLY account allowed in (also set in index.html)
export const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // sign in again after ~6 months
export const OTP_TTL_MS = 1000 * 60 * 10; // codes valid 10 minutes
export const OTP_RESEND_COOLDOWN_MS = 30_000; // min gap between two code emails
export const OTP_DAILY_CAP = 15; // max code emails per address per 24h
export const SNAPSHOT_KEEP = 30; // cloud snapshot history depth
export const MAX_BLOB_BYTES = 950_000; // stay under Convex's 1 MiB document limit

export const norm = (e: string) => (e || "").trim().toLowerCase();

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The session row for a valid, unexpired token — else null.
export async function sessionOf(ctx: { db: any }, token: string) {
  if (!token) return null;
  const s = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", token))
    .first();
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) return null;
  return s;
}

export async function requireSession(ctx: { db: any }, token: string) {
  const s = await sessionOf(ctx, token);
  if (!s) throw new ConvexError("Not signed in.");
  return s;
}

// This user's device row for a deviceId — else null.
export async function deviceOf(ctx: { db: any }, email: string, deviceId: string) {
  if (!deviceId) return null;
  return await ctx.db
    .query("devices")
    .withIndex("by_email_device", (q: any) => q.eq("email", email).eq("deviceId", deviceId))
    .first();
}

// Data functions require BOTH a valid session AND a trusted device — so a
// pending/revoked device can never read or write the workspace, even with a token.
export async function requireTrusted(ctx: { db: any }, token: string, deviceId: string) {
  const s = await requireSession(ctx, token);
  const d = await deviceOf(ctx, s.email, deviceId);
  if (!d || d.status !== "trusted") throw new ConvexError("This device isn't approved yet.");
  return { session: s, device: d };
}

// Same check, but returns null instead of throwing (for subscribed queries).
export async function trustedOrNull(ctx: { db: any }, token: string, deviceId: string) {
  const s = await sessionOf(ctx, token);
  if (!s) return null;
  const d = await deviceOf(ctx, s.email, deviceId);
  if (!d || d.status !== "trusted") return null;
  return { session: s, device: d };
}
