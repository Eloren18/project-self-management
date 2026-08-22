import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  ADMIN_EMAIL,
  OTP_DAILY_CAP,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  norm,
  randomToken,
  sessionOf,
  sha256Hex,
} from "./lib";

/* ===== sign-in: email a 6-digit code (admin-only, throttled) ===== */

export const requestCode = action({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const email = norm(args.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ConvexError("Enter a valid email address.");
    if (email !== ADMIN_EMAIL) throw new ConvexError("This workspace is private — that email isn't authorized.");

    // 6-digit code from a CSPRNG.
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    const code = String(100000 + (a[0] % 900000));
    const codeHash = await sha256Hex(email + ":" + code);
    await ctx.runMutation(internal.auth.storeCode, { email, codeHash }); // throws when throttled

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "Self-Management <onboarding@resend.dev>",
        to: [email],
        subject: `${code} is your Self-Management sign-in code`,
        text: `Your sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't request it, you can ignore this email.`,
      }),
    });
    if (!r.ok) {
      console.error("Resend error", r.status, await r.text());
      throw new ConvexError("Couldn't send the email — try again in a minute.");
    }
  },
});

export const storeCode = internalMutation({
  args: { email: v.string(), codeHash: v.string() },
  handler: async (ctx, { email, codeHash }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("otps")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    const recent = existing.filter((o) => now - o.sentAt < 24 * 60 * 60 * 1000);
    if (recent.some((o) => now - o.sentAt < OTP_RESEND_COOLDOWN_MS))
      throw new ConvexError("A code was just sent — check your inbox (and spam) first.");
    if (recent.length >= OTP_DAILY_CAP)
      throw new ConvexError("Too many codes requested today — try again tomorrow.");
    for (const o of existing) if (now - o.sentAt >= 24 * 60 * 60 * 1000) await ctx.db.delete(o._id);
    await ctx.db.insert("otps", { email, codeHash, expiresAt: now + OTP_TTL_MS, attempts: 0, sentAt: now });
  },
});

/* ===== verify the code → session token ===== */

export const verifyCode = action({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<{ token: string; email: string }> => {
    const email = norm(args.email);
    const codeHash = await sha256Hex(email + ":" + args.code.trim());
    const token = randomToken();
    await ctx.runMutation(internal.auth.consumeCode, { email, codeHash, token }); // throws on mismatch
    return { token, email };
  },
});

export const consumeCode = internalMutation({
  args: { email: v.string(), codeHash: v.string(), token: v.string() },
  handler: async (ctx, { email, codeHash, token }) => {
    const otp = await ctx.db
      .query("otps")
      .withIndex("by_email", (q) => q.eq("email", email))
      .order("desc")
      .first(); // newest code wins
    if (!otp) throw new ConvexError("No pending code — request a new one.");
    if (Date.now() > otp.expiresAt) {
      await ctx.db.delete(otp._id);
      throw new ConvexError("That code expired — request a new one.");
    }
    if (otp.attempts >= 5) {
      await ctx.db.delete(otp._id);
      throw new ConvexError("Too many wrong tries — request a new code.");
    }
    if (otp.codeHash !== codeHash) {
      await ctx.db.patch(otp._id, { attempts: otp.attempts + 1 });
      throw new ConvexError("That code didn't work — check it and try again.");
    }
    await ctx.db.delete(otp._id);
    await ctx.db.insert("sessions", { token, email, createdAt: Date.now() });
    // Keep at most 10 sessions per user (drop the oldest).
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    if (sessions.length > 10) {
      sessions.sort((x, y) => x.createdAt - y.createdAt);
      for (const s of sessions.slice(0, sessions.length - 10)) await ctx.db.delete(s._id);
    }
  },
});

/* ===== session state ===== */

// Who am I? Null when the token is missing/expired/revoked.
export const me = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const s = await sessionOf(ctx, token);
    return s ? { email: s.email } : null;
  },
});

export const signOut = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const s = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (s) await ctx.db.delete(s._id);
  },
});
