// photo-drop: takes in the School Daze photos, lets the organizers review them, and feeds the
// slideshow on the venue's screens. index.ts runs this on Supabase Edge Functions (Deno). The tests
// run the same file in Node against the real migration, with Storage simulated
// (tests/calendar/photo-drop-function.test.mjs).
//
// Routes, all POST, under https://<project>.supabase.co/functions/v1/photo-drop:
//   /open    The upload page: is this link good, and are photos still being taken?
//   /send    The upload page: one photo, as a form.
//   /review  The review page: list, set, caption, settings, delete, empty, and for the committee's
//            videos: video, video-done, video-cancel.
//   /screen  The slideshow: the approved photos, and the committee's videos beside them.
//
// Each page sends its own code and the database checks it (the cal_private.drop_ functions in
// migration 20261118000100_photo_drop.sql and the three after it). Photos live in a private
// Storage bucket that only this function's secret key reaches. The pages see them through signed
// links. A video is the one thing that doesn't pass through here: the organizer's browser sends
// it straight to the bucket, through a link this function hands out for that one file.

const DAY = 86400000;
export const BUCKET = 'photo-drop';
export const MAX_REQUEST_BYTES = 7500000; // one /send, form and all
export const MAX_PHOTO_BYTES = 6291456; // 6 MB, the same number drop_open gives the page
export const MAX_THUMB_BYTES = 307200;
export const MIN_EDGE = 500; // a long side under this looks like mush on a big screen
// The page never sends a long side over 2,560. These stop a file made to exhaust whatever opens
// it: the review page on a phone, or the venue's computer.
export const MAX_SIDE = 12000;
export const MAX_PIXELS = 50000000;
export const MAX_THUMB_SIDE = 2000;
export const MAX_TEXT = 2000; // anything longer isn't a name, an email, or a caption
export const MAX_JSON_BYTES = 65536;
// A body is read to its end even when it is too large to use, up to this much. See readBody.
export const DRAIN_MAX = 40000000;
export const SIGN_DAYS = 14; // how long a signed link lasts; the review list renews them
export const REMOVE_BATCH = 100;
export const LIST_BATCH = 1000;
export const SIGN_BATCH = 200;
// What a filled honeypot is told, as if the photo had been taken.
const PRETEND_LEFT = 4;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json'
};
const ROUTES = new Set(['open', 'send', 'review', 'screen']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_A_PHOTO = "That file isn't a photo we can use. Send a JPEG.";
const TOO_LARGE = 'That photo is too large to send. Try a smaller copy.';
const UNREADABLE = "That request didn't read right. Reload the page and try again.";

// Something the caller can fix. It becomes { error, reason } with the status.
class Refusal extends Error {
  constructor(status, reason, message) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

// Storage didn't do what was asked. The message is safe to log: what was tried and the status,
// never a key or a link.
class StorageError extends Error {}

// The database side: the cal_private.drop_ functions. query(sql, params) returns rows. index.ts
// passes postgres.js, and the tests pass PGlite.
export function makeDb(query) {
  const value = async (call, params) => (await query(`select ${call} as r`, params))[0]?.r ?? null;
  // JSON and lists of ids go over as text: postgres.js would encode a string sent as jsonb a
  // second time, and the two drivers write arrays differently. Ids are checked before they get here.
  const idList = (ids) => (ids ? `{${ids.join(',')}}` : null);
  return {
    open: (code) => value('cal_private.drop_open($1::text)', [code]),
    reserve: (p) =>
      value(`cal_private.drop_reserve($1::text, $2::text, $3::text, $4::text, $5::integer, $6::integer, $7::integer,
        ($8::text)::boolean, $9::text, ($10::text)::jsonb, $11::text)`,
        [p.code, p.name, p.email, p.caption, p.width, p.height, p.bytes, p.hasThumb ? 'true' : 'false', p.ip,
          p.original ? JSON.stringify(p.original) : null, p.sha256 || null]),
    stored: async (id, url, thumbUrl, until) =>
      (await value('cal_private.drop_stored($1::uuid, $2::text, $3::text, ($4::text)::timestamptz)', [id, url, thumbUrl, until])) === true,
    abandon: (id) => query('select cal_private.drop_abandon($1::uuid)', [id]),
    stale: async () => (await value('cal_private.drop_stale()', [])) || [],
    reviewList: (code) => value('cal_private.drop_review_list($1::text)', [code]),
    reviewSet: (code, ids, status, by) =>
      value('cal_private.drop_review_set($1::text, ($2::text)::uuid[], $3::text, $4::text)', [code, idList(ids), status, by]),
    reviewCaption: (code, id, caption) => value('cal_private.drop_review_caption($1::text, $2::uuid, $3::text)', [code, id, caption]),
    reviewSettings: (code, changes) =>
      value('cal_private.drop_review_settings($1::text, ($2::text)::jsonb)', [code, JSON.stringify(changes)]),
    reviewPaths: (code, ids) => value('cal_private.drop_review_paths($1::text, ($2::text)::uuid[])', [code, idList(ids)]),
    reviewDelete: (code, ids) => value('cal_private.drop_review_delete($1::text, ($2::text)::uuid[])', [code, idList(ids)]),
    screenList: (code) => value('cal_private.drop_screen_list($1::text)', [code]),
    resignDue: async () => (await value('cal_private.drop_resign_due()', [])) || [],
    resignSave: (rows) => value('cal_private.drop_resign_save(($1::text)::jsonb)', [JSON.stringify(rows)]),
    // The size and the length go over as text too: one can be past what a driver takes for an
    // integer, and the other has a fraction.
    videoReserve: (p) =>
      value(`cal_private.drop_video_reserve($1::text, $2::text, $3::text, $4::integer, $5::integer, ($6::text)::bigint,
        ($7::text)::numeric, $8::text)`,
        [p.code, p.by, p.caption, p.width, p.height, String(p.bytes), p.seconds === null ? null : String(p.seconds), p.mime]),
    videoHeld: (code, id) => value('cal_private.drop_video_held($1::text, $2::uuid)', [code, id]),
    videoStored: (code, id, by, hasThumb, url, thumbUrl, until) =>
      value(`cal_private.drop_video_stored($1::text, $2::uuid, $3::text, ($4::text)::boolean, $5::text, $6::text,
        ($7::text)::timestamptz)`, [code, id, by, hasThumb ? 'true' : 'false', url, thumbUrl, until])
  };
}

// The pixel size of a JPEG, read from its frame header, or null when the bytes aren't a JPEG a
// browser can show. Nothing is decoded: this walks the segments at the front of the file, and
// anything out of place counts as not a photo.
export function jpegSize(bytes) {
  const end = bytes.length;
  if (end < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  let at = 2;
  while (at < end) {
    // Every segment starts with FF, and any number of extra FF bytes may pad the gap before it.
    if (bytes[at] !== 0xff) return null;
    while (at < end && bytes[at] === 0xff) at += 1;
    if (at >= end) return null;
    const marker = bytes[at];
    at += 1;
    // Markers that stand alone, with no length after them: TEM, the restart markers, and SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // FF 00 only belongs inside picture data. The end of the file or the start of the picture
    // data before any frame header means there is no size to read.
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) return null;
    if (at + 2 > end) return null;
    const length = (bytes[at] << 8) | bytes[at + 1];
    if (length < 2 || at + length > end) return null;
    // Baseline, extended, and progressive frames: the kinds browsers show.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) return null;
      const precision = bytes[at + 2];
      const height = (bytes[at + 3] << 8) | bytes[at + 4];
      const width = (bytes[at + 5] << 8) | bytes[at + 6];
      const parts = bytes[at + 7];
      // 8 bits a sample, in grey, colour, or four inks, with the header exactly as long as that needs.
      if (precision !== 8 || ![1, 3, 4].includes(parts) || length !== 8 + 3 * parts) return null;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    // The other frame kinds (lossless, arithmetic-coded, and so on) are JPEGs no browser shows.
    // C4, C8, and CC are tables and an extension, not frames, and are skipped like the rest.
    if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return null;
    at += length;
  }
  return null;
}

// The caller's address, for the limit on photos from one connection: the last entry of
// x-forwarded-for, which the platform adds (anything before it can be typed in by the sender).
// An address inside a private network is one of the platform's own machines, not anyone's
// connection, so it counts as none rather than as everyone.
const PRIVATE_ADDRESS = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/;
export function callerIp(req) {
  let last = (req.headers.get('x-forwarded-for') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).pop() || '';
  if (last.length > 45 || !/^[0-9a-f:.]+$/.test(last)) return '';
  // An IPv4 address written the IPv6 way.
  const mapped = /^::ffff:([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/.exec(last);
  if (mapped) last = mapped[1];
  if (PRIVATE_ADDRESS.test(last)) return '';
  if (!last.includes(':')) return last;
  // The all-zero network holds no real sender: it is "no address", this machine, or an IPv4
  // address written in a form not unwrapped above. None of those is anyone's connection.
  const network = network64(last);
  return network === '0:0:0:0::/64' ? '' : network;
}

// A home line or a phone is given a whole block of IPv6 addresses (a /64) and can use any of
// them, so the block is the connection: its first four groups.
function network64(address) {
  const [head, tail] = address.split('::');
  const first = head ? head.split(':') : [];
  const rest = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...first, ...Array(Math.max(0, 8 - first.length - rest.length)).fill('0'), ...rest] : first;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Text for a log line: one line, no control characters, cut on whole characters.
function short(text, max = 160) {
  const s = Array.from(String(text || '').replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim());
  return s.length > max ? `${s.slice(0, max - 1).join('')}…` : s.join('');
}

// An error for the log. Postgres quotes the offending value in some messages, and a value can be
// something a person typed, so anything in quotes is left out. The constraint's name says enough.
function errorText(e) {
  if (e instanceof StorageError) return e.message;
  const message = short(String((e && e.message) || e).replace(/"[^"]*"/g, '(…)'));
  const more = [
    e && e.code ? `code ${short(e.code, 20)}` : '',
    short((e && (e.constraint_name || e.constraint)) || '', 80)
  ].filter(Boolean);
  return more.length ? `${message} (${more.join(', ')})` : message;
}

// Text made safe to store: no control characters (Postgres can't hold a NUL), no half of a split
// emoji (JSON for Postgres can't hold one), and no space around it.
const tidy = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\p{Cs}/gu, '').trim();

// Text a person typed, ready for the database. Real limits are the database's; this only stops
// the absurd.
function typed(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new Refusal(400, 'input', UNREADABLE);
  const text = tidy(value);
  if (text.length > MAX_TEXT) throw new Refusal(400, 'input', "That's too much text. Shorten it and try again.");
  return text;
}

// A whole number the page sent as text, or null.
function whole(value) {
  const n = typeof value === 'string' && /^[0-9]{1,9}$/.test(value.trim()) ? Number(value.trim()) : null;
  return n !== null && n > 0 ? n : null;
}

// What the page says about the file the person picked, before it shrank the photo. Kept for the
// review page's size pill. Only the five fields, each a sane size, or nothing at all.
function originalOf(text) {
  let o;
  try {
    o = JSON.parse(typeof text === 'string' ? text : '');
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const words = (v, max) => (typeof v === 'string' ? Array.from(tidy(v)).slice(0, max).join('') : null);
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const kept = { name: words(o.name, 120), width: count(o.width), height: count(o.height), bytes: count(o.bytes), type: words(o.type, 60) };
  return Object.values(kept).some((v) => v !== null) ? kept : null;
}

// Reads a request's body to its end and returns up to `keep` bytes of it. `over` says there was
// more. An answer sent while the body is still arriving can hang or be lost on the sender's side
// (seen on this platform with anything past about 100 KB), so every answer waits for the whole
// body, even one that is too large to use. Past DRAIN_MAX the rest is dropped unread.
export async function readBody(req, keep) {
  if (!req.body) return { bytes: new Uint8Array(0), over: false };
  const reader = req.body.getReader();
  let chunks = [];
  let size = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (!over && size > keep) {
      over = true;
      chunks = [];
    }
    if (!over) chunks.push(value);
    if (size > DRAIN_MAX) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(over ? 0 : size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, over };
}

// A photo's fingerprint: the SHA-256 of its bytes, in hex. The database uses it to notice the
// same photo sent twice by the same person.
async function fingerprint(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

const isFile = (v) => !!v && typeof v === 'object' && typeof v.arrayBuffer === 'function' && typeof v.size === 'number';
const iso = (time) => (time ? new Date(time).toISOString() : null);

export function createHandler({ env, db, fetch: fetchImpl, now = () => Date.now(), log = console }) {
  const get = (name) => (typeof env === 'function' ? env(name) : env[name]) || '';
  const base = () => get('SUPABASE_URL').replace(/\/+$/, '');

  function json(status, body) {
    return new Response(JSON.stringify(body), { status, headers: HEADERS });
  }

  // A refusal from the database ({ ok: false, status, reason, error }) is the answer as it stands.
  function refused(r) {
    const status = Number.isInteger(r && r.status) && r.status >= 400 && r.status <= 499 ? r.status : 400;
    return json(status, { error: (r && r.error) || 'Something went wrong. Try again.', reason: (r && r.reason) || 'input' });
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  // The project's secret key, which every Edge Function is given. Newer projects have it in
  // SUPABASE_SECRET_KEYS (JSON, under "default"), and older ones in SUPABASE_SERVICE_ROLE_KEY.
  let saidNoKey = false;
  function storageKey() {
    let key = '';
    try {
      const keys = JSON.parse(get('SUPABASE_SECRET_KEYS') || 'null');
      if (keys && typeof keys.default === 'string') key = keys.default;
    } catch {
      key = '';
    }
    key = key || get('SUPABASE_SERVICE_ROLE_KEY');
    if (!key && !saidNoKey) {
      saidNoKey = true;
      log.error('photo-drop: no Storage key. The function needs SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY to save photos.');
    }
    return key;
  }

  // One request to Storage. what names it for the log.
  async function storage(what, method, path, { headers = {}, body = undefined, timeout = 15000 } = {}) {
    const key = storageKey();
    if (!key) throw new StorageError(`${what}: no Storage key`);
    let res;
    try {
      res = await fetchImpl(`${base()}/storage/v1${path}`, {
        method,
        headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers },
        body,
        signal: AbortSignal.timeout(timeout)
      });
    } catch {
      throw new StorageError(`${what}: Storage didn't answer`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const said = data && typeof data === 'object' ? [data.error, data.message].filter((x) => typeof x === 'string').join(': ') : '';
      throw new StorageError(`${what}: HTTP ${res.status}${said ? ` ${short(said, 120)}` : ''}`);
    }
    return data;
  }

  const putFile = (path, bytes) =>
    storage('put', 'POST', `/object/${BUCKET}/${path}`, {
      headers: { 'Content-Type': 'image/jpeg', 'cache-control': 'max-age=31536000', 'x-upsert': 'true' },
      body: bytes,
      timeout: 30000
    });

  // Signed links for these paths, as a Map of path to full link. A path with no file is left out.
  async function signLinks(paths) {
    const links = new Map();
    for (let i = 0; i < paths.length; i += SIGN_BATCH) {
      const answer = await storage('sign', 'POST', `/object/sign/${BUCKET}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: SIGN_DAYS * 86400, paths: paths.slice(i, i + SIGN_BATCH) })
      });
      if (!Array.isArray(answer)) throw new StorageError('sign: an answer that made no sense');
      for (const item of answer) {
        if (item && typeof item.path === 'string' && typeof item.signedURL === 'string' && item.signedURL) {
          links.set(item.path, `${base()}/storage/v1${item.signedURL.startsWith('/') ? '' : '/'}${item.signedURL}`);
        }
      }
    }
    return links;
  }
  const signedUntil = () => new Date(now() + SIGN_DAYS * DAY).toISOString();

  // A link an organizer's browser can send one file to, with no key: Storage takes a PUT to it
  // for that path only, for two hours. A second PUT replaces the first, so an upload that broke
  // off can be sent again.
  async function uploadLink(path) {
    const answer = await storage('sign', 'POST', `/object/upload/sign/${BUCKET}/${path}`, {
      headers: { 'Content-Type': 'application/json', 'x-upsert': 'true' },
      body: '{}'
    });
    const url = answer && typeof answer.url === 'string' && answer.url.includes('token=') ? answer.url : '';
    if (!url) throw new StorageError('sign: an answer that made no sense');
    return `${base()}/storage/v1${url.startsWith('/') ? '' : '/'}${url}`;
  }

  // Takes files out of the bucket. A path with no file is not an error.
  async function removeFiles(paths) {
    for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
      await storage('remove', 'DELETE', `/object/${BUCKET}`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: paths.slice(i, i + REMOVE_BATCH) })
      });
    }
  }

  // What Storage holds at a path: { size, type }, the file's size in bytes and the type it was
  // stored with, or null when no file is there. This is how a video is checked: its bytes went
  // from the organizer's browser to Storage and were never here. Storage is asked for the file's
  // folder, narrowed to the file's name.
  async function findFile(path) {
    const cut = path.lastIndexOf('/');
    const name = path.slice(cut + 1);
    const answer = await storage('list', 'POST', `/object/list/${BUCKET}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: path.slice(0, Math.max(cut, 0)), search: name, limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } })
    });
    if (!Array.isArray(answer)) throw new StorageError('list: an answer that made no sense');
    const item = answer.find((x) => x && x.name === name);
    if (!item) return null;
    const about = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    return { size: Number.isFinite(about.size) ? about.size : null, type: typeof about.mimetype === 'string' ? about.mimetype : null };
  }

  // The paths of the files in one of the bucket's three folders, up to a thousand a call.
  async function listFiles(folder) {
    const answer = await storage('list', 'POST', `/object/list/${BUCKET}`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: folder, limit: LIST_BATCH, offset: 0, sortBy: { column: 'name', order: 'asc' } })
    });
    if (!Array.isArray(answer)) throw new StorageError('list: an answer that made no sense');
    // A file under 10 minutes old may belong to a photo that is arriving right now, so it is
    // left for a later look. `young` is the paths left for that reason.
    const files = answer.filter((item) => item && typeof item.name === 'string' && item.id);
    const isYoung = (item) => Date.parse(item.created_at) > now() - 600000;
    const path = (item) => `${folder}/${item.name}`;
    return { settled: files.filter((item) => !isYoung(item)).map(path), young: files.filter(isYoung).map(path) };
  }

  // ---------------------------------------------------------------------------
  // Reading requests
  // ---------------------------------------------------------------------------

  // The pages send JSON as plain text, so the browser asks no permission first. Whatever the
  // content type says, the body is JSON.
  async function readJson(req) {
    let body = null;
    let read;
    try {
      read = await readBody(req, MAX_JSON_BYTES);
    } catch {
      throw new Refusal(400, 'input', UNREADABLE);
    }
    if (read.over) throw new Refusal(413, 'size', 'That request is too large.');
    try {
      body = JSON.parse(new TextDecoder().decode(read.bytes));
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refusal(400, 'input', UNREADABLE);
    return body;
  }

  // Reads a form no larger than the limit, however its bytes arrive: a request doesn't have to
  // say how long it is. A form that says it is too large is read to its end without being kept.
  // The platform's own parser then takes the form apart.
  async function readForm(req) {
    const broken = () => new Refusal(400, 'input', "That upload didn't arrive whole. Try again.");
    const declared = Number(req.headers.get('content-length') || 0);
    let read;
    try {
      read = await readBody(req, declared > MAX_REQUEST_BYTES ? 0 : MAX_REQUEST_BYTES);
    } catch {
      throw broken();
    }
    if (read.over || declared > MAX_REQUEST_BYTES) throw new Refusal(413, 'size', TOO_LARGE);
    const type = req.headers.get('content-type') || '';
    if (!/^multipart\/form-data\b/i.test(type) || !read.bytes.length) throw broken();
    try {
      return await new Response(read.bytes, { headers: { 'content-type': type } }).formData();
    } catch {
      throw broken();
    }
  }

  // One row's id from the review page.
  function oneId(value) {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Refusal(400, 'input', UNREADABLE);
    return value.toLowerCase();
  }

  // A list of 1 to 200 photo ids from the review page.
  function idsFrom(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 200 || !value.every((x) => typeof x === 'string' && UUID.test(x))) {
      throw new Refusal(400, 'input', 'Choose between 1 and 200 photos at a time.');
    }
    return [...new Set(value.map((x) => x.toLowerCase()))];
  }

  // ---------------------------------------------------------------------------
  // The upload page
  // ---------------------------------------------------------------------------

  async function open(req) {
    const body = await readJson(req);
    const r = await db.open(typed(body.code));
    if (!r || !r.ok) return refused(r);
    return json(200, {
      ok: true,
      open: r.open === true,
      reason: r.reason || null,
      closesAt: iso(r.closes_at),
      perPerson: r.per_person,
      limits: { minEdge: r.limits.min_edge, maxEdge: r.limits.max_edge, maxBytes: r.limits.max_bytes }
    });
  }

  // The photo's bytes and real size, or a refusal. The size comes from the file itself. When the
  // page's numbers are the same two the other way round, the phone was held sideways and the
  // browser turned the picture upright, so the page's order is how it will show.
  async function readPhoto(file, pageWidth, pageHeight) {
    if (!isFile(file) || file.size < 4) throw new Refusal(400, 'photo', NOT_A_PHOTO);
    if (file.size > MAX_PHOTO_BYTES) throw new Refusal(413, 'size', TOO_LARGE);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const size = jpegSize(bytes);
    if (!size) throw new Refusal(400, 'photo', NOT_A_PHOTO);
    if (Math.max(size.width, size.height) < MIN_EDGE) {
      throw new Refusal(400, 'photo', 'That photo is too small to show on a big screen. Send a larger copy.');
    }
    if (Math.max(size.width, size.height) > MAX_SIDE || size.width * size.height > MAX_PIXELS) {
      throw new Refusal(400, 'photo', 'That photo has too many pixels to show. Send a smaller copy.');
    }
    const turned = pageWidth === size.height && pageHeight === size.width;
    return { bytes, width: turned ? pageWidth : size.width, height: turned ? pageHeight : size.height };
  }

  // The thumbnail's bytes, or null. A thumbnail that is too big or isn't a small JPEG is left
  // out, and the photo is sent without one.
  async function readThumb(file) {
    if (!isFile(file) || file.size < 4 || file.size > MAX_THUMB_BYTES) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const size = jpegSize(bytes);
    return size && Math.max(size.width, size.height) <= MAX_THUMB_SIDE ? bytes : null;
  }

  // One photo. The form's text fields: code, name, email, caption (optional), width and height
  // (the sent photo's pixels as the page measured them), original (JSON: the name, width, height,
  // bytes, and type of the file the person picked), and website (the honeypot). Its files: photo
  // (a JPEG) and thumb (optional, a small JPEG). Answers { ok, id, left }, where left is how many
  // more this email may send.
  async function send(req) {
    const form = await readForm(req);
    // A hidden field people never see. Something filled it in, so say thanks and keep nothing.
    const website = form.get('website');
    if (typeof website === 'string' ? website.trim() !== '' : website !== null) {
      return json(200, { ok: true, id: null, left: PRETEND_LEFT });
    }
    const text = (name) => {
      const v = form.get(name);
      return typed(typeof v === 'string' || v === null ? v : '');
    };
    const fields = { code: text('code'), name: text('name'), email: text('email'), caption: text('caption') };
    const photo = await readPhoto(form.get('photo'), whole(form.get('width')), whole(form.get('height')));
    const thumb = await readThumb(form.get('thumb'));

    if (!storageKey()) return json(502, { error: "We couldn't save that photo. Try again.", reason: 'storage' });

    // The database checks the code, what was typed, and every limit, and holds a place.
    const held = await db.reserve({
      ...fields,
      width: photo.width,
      height: photo.height,
      bytes: photo.bytes.length + (thumb ? thumb.length : 0),
      hasThumb: !!thumb,
      ip: callerIp(req),
      original: originalOf(form.get('original')),
      sha256: await fingerprint(photo.bytes)
    });
    if (!held || !held.ok) return refused(held);
    // We already have this photo from this person: their phone lost our first answer and sent it
    // again. Nothing more to store.
    if (held.duplicate) return json(200, { ok: true, id: held.id, left: held.left });

    const paths = [held.path, held.thumb_path].filter(Boolean);
    try {
      await putFile(held.path, photo.bytes);
      if (thumb && held.thumb_path) await putFile(held.thumb_path, thumb);
      const links = await signLinks(paths);
      if (!links.get(held.path)) throw new StorageError('sign: no link for the photo');
      const saved = await db.stored(held.id, links.get(held.path), held.thumb_path ? links.get(held.thumb_path) || null : null, signedUntil());
      if (!saved) throw new Error('its row was gone before the files were in');
    } catch (e) {
      const cleared = await giveUp(held.id, paths);
      log.error(`photo-drop: photo ${held.id} was not saved: ${errorText(e)}${cleared ? '' : '. Its files may still be in the bucket'}`);
      return json(502, { error: "We couldn't save that photo. Try again.", reason: 'storage' });
    }
    return json(200, { ok: true, id: held.id, left: held.left });
  }

  // A send that failed partway: take out whatever went in, including a file whose put timed out
  // but landed, and give the sender their place back. False when the files couldn't be removed.
  async function giveUp(id, paths) {
    let cleared = true;
    try {
      await removeFiles(paths);
    } catch {
      cleared = false;
    }
    try {
      await db.abandon(id);
    } catch {
      // The row stays 'sending', and the review page's tidy-up removes it with its files.
    }
    return cleared;
  }

  // ---------------------------------------------------------------------------
  // The review page
  // ---------------------------------------------------------------------------

  const settingsOut = (s) => ({
    open: s.open === true,
    closesAt: iso(s.closes_at),
    state: s.state,
    perPerson: s.per_person,
    maxPhotos: s.max_photos,
    maxBytes: s.max_bytes,
    photos: s.photos,
    bytes: s.bytes,
    // The committee's videos, counted apart from the guests' photos. A database that has not
    // had the videos' migration yet can take none.
    videos: s.videos ?? 0,
    videoBytes: s.video_bytes ?? 0,
    maxVideos: s.max_videos ?? 0,
    videoMaxBytes: s.video_max_bytes ?? 0,
    videoTotalBytes: s.video_total_bytes ?? 0
  });

  // One row of the review list. kind is 'photo' or 'video'. A photo with no thumbnail stands in
  // for its own. A video with no poster has none: a page must never be handed a video file where
  // it expects a picture.
  const photoOut = (p) => ({
    id: p.id,
    status: p.status,
    name: p.name,
    email: p.email,
    caption: p.caption ?? null,
    width: p.width,
    height: p.height,
    bytes: p.bytes,
    original: p.original ?? null,
    createdAt: iso(p.created_at),
    reviewedAt: iso(p.reviewed_at),
    reviewedBy: p.reviewed_by ?? null,
    url: p.url,
    thumbUrl: p.kind === 'video' ? p.thumb_url || '' : p.thumb_url || p.url,
    kind: p.kind === 'video' ? 'video' : 'photo',
    seconds: p.seconds ?? null,
    mime: p.mime ?? null
  });

  // Removes sends that never finished, with their files. Nothing here can fail the list.
  async function clearStale() {
    let paths = [];
    try {
      paths = await db.stale();
      if (paths.length) await removeFiles(paths);
    } catch (e) {
      // Their rows are gone by now, so this line is the only record of files left in the bucket.
      log.warn(`photo-drop: tidying up unfinished sends failed${paths.length ? ` with ${paths.length} files left in the bucket` : ''}: ${errorText(e)}`);
    }
  }

  // Renews the links that run out within 3 days. True when any changed.
  async function renewLinks() {
    try {
      const due = await db.resignDue();
      if (!due.length) return false;
      const links = await signLinks(due.flatMap((d) => [d.path, d.thumb_path]).filter(Boolean));
      const until = signedUntil();
      const fresh = due.filter((d) => links.get(d.path)).map((d) => ({
        id: d.id,
        url: links.get(d.path),
        thumb_url: d.thumb_path ? links.get(d.thumb_path) || null : null,
        signed_until: until
      }));
      if (fresh.length < due.length) log.warn(`photo-drop: ${due.length - fresh.length} photos have no file in the bucket`);
      return fresh.length ? (await db.resignSave(fresh)) > 0 : false;
    } catch (e) {
      log.warn(`photo-drop: renewing the photo links failed: ${errorText(e)}`);
      return false;
    }
  }

  // The list checks the code. Only then does the tidy-up run, and the list is read again when the
  // tidy-up changed a link in it.
  async function reviewList(code) {
    let list = await db.reviewList(code);
    if (!list || !list.ok) return refused(list);
    await clearStale();
    if (await renewLinks()) {
      list = await db.reviewList(code);
      if (!list || !list.ok) return refused(list);
    }
    return json(200, { ok: true, settings: settingsOut(list.settings), counts: list.counts, photos: list.photos.map(photoOut) });
  }

  // The open switch and the deadline. Only the keys the page sent are changed.
  async function reviewSettings(code, body) {
    const changes = {};
    if ('open' in body) {
      if (typeof body.open !== 'boolean') throw new Refusal(400, 'input', 'Choose open or closed.');
      changes.open = body.open;
    }
    if ('closesAt' in body) {
      // A time must say which zone it is in (a Z or an offset on the end). Without one, noon on
      // an organizer's laptop would be read as noon in Greenwich.
      const zoned = typeof body.closesAt === 'string' && /(z|[+-][0-9]{2}:?[0-9]{2})$/i.test(body.closesAt.trim());
      const time = zoned ? Date.parse(body.closesAt.trim()) : NaN;
      if (body.closesAt !== null && !Number.isFinite(time)) {
        throw new Refusal(400, 'input', "That date and time didn't read right. Choose them again.");
      }
      changes.closes_at = body.closesAt === null ? null : new Date(time).toISOString();
    }
    const r = await db.reviewSettings(code, changes);
    if (!r || !r.ok) return refused(r);
    return json(200, { ok: true, settings: settingsOut(r.settings) });
  }

  // Deletes photos for good: the files first, then the rows, so a failure partway leaves rows
  // that can be deleted again rather than files nobody can find. ids null means everything.
  async function deletePhotos(code, ids) {
    const found = await db.reviewPaths(code, ids);
    if (!found || !found.ok) return refused(found);
    try {
      await removeFiles(found.paths);
    } catch (e) {
      log.error(`photo-drop: deleting ${found.ids.length} photos stopped at their files: ${errorText(e)}`);
      return json(502, { error: "We couldn't delete those photos. Try again.", reason: 'storage' });
    }
    let deleted = 0;
    if (found.ids.length) {
      const done = await db.reviewDelete(code, found.ids);
      if (!done || !done.ok) return refused(done);
      deleted = done.deleted;
    }
    if (ids === null) return json(200, { ok: true, deleted, swept: await sweep(code) });
    return json(200, { ok: true, deleted });
  }

  // After Delete everything: takes out any file no row points to. A send that failed partway
  // while Storage was struggling can leave one, and a guest's photo must not stay behind. Files
  // of a photo that arrived a moment ago keep their row and are left alone. True when the bucket
  // was looked through and nothing without a row is left in it. False when the look failed, or
  // when a file too new to judge was left: the page then asks for another go in ten minutes.
  async function sweep(code) {
    try {
      const kept = await db.reviewPaths(code, null);
      // Without the list of files to keep, nothing can be told apart, so nothing is removed.
      if (!kept || !kept.ok || !Array.isArray(kept.paths)) throw new Error('the rows could not be read');
      const keep = new Set(kept.paths);
      let left = 0;
      for (const folder of ['photos', 'thumbs', 'videos']) {
        for (let round = 0; ; round += 1) {
          const found = await listFiles(folder);
          const stray = found.settled.filter((path) => !keep.has(path));
          if (!stray.length) {
            left += found.young.filter((path) => !keep.has(path)).length;
            break;
          }
          if (round >= 20) throw new Error('files kept turning up');
          await removeFiles(stray);
        }
      }
      return left === 0;
    } catch (e) {
      log.error(`photo-drop: Delete everything could not check the bucket for leftover files: ${errorText(e)}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // The committee's videos
  // ---------------------------------------------------------------------------

  // A video takes three actions on /review, in the order the page calls them. video holds a
  // place and hands out two links, one for the video and one for its poster. The organizer's
  // browser sends the files straight to Storage. video-done then asks Storage what arrived, and
  // puts the video in the show. video-cancel gives it up. A video never waits for review: the
  // organizer who added it has seen it.

  // Asks to add a video: by (the organizer's name), caption (optional), and what the page read
  // from the file: width, height, bytes, seconds (or null), and mime. Answers
  // { ok, id, upload: { video, poster, type }, bytes }: the link to send each file to, and the
  // type and the size the video has to arrive with.
  async function videoStart(code, body) {
    const fields = { by: typed(body.by), caption: typed(body.caption), mime: typed(body.mime) };
    const count = (v) => Number.isSafeInteger(v) && v > 0;
    const seconds = body.seconds === undefined ? null : body.seconds;
    if (!count(body.width) || !count(body.height) || !count(body.bytes) || (seconds !== null && typeof seconds !== 'number')) {
      throw new Refusal(400, 'input', UNREADABLE);
    }
    // A side longer than the database's integer holds is cut to that, and the database turns it
    // away in its own words, as it does any side too long to be a video's.
    const side = (n) => Math.min(n, 2147483647);
    // The database checks the code, what was typed, and the limits, and holds a place.
    const held = await db.videoReserve({
      code,
      ...fields,
      width: side(body.width),
      height: side(body.height),
      bytes: body.bytes,
      seconds: Number.isFinite(seconds) ? seconds : null
    });
    if (!held || !held.ok) return refused(held);
    let video;
    let poster;
    try {
      video = await uploadLink(held.path);
      poster = await uploadLink(held.thumb_path);
    } catch (e) {
      try {
        await db.abandon(held.id);
      } catch {
        // The row stays 'sending', and the review page's tidy-up removes it.
      }
      log.error(`photo-drop: video ${held.id} could not be given an upload link: ${errorText(e)}`);
      return json(502, { error: "We couldn't start that upload. Try again.", reason: 'storage' });
    }
    return json(200, { ok: true, id: held.id, upload: { video, poster, type: held.mime }, bytes: held.bytes });
  }

  // Whether a row with this id is still there: true, false, or null when the database won't say.
  async function rowIsThere(code, id) {
    const kept = await db.reviewPaths(code, null);
    return kept && kept.ok && Array.isArray(kept.ids) ? kept.ids.includes(id) : null;
  }

  // Gives up a video that is on its way in: its files first, then its row, so a failure partway
  // leaves a row that can be given up again rather than files nobody can find. If video-done
  // finished this same video in between, its row is in the show by now and outlives that. With
  // its files gone it would be a video that never plays, so that row is deleted as well.
  async function dropVideo(code, held) {
    await removeFiles([held.path, held.thumb_path].filter(Boolean));
    await db.abandon(held.id);
    if (await rowIsThere(code, held.id)) await db.reviewDelete(code, [held.id]);
  }

  // The browser says both uploads have finished: { id, by }. The video goes into the show once
  // Storage holds, at its path, a file of exactly the size and type its place was held for. The
  // poster is kept only when it is a small JPEG, and the video goes in without one otherwise.
  // Answers { ok, id }.
  async function videoDone(code, body) {
    const id = oneId(body.id);
    const by = typed(body.by);
    const held = await db.videoHeld(code, id);
    if (!held || !held.ok) return refused(held);
    let link = '';
    let posterLink = null;
    try {
      const file = await findFile(held.path);
      let whole = !!file && file.size === held.bytes && file.type === held.mime;
      if (whole) {
        const poster = held.thumb_path ? await findFile(held.thumb_path) : null;
        const usable = !!poster && poster.type === 'image/jpeg' && poster.size > 0 && poster.size <= MAX_THUMB_BYTES;
        if (poster && !usable) await removeFiles([held.thumb_path]);
        const links = await signLinks(usable ? [held.path, held.thumb_path] : [held.path]);
        link = links.get(held.path) || '';
        posterLink = usable ? links.get(held.thumb_path) || null : null;
        // No link means the file went missing between the two looks.
        whole = !!link;
      }
      if (!whole) {
        await dropVideo(code, held);
        return json(400, { error: "That video didn't arrive whole. Add it again.", reason: 'video' });
      }
    } catch (e) {
      if (!(e instanceof StorageError)) throw e;
      // The row and the files stay as they are, so the page can ask again.
      log.error(`photo-drop: video ${id} could not be checked: ${errorText(e)}`);
      return json(502, { error: "We couldn't check that video. Try again.", reason: 'storage' });
    }
    const saved = await db.videoStored(code, id, by, !!posterLink, link, posterLink, signedUntil());
    if (saved && saved.ok) return json(200, { ok: true, id });
    // The row stopped being a video on its way in while its files were being checked. If it is
    // still there, another video-done finished it first: it is in the show, its files are in
    // use, and this one hears the same good news. If it is gone (cancelled, or everything was
    // deleted), its files go too.
    const there = await rowIsThere(code, id);
    if (there) return json(200, { ok: true, id });
    if (there === false) {
      try {
        await removeFiles([held.path, held.thumb_path].filter(Boolean));
      } catch (e) {
        log.error(`photo-drop: video ${id} is gone, and its files may still be in the bucket: ${errorText(e)}`);
      }
    }
    return refused(saved);
  }

  // The organizer gave up, or the upload failed: { id }. A video that is no longer on its way in
  // (already cancelled, or already in the show) is not an error, and is left as it is.
  async function videoCancel(code, body) {
    const id = oneId(body.id);
    const held = await db.videoHeld(code, id);
    if (held && !held.ok && held.status === 409) return json(200, { ok: true });
    if (!held || !held.ok) return refused(held);
    try {
      await dropVideo(code, held);
    } catch (e) {
      if (!(e instanceof StorageError)) throw e;
      log.error(`photo-drop: video ${id} could not be cancelled: ${errorText(e)}`);
      return json(502, { error: "We couldn't delete those photos. Try again.", reason: 'storage' });
    }
    return json(200, { ok: true });
  }

  async function review(req) {
    const body = await readJson(req);
    const code = typed(body.code);
    const action = typeof body.action === 'string' ? body.action : '';
    if (action === 'list') return reviewList(code);
    if (action === 'set') {
      const r = await db.reviewSet(code, idsFrom(body.ids), typed(body.status), typed(body.by));
      return r && r.ok ? json(200, { ok: true, changed: r.changed }) : refused(r);
    }
    if (action === 'caption') {
      if (typeof body.id !== 'string' || !UUID.test(body.id)) throw new Refusal(400, 'input', UNREADABLE);
      const r = await db.reviewCaption(code, body.id.toLowerCase(), typed(body.caption));
      return r && r.ok ? json(200, { ok: true }) : refused(r);
    }
    if (action === 'settings') return reviewSettings(code, body);
    if (action === 'delete') return deletePhotos(code, idsFrom(body.ids));
    if (action === 'empty') {
      if (body.confirm !== 'DELETE') throw new Refusal(400, 'input', 'Type DELETE to delete every photo.');
      return deletePhotos(code, null);
    }
    if (action === 'video') return videoStart(code, body);
    if (action === 'video-done') return videoDone(code, body);
    if (action === 'video-cancel') return videoCancel(code, body);
    throw new Refusal(400, 'input', UNREADABLE);
  }

  // ---------------------------------------------------------------------------
  // The slideshow
  // ---------------------------------------------------------------------------

  // The approved photos, and beside them the committee's videos. A video comes with the exact
  // size of its file, which the slideshow holds its download to, and its length. Its thumbUrl is
  // its poster or nothing, never the video itself.
  async function screen(req) {
    const body = await readJson(req);
    const r = await db.screenList(typed(body.code));
    if (!r || !r.ok) return refused(r);
    return json(200, {
      ok: true,
      photos: r.photos.map((p) => ({ id: p.id, url: p.url, thumbUrl: p.thumb_url || p.url, width: p.width, height: p.height, caption: p.caption ?? null })),
      videos: (r.videos || []).map((v) => ({
        id: v.id,
        url: v.url,
        thumbUrl: v.thumb_url || '',
        caption: v.caption ?? null,
        bytes: v.bytes,
        seconds: v.seconds ?? null,
        width: v.width,
        height: v.height
      }))
    });
  }

  return async function handle(req) {
    // Browsers ask first before some requests. Every route gives the same answer.
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    const route = new URL(req.url).pathname.replace(/\/+$/, '').split('/').pop();
    try {
      if (req.method === 'POST') {
        if (route === 'open') return await open(req);
        if (route === 'send') return await send(req);
        if (route === 'review') return await review(req);
        if (route === 'screen') return await screen(req);
      }
      // Not one of ours, but its body is still read to the end before the answer goes out.
      await readBody(req, 0).catch(() => {});
      return json(404, { error: 'Not found.' });
    } catch (e) {
      // A failure before the body was read (none today) would otherwise answer too early.
      if (!req.bodyUsed) await readBody(req, 0).catch(() => {});
      if (e instanceof Refusal) return json(e.status, { error: e.message, reason: e.reason });
      // The route is named only when it is one of ours: anything else is text a stranger typed.
      log.error(`photo-drop: ${ROUTES.has(route) ? route : 'a request'} failed: ${errorText(e)}`);
      return json(500, { error: 'Something went wrong. Try again.' });
    }
  };
}
