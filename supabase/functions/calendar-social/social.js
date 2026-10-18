// calendar-social: connects the chapter's Instagram and Threads accounts to the content calendar
// and keeps their numbers current. index.ts runs this on Supabase Edge Functions (Deno). The tests
// run the same file in Node against the real migrations, with Instagram and Threads simulated
// (tests/calendar/social-function.test.mjs).
//
// Routes, all under https://<project>.supabase.co/functions/v1/calendar-social:
//   GET  /connect?state=...  The Results tab's Connect button lands here. On to Instagram or Threads.
//   GET  /callback           Instagram and Threads send the browser back here with a code.
//   POST /sync               The nightly pg_cron job and Refresh now, with the x-sync-key header.
//   POST /uninstall, /delete Meta's deauthorize and data deletion callbacks.
//
// Tokens never leave the server: they go from Meta to Vault through the cal_private functions, and
// the browser only ever carries the one-time Connect code.

const DAY = 86400000;
export const WINDOW_DAYS = 400; // posts from this far back are listed and kept current
export const FRESH_DAYS = 60; // posts this new get fresh numbers every night, older ones on Sundays
export const RENEW_AFTER_DAYS = 7; // each 60-day token is renewed once it's a week old
export const DEADLINE_MS = 110000; // stop asking for numbers before the Edge Function's time runs out
export const DEFAULT_RETURN = 'https://www.gil1906.org/calendar.html';
const RETURN_OK = /^(https:\/\/(www\.)?gil1906\.org\/|https:\/\/brooklyn-alphas[a-z0-9-]*\.vercel\.app\/|http:\/\/(localhost|127\.0\.0\.1):[0-9]{2,5}\/)[^\s<>"']*$/;

export const IG_GRAPH = 'https://graph.instagram.com';
export const IG_VERSION = 'v25.0';
export const TH_GRAPH = 'https://graph.threads.net';
export const TH_VERSION = 'v1.0';

// Metric sets to ask for, fullest first. A post that can't report a set gets the next one.
const IG_METRICS = ['views,reach,likes,comments,saved,shares,total_interactions', 'reach,likes,comments,saved,shares'];
const TH_METRICS = ['views,likes,replies,reposts,quotes,shares', 'views,likes,replies,reposts,quotes'];
const TH_EARLIEST = 1688540400; // Threads rejects earlier "since" values

export const PLATFORMS = {
  instagram: {
    key: 'instagram',
    label: 'Instagram',
    idEnv: 'INSTAGRAM_APP_ID',
    secretEnv: 'INSTAGRAM_APP_SECRET',
    authorize: 'https://www.instagram.com/oauth/authorize',
    scope: 'instagram_business_basic,instagram_business_manage_insights',
    // Ask for the account's own password, so a personal account signed in on the same phone or
    // browser isn't connected by mistake.
    extra: { force_reauth: 'true', enable_fb_login: 'false' },
    codeUrl: 'https://api.instagram.com/oauth/access_token',
    exchangeUrl: `${IG_GRAPH}/access_token`,
    exchangeGrant: 'ig_exchange_token',
    refreshUrl: `${IG_GRAPH}/refresh_access_token`,
    refreshGrant: 'ig_refresh_token'
  },
  threads: {
    key: 'threads',
    label: 'Threads',
    idEnv: 'THREADS_APP_ID',
    secretEnv: 'THREADS_APP_SECRET',
    authorize: 'https://threads.com/oauth/authorize',
    scope: 'threads_basic,threads_manage_insights',
    extra: {},
    codeUrl: `${TH_GRAPH}/oauth/access_token`,
    exchangeUrl: `${TH_GRAPH}/access_token`,
    exchangeGrant: 'th_exchange_token',
    refreshUrl: `${TH_GRAPH}/refresh_access_token`,
    refreshGrant: 'th_refresh_token'
  }
};

// An error from Instagram or Threads. kind: 'token' (the connection stopped working), 'rate'
// (asked to slow down), 'network' (no answer), or 'api' (anything else).
export class GraphError extends Error {
  constructor(message, { code = null, status = 0, kind = 'api' } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.kind = kind;
  }
}
const TOKEN_CODES = new Set([102, 190]);
const RATE_CODES = new Set([4, 17, 32, 613, 80001, 80002]);

// The database side: the cal_private functions in the fourth migration. query(sql, params) returns
// rows. index.ts passes postgres.js, and the tests pass PGlite.
export function makeDb(query) {
  const one = async (sql, params) => (await query(sql, params))[0] || null;
  return {
    peek: (state) => one('select platform, return_to from cal_private.social_connect_peek($1::text)', [state]),
    claim: (state) => one('select platform, user_id::text as user_id, return_to from cal_private.social_connect_claim($1::text)', [state]),
    saveConnection: (c) =>
      query('select cal_private.social_save_connection($1::text, $2::text, $3::text, $4::text, $5::integer, $6::uuid, $7::text)',
        [c.platform, c.accountId, c.username || null, c.token, c.expiresIn || 0, c.userId, c.functionsUrl]),
    syncKeyOk: async (key) => (await one('select cal_private.social_sync_key_ok($1::text) as ok', [key]))?.ok === true,
    connected: async () => (await query('select p from cal_private.social_connected() as p', [])).map((r) => r.p),
    token: (platform) => one('select token, refreshed_at, expires_at from cal_private.social_token($1::text)', [platform]),
    saveToken: (platform, token, expiresIn) =>
      query('select cal_private.social_save_token($1::text, $2::text, $3::integer)', [platform, token, expiresIn || 0]),
    knownMedia: async (platform) =>
      new Set((await query('select m from cal_private.social_known_media($1::text) as m', [platform])).map((r) => r.m)),
    // JSON goes over as text: postgres.js would encode a string sent as jsonb a second time.
    saveSync: async (platform, account, posts) =>
      (await one('select cal_private.social_save_sync($1::text, ($2::text)::jsonb, ($3::text)::jsonb) as r',
        [platform, JSON.stringify(account), JSON.stringify(posts)])).r,
    syncFailed: (platform, message) => query('select cal_private.social_sync_failed($1::text, $2::text)', [platform, message])
  };
}

// Numbers come back as numbers or strings. Anything else is no number.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Instagram writes offsets as +0000. Make every timestamp plain ISO.
function isoTime(ts) {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function withParams(base, params) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

// Some answers come wrapped in a data list, others don't.
const unwrap = (j) => (Array.isArray(j?.data) ? j.data[0] || {} : j || {});

function short(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// What the media team reads on the Results tab when something goes wrong.
export function friendly(e, label) {
  if (e instanceof GraphError) {
    if (e.kind === 'token') return `The ${label} connection stopped working. Choose Reconnect on the Results tab.`;
    if (e.kind === 'rate') return `${label} asked the calendar to slow down. The next sync tries again.`;
    if (e.kind === 'network') return `${label} didn't answer. The next sync tries again.`;
    return `${label} sent an error: ${short(e.message)}`;
  }
  return `The ${label} sync stopped: ${short(e && e.message ? e.message : e)}`;
}

export function createHandler({ env, db, fetch: fetchImpl, waitUntil = (_promise) => {}, now = () => Date.now(), log = console }) {
  const get = (name) => (typeof env === 'function' ? env(name) : env[name]) || '';
  const base = () => get('SUPABASE_URL').replace(/\/+$/, '');
  const callbackUrl = () => `${base()}/functions/v1/calendar-social/callback`;

  // One request to Instagram or Threads. Errors never include the address, which holds the token.
  async function call(url, init, label) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) });
    } catch {
      throw new GraphError(`${label} didn't answer.`, { kind: 'network' });
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || !body || body.error) {
      const err = body && body.error && typeof body.error === 'object' ? body.error : {};
      const code = num(err.code ?? body?.code);
      const message = err.message || body?.error_message || body?.error_description ||
        (typeof body?.error === 'string' ? body.error : '') || `HTTP ${res.status}`;
      const kind = TOKEN_CODES.has(code) ? 'token' : RATE_CODES.has(code) || res.status === 429 ? 'rate' : 'api';
      throw new GraphError(short(message), { code, status: res.status, kind });
    }
    return body;
  }
  const getJson = (url, label) => call(url, { method: 'GET' }, label);

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  function redirect(location, status = 302) {
    return new Response(null, {
      status,
      headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
    });
  }

  // Back to the calendar's Results tab, with a note the page shows once.
  function back(returnTo, params) {
    const url = new URL(returnTo && RETURN_OK.test(returnTo) ? returnTo : DEFAULT_RETURN);
    url.searchParams.delete('connected');
    url.searchParams.delete('connect_error');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.hash = 'results';
    return redirect(url.toString(), 303);
  }

  const expired = () => back(null, { connect_error: 'That Connect link has expired. Choose Connect again on the Results tab.' });

  async function connect(url) {
    const state = url.searchParams.get('state') || '';
    const found = /^[0-9a-f]{48}$/.test(state) ? await db.peek(state) : null;
    if (!found) return expired();
    const p = PLATFORMS[found.platform];
    if (!get(p.idEnv) || !get(p.secretEnv)) {
      return back(found.return_to, { connect_error: `${p.label} isn't set up yet. Its app ID and secret go in the Edge Function's secrets first.` });
    }
    return redirect(withParams(p.authorize, {
      client_id: get(p.idEnv),
      redirect_uri: callbackUrl(),
      response_type: 'code',
      scope: p.scope,
      state,
      ...p.extra
    }));
  }

  async function callback(url) {
    const state = url.searchParams.get('state') || '';
    let claim = null;
    try {
      claim = /^[0-9a-f]{48}$/.test(state) ? await db.claim(state) : null;
    } catch {
      claim = null;
    }
    if (!claim) return expired();
    const p = PLATFORMS[claim.platform];
    if (url.searchParams.get('error')) {
      return back(claim.return_to, { connect_error: `${p.label} wasn't connected. The sign-in was cancelled.` });
    }
    const code = (url.searchParams.get('code') || '').replace(/#_$/, '');
    if (!code) return back(claim.return_to, { connect_error: `${p.label} wasn't connected. It sent no sign-in code.` });

    try {
      const form = new URLSearchParams({
        client_id: get(p.idEnv),
        client_secret: get(p.secretEnv),
        grant_type: 'authorization_code',
        redirect_uri: callbackUrl(),
        code
      });
      const first = unwrap(await call(p.codeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      }, p.label));
      if (!first.access_token) throw new GraphError(`${p.label} sent no access token.`);
      const long = await getJson(withParams(p.exchangeUrl, {
        grant_type: p.exchangeGrant,
        client_secret: get(p.secretEnv),
        access_token: first.access_token
      }), p.label);
      if (!long.access_token) throw new GraphError(`${p.label} sent no long-lived token.`);
      const me = await profile(p.key, long.access_token);
      await db.saveConnection({
        platform: p.key,
        accountId: me.id,
        username: me.username,
        token: long.access_token,
        expiresIn: num(long.expires_in) || 0,
        userId: claim.user_id,
        functionsUrl: `${base()}/functions/v1`
      });
    } catch (e) {
      log.error(`calendar-social: ${p.key} connect failed: ${e && e.message}`);
      return back(claim.return_to, { connect_error: `${p.label} wasn't connected. ${friendly(e, p.label)}` });
    }
    // The first sync runs after the page is back, so no one waits on it.
    waitUntil(syncPlatform(p.key, { full: true, started: now() }));
    return back(claim.return_to, { connected: p.key });
  }

  async function profile(platform, token) {
    if (platform === 'instagram') {
      const me = unwrap(await getJson(withParams(`${IG_GRAPH}/${IG_VERSION}/me`, { fields: 'user_id,username', access_token: token }), 'Instagram'));
      return { id: String(me.user_id || me.id || ''), username: me.username || null };
    }
    const me = await getJson(withParams(`${TH_GRAPH}/${TH_VERSION}/me`, { fields: 'id,username', access_token: token }), 'Threads');
    return { id: String(me.id || ''), username: me.username || null };
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  // Lists items newest first, page by page, until they're older than the cutoff.
  async function listPages(first, label, cutoff) {
    const out = [];
    const seen = new Set();
    let next = first;
    for (let page = 0; next && page < 40 && !seen.has(next); page += 1) {
      seen.add(next);
      const j = await getJson(next, label);
      const items = Array.isArray(j.data) ? j.data : [];
      let older = false;
      for (const item of items) {
        const t = Date.parse(isoTime(item.timestamp) || '');
        if (Number.isFinite(t) && t < cutoff) {
          older = true;
          break;
        }
        out.push(item);
      }
      if (older || !items.length) break;
      const after = j.paging && j.paging.cursors && j.paging.cursors.after;
      next = (j.paging && j.paging.next) || (after ? withParams(next, { after }) : null);
    }
    return out;
  }

  // Runs fn over items a few at a time, and stops early when told to.
  async function inBatches(items, size, ctx, fn) {
    const out = new Array(items.length).fill(null);
    let i = 0;
    const worker = async () => {
      while (i < items.length && !ctx.stop) {
        const k = i;
        i += 1;
        if (now() - ctx.started > DEADLINE_MS) {
          ctx.stop = 'time';
          break;
        }
        try {
          out[k] = await fn(items[k]);
        } catch (e) {
          if (e instanceof GraphError && ['token', 'rate', 'network'].includes(e.kind)) ctx.stop = e.kind;
          if (e instanceof GraphError && e.kind === 'token') throw e;
          if (!ctx.stop) out[k] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
    return out;
  }

  // A post's insights, trying smaller metric sets when it can't report the full one.
  async function insights(url, sets, token, label) {
    let lastError = null;
    for (const metric of sets) {
      try {
        const j = await getJson(withParams(url, { metric, access_token: token }), label);
        const out = {};
        for (const m of Array.isArray(j.data) ? j.data : []) {
          if (m && typeof m.name === 'string') out[m.name] = num(m.values?.[0]?.value ?? m.total_value?.value);
        }
        return out;
      } catch (e) {
        if (!(e instanceof GraphError) || e.kind !== 'api') throw e;
        lastError = e;
      }
    }
    if (lastError) log.warn(`calendar-social: no ${label} insights for a post: ${lastError.message}`);
    return null;
  }

  // Which posts get fresh numbers: new ones, ones from the last 60 days, and everything on Sundays
  // and on the first sync after connecting.
  function needsNumbers(id, postedAt, known, ctx) {
    return ctx.full || new Date(now()).getUTCDay() === 0 || !known.has(id) || Date.parse(postedAt) > now() - FRESH_DAYS * DAY;
  }

  async function fetchInstagram(token, ctx) {
    const me = unwrap(await getJson(withParams(`${IG_GRAPH}/${IG_VERSION}/me`, {
      fields: 'user_id,username,followers_count,media_count',
      access_token: token
    }), 'Instagram'));
    const media = (await listPages(withParams(`${IG_GRAPH}/${IG_VERSION}/me/media`, {
      fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count',
      limit: 50,
      access_token: token
    }), 'Instagram', ctx.cutoff)).filter((m) => m && m.id && isoTime(m.timestamp));
    const known = await db.knownMedia('instagram');
    const wanted = media.filter((m) => needsNumbers(String(m.id), isoTime(m.timestamp), known, ctx));
    const found = await inBatches(wanted, 4, ctx, (m) => insights(`${IG_GRAPH}/${IG_VERSION}/${m.id}/insights`, IG_METRICS, token, 'Instagram'));
    const byId = new Map(wanted.map((m, k) => [String(m.id), found[k] || {}]));
    const posts = media.map((m) => {
      const n = byId.get(String(m.id)) || {};
      return {
        media_id: String(m.id),
        posted_at: isoTime(m.timestamp),
        permalink: typeof m.permalink === 'string' ? m.permalink : null,
        media_type: m.media_product_type === 'REELS' ? 'REELS' : m.media_type || null,
        caption: typeof m.caption === 'string' ? m.caption.slice(0, 400) : null,
        views: n.views ?? null,
        reach: n.reach ?? null,
        likes: n.likes ?? num(m.like_count),
        comments: n.comments ?? num(m.comments_count),
        saves: n.saved ?? null,
        shares: n.shares ?? null,
        interactions: n.total_interactions ?? null
      };
    });
    return { account: { username: me.username || null, followers: num(me.followers_count), posts: num(me.media_count) }, posts };
  }

  async function fetchThreads(token, ctx) {
    const me = await getJson(withParams(`${TH_GRAPH}/${TH_VERSION}/me`, { fields: 'id,username', access_token: token }), 'Threads');
    let followers = null;
    try {
      const j = await getJson(withParams(`${TH_GRAPH}/${TH_VERSION}/me/threads_insights`, { metric: 'followers_count', access_token: token }), 'Threads');
      const row = (Array.isArray(j.data) ? j.data : []).find((d) => d && d.name === 'followers_count');
      followers = num(row?.total_value?.value ?? row?.values?.[0]?.value);
    } catch (e) {
      if (e instanceof GraphError && e.kind === 'token') throw e;
      ctx.notes.push("Threads didn't send the follower count this time.");
    }
    const items = (await listPages(withParams(`${TH_GRAPH}/${TH_VERSION}/me/threads`, {
      fields: 'id,text,permalink,timestamp,media_type,is_quote_post',
      limit: 50,
      since: Math.max(TH_EARLIEST, Math.floor(ctx.cutoff / 1000)),
      access_token: token
    }), 'Threads', ctx.cutoff)).filter((t) => t && t.id && isoTime(t.timestamp) && t.media_type !== 'REPOST_FACADE');
    const known = await db.knownMedia('threads');
    const wanted = items.filter((t) => needsNumbers(String(t.id), isoTime(t.timestamp), known, ctx));
    const found = await inBatches(wanted, 4, ctx, (t) => insights(`${TH_GRAPH}/${TH_VERSION}/${t.id}/insights`, TH_METRICS, token, 'Threads'));
    const byId = new Map(wanted.map((t, k) => [String(t.id), found[k]]));
    const posts = items.map((t) => {
      const n = byId.get(String(t.id));
      const post = {
        media_id: String(t.id),
        posted_at: isoTime(t.timestamp),
        permalink: typeof t.permalink === 'string' ? t.permalink : null,
        media_type: t.media_type || null,
        caption: typeof t.text === 'string' ? t.text.slice(0, 400) : null
      };
      if (n) {
        Object.assign(post, { views: n.views ?? null, likes: n.likes ?? null, replies: n.replies ?? null, reposts: n.reposts ?? null, quotes: n.quotes ?? null, shares: n.shares ?? null });
        const parts = [n.likes, n.replies, n.reposts, n.quotes, n.shares].filter((x) => x !== null && x !== undefined);
        post.interactions = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
      }
      return post;
    });
    return { account: { username: me.username || null, followers, posts: null }, posts };
  }

  // One platform's sync: renew the token when it's due, fetch, save, and leave a note if needed.
  async function syncPlatform(platform, { full = false, started = now() } = {}) {
    const p = PLATFORMS[platform];
    const ctx = { full, started, cutoff: now() - WINDOW_DAYS * DAY, stop: null, notes: [] };
    try {
      const saved = await db.token(platform);
      if (!saved || !saved.token) return { platform, skipped: true };
      const expiresAt = saved.expires_at ? new Date(saved.expires_at).getTime() : null;
      if (expiresAt && expiresAt <= now()) {
        throw new GraphError('expired', { kind: 'expired' });
      }
      let token = saved.token;
      if (now() - new Date(saved.refreshed_at).getTime() > RENEW_AFTER_DAYS * DAY) {
        try {
          const r = await getJson(withParams(p.refreshUrl, { grant_type: p.refreshGrant, access_token: token }), p.label);
          if (r.access_token) {
            await db.saveToken(platform, r.access_token, num(r.expires_in) || 0);
            token = r.access_token;
          }
        } catch (e) {
          if (e instanceof GraphError && e.kind === 'token') throw e;
          log.warn(`calendar-social: renewing the ${platform} token failed: ${e && e.message}`);
          if (expiresAt && expiresAt - now() < 10 * DAY) {
            const day = new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
            ctx.notes.push(`Renewing the ${p.label} connection didn't work. Choose Reconnect on the Results tab before ${day}.`);
          }
        }
      }
      const result = platform === 'instagram' ? await fetchInstagram(token, ctx) : await fetchThreads(token, ctx);
      const counts = await db.saveSync(platform, result.account, result.posts);
      if (ctx.stop === 'rate') ctx.notes.unshift(`${p.label} asked the calendar to slow down. Numbers for some posts update on the next sync.`);
      if (ctx.stop === 'network') ctx.notes.unshift(`${p.label} stopped answering partway. Numbers for some posts update on the next sync.`);
      if (ctx.stop === 'time') ctx.notes.unshift(`The ${p.label} sync ran out of time. Numbers for some posts update on the next sync.`);
      if (ctx.notes.length) await db.syncFailed(platform, ctx.notes.join(' '));
      return { platform, ...counts, notes: ctx.notes };
    } catch (e) {
      const message = e instanceof GraphError && e.kind === 'expired'
        ? `The ${p.label} connection expired. Choose Reconnect on the Results tab.`
        : friendly(e, p.label);
      log.error(`calendar-social: ${platform} sync failed: ${e && e.message}`);
      try {
        await db.syncFailed(platform, message);
      } catch (inner) {
        log.error(`calendar-social: could not record the ${platform} sync failure: ${inner && inner.message}`);
      }
      return { platform, error: message };
    }
  }

  async function sync(req) {
    const key = req.headers.get('x-sync-key') || '';
    if (!key || !(await db.syncKeyOk(key))) return json(401, { error: 'Not allowed.' });
    const platforms = await db.connected();
    const started = now();
    // Answer right away and keep working, so the database's request never waits on Meta.
    waitUntil(Promise.all(platforms.map((platform) => syncPlatform(platform, { started }))));
    return json(202, { syncing: platforms });
  }

  function json(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  return async function handle(req) {
    const url = new URL(req.url);
    const route = url.pathname.replace(/\/+$/, '').split('/').pop();
    try {
      if (route === 'connect' && req.method === 'GET') return await connect(url);
      if (route === 'callback' && req.method === 'GET') return await callback(url);
      if (route === 'sync' && req.method === 'POST') return await sync(req);
      // Meta calls these if the account removes the app or asks for its data to be deleted. The
      // media team disconnects from the Results tab, and the next sync notes a removed app.
      if (route === 'uninstall' && req.method === 'POST') return json(200, { ok: true });
      if (route === 'delete' && req.method === 'POST') {
        const code = crypto.randomUUID();
        return json(200, { url: `${DEFAULT_RETURN}#results`, confirmation_code: code });
      }
      return json(404, { error: 'Not found.' });
    } catch (e) {
      log.error(`calendar-social: ${route} failed: ${e && e.message}`);
      if (route === 'connect' || route === 'callback') {
        return back(null, { connect_error: 'Something went wrong while connecting. Try again in a minute.' });
      }
      return json(500, { error: 'Something went wrong.' });
    }
  };
}
