import { ConvexError, v } from "convex/values";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  ADMIN_EMAIL,
  OTP_DAILY_CAP,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  SESSION_MAX_PER_USER,
  norm,
  randomToken,
  sessionOf,
  sha256Hex,
} from "./lib";

/* ===== sign-in: email a 6-digit code (admin-only, throttled) ===== */

export const requestCode = action({
  args: { email: v.string() },
  returns: v.null(),
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
    return null;
  },
});

export const storeCode = internalMutation({
  args: { email: v.string(), codeHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { email, codeHash }) => {
    if (email !== ADMIN_EMAIL) throw new ConvexError("This workspace is private — that email isn't authorized.");
    const now = Date.now();
    const existing = await ctx.db
      .query("otps")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    // Consumed and dead codes still count: that is what keeps the cooldown and the daily cap honest.
    const recent = existing.filter((o) => now - o.sentAt < 24 * 60 * 60 * 1000);
    if (recent.some((o) => now - o.sentAt < OTP_RESEND_COOLDOWN_MS))
      throw new ConvexError("A code was just sent — check your inbox (and spam) first.");
    if (recent.length >= OTP_DAILY_CAP)
      throw new ConvexError("Too many codes requested today — try again tomorrow.");
    for (const o of existing) if (now - o.sentAt >= 24 * 60 * 60 * 1000) await ctx.db.delete(o._id);
    await ctx.db.insert("otps", { email, codeHash, expiresAt: now + OTP_TTL_MS, attempts: 0, sentAt: now });
    return null;
  },
});

/* ===== verify the code → session token ===== */

// Stays an action (not a mutation) so browsers still running the previous build
// keep working: they call it with convex.action(). The raw token never reaches
// the database — only its hash is stored.
export const verifyCode = action({
  args: { email: v.string(), code: v.string() },
  returns: v.object({ token: v.string(), email: v.string() }),
  handler: async (ctx, args): Promise<{ token: string; email: string }> => {
    const email = norm(args.email);
    const code = args.code.trim();
    if (!/^\d{6}$/.test(code)) throw new ConvexError("That code didn't work — check it and try again.");
    const codeHash = await sha256Hex(email + ":" + code);
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const r = await ctx.runMutation(internal.auth.consumeCode, { email, codeHash, tokenHash });
    if (!r.ok) throw new ConvexError(r.error); // thrown AFTER the mutation committed its attempt counter
    return { token, email };
  },
});

// Returns a result instead of throwing: a throw inside a mutation rolls back its
// writes, which used to discard the attempt counter (unlimited guesses per code).
export const consumeCode = internalMutation({
  args: { email: v.string(), codeHash: v.string(), tokenHash: v.string() },
  returns: v.union(v.object({ ok: v.literal(true) }), v.object({ ok: v.literal(false), error: v.string() })),
  handler: async (ctx, { email, codeHash, tokenHash }) => {
    const fail = (error: string) => ({ ok: false as const, error });
    if (email !== ADMIN_EMAIL) return fail("No pending code — request a new one.");
    const otp = await ctx.db
      .query("otps")
      .withIndex("by_email", (q) => q.eq("email", email))
      .order("desc")
      .first(); // newest code wins
    if (!otp || otp.consumedAt) return fail("No pending code — request a new one.");
    if (Date.now() > otp.expiresAt) return fail("That code expired — request a new one.");
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return fail("Too many wrong tries — request a new code.");
    if (otp.codeHash !== codeHash) {
      await ctx.db.patch(otp._id, { attempts: otp.attempts + 1 }); // commits — no throw follows
      return fail("That code didn't work — check it and try again.");
    }
    await ctx.db.patch(otp._id, { consumedAt: Date.now() }); // kept (not deleted) so cooldown/daily cap keep counting
    await ctx.db.insert("sessions", { tokenHash, email, createdAt: Date.now() });
    // Keep at most SESSION_MAX_PER_USER sessions per user (drop the oldest).
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    if (sessions.length > SESSION_MAX_PER_USER) {
      sessions.sort((x, y) => x.createdAt - y.createdAt);
      for (const s of sessions.slice(0, sessions.length - SESSION_MAX_PER_USER)) await ctx.db.delete(s._id);
    }
    return { ok: true as const };
  },
});

/* ===== session state ===== */

// Who am I? Null when the token is missing/expired/revoked.
export const me = query({
  args: { token: v.string() },
  returns: v.union(v.null(), v.object({ email: v.string() })),
  handler: async (ctx, { token }) => {
    const s = await sessionOf(ctx, token);
    return s ? { email: s.email } : null;
  },
});

export const signOut = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const s = await sessionOf(ctx, token);
    if (s) await ctx.db.delete(s._id);
    return null;
  },
});
