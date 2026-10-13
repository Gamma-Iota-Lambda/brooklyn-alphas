// A local stand-in for the Supabase project behind calendar.html, for testing live mode in a real browser:
//   * Postgres: the real migration and seed in PGlite, with row level security enforced per request
//   * Data API: the parts of PostgREST the calendar uses (table reads and writes, and RPC)
//   * Auth: anonymous and email/password sessions
//   * Storage: uploads, signed links, downloads, and removal, with the storage policies enforced
//   * Static hosting for the site, with assets/calendar/config.js pointed at this server
// Adapted from the Alpha Academy Trading Floor's stand-in. live-smoke.mjs drives it.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDb } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};
const IDENT = /^[a-z_][a-z0-9_]*$/;
const TABLES = new Set(['cal_posts', 'cal_requests', 'cal_members', 'cal_staff']);
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

// demo: serve the site with an empty config.js, so the page runs its demo and no database starts.
export async function startLiveServer({ port = 5181, confirmEmail = false, demo = false } = {}) {
  const h = demo ? null : await createDb({ postgrestTypes: true });
  const origin = `http://localhost:${port}`;

  // One database connection: run requests one at a time.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const users = new Map(); // id -> {id, email, password, is_anonymous, confirmed}
  const files = new Map(); // 'bucket/name' -> {bytes, type}
  const signed = new Map(); // signed-link token -> {key, exp}
  const tokens = new Map(); // access token -> user id
  const refresh = new Map(); // refresh token -> user id

  function publicUser(u) {
    return {
      id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email ?? '', phone: '',
      app_metadata: { provider: u.is_anonymous ? 'anonymous' : 'email' }, user_metadata: {}, identities: [],
      is_anonymous: !!u.is_anonymous, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
  }

  function issue(user) {
    const iat = Math.floor(Date.now() / 1000);
    const claims = { sub: user.id, role: 'authenticated', aud: 'authenticated', email: user.email ?? '', is_anonymous: !!user.is_anonymous, iat, exp: iat + 3600 };
    const access = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.${Buffer.from(randomUUID()).toString('base64url')}`;
    const rt = randomUUID();
    tokens.set(access, user.id);
    refresh.set(rt, user.id);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: iat + 3600, refresh_token: rt, user: publicUser(user) };
  }

  async function createUser({ email = null, password = null, anon = false }) {
    const id = randomUUID();
    await serial(() => h.sql('insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)', [id, email, anon]));
    const user = { id, email, password, is_anonymous: anon, confirmed: anon || !confirmEmail };
    users.set(id, user);
    return user;
  }

  function principal(req) {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const uid = tokens.get(auth);
    if (!uid) return null;
    const u = users.get(uid);
    return { id: u.id, anon: !!u.is_anonymous };
  }

  // ---------------------------------------------------------------- Data API: RPC
  async function callRpc(who, fn, args = {}) {
    const [meta] = await h.sql(
      `select p.proretset, t.typtype, p.prorettype::regtype::text as rt
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
       where n.nspname = 'public' and p.proname = $1`, [fn]);
    if (!meta) throw fail(404, 'PGRST202', `Could not find the function public.${fn} in the schema cache`);
    const keys = Object.keys(args || {});
    if (!keys.every((k) => IDENT.test(k))) throw fail(400, 'PGRST100', 'bad argument name');
    const argSql = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
    const vals = keys.map((k) => (args[k] && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
    return h.as(who, async (db) => {
      if (meta.typtype === 'c' || meta.rt === 'record') {
        const r = await db.query(`select * from public.${fn}(${argSql})`, vals);
        return meta.proretset ? r.rows : (r.rows[0] ?? null);
      }
      const r = await db.query(`select public.${fn}(${argSql}) as v`, vals);
      return meta.proretset ? r.rows.map((x) => x.v) : (r.rows[0]?.v ?? null);
    });
  }

  // ---------------------------------------------------------------- Data API: tables
  function filters(params, vals) {
    const where = [];
    for (const [k, v] of params.entries()) {
      if (['select', 'order', 'limit', 'offset', 'columns'].includes(k)) continue;
      if (!IDENT.test(k)) throw fail(400, 'PGRST100', `bad filter ${k}`);
      const dot = v.indexOf('.');
      const op = v.slice(0, dot), raw = v.slice(dot + 1);
      if (op !== 'eq') throw fail(400, 'PGRST100', `unsupported operator ${op}`);
      vals.push(raw);
      where.push(`t.${k}::text = $${vals.length}`);
    }
    return where.length ? ' where ' + where.join(' and ') : '';
  }

  function columns(params) {
    const select = (params.get('select') || '*').replace(/\s+/g, '');
    return select.split(',').filter(Boolean).map((c) => {
      if (c === '*') return 't.*';
      if (!IDENT.test(c)) throw fail(400, 'PGRST100', `bad column ${c}`);
      return `t.${c}`;
    }).join(', ');
  }

  async function tableRead(table, params, who) {
    const vals = [];
    const where = filters(params, vals);
    let order = '';
    if (params.get('order')) {
      order = ' order by ' + params.get('order').split(',').map((o) => {
        const [col, dir] = o.split('.');
        if (!IDENT.test(col)) throw fail(400, 'PGRST100', `bad order ${col}`);
        return `t.${col} ${dir === 'desc' ? 'desc' : 'asc'}`;
      }).join(', ');
    }
    const limit = params.get('limit') ? ` limit ${Number(params.get('limit'))}` : '';
    const offset = params.get('offset') ? ` offset ${Number(params.get('offset'))}` : '';
    return serial(() => h.select(who, `select ${columns(params)} from public.${table} t${where}${order}${limit}${offset}`, vals));
  }

  async function tableWrite(method, table, params, payload, who) {
    if (method === 'POST') {
      const rows = Array.isArray(payload) ? payload : [payload];
      const out = [];
      for (const row of rows) {
        const keys = Object.keys(row);
        if (!keys.every((k) => IDENT.test(k))) throw fail(400, 'PGRST100', 'bad column');
        const sql = `insert into public.${table} as t (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning t.*`;
        out.push(...await serial(() => h.select(who, sql, keys.map((k) => row[k]))));
      }
      return out;
    }
    const vals = [];
    if (method === 'PATCH') {
      const keys = Object.keys(payload);
      if (!keys.every((k) => IDENT.test(k))) throw fail(400, 'PGRST100', 'bad column');
      const set = keys.map((k) => { vals.push(payload[k]); return `${k} = $${vals.length}`; }).join(', ');
      const where = filters(params, vals);
      return serial(() => h.select(who, `update public.${table} as t set ${set}${where} returning t.*`, vals));
    }
    if (method === 'DELETE') {
      const where = filters(params, vals);
      return serial(() => h.select(who, `delete from public.${table} as t${where} returning t.*`, vals));
    }
    throw fail(405, 'PGRST000', 'method not allowed');
  }

  // Postgres errors, shaped the way PostgREST sends them.
  function pgError(e) {
    const msg = e.message || String(e);
    if (e.status) return [e.status, { code: e.code, message: msg, details: null, hint: null }];
    if (/row-level security|permission denied/.test(msg)) return [403, { code: '42501', message: msg, details: null, hint: null }];
    if (/violates check constraint/.test(msg)) return [400, { code: '23514', message: msg, details: null, hint: null }];
    return [400, { code: 'P0001', message: msg, details: null, hint: null }];
  }

  // ---------------------------------------------------------------- HTTP
  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const s = Buffer.concat(chunks).toString('utf8');
    return s ? JSON.parse(s) : {};
  }

  function send(res, status, data, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(data === undefined ? '' : JSON.stringify(data));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const path = url.pathname;
    try {
      if (demo && /^\/(auth|rest|storage)\//.test(path)) return send(res, 404, { message: 'demo mode has no backend' });

      // Auth
      if (path === '/auth/v1/signup' && req.method === 'POST') {
        const b = await body(req);
        if (b.email) {
          if ([...users.values()].some((u) => u.email === b.email)) return send(res, 422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
          const user = await createUser({ email: b.email, password: b.password });
          return send(res, 200, user.confirmed ? issue(user) : publicUser(user));
        }
        return send(res, 200, issue(await createUser({ anon: true })));
      }
      if (path === '/auth/v1/token' && req.method === 'POST') {
        const b = await body(req);
        if (url.searchParams.get('grant_type') === 'password') {
          const u = [...users.values()].find((x) => x.email === b.email && x.password === b.password);
          if (!u) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
          if (!u.confirmed) return send(res, 400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
          return send(res, 200, issue(u));
        }
        const uid = refresh.get(b.refresh_token);
        if (!uid) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        return send(res, 200, issue(users.get(uid)));
      }
      if (path === '/auth/v1/logout') {
        res.writeHead(204);
        return res.end();
      }
      if (path === '/auth/v1/user') {
        const p = principal(req);
        return p ? send(res, 200, publicUser(users.get(p.id))) : send(res, 401, { msg: 'invalid JWT' });
      }

      // Data API
      if (path.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
        const fn = path.slice('/rest/v1/rpc/'.length);
        if (!IDENT.test(fn)) return send(res, 404, { message: 'not found' });
        const args = await body(req);
        try {
          return send(res, 200, await serial(() => callRpc(principal(req), fn, args)));
        } catch (e) {
          return send(res, ...pgError(e));
        }
      }
      if (path.startsWith('/rest/v1/')) {
        const table = path.slice('/rest/v1/'.length);
        if (!TABLES.has(table)) return send(res, 404, { code: 'PGRST205', message: `Could not find the table public.${table}` });
        const single = /vnd\.pgrst\.object/.test(req.headers.accept || '');
        const representation = /return=representation/.test(req.headers.prefer || '');
        try {
          const rows = req.method === 'GET'
            ? await tableRead(table, url.searchParams, principal(req))
            : await tableWrite(req.method, table, url.searchParams, await body(req), principal(req));
          if (req.method !== 'GET' && !representation) { res.writeHead(204); return res.end(); }
          if (single) {
            if (rows.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null });
            return send(res, req.method === 'POST' ? 201 : 200, rows[0]);
          }
          return send(res, req.method === 'POST' ? 201 : 200, rows);
        } catch (e) {
          return send(res, ...pgError(e));
        }
      }

      // Storage (the parts the calendar uses). Object rows go through row level security as the caller.
      if (path.startsWith('/storage/v1/object/sign/') && req.method === 'POST') {
        const rest = decodeURIComponent(path.slice('/storage/v1/object/sign/'.length));
        const [bucket, ...nameParts] = rest.split('/');
        const b = await body(req);
        const names = nameParts.length ? [nameParts.join('/')] : (b.paths || []);
        const visible = new Set((await serial(() => h.select(principal(req),
          'select name from storage.objects where bucket_id = $1 and name = any($2::text[])', [bucket, names]))).map((r) => r.name));
        const out = names.map((name) => {
          if (!visible.has(name)) return { error: 'Either the object does not exist or you do not have access to it', path: name, signedURL: null };
          const token = randomUUID();
          signed.set(token, { key: `${bucket}/${name}`, exp: Date.now() + (Number(b.expiresIn) || 60) * 1000 });
          return { error: null, path: name, signedURL: `/object/sign/${bucket}/${name}?token=${token}` };
        });
        return send(res, 200, nameParts.length ? { signedURL: out[0].signedURL } : out);
      }
      if (path.startsWith('/storage/v1/object/sign/') && req.method === 'GET') {
        const key = decodeURIComponent(path.slice('/storage/v1/object/sign/'.length));
        const grant = signed.get(url.searchParams.get('token'));
        if (!grant || grant.key !== key || grant.exp < Date.now()) return send(res, 400, { statusCode: '400', error: 'InvalidSignature', message: 'The signature is not valid' });
        const file = files.get(key);
        if (!file) return send(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        const headers = { 'Content-Type': file.type, 'Content-Length': file.bytes.length };
        if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="${url.searchParams.get('download') || key.split('/').pop()}"`;
        res.writeHead(200, headers);
        return res.end(file.bytes);
      }
      if (path.startsWith('/storage/v1/object/') && req.method === 'POST') {
        const rest = decodeURIComponent(path.slice('/storage/v1/object/'.length));
        const [bucket, ...nameParts] = rest.split('/');
        const name = nameParts.join('/');
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const form = await new Request(origin + path, { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
        const file = [...form.values()].find((v) => typeof v !== 'string');
        if (!file) return send(res, 400, { statusCode: '400', error: 'Error', message: 'No file in the upload' });
        const [limits] = await serial(() => h.sql('select file_size_limit, allowed_mime_types from storage.buckets where id = $1', [bucket]));
        if (!limits) return send(res, 400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
        const type = file.type || 'application/octet-stream';
        if (limits.file_size_limit && file.size > Number(limits.file_size_limit)) {
          return send(res, 400, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
        }
        if (limits.allowed_mime_types && !limits.allowed_mime_types.some((m) => (m.endsWith('/*') ? type.startsWith(m.slice(0, -1)) : m === type))) {
          return send(res, 400, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` });
        }
        const who = principal(req);
        try {
          await serial(() => h.select(who, 'insert into storage.objects (bucket_id, name, owner_id, metadata) values ($1, $2, $3, $4) returning id',
            [bucket, name, who ? who.id : null, JSON.stringify({ mimetype: type, size: file.size })]));
        } catch (e) {
          return send(res, 400, { statusCode: '403', error: 'Unauthorized', message: /row-level security/.test(e.message) ? 'new row violates row-level security policy' : e.message });
        }
        files.set(`${bucket}/${name}`, { bytes: Buffer.from(await file.arrayBuffer()), type });
        return send(res, 200, { Id: randomUUID(), Key: `${bucket}/${name}` });
      }
      if (path.startsWith('/storage/v1/object/') && req.method === 'DELETE') {
        const bucket = decodeURIComponent(path.slice('/storage/v1/object/'.length));
        const b = await body(req);
        const rows = await serial(() => h.select(principal(req),
          'delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name', [bucket, b.prefixes || []]));
        for (const r of rows) files.delete(`${bucket}/${r.name}`);
        return send(res, 200, rows.map((r) => ({ name: r.name, bucket_id: bucket })));
      }

      // Site
      if (path === '/assets/calendar/config.js') {
        res.writeHead(200, { 'Content-Type': TYPES['.js'] });
        const config = demo ? { supabaseUrl: '', supabaseKey: '' } : { supabaseUrl: origin, supabaseKey: 'sb_publishable_test' };
        return res.end(`window.GIL_CALENDAR_CONFIG = ${JSON.stringify(config)};`);
      }
      let p = decodeURIComponent(path);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(root, p));
      if (!file.startsWith(root)) throw new Error('outside');
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(await readFile(file));
    } catch (e) {
      if (!res.headersSent) send(res, 404, { message: e.message });
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return {
    origin,
    h,
    users,
    files,
    sql: (q, params) => serial(() => h.sql(q, params)),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
