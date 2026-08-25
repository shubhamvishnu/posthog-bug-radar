const SESSION_COOKIE = "bugradar_admin_session";
const SESSION_DAYS = 30;
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

// Cloudflare Workers' crypto.subtle.deriveBits refuses PBKDF2 with more than
// 100000 iterations ("iteration counts above 100000 are not supported"), but
// the design spec calls for 210000. crypto.subtle.sign (HMAC) has no such cap,
// so PBKDF2 is computed manually via the standard iterative-HMAC construction
// (RFC 8018 5.2, one block since SHA-256's 32-byte output == the 32-byte key
// length needed). Verified byte-identical to Node's crypto.pbkdf2Sync at
// 210000 iterations before deploying this.
async function pbkdf2Hash(password, saltHex) {
  const saltBytes = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const iterations = 210000;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const blockIndex = new Uint8Array([0, 0, 0, 1]);
  const initial = new Uint8Array(saltBytes.length + 4);
  initial.set(saltBytes, 0);
  initial.set(blockIndex, saltBytes.length);

  let u = new Uint8Array(await crypto.subtle.sign("HMAC", key, initial));
  const t = new Uint8Array(u);
  for (let i = 1; i < iterations; i++) {
    u = new Uint8Array(await crypto.subtle.sign("HMAC", key, u));
    for (let j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return Array.from(t).map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function getSessionEmail(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT email, expires_at FROM sessions WHERE token = ? AND surface = 'admin'")
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/auth/login" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (email !== ADMIN_EMAIL) return json({ error: "Incorrect email or password." }, 401);

      const attemptRow = await env.DB.prepare(
        "SELECT failed_count, locked_until FROM admin_login_attempts WHERE email = ?"
      ).bind(email).first();
      if (attemptRow && attemptRow.locked_until && Date.parse(attemptRow.locked_until) > Date.now()) {
        return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
      }

      const [saltHex, expectedHashHex] = String(env.ADMIN_PASSWORD_HASH || "").split(":");
      const candidateHashHex = saltHex ? await pbkdf2Hash(password, saltHex) : "";
      const ok = !!saltHex && !!expectedHashHex && timingSafeEqual(candidateHashHex, expectedHashHex);

      if (!ok) {
        const failedCount = (attemptRow?.failed_count || 0) + 1;
        const lockedUntil = failedCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
        await env.DB.prepare(
          `INSERT INTO admin_login_attempts (email, failed_count, locked_until, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(email) DO UPDATE SET failed_count = ?, locked_until = ?, updated_at = datetime('now')`
        ).bind(email, failedCount, lockedUntil, failedCount, lockedUntil).run();
        return json({ error: "Incorrect email or password." }, 401);
      }

      await env.DB.prepare(
        `INSERT INTO admin_login_attempts (email, failed_count, locked_until, updated_at)
         VALUES (?, 0, NULL, datetime('now'))
         ON CONFLICT(email) DO UPDATE SET failed_count = 0, locked_until = NULL, updated_at = datetime('now')`
      ).bind(email).run();

      await env.DB.prepare("INSERT OR IGNORE INTO users (email) VALUES (?)").bind(email).run();
      const token = crypto.randomUUID();
      const maxAge = SESSION_DAYS * 24 * 60 * 60;
      const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
      await env.DB.prepare(
        "INSERT INTO sessions (token, email, expires_at, surface) VALUES (?, ?, ?, 'admin')"
      ).bind(token, email, expiresAt).run();
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
      const userCount = (await env.DB.prepare("SELECT COUNT(*) as n FROM users").first()).n;
      const connectionCount = (await env.DB.prepare("SELECT COUNT(*) as n FROM connections").first()).n;
      const reportCount = (await env.DB.prepare("SELECT COUNT(*) as n FROM reports").first()).n;
      const { results: statusRows } = await env.DB.prepare(
        "SELECT status, COUNT(*) as n FROM connections GROUP BY status"
      ).all();
      const connectionsByStatus = {};
      for (const row of statusRows) connectionsByStatus[row.status] = row.n;
      return json({ userCount, connectionCount, reportCount, connectionsByStatus });
    }

    if (pathname === "/api/events" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 100, 500));
      const { results } = await env.DB.prepare(
        `SELECT ce.id, ce.connection_id, ce.kind, ce.status, ce.title, ce.detail, ce.trigger_label, ce.created_at,
                c.owner_email, c.project_name
         FROM connection_events ce
         JOIN connections c ON c.id = ce.connection_id
         ORDER BY ce.id DESC LIMIT ?`
      ).bind(limit).all();
      return json(results);
    }

    if (pathname === "/api/users" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const { results: users } = await env.DB.prepare("SELECT id, email, created_at FROM users ORDER BY id").all();
      const { results: connCounts } = await env.DB.prepare(
        "SELECT owner_email, COUNT(*) as n FROM connections GROUP BY owner_email"
      ).all();
      const connCountMap = {};
      for (const row of connCounts) connCountMap[row.owner_email] = row.n;
      const { results: eventActivity } = await env.DB.prepare(
        `SELECT c.owner_email as owner_email, MAX(ce.created_at) as last_event
         FROM connection_events ce JOIN connections c ON c.id = ce.connection_id
         GROUP BY c.owner_email`
      ).all();
      const eventActivityMap = {};
      for (const row of eventActivity) eventActivityMap[row.owner_email] = row.last_event;
      const { results: reportActivity } = await env.DB.prepare(
        "SELECT owner_email, MAX(created_at) as last_report FROM reports GROUP BY owner_email"
      ).all();
      const reportActivityMap = {};
      for (const row of reportActivity) reportActivityMap[row.owner_email] = row.last_report;
      const { results: slackRows } = await env.DB.prepare("SELECT owner_email, status FROM slack_connections").all();
      const slackStatusMap = {};
      for (const row of slackRows) slackStatusMap[row.owner_email] = row.status;
      const enriched = users.map(u => ({
        ...u,
        connection_count: connCountMap[u.email] || 0,
        last_activity: eventActivityMap[u.email] || reportActivityMap[u.email] || null,
        slack_status: slackStatusMap[u.email] || null,
      }));
      return json(enriched);
    }

    const userDetailMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userDetailMatch && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const targetEmail = decodeURIComponent(userDetailMatch[1]).trim().toLowerCase();
      const user = await env.DB.prepare("SELECT id, email, created_at FROM users WHERE email = ?").bind(targetEmail).first();
      if (!user) return json({ error: "not found" }, 404);

      const { results: connections } = await env.DB.prepare(
        `SELECT id, region, project_id, project_name, timezone, identity_email_prop, identity_name_prop, identity_role_prop,
                status, last_error, last_synced_at, sync_freq, sync_max_sessions, last_pipeline_run_at, created_at
         FROM connections WHERE owner_email = ? ORDER BY id DESC`
      ).bind(targetEmail).all();

      const latestReportRow = await env.DB.prepare(
        "SELECT connection_id, generated_at, macro_themes, micro_findings FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1"
      ).bind(targetEmail).first();
      const latestReport = latestReportRow ? {
        connection_id: latestReportRow.connection_id,
        generated_at: latestReportRow.generated_at,
        macro_themes: JSON.parse(latestReportRow.macro_themes),
        micro_findings: JSON.parse(latestReportRow.micro_findings),
      } : null;

      const { results: reportHistoryRaw } = await env.DB.prepare(
        "SELECT id, connection_id, generated_at, created_at, micro_findings FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 10"
      ).bind(targetEmail).all();
      const reportHistory = reportHistoryRaw.map(r => ({
        id: r.id,
        connection_id: r.connection_id,
        generated_at: r.generated_at,
        created_at: r.created_at,
        task_count: JSON.parse(r.micro_findings).reduce((n, f) => n + (f.tasks || []).length, 0),
      }));

      const { results: goalsRaw } = await env.DB.prepare(
        "SELECT id, purpose, description, tags, source, created_at FROM goals WHERE owner_email = ? ORDER BY id DESC"
      ).bind(targetEmail).all();
      const goals = goalsRaw.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") }));

      const { results: tags } = await env.DB.prepare(
        "SELECT id, label, color, source, created_at FROM tags WHERE owner_email = ? ORDER BY id DESC"
      ).bind(targetEmail).all();

      const { results: corrections } = await env.DB.prepare(
        `SELECT id, session_id, task_index, task_title, field, from_value, to_value, reason, connection_id, created_at
         FROM corrections WHERE owner_email = ? ORDER BY id DESC`
      ).bind(targetEmail).all();

      const connectionIds = connections.map(c => c.id);
      let events = [];
      if (connectionIds.length) {
        const placeholders = connectionIds.map(() => "?").join(",");
        const { results } = await env.DB.prepare(
          `SELECT id, connection_id, kind, status, title, detail, trigger_label, created_at
           FROM connection_events WHERE connection_id IN (${placeholders}) ORDER BY id DESC LIMIT 200`
        ).bind(...connectionIds).all();
        events = results;
      }

      return json({
        user: { email: user.email, created_at: user.created_at },
        connections,
        latest_report: latestReport,
        report_history: reportHistory,
        goals,
        tags,
        corrections,
        events,
      });
    }

    const mediaProxyMatch = pathname.match(/^\/api\/media\/(.+)$/);
    if (mediaProxyMatch && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const key = mediaProxyMatch[1];
      // Cloudflare Workers on *.workers.dev share a zone, so a plain global
      // fetch() from this Worker to the main Worker's public URL is blocked
      // (error 1042: "Worker tried to fetch from another Worker on the same
      // zone"). Use the Service Binding instead, the documented mechanism
      // for Worker-to-Worker calls (see worker-admin/wrangler.jsonc).
      const upstream = await env.MAIN_WORKER.fetch(
        new Request(`${env.MAIN_WORKER_URL}/api/admin/media/${key}`, {
          headers: { authorization: `Bearer ${env.ADMIN_MEDIA_SECRET}` },
        })
      );
      if (!upstream.ok) return json({ error: "not found" }, upstream.status === 401 ? 401 : 404);
      return new Response(upstream.body, {
        headers: {
          "content-type": upstream.headers.get("content-type") || "image/png",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
