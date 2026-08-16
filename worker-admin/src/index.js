const SESSION_COOKIE = "bugradar_admin_session";
const SESSION_DAYS = 30;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const ADMIN_EMAIL = "shubhamvishnu@gmail.com";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function sessionCookieHeader(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function sqliteTimeToMs(sqliteText) {
  // D1's datetime('now') default returns "YYYY-MM-DD HH:MM:SS" in UTC, no timezone suffix.
  return Date.parse(sqliteText.replace(" ", "T") + "Z");
}

async function getSessionEmail(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT email, expires_at FROM sessions WHERE token = ?")
    .bind(token)
    .first();
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return row.email;
}

async function adminAuthed(request, env) {
  const email = await getSessionEmail(request, env);
  return email === ADMIN_EMAIL;
}

function randomOtp() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

async function sendOtpEmail(env, email, code) {
  const from = env.RESEND_FROM || "Bug Radar Admin <login@revsight.io>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Your Bug Radar Admin login code",
      html: `<div style="font-family:-apple-system,sans-serif;font-size:15px;color:#1a1712">
        <p>Your admin login code is:</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:6px;font-family:monospace">${code}</p>
        <p style="color:#6b6860;font-size:13px">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/auth/request-otp" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      if (email !== ADMIN_EMAIL) {
        return json({ error: "not found" }, 404);
      }
      const recent = await env.DB.prepare(
        "SELECT created_at FROM otp_codes WHERE email = ? ORDER BY id DESC LIMIT 1"
      ).bind(email).first();
      if (recent && Date.now() - sqliteTimeToMs(recent.created_at) < OTP_RESEND_COOLDOWN_MS) {
        return json({ error: "Please wait before requesting another code." }, 429);
      }
      const code = randomOtp();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
      await env.DB.prepare("INSERT INTO otp_codes (email, code, expires_at) VALUES (?, ?, ?)")
        .bind(email, code, expiresAt)
        .run();
      try {
        await sendOtpEmail(env, email, code);
      } catch (e) {
        return json({ error: "Could not send the email. Try again in a moment." }, 502);
      }
      return json({ ok: true });
    }

    if (pathname === "/api/auth/verify-otp" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").trim();
      if (email !== ADMIN_EMAIL) {
        return json({ error: "That code doesn't match." }, 401);
      }
      const row = await env.DB.prepare(
        "SELECT * FROM otp_codes WHERE email = ? AND consumed = 0 ORDER BY id DESC LIMIT 1"
      ).bind(email).first();
      if (!row || Date.parse(row.expires_at) < Date.now()) {
        return json({ error: "That code has expired. Request a new one." }, 401);
      }
      if (row.attempts >= OTP_MAX_ATTEMPTS) {
        return json({ error: "Too many attempts. Request a new code." }, 401);
      }
      if (row.code !== code) {
        await env.DB.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
        return json({ error: "That code doesn't match." }, 401);
      }
      await env.DB.prepare("UPDATE otp_codes SET consumed = 1 WHERE id = ?").bind(row.id).run();
      await env.DB.prepare("INSERT OR IGNORE INTO users (email) VALUES (?)").bind(email).run();
      const token = crypto.randomUUID();
      const maxAge = SESSION_DAYS * 24 * 60 * 60;
      const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
      await env.DB.prepare("INSERT INTO sessions (token, email, expires_at) VALUES (?, ?, ?)")
        .bind(token, email, expiresAt)
        .run();
      return json({ ok: true, email }, 200, { "set-cookie": sessionCookieHeader(token, maxAge) });
    }

    if (pathname === "/api/auth/me" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email || email !== ADMIN_EMAIL) return json({ error: "not authenticated" }, 401);
      return json({ email });
    }

    if (pathname === "/api/auth/logout" && request.method === "POST") {
      const token = getCookie(request, SESSION_COOKIE);
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
      return json({ ok: true }, 200, { "set-cookie": sessionCookieHeader("", 0) });
    }

    if (pathname === "/api/overview" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      return json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },
};
