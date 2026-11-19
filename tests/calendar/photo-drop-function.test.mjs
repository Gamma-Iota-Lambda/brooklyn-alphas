// The photo-drop Edge Function (supabase/functions/photo-drop/drop.js), run in Node against the
// real migrations in PGlite, with Storage simulated (storage-sim.mjs). Covers what the three
// School Daze pages ask of it: opening the upload page, sending a photo and every way that is
// refused, a photo sent twice, a Storage failure partway, the organizers' review actions, the
// committee's videos (which go from the organizer's browser straight to Storage), the slideshow's
// list, and what never reaches the log.
// Run with the other database tests: node --test "tests/calendar/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createDb } from './harness.mjs';
import { Storage } from './storage-sim.mjs';
import {
  createHandler, makeDb, jpegSize, callerIp, DRAIN_MAX, LIST_BATCH, MAX_PHOTO_BYTES, MAX_REQUEST_BYTES, MAX_THUMB_BYTES, MIN_EDGE, REMOVE_BATCH, SIGN_DAYS
} from '../../supabase/functions/photo-drop/drop.js';

const BASE = 'https://uqfoifrpyysqjvwtkgia.supabase.co';
const FN = `${BASE}/functions/v1/photo-drop`;
const KEY = 'sb_secret_Zm9yLXRlc3RzLW9ubHk';
const ENV = { SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: KEY }) };
const UPLOAD = 'Daze-2026-BK';
const REVIEW = 'organizers only review phrase';
const SCREEN = 'venue screen phrase 21';
const NOW = '2026-11-19T15:00:00Z'; // two days before the party
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, apikey, authorization, x-client-info',
  'access-control-max-age': '86400',
  'cache-control': 'no-store',
  'content-type': 'application/json'
};

// A JPEG with a real header and no real picture: the function reads sizes and never decodes.
// frame is the start-of-frame marker (C0 baseline, C2 progressive). exif adds a camera's
// thumbnail, a small JPEG of its own inside the Exif segment. before goes in ahead of the frame
// header. bytes pads the file out to a size. mark is a number written into the padding, so that
// two files of one size are two different photos.
function jpeg(width, height, { bytes = 4096, frame = 0xc0, exif = false, before = [], precision = 8, mark = 0 } = {}) {
  const segment = (marker, data) => Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), Buffer.from(data)]);
  const sof = (marker, w, h) => segment(marker, [precision, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const parts = [Buffer.from([0xff, 0xd8]), segment(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0])];
  if (exif) parts.push(segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from([0xff, 0xd8]), sof(0xc0, 160, 120), Buffer.from([0xff, 0xd9])])));
  parts.push(segment(0xdb, Buffer.alloc(65, 1)), Buffer.from(before), sof(frame, width, height), segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]));
  const head = Buffer.concat(parts);
  const out = Buffer.alloc(Math.max(bytes, head.length + (mark ? 6 : 2)), 0x2a);
  head.copy(out);
  if (mark) out.writeUInt32BE(mark, out.length - 6);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}
const file = (bytes, name = 'photo.jpg', type = 'image/jpeg') => new File([bytes], name, { type });
// A photo's fingerprint, as the function works it out and the database keeps it.
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(2000, 7)]);
// A video file's worth of bytes. The function never sees a video's bytes, and Storage never
// looks inside one, so only the size matters. mark makes two files of one size differ.
const mp4 = (bytes = 2000000, mark = 0x76) => Buffer.concat([Buffer.from('\0\0\0\x18ftypmp42'), Buffer.alloc(bytes - 12, mark)]);
const MB50 = 52428800;

// What kind of call the function, or a browser with an upload link, made to Storage.
function kindOf(call) {
  if (call.method === 'DELETE') return 'remove';
  if (call.method === 'PUT') return 'upload';
  if (call.method !== 'POST') return '';
  if (call.path.includes('/object/upload/sign/')) return 'link';
  if (call.path.includes('/object/sign/')) return 'sign';
  return call.path.includes('/object/list/') ? 'list' : 'put';
}

// db wraps the database calls, and net wraps the calls to Storage, for a test that has something
// happen between two of them. migrations names the ones to run, for a database that has not had
// them all yet.
async function setup({ now = NOW, env = ENV, db = (real) => real, net = (fetch) => fetch, migrations = null } = {}) {
  const h = await createDb({ codes: false, migrations });
  await h.setNow(now);
  await h.sql(`select cal_private.drop_set_code('upload', $1)`, [UPLOAD]);
  await h.sql(`select cal_private.drop_set_code('review', $1)`, [REVIEW]);
  await h.sql(`select cal_private.drop_set_code('screen', $1)`, [SCREEN]);
  const clock = { t: Date.parse(now) };
  // The simulated bucket takes its rules from the one the migration made.
  const [bucket] = await h.sql(`select file_size_limit, allowed_mime_types from storage.buckets where id = 'photo-drop'`);
  const storage = new Storage({ url: BASE, key: KEY, maxBytes: Number(bucket.file_size_limit), types: bucket.allowed_mime_types, now: () => clock.t });
  const logs = [];
  const handler = createHandler({
    env,
    db: db(makeDb((text, params) => h.sql(text, params))),
    fetch: net(storage.fetch),
    now: () => clock.t,
    log: { error: (m) => logs.push(m), warn: (m) => logs.push(m) }
  });
  const answer = async (res) => ({ status: res.status, headers: Object.fromEntries(res.headers), body: res.status === 204 ? null : await res.json() });
  // The pages send JSON as plain text, with no content type of their own.
  const post = async (route, body, headers = { 'content-type': 'text/plain;charset=UTF-8' }) =>
    answer(await handler(new Request(`${FN}/${route}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })));
  // One photo, as the upload page sends it. A field set to undefined is left out. Each send is
  // a new photo: a count in its padding makes its bytes differ from the last one's. The very same
  // bytes from the same email are a repeat, and a test that means one passes the same photo twice.
  let sent = 0;
  const send = async (over = {}, headers = {}) => {
    sent += 1;
    const fields = {
      code: UPLOAD, name: 'Ada Lovelace', email: 'ada@example.com', caption: 'Howard, class of 1998', width: '1600', height: '1200',
      original: JSON.stringify({ name: 'IMG_0042.HEIC', width: 4032, height: 3024, bytes: 2310456, type: 'image/heic' }), website: '',
      photo: file(jpeg(1600, 1200, { bytes: 300000, mark: sent })), thumb: file(jpeg(480, 360, { bytes: 30000 }), 'thumb.jpg'), ...over
    };
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.set(k, v);
    return answer(await handler(new Request(`${FN}/send`, { method: 'POST', body: form, headers })));
  };
  const review = (action, more = {}, code = REVIEW) => post('review', { ...more, code, action });
  // The committee's videos, as the review page adds one. video asks for a place and the two
  // links. put sends a file to a link the way the organizer's browser does: straight to Storage,
  // with no key. clip does all of it (the poster, the video, then video-done) and resolves with
  // every answer along the way. A poster of null is not sent.
  const video = (more = {}, code = REVIEW) =>
    review('video', { by: 'Eugene Aiken', caption: 'Step show, 2019', width: 1920, height: 1080, bytes: 2000000, seconds: 23.5, mime: 'video/mp4', ...more }, code);
  const put = async (link, bytes, type) => {
    const res = await storage.fetch(link, { method: 'PUT', headers: { 'Content-Type': type, 'cache-control': 'max-age=31536000', 'x-upsert': 'true' }, body: bytes });
    return { status: res.status, body: await res.json() };
  };
  const clip = async ({ file: bytes = mp4(), poster = jpeg(480, 270, { bytes: 20000 }), ...more } = {}) => {
    const start = await video({ bytes: bytes.length, ...more });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const { id, upload } = start.body;
    const sent = { poster: poster ? await put(upload.poster, poster, 'image/jpeg') : null, video: await put(upload.video, bytes, upload.type) };
    const done = await review('video-done', { id, by: more.by === undefined ? 'Eugene Aiken' : more.by });
    return { id, start, sent, done, file: bytes, poster };
  };
  return {
    h, storage, logs, handler, post, send, answer, review, video, put, clip,
    at: async (iso) => {
      clock.t = Date.parse(iso);
      await h.setNow(iso);
    },
    rows: (sql = 'select * from public.drop_photos order by created_at, id') => h.sql(sql),
    // Storage calls by kind: put, sign, list, remove, link (the function asking for a link for an
    // upload), or upload (a file sent to such a link).
    calls: (kind) => storage.calls.filter((c) => kindOf(c) === kind)
  };
}

// Nothing a person typed, no code, no key, and no signed link may reach the function's log.
function assertQuietLogs(s, more = []) {
  for (const line of s.logs) assert.match(line, /^photo-drop: /);
  // Row ids are fine in the log, and their letters can spell anything.
  const all = s.logs.join('\n').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '(id)');
  for (const secret of [UPLOAD, REVIEW, SCREEN, KEY, 'Ada', 'Lovelace', 'ada@example.com', 'example.com', 'Howard', 'token=', 'IMG_0042', ...more]) {
    assert.ok(!all.toLowerCase().includes(secret.toLowerCase()), `the log holds "${secret}":\n${all}`);
  }
}

test('every answer carries the CORS headers, and a preflight is answered on any route', async () => {
  const s = await setup();
  for (const route of ['open', 'send', 'review', 'screen', 'anything']) {
    const res = await s.answer(await s.handler(new Request(`${FN}/${route}`, { method: 'OPTIONS', headers: { origin: 'https://www.gil1906.org', 'access-control-request-method': 'POST' } })));
    assert.equal(res.status, 204);
    assert.deepEqual(res.headers, CORS);
  }
  const good = await s.post('open', { code: UPLOAD });
  assert.equal(good.status, 200);
  assert.deepEqual(good.headers, CORS);
  const refused = await s.post('open', { code: 'nope' });
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.headers, CORS);
  const missing = await s.post('nowhere', { code: UPLOAD });
  assert.deepEqual([missing.status, missing.body, missing.headers], [404, { error: 'Not found.' }, CORS]);
  // Every route is POST. The base address and a GET are not found, with the same headers.
  for (const [method, path] of [['GET', '/open'], ['GET', '/screen'], ['PUT', '/send'], ['DELETE', '/review'], ['POST', ''], ['POST', '/'], ['POST', '/open/extra']]) {
    const res = await s.answer(await s.handler(new Request(`${FN}${path}`, { method, body: method === 'GET' ? undefined : '{}' })));
    assert.deepEqual([res.status, res.body, res.headers], [404, { error: 'Not found.' }, CORS], `${method} ${path}`);
  }
  assert.equal((await s.post('open/', { code: UPLOAD })).status, 200, 'a trailing slash is fine');
  assert.deepEqual(s.logs, [], 'a stray request is not worth a log line');
});

test('the upload page asks with JSON sent as plain text, and hears open, closed, or full', async () => {
  const s = await setup();
  const open = { ok: true, open: true, reason: null, closesAt: '2026-11-21T17:00:00.000Z', perPerson: 5, limits: { minEdge: 500, maxEdge: 2560, maxBytes: 6291456 } };
  // Whatever the content type says, or with none at all, the body is read as JSON.
  for (const type of ['text/plain;charset=UTF-8', 'application/json', 'application/x-www-form-urlencoded', null]) {
    const res = await s.post('open', { code: `  ${UPLOAD.toUpperCase()} ` }, type ? { 'content-type': type } : {});
    assert.deepEqual([res.status, res.body], [200, open], String(type));
  }
  // The numbers the page shrinks to are the numbers the function enforces.
  assert.deepEqual([open.limits.minEdge, open.limits.maxBytes], [MIN_EDGE, MAX_PHOTO_BYTES]);

  const wrong = { error: "That link isn't right. Use the link in your School Daze email.", reason: 'code' };
  for (const body of [{ code: 'nope' }, { code: '' }, {}, { code: null }, { code: REVIEW }, { code: SCREEN }]) {
    const res = await s.post('open', body);
    assert.deepEqual([res.status, res.body], [403, wrong], JSON.stringify(body));
  }
  const unreadable = { error: "That request didn't read right. Reload the page and try again.", reason: 'input' };
  for (const body of ['', 'code=Daze-2026-BK', '[1, 2]', '"Daze-2026-BK"', 'null', '{"code": 12345678}', '{"code": ["Daze-2026-BK"]}']) {
    const res = await s.post('open', body);
    assert.deepEqual([res.status, res.body], [400, unreadable], body);
  }
  const long = await s.post('open', { code: 'x'.repeat(2001) });
  assert.deepEqual([long.status, long.body], [400, { error: "That's too much text. Shorten it and try again.", reason: 'input' }]);
  const huge = await s.post('open', { code: UPLOAD, padding: 'x'.repeat(70000) });
  assert.deepEqual([huge.status, huge.body], [413, { error: 'That request is too large.', reason: 'size' }]);

  // Full, then closed by the switch, then by the clock.
  await s.h.sql(`update cal_private.config set value = '0' where key = 'drop_max_photos'`);
  assert.deepEqual((await s.post('open', { code: UPLOAD })).body, { ...open, open: false, reason: 'full' });
  await s.h.sql(`update cal_private.config set value = 'false' where key = 'drop_open'`);
  assert.deepEqual((await s.post('open', { code: UPLOAD })).body, { ...open, open: false, reason: 'closed' });
  await s.h.sql(`update cal_private.config set value = 'true' where key = 'drop_open'`);
  await s.h.sql(`update cal_private.config set value = '600' where key = 'drop_max_photos'`);
  await s.at('2026-11-21T17:00:00Z');
  assert.deepEqual((await s.post('open', { code: UPLOAD })).body, { ...open, open: false, reason: 'closed' });
  await s.h.sql(`delete from cal_private.config where key = 'drop_closes_at'`);
  assert.deepEqual((await s.post('open', { code: UPLOAD })).body, { ...open, closesAt: null });
  assert.equal(s.storage.calls.length, 0);
  assertQuietLogs(s);
});

test('a photo is stored with its thumbnail, waits for review, and its links open the files', async () => {
  const s = await setup();
  const photo = jpeg(1600, 1200, { bytes: 300000 });
  const thumb = jpeg(480, 360, { bytes: 30000 });
  const sent = await s.send({ photo: file(photo), thumb: file(thumb, 'thumb.jpg'), name: '  Ada   Lovelace ', email: ' Ada@Example.com ' },
    { 'x-forwarded-for': '10.1.2.3, 203.0.113.9' });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.headers, CORS);
  assert.match(sent.body.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent.body, { ok: true, id: sent.body.id, left: 4 });
  const id = sent.body.id;

  // Two files, put as JPEGs with the secret key, kept by browsers for a year.
  assert.deepEqual(s.storage.paths(), [`photos/${id}.jpg`, `thumbs/${id}.jpg`]);
  assert.ok(s.storage.read(`photos/${id}.jpg`).equals(photo), 'the photo is stored byte for byte');
  assert.ok(s.storage.read(`thumbs/${id}.jpg`).equals(thumb));
  assert.deepEqual(s.storage.calls.map((c) => `${c.method} ${c.path}`), [
    `POST /storage/v1/object/photo-drop/photos/${id}.jpg`, `POST /storage/v1/object/photo-drop/thumbs/${id}.jpg`, 'POST /storage/v1/object/sign/photo-drop'
  ]);
  for (const c of s.storage.calls) assert.deepEqual([c.headers.apikey, c.headers.authorization], [KEY, `Bearer ${KEY}`]);
  for (const c of s.calls('put')) {
    assert.deepEqual([c.headers['content-type'], c.headers['cache-control'], c.headers['x-upsert']], ['image/jpeg', 'max-age=31536000', 'true']);
  }
  assert.deepEqual(s.calls('sign')[0].json, { expiresIn: SIGN_DAYS * 86400, paths: [`photos/${id}.jpg`, `thumbs/${id}.jpg`] });

  const [row] = await s.rows();
  const link = (path) => new RegExp(`^${BASE}/storage/v1/object/sign/photo-drop/${path}/${id}\\.jpg\\?token=[0-9a-f-]{36}$`);
  assert.match(row.url, link('photos'));
  assert.match(row.thumb_url, link('thumbs'));
  assert.deepEqual({ ...row, created_at: row.created_at.toISOString(), stored_at: row.stored_at.toISOString(), signed_until: row.signed_until.toISOString() }, {
    id, status: 'waiting', name: 'Ada Lovelace', email: 'ada@example.com', caption: 'Howard, class of 1998',
    width: 1600, height: 1200, bytes: 330000, has_thumb: true,
    original: { name: 'IMG_0042.HEIC', width: 4032, height: 3024, bytes: 2310456, type: 'image/heic' },
    path: `photos/${id}.jpg`, thumb_path: `thumbs/${id}.jpg`, url: row.url, thumb_url: row.thumb_url,
    signed_until: '2026-12-03T15:00:00.000Z', ip_hash: row.ip_hash, sha256: sha256(photo), created_at: '2026-11-19T15:00:00.000Z',
    stored_at: '2026-11-19T15:00:00.000Z', reviewed_at: null, reviewed_by: null, kind: 'photo', seconds: null, mime: null
  });
  assert.ok(s.storage.fileFor(row.url).equals(photo), 'the saved link opens the photo');
  assert.ok(s.storage.fileFor(row.thumb_url).equals(thumb));

  // The connection is the last address in the list (the first can be typed in by the sender).
  const hashOf = async (ip) => (await s.h.sql(
    `select encode(sha256(convert_to((select value from cal_private.config where key = 'drop_ip_salt') || $1, 'UTF8')), 'hex') as hash`, [ip]))[0].hash;
  assert.equal(row.ip_hash, await hashOf('203.0.113.9'));

  // The size is the file's own. Only the same two numbers the other way round are taken from
  // the page: a phone photo the browser turned upright.
  const turned = await s.send({ width: '1200', height: '1600', caption: '', thumb: undefined, original: undefined });
  const lied = await s.send({ width: '3000', height: '2000', caption: undefined, original: 'not json' });
  const progressive = await s.send({ photo: file(jpeg(2560, 1707, { frame: 0xc2, exif: true, bytes: 500000 })), width: undefined, height: undefined, original: '[1]' });
  assert.deepEqual([turned.body.left, lied.body.left, progressive.body.left], [3, 2, 1]);
  const kept = await s.rows(`select id, width, height, caption, has_thumb, thumb_url, original, bytes, ip_hash from public.drop_photos where id <> '${id}'`);
  const byId = (x) => kept.find((r) => r.id === x.body.id);
  assert.deepEqual(byId(turned), { id: turned.body.id, width: 1200, height: 1600, caption: null, has_thumb: false, thumb_url: null, original: null, bytes: 300000, ip_hash: null });
  assert.deepEqual([byId(lied).width, byId(lied).height, byId(lied).original], [1600, 1200, null]);
  assert.deepEqual([byId(progressive).width, byId(progressive).height, byId(progressive).original], [2560, 1707, null], "the frame's size, not the camera thumbnail's");
  assert.equal(s.storage.paths().length, 7);

  // What the page says about the picked file is kept as five tidy fields, whatever else it sends:
  // a very long name is cut, and characters the database can't hold are dropped.
  const odd = await s.send({ email: 'grace@example.com', name: 'Grace Hopper', caption: 'Vassar \ud83c\udf93 1928',
    original: JSON.stringify({ name: `IMG\u0000_1\ud83d${'x'.repeat(300)}.jpg`, width: 4032, height: '3024', bytes: -1, type: 'image/jpeg', path: '/Users/grace/Pictures', extra: { a: 1 } }) });
  assert.equal(odd.status, 200);
  const [oddRow] = await s.rows(`select name, caption, original from public.drop_photos where id = '${odd.body.id}'`);
  assert.deepEqual(oddRow, { name: 'Grace Hopper', caption: 'Vassar \ud83c\udf93 1928',
    original: { name: `IMG _1${'x'.repeat(114)}`, width: 4032, height: null, bytes: null, type: 'image/jpeg' } });
  const empty = await s.send({ email: 'grace@example.com', original: '{"path": "/Users/grace"}' });
  assert.deepEqual(await s.rows(`select original from public.drop_photos where id = '${empty.body.id}'`), [{ original: null }]);
  assert.deepEqual(s.logs, []);
});

test('the very same photo sent again by the same person is stored once, and both sends hear the same answer', async () => {
  const s = await setup();
  const photo = jpeg(1600, 1200, { bytes: 300000 });
  const form = { photo: file(photo), thumb: file(jpeg(480, 360, { bytes: 30000 }), 'thumb.jpg') };
  const first = await s.send(form);
  assert.deepEqual([first.status, first.body], [200, { ok: true, id: first.body.id, left: 4 }]);
  const id = first.body.id;
  const [row] = await s.rows();
  const calls = s.storage.calls.length;
  assert.equal(s.calls('put').length, 2);

  // The phone never heard that answer: the signal dropped, or the browser threw the tab away. It
  // sends the very same form again, and hears what it would have heard the first time.
  await s.at('2026-11-19T15:02:00Z');
  const second = await s.send(form);
  assert.deepEqual([second.status, second.body, second.headers], [200, { ok: true, id, left: 4 }, CORS]);
  assert.equal(s.calls('put').length, 2, 'the two files went in once, not twice');
  assert.equal(s.storage.calls.length, calls, 'the repeat never reached Storage');
  assert.deepEqual(s.storage.paths(), [`photos/${id}.jpg`, `thumbs/${id}.jpg`]);
  assert.deepEqual(await s.rows(), [row], 'one row, just as the first send left it');
  // The same person, however the email is typed.
  const third = await s.send({ ...form, email: ' ADA@Example.com ' });
  assert.deepEqual([third.status, third.body], [200, { ok: true, id, left: 4 }]);

  // A different photo from the same person is a new photo, even one the same size to the byte.
  const other = jpeg(1600, 1200, { bytes: 300000, mark: 1906 });
  const next = await s.send({ ...form, photo: file(other) });
  assert.deepEqual([next.status, next.body], [200, { ok: true, id: next.body.id, left: 3 }]);
  assert.notEqual(next.body.id, id);
  assert.equal(s.calls('put').length, 4);
  // The same bytes from another email are someone else's photo: two people sent the same picture.
  const theirs = await s.send({ ...form, name: 'Grace Hopper', email: 'grace@example.com' });
  assert.deepEqual([theirs.status, theirs.body], [200, { ok: true, id: theirs.body.id, left: 4 }]);
  assert.equal(s.calls('put').length, 6);
  assert.ok(s.storage.read(`photos/${theirs.body.id}.jpg`).equals(photo));
  assert.deepEqual(await s.rows('select id, email, sha256 from public.drop_photos order by created_at, email'), [
    { id, email: 'ada@example.com', sha256: sha256(photo) },
    { id: next.body.id, email: 'ada@example.com', sha256: sha256(other) },
    { id: theirs.body.id, email: 'grace@example.com', sha256: sha256(photo) }
  ]);

  // A repeat is still answered after uploads close: the photo is already here. A new one is not taken.
  await s.h.sql(`update cal_private.config set value = 'false' where key = 'drop_open'`);
  const late = await s.send(form);
  assert.deepEqual([late.status, late.body], [200, { ok: true, id, left: 3 }]);
  assert.deepEqual((await s.send()).body, { error: 'Photo uploads have closed.', reason: 'closed' });
  await s.h.sql(`update cal_private.config set value = 'true' where key = 'drop_open'`);

  // A send still on its way in has its row but not yet its files. The same photo again is asked
  // to wait, and nothing goes to Storage.
  const slow = jpeg(2000, 1500, { bytes: 200000 });
  await s.h.sql(`select cal_private.drop_reserve($1, 'Ada Lovelace', 'ada@example.com', null, 2000, 1500, 200000, false, '', null, $2)`, [UPLOAD, sha256(slow)]);
  const wait = await s.send({ photo: file(slow), thumb: undefined });
  assert.deepEqual([wait.status, wait.body], [409, { error: 'That photo is still on its way in. Give it a minute, then try again.', reason: 'busy' }]);
  assert.equal(s.calls('put').length, 6);
  assert.equal(s.calls('remove').length, 0, 'and nothing of the send under way is touched');
  // Sixteen minutes on, that send never finished, and the photo goes through.
  await s.at('2026-11-19T15:18:00Z');
  const through = await s.send({ photo: file(slow), thumb: undefined });
  assert.deepEqual([through.status, through.body.left], [200, 2]);
  assert.ok(s.storage.read(`photos/${through.body.id}.jpg`).equals(slow));
  assert.deepEqual(s.logs, []);
});

test('a file that is not a usable photo is refused before anything is stored', async () => {
  const s = await setup();
  const notPhoto = { error: "That file isn't a photo we can use. Send a JPEG.", reason: 'photo' };
  const tooSmall = { error: 'That photo is too small to show on a big screen. Send a larger copy.', reason: 'photo' };
  const tooLarge = { error: 'That photo is too large to send. Try a smaller copy.', reason: 'size' };
  const is = async (res, status, body, what) => assert.deepEqual([res.status, res.body], [status, body], what);

  await is(await s.send({ photo: file(PNG, 'photo.jpg') }), 400, notPhoto, 'a PNG named .jpg');
  await is(await s.send({ photo: file(Buffer.from('GIF89a' + 'x'.repeat(500))) }), 400, notPhoto, 'a GIF');
  await is(await s.send({ photo: file(jpeg(1600, 1200).subarray(0, 20)) }), 400, notPhoto, 'a JPEG cut off before its size');
  await is(await s.send({ photo: file(jpeg(1600, 1200, { frame: 0xc3 })) }), 400, notPhoto, 'a lossless JPEG no browser shows');
  await is(await s.send({ photo: file(Buffer.alloc(0)) }), 400, notPhoto, 'an empty file');
  await is(await s.send({ photo: undefined }), 400, notPhoto, 'no photo at all');
  await is(await s.send({ photo: 'photo.jpg' }), 400, notPhoto, 'a file name in place of the file');
  await is(await s.send({ photo: file(jpeg(499, 499)) }), 400, tooSmall, 'a long side under 500');
  await is(await s.send({ photo: file(jpeg(400, 300)), width: '4000', height: '3000' }), 400, tooSmall, "the page's numbers don't count");
  assert.equal((await s.send({ photo: file(jpeg(500, 100)), email: 'edge@example.com' })).status, 200, '500 on the long side is enough');
  await is(await s.send({ photo: file(jpeg(12001, 800)) }), 400, { error: 'That photo has too many pixels to show. Send a smaller copy.', reason: 'photo' }, 'a side too long');
  await is(await s.send({ photo: file(jpeg(9000, 6000)) }), 400, { error: 'That photo has too many pixels to show. Send a smaller copy.', reason: 'photo' }, 'too many pixels');

  // Too large, three ways: the request says so, the photo is over 6 MB, or the bytes just keep coming.
  await is(await s.send({}, { 'content-length': String(MAX_REQUEST_BYTES + 1) }), 413, tooLarge, 'by its stated length');
  await is(await s.send({ photo: file(jpeg(2560, 1707, { bytes: MAX_PHOTO_BYTES + 1 })) }), 413, tooLarge, 'a photo one byte over');
  await is(await s.send({ photo: file(jpeg(2560, 1707, { bytes: MAX_REQUEST_BYTES })) }), 413, tooLarge, 'a request over the limit that never said so');
  const exact = await s.send({ photo: file(jpeg(2560, 1707, { bytes: MAX_PHOTO_BYTES })), email: 'edge@example.com' });
  assert.equal(exact.status, 200, '6 MB exactly is fine');
  assert.equal(s.storage.read(`photos/${exact.body.id}.jpg`).length, MAX_PHOTO_BYTES);

  // Not a form at all.
  const notForm = await s.post('send', { code: UPLOAD });
  await is(notForm, 400, { error: "That upload didn't arrive whole. Try again.", reason: 'input' }, 'JSON to /send');
  const cut = await s.answer(await s.handler(new Request(`${FN}/send`, {
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=xyz' }, body: '--xyz\r\ncontent-disposition: form-data; name="code"\r\n\r\nDaze'
  })));
  await is(cut, 400, { error: "That upload didn't arrive whole. Try again.", reason: 'input' }, 'a form cut off partway');

  // Text no name, email, or caption would run to.
  for (const field of ['code', 'name', 'email', 'caption']) {
    await is(await s.send({ [field]: 'x'.repeat(2001) }), 400, { error: "That's too much text. Shorten it and try again.", reason: 'input' }, field);
  }
  assert.deepEqual((await s.rows('select email from public.drop_photos order by email')).map((r) => r.email), ['edge@example.com', 'edge@example.com']);
  assert.deepEqual(s.storage.paths().map((path) => path.split('/')[0]), ['photos', 'photos', 'thumbs', 'thumbs'], 'only the two good photos reached Storage');
  assert.equal(s.calls('put').length, 4);
  assertQuietLogs(s);
});

test('a thumbnail that is too big or not a small JPEG is left out, and the photo is still taken', async () => {
  const s = await setup();
  const cases = {
    'too big': file(jpeg(480, 360, { bytes: MAX_THUMB_BYTES + 1 }), 'thumb.jpg'),
    'not a JPEG': file(PNG, 'thumb.jpg'),
    'far too many pixels': file(jpeg(4000, 3000), 'thumb.jpg'),
    empty: file(Buffer.alloc(0), 'thumb.jpg'),
    'text in its place': 'thumb.jpg'
  };
  let left = 5;
  for (const [what, thumb] of Object.entries(cases)) {
    const res = await s.send({ thumb });
    left -= 1;
    assert.deepEqual([res.status, res.body.left], [200, left], what);
    assert.deepEqual(await s.rows(`select has_thumb, thumb_path, thumb_url, bytes from public.drop_photos where id = '${res.body.id}'`),
      [{ has_thumb: false, thumb_path: null, thumb_url: null, bytes: 300000 }], what);
  }
  assert.equal(s.storage.paths().filter((p) => p.startsWith('thumbs/')).length, 0);
  assert.equal(s.storage.paths().filter((p) => p.startsWith('photos/')).length, 5);
  // The largest thumbnail allowed is kept.
  const most = await s.send({ thumb: file(jpeg(640, 480, { bytes: MAX_THUMB_BYTES }), 'thumb.jpg'), email: 'grace@example.com' });
  assert.deepEqual(await s.rows(`select has_thumb, bytes from public.drop_photos where id = '${most.body.id}'`), [{ has_thumb: true, bytes: 300000 + MAX_THUMB_BYTES }]);
  // With no thumbnail, the review page and the slideshow use the photo itself.
  const list = (await s.review('list')).body;
  assert.equal(list.photos.length, 6);
  for (const p of list.photos) {
    if (p.id === most.body.id) assert.match(p.thumbUrl, /\/thumbs\//);
    else assert.equal(p.thumbUrl, p.url);
  }
});

test('the honeypot, a wrong link, closed, full, and the limits each answer in their own words, and store nothing', async () => {
  const s = await setup();
  const none = async (what) => {
    assert.deepEqual(await s.rows(), [], what);
    assert.equal(s.storage.calls.length, 0, what);
  };
  // Something filled in the field people never see. It hears thanks, and nothing is kept.
  const bot = await s.send({ website: 'https://spam.example/' });
  assert.deepEqual([bot.status, bot.body], [200, { ok: true, id: null, left: 4 }]);
  // The trap springs before anything is checked, so it gives a guesser nothing to go on.
  assert.deepEqual((await s.send({ website: 'x', code: 'nope', photo: file(PNG) })).body, { ok: true, id: null, left: 4 });
  await none('honeypot');

  const wrong = { error: "That link isn't right. Use the link in your School Daze email.", reason: 'code' };
  for (const code of ['nope', '', undefined, REVIEW, SCREEN]) {
    const res = await s.send({ code });
    assert.deepEqual([res.status, res.body], [403, wrong], String(code));
  }
  await none('wrong code');

  const typed = async (over, error) => {
    const res = await s.send(over);
    assert.deepEqual([res.status, res.body], [400, { error, reason: 'input' }], JSON.stringify(over));
  };
  await typed({ name: '   ' }, 'Add your name.');
  await typed({ name: undefined }, 'Add your name.');
  await typed({ name: 'x'.repeat(81) }, 'Keep your name to 80 characters or fewer.');
  await typed({ email: 'ada at example dot com' }, 'Add the email you bought your ticket with.');
  await typed({ email: undefined }, 'Add the email you bought your ticket with.');
  await typed({ caption: 'x'.repeat(81) }, 'Keep the caption to 80 characters or fewer.');
  await none('bad text');

  await s.h.sql(`update cal_private.config set value = 'false' where key = 'drop_open'`);
  const closed = await s.send();
  assert.deepEqual([closed.status, closed.body], [409, { error: 'Photo uploads have closed.', reason: 'closed' }]);
  await s.h.sql(`update cal_private.config set value = 'true' where key = 'drop_open'`);
  await s.h.sql(`update cal_private.config set value = '0' where key = 'drop_max_photos'`);
  const full = await s.send();
  assert.deepEqual([full.status, full.body], [409, { error: 'We have all the photos we can take. Thank you!', reason: 'full' }]);
  await s.h.sql(`update cal_private.config set value = '600' where key = 'drop_max_photos'`);
  await none('closed and full');

  // Five from one email, however it is typed, and no more. A control character in a name is not an error.
  const lefts = [];
  for (const email of ['ada@example.com', 'ADA@example.com', ' ada@Example.com', 'ada@example.com', 'ada@example.com']) {
    lefts.push((await s.send({ email, name: 'Ada\u0000 Love\u0007lace' })).body.left);
  }
  assert.deepEqual(lefts, [4, 3, 2, 1, 0]);
  assert.deepEqual(await s.rows('select distinct name, email from public.drop_photos'), [{ name: 'Ada Love lace', email: 'ada@example.com' }]);
  const sixth = await s.send();
  assert.deepEqual([sixth.status, sixth.body], [409, { error: "You've sent 5 photos, which is the most one person can send.", reason: 'limit' }]);
  assert.equal(s.storage.paths().length, 10, 'the sixth never reached Storage');

  // One connection. That limit starts off, so it is turned on here. It goes by the last address
  // in the list, whatever comes before it.
  assert.deepEqual(await s.h.sql(`select value from cal_private.config where key = 'drop_per_ip_day'`), [{ value: '0' }]);
  await s.h.sql(`update cal_private.config set value = '2' where key = 'drop_per_ip_day'`);
  const from = (n, forwarded) => s.send({ email: `guest${n}@example.com` }, forwarded ? { 'x-forwarded-for': forwarded } : {});
  assert.equal((await from(1, '198.51.100.7')).status, 200);
  assert.equal((await from(2, '1.2.3.4, 198.51.100.7')).status, 200);
  const third = await from(3, '5.6.7.8,198.51.100.7');
  assert.deepEqual([third.status, third.body], [409, { error: 'Too many photos have come from this connection today. Try again tomorrow.', reason: 'limit' }]);
  assert.equal((await from(3, '198.51.100.7, 5.6.7.8')).status, 200, 'another connection');
  // With no address to go by, or only the platform's own, the connection limit is not applied.
  for (let n = 4; n <= 6; n += 1) assert.equal((await from(n, n === 4 ? '' : '198.51.100.7, 10.0.0.12')).status, 200);
  // The same address written the IPv6 way is the same connection.
  assert.equal((await from(7, '::ffff:198.51.100.7')).status, 409);
  // An IPv6 connection is its whole /64: any address in it counts toward the one limit.
  assert.equal((await from(7, '2001:db8:aa:bb:1:2:3:4')).status, 200);
  assert.equal((await from(8, '2001:db8:aa:bb::9')).status, 200);
  const ninth = await from(9, '2001:0DB8:00AA:00BB:ffff::1');
  assert.deepEqual([ninth.status, ninth.body.reason], [409, 'limit']);
  assert.equal((await from(9, '2001:db8:aa:bc::1')).status, 200, 'the next /64 along is another connection');
  assertQuietLogs(s);
});

test('the address a photo came from: the last in the list, never a private one, and an IPv6 address as its /64 network', () => {
  const ip = (forwarded) => callerIp(new Request(FN, { headers: forwarded === null ? {} : { 'x-forwarded-for': forwarded } }));
  assert.equal(ip(null), '');
  assert.equal(ip(''), '');
  assert.equal(ip('203.0.113.9'), '203.0.113.9');
  assert.equal(ip('1.1.1.1, 203.0.113.9'), '203.0.113.9');
  assert.equal(ip(' 1.1.1.1 ,203.0.113.9 , '), '203.0.113.9');
  // A home line or a phone has a whole /64 of IPv6 addresses to use, so the /64 is the connection:
  // the first four groups, however the address is written.
  assert.equal(ip('2001:DB8::1:2'), '2001:db8:0:0::/64');
  for (const same of ['2001:db8:aa:bb:1:2:3:4', '2001:db8:aa:bb::9', '2001:0db8:00aa:00bb::1', '2001:DB8:AA:BB:ffff:ffff:ffff:ffff', '1.1.1.1, 2001:db8:aa:bb::']) {
    assert.equal(ip(same), '2001:db8:aa:bb::/64', same);
  }
  assert.equal(ip('2001:db8:aa:bc::9'), '2001:db8:aa:bc::/64', 'the next network along is another connection');
  // An IPv4 address written the IPv6 way is the IPv4 address.
  assert.equal(ip('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(ip('1.1.1.1, ::FFFF:203.0.113.9'), '203.0.113.9');
  for (const inside of ['10.4.5.6', '127.0.0.1', '192.168.1.20', '172.16.0.1', '172.31.255.1', '169.254.1.1', '100.64.0.1', '100.127.9.9', '::1', 'fd00::1', 'fd12:3456::1', 'fe80::1',
    '::ffff:10.4.5.6', '::ffff:192.168.1.20']) {
    assert.equal(ip(`203.0.113.9, ${inside}`), '', inside);
  }
  assert.equal(ip('::1'), '');
  assert.equal(ip('fd00::1'), '');
  // The all-zero network is nobody's connection: no address at all, this machine however it is
  // written, or an IPv4 address in a form that isn't unwrapped.
  for (const nobody of ['::', '::1', '0:0:0:0:0:0:0:1', '::ffff:cb00:7109', '0000:0000:0000:0000:1:2:3:4', '203.0.113.9, ::']) {
    assert.equal(ip(nobody), '', nobody);
  }
  assert.equal(ip('0:0:0:1::5'), '0:0:0:1::/64', 'one network along is a connection like any other');
  for (const outside of ['172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '11.0.0.1']) assert.equal(ip(outside), outside);
  for (const odd of ['unknown', 'ada@example.com', '<script>', `${'1'.repeat(46)}`, '203.0.113.9; drop table']) assert.equal(ip(odd), '', odd);
});

test('when Storage fails partway, the stray file is removed, the row is given up, and the sender can try again', async () => {
  const s = await setup();
  const failed = { error: "We couldn't save that photo. Try again.", reason: 'storage' };
  const nothingKept = async (what) => {
    assert.deepEqual(await s.rows(), [], what);
    assert.deepEqual(s.storage.paths(), [], what);
  };
  // The sender tries again with the very same photo every time. A send that failed leaves no row
  // behind, so the next try is never taken for a repeat or told to wait.
  const same = { photo: file(jpeg(1600, 1200, { bytes: 300000 })) };

  // The photo goes in, then the thumbnail is refused.
  s.storage.failPut = /^thumbs\//;
  let res = await s.send(same);
  assert.deepEqual([res.status, res.body, res.headers], [502, failed, CORS]);
  assert.equal(s.calls('put').length, 2);
  assert.equal(s.calls('remove').length, 1);
  assert.equal(s.calls('remove')[0].json.prefixes.length, 2, 'both paths are cleared, in case a put landed after all');
  assert.match(s.calls('remove')[0].json.prefixes[0], /^photos\/[0-9a-f-]{36}\.jpg$/);
  await nothingKept('thumbnail put failed');
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /^photo-drop: photo [0-9a-f-]{36} was not saved: put: HTTP 500 Internal: Internal Server Error$/);

  // Both files go in, then signing fails.
  s.storage.failPut = false;
  s.storage.failSign = true;
  res = await s.send(same);
  assert.deepEqual([res.status, res.body], [502, failed]);
  await nothingKept('sign failed');
  assert.match(s.logs[1], /was not saved: sign: HTTP 500/);

  // The files are in and signed, but the row went while they were on their way (Delete everything).
  s.storage.failSign = false;
  const gone = await setup({ db: (real) => ({ ...real, stored: async () => false }) });
  res = await gone.send(same);
  assert.deepEqual([res.status, res.body], [502, failed]);
  assert.deepEqual(gone.storage.paths(), []);
  assert.deepEqual(await gone.rows(), []);
  assert.match(gone.logs[0], /was not saved: its row was gone before the files were in$/);
  assertQuietLogs(gone);

  // Storage refuses the bucket's own rules: a wrong key, then a file over the bucket's size limit.
  s.storage.key = 'sb_secret_another';
  res = await s.send(same);
  assert.deepEqual([res.status, res.body], [502, failed]);
  assert.match(s.logs[2], /was not saved: put: HTTP 403 Unauthorized/);
  s.storage.key = KEY;
  s.storage.maxBytes = 1000;
  res = await s.send(same);
  assert.deepEqual([res.status, res.body], [502, failed]);
  assert.match(s.logs[3], /was not saved: put: HTTP 413 Payload too large/);
  s.storage.maxBytes = 52428800;
  await nothingKept('refused by the bucket');

  // Storage is not answering at all: nothing can be removed either, and the log says so.
  s.storage.down = true;
  res = await s.send(same);
  assert.deepEqual([res.status, res.body], [502, failed]);
  assert.deepEqual(await s.rows(), [], 'the place is given back even though Storage is down');
  assert.match(s.logs[4], /was not saved: put: Storage didn't answer\. Its files may still be in the bucket$/);
  assert.equal(s.logs.length, 5, 'one line for each failure');

  // None of that counted against the sender.
  s.storage.down = false;
  res = await s.send(same);
  assert.deepEqual([res.status, res.body.left], [200, 4]);
  assert.equal(s.storage.paths().length, 2, 'and this time the photo is in');
  assertQuietLogs(s);
});

test('the Storage key comes from the new secret keys or the old service role key, and a missing one is logged once', async () => {
  const legacy = await setup({ env: { SUPABASE_URL: `${BASE}/`, SUPABASE_SECRET_KEYS: 'not json', SUPABASE_SERVICE_ROLE_KEY: KEY } });
  assert.equal((await legacy.send()).status, 200);
  assert.equal(legacy.storage.paths().length, 2);
  assert.match((await legacy.rows())[0].url, new RegExp(`^${BASE}/storage/v1/object/sign/photo-drop/photos/`), 'no doubled slash from the address');

  // env can be a function, as index.ts passes it.
  const viaFunction = await setup({ env: (name) => ENV[name] });
  assert.equal((await viaFunction.send()).status, 200);

  const none = await setup({ env: { SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: JSON.stringify({ other: 'sb_secret_x' }) } });
  for (let i = 0; i < 3; i += 1) {
    const res = await none.send();
    assert.deepEqual([res.status, res.body], [502, { error: "We couldn't save that photo. Try again.", reason: 'storage' }]);
  }
  assert.deepEqual(none.logs, ['photo-drop: no Storage key. The function needs SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY to save photos.']);
  assert.deepEqual(await none.rows(), [], 'no place is held for a photo that can not be stored');
  assert.equal(none.storage.calls.length, 0);
  // The pages that only read still work.
  assert.equal((await none.post('open', { code: UPLOAD })).status, 200);
  assert.equal((await none.review('list')).status, 200);
});

test('the review list shows everything, tidies up sends that never finished, and renews links about to run out', async () => {
  const s = await setup();
  const first = (await s.send()).body.id;
  await s.at('2026-11-19T15:01:00Z');
  const second = (await s.send({ name: 'Grace Hopper', email: 'grace@example.com', caption: '', thumb: undefined })).body.id;

  // A send that died after its files went in: the row is still 'sending'.
  const dead = (await s.h.sql(`select cal_private.drop_reserve($1, 'Lost Upload', 'lost@example.com', null, 1600, 1200, 330000, true, '', null) as r`, [UPLOAD]))[0].r;
  s.storage.seed(dead.path, jpeg(1600, 1200));
  s.storage.seed(dead.thumb_path, jpeg(480, 360));
  const before = s.storage.calls.length;

  let res = await s.review('list');
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers, CORS);
  const [row] = await s.rows(`select url, thumb_url from public.drop_photos where id = '${first}'`);
  assert.deepEqual(res.body, {
    ok: true,
    settings: { open: true, closesAt: '2026-11-21T17:00:00.000Z', state: 'open', perPerson: 5, maxPhotos: 600, maxBytes: 750000000, photos: 3, bytes: 960000,
      videos: 0, videoBytes: 0, maxVideos: 40, videoMaxBytes: 52428800, videoTotalBytes: 200000000 },
    counts: { waiting: 2, approved: 0, rejected: 0 },
    photos: [
      { id: first, status: 'waiting', name: 'Ada Lovelace', email: 'ada@example.com', caption: 'Howard, class of 1998', width: 1600, height: 1200, bytes: 330000,
        original: { name: 'IMG_0042.HEIC', width: 4032, height: 3024, bytes: 2310456, type: 'image/heic' },
        createdAt: '2026-11-19T15:00:00.000Z', reviewedAt: null, reviewedBy: null, url: row.url, thumbUrl: row.thumb_url,
        kind: 'photo', seconds: null, mime: null },
      { id: second, status: 'waiting', name: 'Grace Hopper', email: 'grace@example.com', caption: null, width: 1600, height: 1200, bytes: 300000,
        original: { name: 'IMG_0042.HEIC', width: 4032, height: 3024, bytes: 2310456, type: 'image/heic' },
        createdAt: '2026-11-19T15:01:00.000Z', reviewedAt: null, reviewedBy: null, url: res.body.photos[1].url, thumbUrl: res.body.photos[1].url,
        kind: 'photo', seconds: null, mime: null }
    ]
  });
  assert.equal(s.storage.calls.length, before, 'nothing to tidy yet: Storage is left alone');

  // Sixteen minutes on, the dead send is stale. A wrong code tidies nothing.
  await s.at('2026-11-19T15:17:00Z');
  for (const code of ['nope', UPLOAD, SCREEN, '']) {
    res = await s.review('list', {}, code);
    assert.deepEqual([res.status, res.body], [403, { error: "That code isn't right.", reason: 'code' }]);
  }
  assert.equal((await s.rows()).length, 3);
  assert.ok(s.storage.read(dead.path));
  res = await s.review('list');
  assert.deepEqual([res.body.settings.photos, res.body.photos.length], [2, 2]);
  assert.deepEqual((await s.rows('select id from public.drop_photos order by created_at')).map((r) => r.id), [first, second]);
  assert.deepEqual(s.storage.paths(), [`photos/${first}.jpg`, `photos/${second}.jpg`, `thumbs/${first}.jpg`].sort());
  assert.deepEqual(s.calls('remove').at(-1).json.prefixes.sort(), [dead.path, dead.thumb_path].sort());

  // Links last 14 days. With more than 3 days left nothing is signed again.
  const old = res.body.photos.map((p) => [p.url, p.thumbUrl]);
  const signs = s.calls('sign').length;
  await s.at('2026-11-30T14:00:00Z');
  res = await s.review('list');
  assert.deepEqual(res.body.photos.map((p) => [p.url, p.thumbUrl]), old);
  assert.equal(s.calls('sign').length, signs);
  // Inside the last 3 days every link is renewed for another 14, and the answer carries the new ones.
  await s.at('2026-11-30T16:00:00Z');
  res = await s.review('list');
  assert.equal(s.calls('sign').length, signs + 1);
  assert.deepEqual(s.calls('sign').at(-1).json.paths.sort(), [`photos/${first}.jpg`, `photos/${second}.jpg`, `thumbs/${first}.jpg`].sort());
  const fresh = res.body.photos.map((p) => [p.url, p.thumbUrl]);
  assert.notEqual(fresh[0][0], old[0][0]);
  assert.notEqual(fresh[0][1], old[0][1]);
  assert.notEqual(fresh[1][0], old[1][0]);
  assert.equal(fresh[1][1], fresh[1][0], 'still no thumbnail for the second');
  assert.deepEqual((await s.rows('select signed_until from public.drop_photos')).map((r) => r.signed_until.toISOString()),
    ['2026-12-14T16:00:00.000Z', '2026-12-14T16:00:00.000Z']);
  await s.at('2026-12-05T00:00:00Z');
  assert.equal(s.storage.fileFor(old[0][0]), null, 'the first link has run out by now');
  assert.ok(s.storage.fileFor(fresh[0][0]), 'and the renewed one still opens the photo');
  res = await s.review('list');
  assert.equal(s.calls('sign').length, signs + 1, 'renewed links are left alone until they are due again');
  assert.deepEqual(s.logs, []);
});

test('the review list still answers when Storage is down or a file has gone missing', async () => {
  const s = await setup();
  const first = (await s.send()).body.id;
  const second = (await s.send({ email: 'grace@example.com' })).body.id;
  const dead = (await s.h.sql(`select cal_private.drop_reserve($1, 'Lost Upload', 'lost@example.com', null, 1600, 1200, 330000, true, '', null) as r`, [UPLOAD]))[0].r;
  s.storage.seed(dead.path, jpeg(1600, 1200));
  await s.at('2026-11-30T16:00:00Z');
  const old = (await s.rows('select id, url from public.drop_photos order by created_at, id')).filter((r) => r.url);

  s.storage.down = true;
  let res = await s.review('list');
  assert.equal(res.status, 200);
  assert.equal(res.body.photos.length, 2);
  assert.deepEqual(res.body.photos.map((p) => p.url).sort(), old.map((r) => r.url).sort(), 'the links it has, unchanged');
  assert.equal(s.logs.length, 2);
  assert.match(s.logs[0], /^photo-drop: tidying up unfinished sends failed with 2 files left in the bucket: remove: Storage didn't answer$/);
  assert.match(s.logs[1], /^photo-drop: renewing the photo links failed: sign: Storage didn't answer$/);

  // Back up, with one photo's file missing: the rest are renewed, and the log counts the missing.
  s.storage.down = false;
  s.storage.files.delete(`photos/${second}.jpg`);
  res = await s.review('list');
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.body.photos.map((p) => [p.id, p.url]));
  assert.notEqual(byId[first], old.find((r) => r.id === first).url);
  assert.equal(byId[second], old.find((r) => r.id === second).url);
  assert.equal(s.logs[2], 'photo-drop: 1 photos have no file in the bucket');
  assertQuietLogs(s, ['Grace', 'Lost Upload', 'lost@']);
});

test('the organizers approve, reject, caption, and change the settings', async () => {
  const s = await setup();
  const a = (await s.send()).body.id;
  await s.at('2026-11-19T15:01:00Z');
  const b = (await s.send({ email: 'grace@example.com', name: 'Grace Hopper' })).body.id;
  await s.at('2026-11-19T15:02:00Z');
  const c = (await s.send({ email: 'grace@example.com', name: 'Grace Hopper' })).body.id;
  const is = (res, status, body, what) => assert.deepEqual([res.status, res.body], [status, body], what);
  const wrong = { error: "That code isn't right.", reason: 'code' };
  const unreadable = { error: "That request didn't read right. Reload the page and try again.", reason: 'input' };

  await s.at('2026-11-19T16:00:00Z');
  is(await s.review('set', { ids: [a, b.toUpperCase(), a], status: 'approved', by: ' Eugene  Aiken ' }), 200, { ok: true, changed: 2 });
  is(await s.review('set', { ids: [c], status: 'rejected' }), 200, { ok: true, changed: 1 });
  is(await s.review('set', { ids: [a], status: 'approved', by: 'Someone Else' }), 200, { ok: true, changed: 0 }, 'already approved');
  let list = (await s.review('list')).body;
  assert.deepEqual(list.counts, { waiting: 0, approved: 2, rejected: 1 });
  assert.deepEqual(list.photos.map((p) => [p.status, p.reviewedAt, p.reviewedBy]), [
    ['approved', '2026-11-19T16:00:00.000Z', 'Eugene Aiken'], ['approved', '2026-11-19T16:00:00.000Z', 'Eugene Aiken'], ['rejected', '2026-11-19T16:00:00.000Z', null]
  ]);
  // Another organizer's list is a minute old and still shows all three waiting. Tapping the other
  // way changes nothing: a decision stands until the photo is sent back to waiting.
  await s.at('2026-11-19T16:01:00Z');
  is(await s.review('set', { ids: [c], status: 'approved', by: 'Someone Else' }), 200, { ok: true, changed: 0 }, 'rejected stays rejected');
  is(await s.review('set', { ids: [a, b], status: 'rejected', by: 'Someone Else' }), 200, { ok: true, changed: 0 }, 'approved stays approved');
  assert.deepEqual((await s.review('list')).body.photos, list.photos);
  is(await s.review('set', { ids: [b], status: 'waiting', by: 'Eugene Aiken' }), 200, { ok: true, changed: 1 });

  const many = { error: 'Choose between 1 and 200 photos at a time.', reason: 'input' };
  is(await s.review('set', { ids: [], status: 'approved' }), 400, many);
  is(await s.review('set', { status: 'approved' }), 400, many);
  is(await s.review('set', { ids: a, status: 'approved' }), 400, many);
  is(await s.review('set', { ids: [a, 'not-an-id'], status: 'approved' }), 400, many);
  is(await s.review('set', { ids: [`${a}'); drop table public.drop_photos; --`], status: 'approved' }), 400, many);
  is(await s.review('set', { ids: Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), status: 'approved' }), 400, many);
  is(await s.review('set', { ids: [a], status: 'sending' }), 400, { error: 'Choose approve, reject, or back to waiting.', reason: 'input' });
  is(await s.review('set', { ids: [a] }), 400, { error: 'Choose approve, reject, or back to waiting.', reason: 'input' });
  is(await s.review('set', { ids: [a], status: 'rejected' }, UPLOAD), 403, wrong);

  is(await s.review('caption', { id: a, caption: '  Morehouse,   class of 2004 ' }), 200, { ok: true });
  is(await s.review('caption', { id: b, caption: '' }), 200, { ok: true });
  is(await s.review('caption', { id: c }), 200, { ok: true });
  is(await s.review('caption', { id: a, caption: 'x'.repeat(81) }), 400, { error: 'Keep the caption to 80 characters or fewer.', reason: 'input' });
  is(await s.review('caption', { id: '00000000-0000-4000-8000-000000000000', caption: 'x' }), 400, { error: 'That photo is no longer here. Refresh to see the latest.', reason: 'input' });
  is(await s.review('caption', { id: 'not-an-id', caption: 'x' }), 400, unreadable);
  is(await s.review('caption', { caption: 'x' }), 400, unreadable);
  is(await s.review('caption', { id: a, caption: 'x' }, SCREEN), 403, wrong);
  list = (await s.review('list')).body;
  assert.deepEqual(list.photos.map((p) => [p.status, p.caption]), [['approved', 'Morehouse, class of 2004'], ['waiting', null], ['rejected', null]]);

  // Settings: only what the page sent is changed.
  const settings = { open: true, closesAt: '2026-11-21T17:00:00.000Z', state: 'open', perPerson: 5, maxPhotos: 600, maxBytes: 750000000, photos: 3, bytes: 990000,
    videos: 0, videoBytes: 0, maxVideos: 40, videoMaxBytes: 52428800, videoTotalBytes: 200000000 };
  is(await s.review('settings'), 200, { ok: true, settings });
  is(await s.review('settings', { open: false }), 200, { ok: true, settings: { ...settings, open: false, state: 'closed' } });
  is(await s.review('settings', { closesAt: '2026-11-21T15:00:00-05:00' }), 200, { ok: true, settings: { ...settings, open: false, state: 'closed', closesAt: '2026-11-21T20:00:00.000Z' } });
  is(await s.review('settings', { closesAt: '2026-11-21T19:30:00.000Z' }), 200, { ok: true, settings: { ...settings, open: false, state: 'closed', closesAt: '2026-11-21T19:30:00.000Z' } });
  is(await s.review('settings', { open: true, closesAt: null }), 200, { ok: true, settings: { ...settings, closesAt: null } });
  assert.equal((await s.post('open', { code: UPLOAD })).body.closesAt, null);
  const when = { error: "That date and time didn't read right. Choose them again.", reason: 'input' };
  is(await s.review('settings', { open: false, closesAt: 'noon on Saturday' }), 400, when);
  is(await s.review('settings', { open: false, closesAt: 1795000000000 }), 400, when);
  // A time with no zone on it could mean noon anywhere, so it is not taken.
  is(await s.review('settings', { open: false, closesAt: '2026-11-21T15:00' }), 400, when);
  is(await s.review('settings', { open: false, closesAt: '2026-11-21' }), 400, when);
  is(await s.review('settings', { open: 'false' }), 400, { error: 'Choose open or closed.', reason: 'input' });
  is(await s.review('settings', { open: false }, 'nope'), 403, wrong);
  assert.deepEqual((await s.review('list')).body.settings, { ...settings, closesAt: null }, 'none of the refused changes was saved');

  is(await s.review('approve everything'), 400, unreadable);
  is(await s.post('review', { code: REVIEW }), 400, unreadable);
  assert.deepEqual(s.logs, []);
});

test('delete removes the files and then the rows, and Delete everything empties the bucket a hundred files at a time', async () => {
  const s = await setup();
  const a = (await s.send()).body.id;
  const b = (await s.send({ thumb: undefined })).body.id;
  const c = (await s.send({ email: 'grace@example.com' })).body.id;
  const is = (res, status, body, what) => assert.deepEqual([res.status, res.body], [status, body], what);

  is(await s.review('delete', { ids: [a] }, 'nope'), 403, { error: "That code isn't right.", reason: 'code' });
  is(await s.review('delete', { ids: [] }), 400, { error: 'Choose between 1 and 200 photos at a time.', reason: 'input' });
  is(await s.review('delete'), 400, { error: 'Choose between 1 and 200 photos at a time.', reason: 'input' });
  assert.equal(s.calls('remove').length, 0);

  // Only a rejected photo can be deleted on its own. One that is waiting, or that someone has
  // approved since this organizer's list was loaded, stays: no file is removed, and no row.
  is(await s.review('set', { ids: [c], status: 'approved' }), 200, { ok: true, changed: 1 });
  is(await s.review('delete', { ids: [a, b, c] }), 200, { ok: true, deleted: 0 });
  assert.equal((await s.rows()).length, 3);
  assert.equal(s.storage.paths().length, 5);
  assert.equal(s.calls('remove').length, 0, 'Storage was not asked to remove anything');
  is(await s.review('set', { ids: [a, b], status: 'rejected' }), 200, { ok: true, changed: 2 });

  // Storage fails: the rows stay, so Delete can be tried again.
  s.storage.failRemove = true;
  is(await s.review('delete', { ids: [a, b] }), 502, { error: "We couldn't delete those photos. Try again.", reason: 'storage' });
  assert.equal((await s.rows()).length, 3);
  assert.equal(s.logs[0], 'photo-drop: deleting 2 photos stopped at their files: remove: HTTP 500 Internal: Internal Server Error');
  s.storage.failRemove = false;

  // The two rejected photos go. The approved one named with them does not.
  is(await s.review('delete', { ids: [a, b, c, '00000000-0000-4000-8000-000000000000'] }), 200, { ok: true, deleted: 2 });
  assert.deepEqual([...s.calls('remove').at(-1).json.prefixes].sort(), [`photos/${a}.jpg`, `photos/${b}.jpg`, `thumbs/${a}.jpg`].sort());
  assert.deepEqual((await s.rows('select id from public.drop_photos')).map((r) => r.id), [c]);
  assert.deepEqual(s.storage.paths(), [`photos/${c}.jpg`, `thumbs/${c}.jpg`]);
  is(await s.review('delete', { ids: [a, b] }), 200, { ok: true, deleted: 0 }, 'already gone');
  assert.equal((await s.send()).body.left, 4, 'deleted photos no longer count against their sender');

  // After the party: 80 more photos with thumbnails, then everything goes.
  await s.h.sql(`
    insert into public.drop_photos (id, status, name, email, width, height, bytes, has_thumb, path, thumb_path, url, created_at)
    select g.id, case when n % 3 = 0 then 'approved' else 'waiting' end, 'Guest ' || n, 'guest' || n || '@example.com', 1600, 1200, 330000, true,
           'photos/' || g.id || '.jpg', 'thumbs/' || g.id || '.jpg', 'https://files.example/' || g.id, cal_private.clock()
    from (select n, gen_random_uuid() as id from generate_series(1, 80) as n) g`);
  for (const r of await s.rows(`select path, thumb_path from public.drop_photos where name like 'Guest %'`)) {
    s.storage.seed(r.path, jpeg(1600, 1200));
    s.storage.seed(r.thumb_path, jpeg(480, 360));
  }
  assert.equal(s.storage.paths().length, 164);
  const sure = { error: 'Type DELETE to delete every photo.', reason: 'input' };
  is(await s.review('empty'), 400, sure);
  is(await s.review('empty', { confirm: 'delete' }), 400, sure);
  is(await s.review('empty', { confirm: 'DELETE ' }), 400, sure);
  is(await s.review('empty', { confirm: 'DELETE' }, SCREEN), 403, { error: "That code isn't right.", reason: 'code' });
  assert.equal((await s.rows()).length, 82);
  const removesBefore = s.calls('remove').length;
  // swept: the bucket was looked through afterwards and nothing without a row is left in it.
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 82, swept: true });
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(s.storage.paths(), []);
  const batches = s.calls('remove').slice(removesBefore).map((call) => call.json.prefixes.length);
  assert.deepEqual(batches, [REMOVE_BATCH, 64], 'at most 100 paths a call');
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 0, swept: true }, 'nothing left to delete');
  assert.deepEqual((await s.review('list')).body.photos, []);
  assertQuietLogs(s, ['Guest']);
});

test('Delete everything also takes out files no row points to, and still answers when it can not look for them', async () => {
  // arriving is something to happen between the rows being deleted and the bucket being looked over.
  let arriving = null;
  const s = await setup({ db: (real) => ({
    ...real,
    reviewDelete: async (code, ids) => {
      const done = await real.reviewDelete(code, ids);
      if (arriving) await arriving();
      return done;
    }
  }) });
  const is = (res, status, body, what) => assert.deepEqual([res.status, res.body], [status, body], what);
  const at = (minutes) => s.at(new Date(Date.parse(NOW) + minutes * 60000).toISOString());
  const a = (await s.send()).body.id;
  const b = (await s.send({ email: 'grace@example.com', thumb: undefined })).body.id;
  // What a send that failed while Storage was struggling leaves behind: files with no row.
  const stray = ['photos/11111111-1111-4111-8111-111111111111.jpg', 'thumbs/11111111-1111-4111-8111-111111111111.jpg', 'thumbs/22222222-2222-4222-8222-222222222222.jpg'];
  const leave = () => {
    for (const path of stray) s.storage.seed(path, jpeg(1600, 1200));
  };
  leave();

  // Ten minutes on, the leftovers are old enough to be told from a photo that is arriving.
  // Deleting chosen photos never looks through the bucket, and neither does a wrong code.
  await at(10);
  is(await s.review('set', { ids: [b], status: 'rejected' }), 200, { ok: true, changed: 1 });
  is(await s.review('delete', { ids: [b] }), 200, { ok: true, deleted: 1 });
  is(await s.review('empty', { confirm: 'DELETE' }, SCREEN), 403, { error: "That code isn't right.", reason: 'code' });
  assert.equal(s.calls('list').length, 0);
  assert.deepEqual(s.storage.paths(), [`photos/${a}.jpg`, `thumbs/${a}.jpg`, ...stray].sort());

  // Delete everything does. A photo that arrives while it runs keeps its row, and so its files.
  // The clock is moved on while it runs, so that the row is all that marks them as wanted.
  let late = null;
  arriving = async () => {
    arriving = null;
    late = (await s.send({ email: 'late@example.com' })).body.id;
    await at(21);
  };
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 1, swept: true });
  assert.match(late, /^[0-9a-f-]{36}$/);
  const left = await s.rows('select id, url, thumb_url from public.drop_photos');
  assert.deepEqual(left.map((r) => r.id), [late]);
  assert.deepEqual(s.storage.paths(), [`photos/${late}.jpg`, `thumbs/${late}.jpg`], 'the strays are gone, and nothing else is');
  assert.ok(s.storage.fileFor(left[0].url) && s.storage.fileFor(left[0].thumb_url), 'its links still open its files');
  // Each folder is listed with the secret key, and again until nothing stray is left in it.
  assert.deepEqual(s.calls('list').map((c) => `${c.method} ${c.path} ${c.json.prefix}`), ['photos', 'photos', 'thumbs', 'thumbs', 'videos'].map((folder) => `POST /storage/v1/object/list/photo-drop ${folder}`));
  assert.deepEqual(s.calls('list')[0].json, { prefix: 'photos', limit: LIST_BATCH, offset: 0, sortBy: { column: 'name', order: 'asc' } });
  for (const c of s.calls('list')) assert.deepEqual([c.headers.apikey, c.headers.authorization], [KEY, `Bearer ${KEY}`]);
  assert.deepEqual(s.calls('remove').slice(-3).map((c) => [...c.json.prefixes].sort()), [[`photos/${a}.jpg`, `thumbs/${a}.jpg`], [stray[0]], [stray[1], stray[2]]]);
  assert.deepEqual(s.logs, []);

  // Storage can't list the bucket. Everything that was asked for is deleted all the same, and
  // the log says the bucket went unchecked.
  leave();
  await at(31);
  s.storage.failList = true;
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 1, swept: false });
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(s.storage.paths(), [...stray].sort(), "the late photo's files went with its row, and the strays are still there");
  assert.deepEqual(s.logs, ['photo-drop: Delete everything could not check the bucket for leftover files: list: HTTP 500 Internal: Internal Server Error']);
  // It finds them but can't remove them: the same answer, and a line of its own.
  s.storage.failList = false;
  s.storage.failRemove = /^photos\/1111/;
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 0, swept: false });
  assert.deepEqual(s.storage.paths(), [...stray].sort());
  assert.deepEqual(s.logs.slice(1), ['photo-drop: Delete everything could not check the bucket for leftover files: remove: HTTP 500 Internal: Internal Server Error']);
  // Storage is well again. Asked once more, the leftovers go.
  s.storage.failRemove = false;
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 0, swept: true });
  assert.deepEqual(s.storage.paths(), []);

  // More leftovers than one listing holds: the folder is listed again until it is clear.
  for (let n = 0; n < LIST_BATCH + 5; n += 1) s.storage.seed(`thumbs/left-${String(n).padStart(4, '0')}.jpg`, 'x');
  await at(41);
  const before = { list: s.calls('list').length, remove: s.calls('remove').length };
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 0, swept: true });
  assert.deepEqual(s.storage.paths(), []);
  assert.deepEqual(s.calls('list').slice(before.list).map((c) => c.json.prefix), ['photos', 'thumbs', 'thumbs', 'thumbs', 'videos']);
  assert.deepEqual(s.calls('remove').slice(before.remove).map((c) => c.json.prefixes.length), [...Array(LIST_BATCH / REMOVE_BATCH).fill(REMOVE_BATCH), 5]);
  assert.equal(s.logs.length, 2, 'one line for each time the bucket went unchecked');
  assertQuietLogs(s);
});

test('Delete everything leaves a file under ten minutes old where it is, and removes nothing when it can not read the rows', async () => {
  // unreadable, when a test sets it, is what the second read of every row gives in place of the
  // rows: the first read, of what to delete, goes through.
  let unreadable = null;
  const s = await setup({ db: (real) => ({
    ...real,
    reviewPaths: async (code, ids) => {
      if (ids === null && unreadable) {
        if (unreadable.next) {
          const give = unreadable.give;
          unreadable = null;
          return give();
        }
        unreadable.next = true;
      }
      return real.reviewPaths(code, ids);
    }
  }) });
  const is = (res, status, body, what) => assert.deepEqual([res.status, res.body], [status, body], what);
  const empty = () => s.review('empty', { confirm: 'DELETE' });

  // Files with no row, in both folders. The older pair was left by a send that failed. The pair a
  // second younger could as well be a photo arriving right now, whose row hasn't been read yet.
  const older = ['photos/11111111-1111-4111-8111-111111111111.jpg', 'thumbs/11111111-1111-4111-8111-111111111111.jpg'];
  const younger = ['photos/22222222-2222-4222-8222-222222222222.jpg', 'thumbs/22222222-2222-4222-8222-222222222222.jpg'];
  for (const path of older) s.storage.seed(path, jpeg(1600, 1200));
  await s.at('2026-11-19T15:00:01Z');
  for (const path of younger) s.storage.seed(path, jpeg(1600, 1200));

  // Nine minutes and 59 seconds after the older pair: both pairs are left where they are.
  await s.at('2026-11-19T15:09:59Z');
  is(await empty(), 200, { ok: true, deleted: 0, swept: false });
  assert.deepEqual(s.storage.paths(), [...older, ...younger].sort());
  assert.equal(s.calls('remove').length, 0);
  assert.deepEqual(s.calls('list').map((c) => c.json.prefix), ['photos', 'thumbs', 'videos'], 'it looked, and found nothing old enough');
  // At ten minutes the older pair is taken, and the younger pair, a second short, is not.
  await s.at('2026-11-19T15:10:00Z');
  is(await empty(), 200, { ok: true, deleted: 0, swept: false });
  assert.deepEqual(s.storage.paths(), [...younger].sort());
  assert.deepEqual(s.calls('remove').map((c) => c.json.prefixes), [[older[0]], [older[1]]]);
  // A second later, so is the younger pair.
  await s.at('2026-11-19T15:10:01Z');
  is(await empty(), 200, { ok: true, deleted: 0, swept: true });
  assert.deepEqual(s.storage.paths(), []);
  assert.deepEqual(s.logs, []);

  // The rows can't be read a second time: the database refuses, gives nothing, or fails. Without
  // them a leftover can't be told from a photo, so the bucket isn't even listed and nothing but
  // what was asked for is removed.
  const a = (await s.send()).body.id;
  for (const path of older) s.storage.seed(path, jpeg(1600, 1200));
  await s.at('2026-11-19T15:30:00Z');
  const lists = s.calls('list').length;
  const line = 'photo-drop: Delete everything could not check the bucket for leftover files: ';
  unreadable = { give: async () => ({ ok: false, status: 403, reason: 'code', error: "That code isn't right." }) };
  is(await empty(), 200, { ok: true, deleted: 1, swept: false });
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(s.storage.paths(), [...older].sort(), `the files of ${a} went with its row, and the leftovers stay`);
  assert.deepEqual(s.logs, [`${line}the rows could not be read`]);
  unreadable = { give: async () => null };
  is(await empty(), 200, { ok: true, deleted: 0, swept: false });
  assert.deepEqual(s.logs.slice(1), [`${line}the rows could not be read`]);
  unreadable = { give: async () => { throw new Error('connection terminated unexpectedly'); } };
  is(await empty(), 200, { ok: true, deleted: 0, swept: false });
  assert.deepEqual(s.logs.slice(2), [`${line}connection terminated unexpectedly`]);
  assert.deepEqual(s.storage.paths(), [...older].sort());
  assert.equal(s.calls('list').length, lists, 'the bucket was never listed');
  assert.equal(unreadable, null, 'each of the three got as far as the second read');

  // The rows can be read again, and the leftovers go.
  is(await empty(), 200, { ok: true, deleted: 0, swept: true });
  assert.deepEqual(s.storage.paths(), []);
  assert.equal(s.logs.length, 3, 'one line for each time the rows could not be read');
  assertQuietLogs(s);
});

test('the slideshow gets approved photos only, in the order they were approved, with nothing about who sent them', async () => {
  const s = await setup();
  const a = (await s.send()).body.id;
  await s.at('2026-11-19T15:01:00Z');
  const b = (await s.send({ email: 'grace@example.com', name: 'Grace Hopper', caption: '', thumb: undefined, photo: file(jpeg(1200, 1600)), width: '1200', height: '1600' })).body.id;
  await s.at('2026-11-19T15:02:00Z');
  const c = (await s.send({ email: 'katherine@example.com', name: 'Katherine Johnson', caption: 'Hampton, class of 1999' })).body.id;

  assert.deepEqual((await s.post('screen', { code: SCREEN })).body, { ok: true, photos: [], videos: [] }, 'nothing is approved yet');
  await s.at('2026-11-19T16:00:00Z');
  await s.review('set', { ids: [c], status: 'approved', by: 'Eugene Aiken' });
  await s.at('2026-11-19T16:05:00Z');
  await s.review('set', { ids: [b], status: 'approved', by: 'Eugene Aiken' });
  await s.review('set', { ids: [a], status: 'rejected', by: 'Eugene Aiken' });

  const res = await s.post('screen', { code: ` ${SCREEN.toUpperCase()} ` });
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers, CORS);
  const urls = Object.fromEntries((await s.rows('select id, url, thumb_url from public.drop_photos')).map((r) => [r.id, r]));
  assert.deepEqual(res.body, { ok: true, photos: [
    { id: c, url: urls[c].url, thumbUrl: urls[c].thumb_url, width: 1600, height: 1200, caption: 'Hampton, class of 1999' },
    { id: b, url: urls[b].url, thumbUrl: urls[b].url, width: 1200, height: 1600, caption: null }
  ], videos: [] });
  assert.doesNotMatch(JSON.stringify(res.body), /Hopper|Johnson|Lovelace|example\.com|Eugene|IMG_0042|reviewed|status/);
  assert.ok(s.storage.fileFor(res.body.photos[0].url), 'the slideshow can open what it is given');

  // Only the screen code opens it. The review code would stay behind on the venue's computer,
  // so it is turned away here, like the upload code, which every ticket buyer has.
  const wrong = { error: "That code isn't right.", reason: 'code' };
  for (const code of [REVIEW, ` ${REVIEW.toUpperCase()} `, UPLOAD, 'nope', '', undefined]) {
    const no = await s.post('screen', { code });
    assert.deepEqual([no.status, no.body], [403, wrong], String(code));
  }
  // A photo sent back to waiting leaves the slideshow.
  const is = (r, status, body, what) => assert.deepEqual([r.status, r.body], [status, body], what);
  const playing = async () => (await s.post('screen', { code: SCREEN })).body.photos.map((p) => p.id);
  is(await s.review('set', { ids: [c], status: 'waiting' }), 200, { ok: true, changed: 1 });
  assert.deepEqual(await playing(), [b]);
  // An approved photo can't be rejected or deleted straight off the screens by an organizer whose
  // list still shows it waiting. It plays on, and its file is still there.
  is(await s.review('set', { ids: [b], status: 'rejected', by: 'Someone Else' }), 200, { ok: true, changed: 0 });
  is(await s.review('delete', { ids: [b] }), 200, { ok: true, deleted: 0 });
  assert.deepEqual(await playing(), [b]);
  assert.ok(s.storage.fileFor(urls[b].url));
  assert.equal(s.calls('remove').length, 0);
  // Sent back, then rejected, then deleted, it is gone.
  is(await s.review('set', { ids: [b], status: 'waiting' }), 200, { ok: true, changed: 1 });
  assert.deepEqual(await playing(), []);
  is(await s.review('set', { ids: [b], status: 'rejected' }), 200, { ok: true, changed: 1 });
  is(await s.review('delete', { ids: [b] }), 200, { ok: true, deleted: 1 });
  assert.equal(s.storage.fileFor(urls[b].url), null);
  assert.deepEqual((await s.post('screen', { code: SCREEN })).body, { ok: true, photos: [], videos: [] });
  assert.deepEqual(s.logs, []);
});

// ---------------------------------------------------------------------------
// The committee's videos
// ---------------------------------------------------------------------------

const WRONG_CODE = { error: "That code isn't right.", reason: 'code' };
const UNREADABLE = { error: "That request didn't read right. Reload the page and try again.", reason: 'input' };
const NOT_WHOLE = { error: "That video didn't arrive whole. Add it again.", reason: 'video' };
const VIDEO_GONE = { error: 'That video is no longer here. Add it again.', reason: 'input' };
const NO_ROW = '00000000-0000-4000-8000-000000000000';
// What must never be in the log after a video: the organizer's name, the caption, or any part
// of a link.
const VIDEO_SECRETS = ['Eugene', 'Aiken', 'Step show', 'supabase.co', '/object/'];
const is = (res, status, body, what) => assert.deepEqual([res.status, res.body], [status, body], what);

test('a video goes in three steps: a place and two links, the files straight to Storage, and then it is in the show', async () => {
  const s = await setup();
  const clipFile = mp4(2000000);
  const poster = jpeg(480, 270, { bytes: 20000 });
  const pattern = (kind, path) => new RegExp(`^${BASE}/storage/v1/object/${kind}/photo-drop/${path.replace('.', '\\.')}\\?token=[0-9a-f-]{36}$`);

  // 1. A place, and a link for each of the two files. A field the function doesn't know is ignored.
  const start = await s.video({ by: '  Eugene   Aiken ', caption: '  Step  show, 2019 ', bytes: clipFile.length, name: 'IMG_0042.MOV' });
  assert.equal(start.status, 200);
  assert.deepEqual(start.headers, CORS);
  const id = start.body.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const { upload } = start.body;
  assert.deepEqual(start.body, { ok: true, id, upload: { video: upload.video, poster: upload.poster, type: 'video/mp4' }, bytes: 2000000 });
  assert.match(upload.video, pattern('upload/sign', `videos/${id}.mp4`));
  assert.match(upload.poster, pattern('upload/sign', `thumbs/${id}.jpg`));
  // The function asked Storage for the two links, with the secret key, and for nothing else.
  assert.deepEqual(s.storage.calls.map((c) => `${c.method} ${c.path}`), [
    `POST /storage/v1/object/upload/sign/photo-drop/videos/${id}.mp4`, `POST /storage/v1/object/upload/sign/photo-drop/thumbs/${id}.jpg`
  ]);
  for (const c of s.calls('link')) {
    assert.deepEqual([c.headers.apikey, c.headers.authorization, c.headers['content-type'], c.headers['x-upsert'], c.json], [KEY, `Bearer ${KEY}`, 'application/json', 'true', {}]);
  }
  // The row holds the place. Nothing is in the bucket, on the review page, or in the show yet.
  const sending = {
    id, status: 'sending', kind: 'video', name: 'Eugene Aiken', email: 'committee', caption: 'Step show, 2019', width: 1920, height: 1080,
    bytes: 2000000, has_thumb: false, original: null, path: `videos/${id}.mp4`, thumb_path: `thumbs/${id}.jpg`, url: null, thumb_url: null,
    signed_until: null, ip_hash: null, sha256: null, created_at: '2026-11-19T15:00:00.000Z', stored_at: null, reviewed_at: null, reviewed_by: null,
    seconds: '23.50', mime: 'video/mp4'
  };
  const whole = async (rowId) => {
    const [row] = await s.rows(`select * from public.drop_photos where id = '${rowId}'`);
    const time = (t) => (t ? t.toISOString() : null);
    return { ...row, created_at: time(row.created_at), stored_at: time(row.stored_at), reviewed_at: time(row.reviewed_at), signed_until: time(row.signed_until) };
  };
  assert.deepEqual(await whole(id), sending);
  assert.deepEqual(s.storage.paths(), []);
  let list = (await s.review('list')).body;
  assert.deepEqual([list.photos, list.counts, list.settings.videos, list.settings.videoBytes], [[], { waiting: 0, approved: 0, rejected: 0 }, 1, 2000000]);
  assert.deepEqual((await s.post('screen', { code: SCREEN })).body, { ok: true, photos: [], videos: [] });

  // 2. The organizer's browser sends the files to the links. No key goes with them.
  await s.at('2026-11-19T15:03:00Z');
  assert.deepEqual(await s.put(upload.poster, poster, 'image/jpeg'), { status: 200, body: { Key: `photo-drop/thumbs/${id}.jpg` } });
  assert.deepEqual(await s.put(upload.video, clipFile, 'video/mp4'), { status: 200, body: { Key: `photo-drop/videos/${id}.mp4` } });
  assert.equal(s.calls('upload').length, 2);
  for (const c of s.calls('upload')) assert.deepEqual([c.headers.apikey, c.headers.authorization], [undefined, undefined]);
  assert.deepEqual(s.storage.paths(), [`thumbs/${id}.jpg`, `videos/${id}.mp4`]);
  assert.ok(s.storage.read(`videos/${id}.mp4`).equals(clipFile), 'the video is stored byte for byte');
  assert.deepEqual([s.storage.files.get(`videos/${id}.mp4`).type, s.storage.files.get(`thumbs/${id}.jpg`).type], ['video/mp4', 'image/jpeg']);
  assert.deepEqual((await s.review('list')).body.photos, [], 'still not on the review page');

  // 3. The page says both are sent. The function asks Storage what is at each path (the file's
  // folder, narrowed to its name), signs the two, and the video is approved there and then.
  const before = s.storage.calls.length;
  await s.at('2026-11-19T15:04:00Z');
  const done = await s.review('video-done', { id: id.toUpperCase(), by: 'Eugene Aiken' });
  assert.deepEqual([done.status, done.body, done.headers], [200, { ok: true, id }, CORS]);
  assert.deepEqual(s.storage.calls.slice(before).map((c) => [kindOf(c), c.json]), [
    ['list', { prefix: 'videos', search: `${id}.mp4`, limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } }],
    ['list', { prefix: 'thumbs', search: `${id}.jpg`, limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } }],
    ['sign', { expiresIn: SIGN_DAYS * 86400, paths: [`videos/${id}.mp4`, `thumbs/${id}.jpg`] }]
  ]);
  for (const c of s.storage.calls.slice(before)) assert.deepEqual([c.headers.apikey, c.headers.authorization], [KEY, `Bearer ${KEY}`]);
  const row = await whole(id);
  assert.match(row.url, pattern('sign', `videos/${id}.mp4`));
  assert.match(row.thumb_url, pattern('sign', `thumbs/${id}.jpg`));
  assert.deepEqual(row, {
    ...sending, status: 'approved', has_thumb: true, url: row.url, thumb_url: row.thumb_url, signed_until: '2026-12-03T15:04:00.000Z',
    stored_at: '2026-11-19T15:04:00.000Z', reviewed_at: '2026-11-19T15:04:00.000Z', reviewed_by: 'Eugene Aiken'
  });
  assert.ok(s.storage.fileFor(row.url).equals(clipFile), 'the saved link opens the video');
  assert.ok(s.storage.fileFor(row.thumb_url).equals(poster));

  // On the review page it is a video, approved, with its poster for a picture.
  list = (await s.review('list')).body;
  assert.deepEqual(list.counts, { waiting: 0, approved: 1, rejected: 0 });
  assert.deepEqual(list.photos, [
    { id, status: 'approved', name: 'Eugene Aiken', email: 'committee', caption: 'Step show, 2019', width: 1920, height: 1080, bytes: 2000000, original: null,
      createdAt: '2026-11-19T15:00:00.000Z', reviewedAt: '2026-11-19T15:04:00.000Z', reviewedBy: 'Eugene Aiken', url: row.url, thumbUrl: row.thumb_url,
      kind: 'video', seconds: 23.5, mime: 'video/mp4' }
  ]);
  // In the show it is under videos, with the exact size of its file and nothing about who added it.
  const screen = await s.post('screen', { code: SCREEN });
  assert.deepEqual(screen.body, { ok: true, photos: [], videos: [
    { id, url: row.url, thumbUrl: row.thumb_url, caption: 'Step show, 2019', bytes: 2000000, seconds: 23.5, width: 1920, height: 1080 }
  ] });
  assert.equal(s.storage.fileFor(screen.body.videos[0].url).length, screen.body.videos[0].bytes, 'the size the slideshow holds its download to');
  assert.doesNotMatch(JSON.stringify(screen.body).replaceAll(id, '(id)'), /Aiken|Eugene|committee|reviewed|status|mime|kind/);

  // A MOV file with no poster, no caption, and no length the browser could read.
  const mov = await s.clip({ file: mp4(1500000, 0x71), poster: null, mime: 'video/quicktime', caption: '', seconds: null, width: 1080, height: 1920 });
  is(mov.done, 200, { ok: true, id: mov.id });
  assert.match(mov.start.body.upload.video, pattern('upload/sign', `videos/${mov.id}.mov`));
  assert.equal(mov.start.body.upload.type, 'video/quicktime');
  assert.deepEqual(s.calls('sign').at(-1).json.paths, [`videos/${mov.id}.mov`], 'only the video is signed');
  assert.deepEqual(await s.rows(`select status, caption, seconds, mime, has_thumb, thumb_path, thumb_url, bytes from public.drop_photos where id = '${mov.id}'`),
    [{ status: 'approved', caption: null, seconds: null, mime: 'video/quicktime', has_thumb: false, thumb_path: null, thumb_url: null, bytes: 1500000 }]);
  assert.deepEqual(s.storage.paths(), [`thumbs/${id}.jpg`, `videos/${id}.mp4`, `videos/${mov.id}.mov`].sort());
  // With no poster there is no picture to show: never the video's own link in a picture's place.
  list = (await s.review('list')).body;
  assert.deepEqual([list.photos[1].kind, list.photos[1].thumbUrl, list.photos[1].seconds, list.photos[1].mime], ['video', '', null, 'video/quicktime']);
  assert.match(list.photos[1].url, pattern('sign', `videos/${mov.id}.mov`));
  assert.deepEqual((await s.post('screen', { code: SCREEN })).body.videos[1],
    { id: mov.id, url: list.photos[1].url, thumbUrl: '', caption: null, bytes: 1500000, seconds: null, width: 1080, height: 1920 });
  assert.deepEqual(s.logs, []);
});

test("a video is turned away before any link is handed out: a wrong code, numbers that aren't numbers, and each of the database's reasons", async () => {
  const s = await setup();
  const nothing = async (what) => {
    assert.deepEqual(await s.rows(), [], what);
    assert.equal(s.storage.calls.length, 0, what);
  };

  // Only the review code adds a video. The code every guest has opens none of the three
  // actions, and neither does the venue's.
  for (const code of [UPLOAD, SCREEN, 'nope', '', null]) {
    is(await s.video({}, code), 403, WRONG_CODE, `video, ${code}`);
    is(await s.review('video-done', { id: NO_ROW, by: 'Eugene Aiken' }, code), 403, WRONG_CODE, `video-done, ${code}`);
    is(await s.review('video-cancel', { id: NO_ROW }, code), 403, WRONG_CODE, `video-cancel, ${code}`);
  }

  // What the page read from the file comes as numbers, and what was typed as text.
  const unreadable = [{ width: '1920' }, { width: 0 }, { width: -1 }, { width: 1920.5 }, { width: null }, { width: undefined }, { height: '1080' }, { height: 0 },
    { height: [1080] }, { bytes: '2000000' }, { bytes: 0 }, { bytes: 1.5 }, { bytes: undefined }, { bytes: 2 ** 53 }, { seconds: '23.5' }, { seconds: true },
    { seconds: [23.5] }, { by: 7 }, { caption: ['Step show'] }, { mime: { type: 'video/mp4' } }];
  for (const bad of unreadable) is(await s.video(bad), 400, UNREADABLE, JSON.stringify(bad));
  is(await s.video({ caption: 'x'.repeat(2001) }), 400, { error: "That's too much text. Shorten it and try again.", reason: 'input' });
  for (const action of ['video-done', 'video-cancel']) {
    for (const bad of [undefined, 'not-an-id', 7, [NO_ROW], `${NO_ROW}'; drop table public.drop_photos; --`]) {
      is(await s.review(action, { id: bad, by: 'Eugene Aiken' }), 400, UNREADABLE, `${action} ${JSON.stringify(bad)}`);
    }
  }
  is(await s.review('video-done', { id: NO_ROW, by: 7 }), 400, UNREADABLE);
  await nothing('unreadable');

  // The database's reasons, each in its own words.
  is(await s.video({ by: '   ' }), 400, { error: 'Add your name.', reason: 'input' });
  is(await s.video({ by: undefined }), 400, { error: 'Add your name.', reason: 'input' });
  is(await s.video({ caption: 'x'.repeat(81) }), 400, { error: 'Keep the caption to 80 characters or fewer.', reason: 'input' });
  const notVideo = { error: "That file isn't a video we can use. Add an MP4 or MOV file.", reason: 'video' };
  for (const mime of ['video/webm', 'image/jpeg', 'Video/MP4', '', undefined]) is(await s.video({ mime }), 400, notVideo, String(mime));
  is(await s.video({ width: 65536 }), 400, notVideo);
  is(await s.video({ height: 3000000000 }), 400, notVideo, 'a side past what the database counts to is turned away, not an error');
  const tooLarge = { error: 'That video is too large. One video can be 50 MB at most.', reason: 'size' };
  is(await s.video({ bytes: MB50 + 1 }), 400, tooLarge);
  is(await s.video({ bytes: 2 ** 53 - 1 }), 400, tooLarge);
  await s.h.sql(`update cal_private.config set value = '0' where key = 'drop_max_videos'`);
  is(await s.video(), 409, { error: 'The show has all the videos it can take. Delete one to add another.', reason: 'full' });
  await s.h.sql(`update cal_private.config set value = '40' where key = 'drop_max_videos'`);
  await s.h.sql(`update cal_private.config set value = '1999999' where key = 'drop_video_total_bytes'`);
  is(await s.video(), 409, { error: "That video doesn't fit. All the videos together can take 1 MB, and 0 MB is in use. Delete one to add another.", reason: 'full' });
  await s.h.sql(`update cal_private.config set value = '200000000' where key = 'drop_video_total_bytes'`);
  await nothing('refused by the database');

  // A length that can't be right is left out and the video is taken: missing, nothing, more than
  // a day, and a number too large to be a number at all.
  for (const seconds of [undefined, 0, -1, 90000]) assert.equal((await s.video({ seconds })).status, 200, String(seconds));
  const endless = await s.post('review', `{"code": ${JSON.stringify(REVIEW)}, "action": "video", "by": "Eugene Aiken", "width": 1920, "height": 1080, "bytes": 2000000, "seconds": 1e999, "mime": "video/mp4"}`);
  assert.equal(endless.status, 200);
  assert.deepEqual(await s.rows('select count(*)::int as videos, count(seconds)::int as lengths from public.drop_photos'), [{ videos: 5, lengths: 0 }]);
  // 50 MB to the byte is fine, and so is adding one when guests' uploads are closed.
  assert.equal((await s.video({ bytes: MB50 })).body.bytes, MB50);
  await s.h.sql(`update cal_private.config set value = 'false' where key = 'drop_open'`);
  assert.equal((await s.video()).status, 200);
  assert.deepEqual(s.logs, []);
});

test("when Storage can't hand out an upload link, the place is given back and the organizer can try again", async () => {
  // garble, when a test sets it, changes Storage's answer to a request for an upload link.
  let garble = null;
  const s = await setup({ net: (fetch) => async (input, init) => {
    const res = await fetch(input, init);
    return garble && String(input).includes('/object/upload/sign/') ? garble(res) : res;
  } });
  const failed = { error: "We couldn't start that upload. Try again.", reason: 'storage' };
  const line = (what) => new RegExp(`^photo-drop: video [0-9a-f-]{36} could not be given an upload link: ${what}$`);

  s.storage.failUploadLink = true;
  let res = await s.video();
  assert.deepEqual([res.status, res.body, res.headers], [502, failed, CORS]);
  assert.equal(s.calls('link').length, 1, 'the second link is not asked for once the first has failed');
  assert.match(s.logs[0], line('sign: HTTP 500 Internal: Internal Server Error'));
  assert.deepEqual(await s.rows(), [], 'the place is given back');
  // The video's link comes and the poster's does not: the same.
  s.storage.failUploadLink = /^thumbs\//;
  is(await s.video(), 502, failed);
  assert.equal(s.calls('link').length, 3);
  assert.match(s.logs[1], line('sign: HTTP 500 Internal: Internal Server Error'));
  // Storage is not answering at all.
  s.storage.failUploadLink = false;
  s.storage.down = true;
  is(await s.video(), 502, failed);
  assert.match(s.logs[2], line("sign: Storage didn't answer"));
  s.storage.down = false;
  // An answer that isn't a link.
  for (const body of [{}, { url: 17 }, { url: '/object/upload/sign/photo-drop/videos/x.mp4' }, { signedURL: '/object/upload/sign/photo-drop/videos/x.mp4?token=abc' }, null, 'ok']) {
    garble = () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    is(await s.video(), 502, failed, JSON.stringify(body));
    assert.match(s.logs.at(-1), line('sign: an answer that made no sense'));
  }
  garble = null;
  assert.equal(s.logs.length, 9, 'one line for each failure');
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(s.storage.paths(), []);

  // None of that took one of the places, and the next try goes through. A link that Storage
  // answers without its leading slash is still a whole link.
  await s.h.sql(`update cal_private.config set value = '1' where key = 'drop_max_videos'`);
  garble = async (answer) => new Response(JSON.stringify({ url: (await answer.json()).url.slice(1) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  res = await s.video();
  assert.equal(res.status, 200);
  assert.match(res.body.upload.video, new RegExp(`^${BASE}/storage/v1/object/upload/sign/photo-drop/videos/${res.body.id}\\.mp4\\?token=`));
  assert.equal((await s.put(res.body.upload.video, mp4(), 'video/mp4')).status, 200);
  assert.equal(s.logs.length, 9);
  assertQuietLogs(s, VIDEO_SECRETS);

  // With no Storage key there is no link either, and the log says why, once.
  const none = await setup({ env: { SUPABASE_URL: BASE, SUPABASE_SECRET_KEYS: JSON.stringify({ other: 'sb_secret_x' }) } });
  is(await none.video(), 502, failed);
  is(await none.video(), 502, failed);
  assert.equal(none.logs[0], 'photo-drop: no Storage key. The function needs SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY to save photos.');
  assert.match(none.logs[1], line('sign: no Storage key'));
  assert.match(none.logs[2], line('sign: no Storage key'));
  assert.equal(none.logs.length, 3);
  assert.deepEqual(await none.rows(), []);
  assert.equal(none.storage.calls.length, 0);
});

test('video-done puts a video in the show only when Storage holds the whole file, as the type its place was held for', async () => {
  const s = await setup();
  const clipFile = mp4(2000000);
  const poster = jpeg(480, 270, { bytes: 20000 });

  // Nothing was sent. The row is given up, and both paths are cleared.
  let start = (await s.video()).body;
  is(await s.review('video-done', { id: start.id, by: 'Eugene Aiken' }), 400, NOT_WHOLE, 'nothing sent');
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(s.calls('remove').at(-1).json.prefixes, [`videos/${start.id}.mp4`, `thumbs/${start.id}.jpg`]);
  assert.equal(s.calls('sign').length, 0, 'nothing is signed for a video that did not arrive');

  // Something arrived, but not the file the place was held for.
  const cases = {
    'only the poster': async () => {},
    'a byte short': (u) => s.put(u.video, clipFile.subarray(1), 'video/mp4'),
    'a byte long': (u) => s.put(u.video, Buffer.concat([clipFile, Buffer.from([0])]), 'video/mp4'),
    empty: (u) => s.put(u.video, Buffer.alloc(0), 'video/mp4'),
    'the right bytes sent as a MOV': (u) => s.put(u.video, clipFile, 'video/quicktime'),
    'a JPEG of the same size': (u) => s.put(u.video, jpeg(1600, 1200, { bytes: 2000000 }), 'image/jpeg')
  };
  for (const [what, sendVideo] of Object.entries(cases)) {
    start = (await s.video()).body;
    assert.equal((await s.put(start.upload.poster, poster, 'image/jpeg')).status, 200, what);
    await sendVideo(start.upload);
    assert.ok(s.storage.paths().length >= 1, what);
    is(await s.review('video-done', { id: start.id, by: 'Eugene Aiken' }), 400, NOT_WHOLE, what);
    assert.deepEqual(await s.rows(), [], `${what}: the row is given up`);
    assert.deepEqual(s.storage.paths(), [], `${what}: the video and the poster are both taken back out`);
  }
  assert.equal(s.calls('sign').length, 0);
  assert.equal((await s.review('list')).body.settings.videos, 0, 'none of them holds a place');

  // Asked twice, a video is finished once: the second hears it is no longer on its way in, and
  // nothing of the video in the show is touched. An id that was never a video's hears the same.
  const good = await s.clip({ file: clipFile, poster });
  is(good.done, 200, { ok: true, id: good.id });
  const photo = (await s.send()).body.id;
  const calls = s.storage.calls.length;
  is(await s.review('video-done', { id: good.id, by: 'Eugene Aiken' }), 409, VIDEO_GONE);
  is(await s.review('video-done', { id: NO_ROW }), 409, VIDEO_GONE);
  is(await s.review('video-done', { id: photo, by: 'Eugene Aiken' }), 409, VIDEO_GONE, "a guest's photo is not a video on its way in");
  assert.equal(s.storage.calls.length, calls, 'Storage was asked nothing');
  assert.deepEqual(s.storage.paths(), [`photos/${photo}.jpg`, `thumbs/${good.id}.jpg`, `thumbs/${photo}.jpg`, `videos/${good.id}.mp4`].sort());
  assert.deepEqual((await s.rows('select id, status from public.drop_photos order by created_at, id')).map((r) => r.status).sort(), ['approved', 'waiting']);
  assert.deepEqual(s.logs, []);
});

test('a poster that is not a small JPEG is taken back out, and the video goes in without one', async () => {
  const s = await setup();
  const cases = {
    'too big': [jpeg(480, 270, { bytes: MAX_THUMB_BYTES + 1 }), 'image/jpeg'],
    'a video where the poster goes': [mp4(20000), 'video/mp4'],
    empty: [Buffer.alloc(0), 'image/jpeg']
  };
  for (const [what, [bytes, type]] of Object.entries(cases)) {
    const start = (await s.video()).body;
    assert.equal((await s.put(start.upload.poster, bytes, type)).status, 200, `${what}: the bucket takes it`);
    assert.equal((await s.put(start.upload.video, mp4(), 'video/mp4')).status, 200);
    is(await s.review('video-done', { id: start.id, by: 'Eugene Aiken' }), 200, { ok: true, id: start.id }, what);
    assert.deepEqual(await s.rows(`select status, has_thumb, thumb_path, thumb_url, bytes from public.drop_photos where id = '${start.id}'`),
      [{ status: 'approved', has_thumb: false, thumb_path: null, thumb_url: null, bytes: 2000000 }], what);
    assert.equal(s.storage.read(`thumbs/${start.id}.jpg`), null, `${what}: taken back out of the bucket`);
    assert.ok(s.storage.read(`videos/${start.id}.mp4`), what);
    assert.deepEqual(s.calls('remove').at(-1).json.prefixes, [`thumbs/${start.id}.jpg`], what);
    assert.deepEqual(s.calls('sign').at(-1).json.paths, [`videos/${start.id}.mp4`], what);
  }
  // No poster was sent at all: there is nothing to take out.
  const removes = s.calls('remove').length;
  const bare = await s.clip({ poster: null });
  is(bare.done, 200, { ok: true, id: bare.id });
  assert.equal(s.calls('remove').length, removes);
  // The largest poster allowed is kept. The row's size is the video's alone, with a poster or without.
  const most = await s.clip({ poster: jpeg(480, 270, { bytes: MAX_THUMB_BYTES }) });
  is(most.done, 200, { ok: true, id: most.id });
  assert.deepEqual(await s.rows(`select has_thumb, thumb_path, bytes from public.drop_photos where id = '${most.id}'`),
    [{ has_thumb: true, thumb_path: `thumbs/${most.id}.jpg`, bytes: 2000000 }]);
  assert.equal(s.storage.paths().filter((p) => p.startsWith('thumbs/')).length, 1);

  // The pages are handed the poster or nothing.
  const list = (await s.review('list')).body;
  assert.equal(list.photos.length, 5);
  for (const p of list.photos) {
    assert.match(p.url, /\/object\/sign\/photo-drop\/videos\//);
    if (p.id === most.id) assert.match(p.thumbUrl, /\/object\/sign\/photo-drop\/thumbs\//);
    else assert.equal(p.thumbUrl, '');
  }
  const screen = (await s.post('screen', { code: SCREEN })).body;
  assert.deepEqual(screen.videos.map((v) => [v.id, v.thumbUrl !== '']), list.photos.map((p) => [p.id, p.id === most.id]));
  assert.deepEqual(s.logs, []);
});

test('when Storage fails while a video is being checked, the row and the files stay, and video-done can be asked again', async () => {
  // between, when a test sets it, happens just before Storage is asked to sign links. garble
  // changes Storage's answer to a list.
  let between = null;
  let garble = null;
  const s = await setup({ net: (fetch) => async (input, init) => {
    if (between && String(input).endsWith('/object/sign/photo-drop')) {
      const happen = between;
      between = null;
      await happen();
    }
    const res = await fetch(input, init);
    return garble && String(input).includes('/object/list/') ? garble(res) : res;
  } });
  const failed = { error: "We couldn't check that video. Try again.", reason: 'storage' };
  const line = (what) => new RegExp(`^photo-drop: video [0-9a-f-]{36} could not be checked: ${what}$`);
  const clipFile = mp4();
  const start = (await s.video()).body;
  const paths = [`thumbs/${start.id}.jpg`, `videos/${start.id}.mp4`];
  // The poster is too big to keep, so checking this video includes taking it out.
  await s.put(start.upload.poster, jpeg(480, 270, { bytes: MAX_THUMB_BYTES + 1 }), 'image/jpeg');
  await s.put(start.upload.video, clipFile, 'video/mp4');
  const done = () => s.review('video-done', { id: start.id, by: 'Eugene Aiken' });
  const untouched = async (what, kept = paths) => {
    assert.deepEqual(await s.rows('select id, status, url from public.drop_photos'), [{ id: start.id, status: 'sending', url: null }], what);
    assert.deepEqual(s.storage.paths(), kept, what);
  };

  // Storage can't say what is at the video's path, then at the poster's.
  s.storage.failList = true;
  let res = await done();
  assert.deepEqual([res.status, res.body, res.headers], [502, failed, CORS]);
  assert.match(s.logs[0], line('list: HTTP 500 Internal: Internal Server Error'));
  await untouched('the first look failed');
  s.storage.failList = /^thumbs$/;
  is(await done(), 502, failed);
  assert.match(s.logs[1], line('list: HTTP 500 Internal: Internal Server Error'));
  await untouched('the second look failed');
  // Its answer is not a list.
  s.storage.failList = false;
  garble = () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  is(await done(), 502, failed);
  assert.match(s.logs[2], line('list: an answer that made no sense'));
  garble = null;
  await untouched('an answer that was not a list');
  // It can't take the poster out.
  s.storage.failRemove = true;
  is(await done(), 502, failed);
  assert.match(s.logs[3], line('remove: HTTP 500 Internal: Internal Server Error'));
  await untouched('the poster could not be removed');
  // The poster goes, and then the links can't be signed.
  s.storage.failRemove = false;
  s.storage.failSign = true;
  is(await done(), 502, failed);
  assert.match(s.logs[4], line('sign: HTTP 500 Internal: Internal Server Error'));
  await untouched('signing failed', [paths[1]]);
  // It is not answering at all.
  s.storage.failSign = false;
  s.storage.down = true;
  is(await done(), 502, failed);
  assert.match(s.logs[5], line("list: Storage didn't answer"));
  s.storage.down = false;
  await untouched('Storage was down', [paths[1]]);
  assert.equal(s.logs.length, 6, 'one line for each failure');
  assert.equal((await s.review('list')).body.settings.videos, 1, 'the place is still held');

  // Storage is well again: asked once more, the video goes in.
  is(await done(), 200, { ok: true, id: start.id });
  const [row] = await s.rows('select status, has_thumb, url from public.drop_photos');
  assert.deepEqual([row.status, row.has_thumb], ['approved', false]);
  assert.ok(s.storage.fileFor(row.url).equals(clipFile));

  // The file was there at the first look and gone by the time its link was asked for. With no
  // link there is no video: the row is given up, and the poster goes too.
  const next = (await s.video()).body;
  await s.put(next.upload.poster, jpeg(480, 270), 'image/jpeg');
  await s.put(next.upload.video, clipFile, 'video/mp4');
  between = async () => { s.storage.files.delete(`videos/${next.id}.mp4`); };
  is(await s.review('video-done', { id: next.id, by: 'Eugene Aiken' }), 400, NOT_WHOLE);
  assert.equal(between, null, 'it got as far as signing');
  assert.deepEqual((await s.rows('select id from public.drop_photos')).map((r) => r.id), [start.id]);
  assert.deepEqual(s.storage.paths(), [paths[1]]);
  assert.equal(s.logs.length, 6);
  assertQuietLogs(s, VIDEO_SECRETS);
});

test('a video whose row goes while it is being checked leaves no file behind, and one finished twice at once is finished once', async () => {
  // meanwhile, when a test sets it, happens between the files being checked and the row being
  // approved. blind makes the database give no answer about which rows are there.
  let meanwhile = null;
  let blind = false;
  const s = await setup({ db: (real) => ({
    ...real,
    videoStored: async (...args) => {
      if (meanwhile) {
        const happen = meanwhile;
        meanwhile = null;
        await happen(real, args);
      }
      return real.videoStored(...args);
    },
    reviewPaths: async (code, ids) => (blind ? null : real.reviewPaths(code, ids))
  }) });
  const clipFile = mp4();
  const sent = async () => {
    const start = (await s.video()).body;
    await s.put(start.upload.poster, jpeg(480, 270), 'image/jpeg');
    await s.put(start.upload.video, clipFile, 'video/mp4');
    return start.id;
  };
  const done = (id) => s.review('video-done', { id, by: 'Eugene Aiken' });
  const remove = (id) => s.h.sql('delete from public.drop_photos where id = $1', [id]);

  // Delete everything ran in between: the row is gone, so the files that were just checked go too.
  let id = await sent();
  meanwhile = () => remove(id);
  is(await done(id), 400, VIDEO_GONE);
  assert.equal(meanwhile, null);
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(s.storage.paths(), []);
  assert.deepEqual(s.calls('remove').at(-1).json.prefixes, [`videos/${id}.mp4`, `thumbs/${id}.jpg`]);
  assert.deepEqual(s.logs, []);

  // Another video-done for the same video got there first. The video is in the show and its
  // files are in use: this one hears the same good news, and takes nothing out.
  id = await sent();
  const removes = s.calls('remove').length;
  meanwhile = (real, args) => real.videoStored(...args);
  is(await done(id), 200, { ok: true, id });
  assert.equal(s.calls('remove').length, removes);
  const [row] = await s.rows();
  assert.deepEqual([row.id, row.status, row.has_thumb], [id, 'approved', true]);
  assert.ok(s.storage.fileFor(row.url).equals(clipFile), 'its link still opens it');
  assert.ok(s.storage.fileFor(row.thumb_url));
  assert.deepEqual((await s.post('screen', { code: SCREEN })).body.videos.map((v) => v.id), [id]);
  assert.deepEqual(s.logs, []);

  // The row is gone and Storage can't take the files out: the page hears the same, and the log
  // has the only record of what was left.
  const second = await sent();
  meanwhile = () => remove(second);
  s.storage.failRemove = true;
  is(await done(second), 400, VIDEO_GONE);
  assert.deepEqual(s.logs, [`photo-drop: video ${second} is gone, and its files may still be in the bucket: remove: HTTP 500 Internal: Internal Server Error`]);
  assert.deepEqual(s.storage.paths().filter((p) => p.includes(second)), [`thumbs/${second}.jpg`, `videos/${second}.mp4`]);
  s.storage.failRemove = false;

  // The database won't say whether the row is still there. Then nothing is taken out: files
  // left over are found by Delete everything, and a video in the show is never emptied on a guess.
  const third = await sent();
  meanwhile = () => remove(third);
  blind = true;
  is(await done(third), 400, VIDEO_GONE);
  blind = false;
  assert.deepEqual(s.storage.paths().filter((p) => p.includes(third)), [`thumbs/${third}.jpg`, `videos/${third}.mp4`]);
  assert.equal(s.logs.length, 1);
  // Ten minutes on, Delete everything takes the video in the show and both sets of leftovers.
  await s.at('2026-11-19T15:11:00Z');
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 1, swept: true });
  assert.deepEqual(s.storage.paths(), []);
  assertQuietLogs(s, VIDEO_SECRETS);
});

test('video-cancel gives a video up with whatever of it arrived, and leaves alone anything that is not on its way in', async () => {
  // racing, when a test sets it, happens after the files are out and before the row is given up.
  let racing = null;
  const s = await setup({ db: (real) => ({
    ...real,
    abandon: async (id) => {
      if (racing) {
        const happen = racing;
        racing = null;
        await happen(real, id);
      }
      return real.abandon(id);
    }
  }) });
  const clipFile = mp4();
  const sent = async () => {
    const start = (await s.video()).body;
    await s.put(start.upload.poster, jpeg(480, 270), 'image/jpeg');
    await s.put(start.upload.video, clipFile, 'video/mp4');
    return start.id;
  };
  const cancel = (id, code = REVIEW) => s.review('video-cancel', { id }, code);

  // Before anything was sent: the place is given back, and both paths are cleared in case a
  // file lands after all.
  const early = (await s.video()).body.id;
  let res = await cancel(early.toUpperCase());
  assert.deepEqual([res.status, res.body, res.headers], [200, { ok: true }, CORS]);
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(s.calls('remove').at(-1).json.prefixes, [`videos/${early}.mp4`, `thumbs/${early}.jpg`]);
  // After both files arrived: they go with the row.
  const late = await sent();
  assert.equal(s.storage.paths().length, 2);
  is(await cancel(late), 200, { ok: true });
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(s.storage.paths(), []);

  // Already cancelled, never there, in the show, or a guest's photo: not an error, and nothing
  // is touched. The page cancels on any failure, without knowing how far the video got.
  const shown = await s.clip({ file: clipFile });
  const photo = (await s.send()).body.id;
  const calls = s.storage.calls.length;
  for (const id of [late, early, NO_ROW, shown.id, photo]) is(await cancel(id), 200, { ok: true }, id);
  assert.equal(s.storage.calls.length, calls, 'Storage was asked nothing');
  assert.deepEqual((await s.rows('select id, status from public.drop_photos')).map((r) => [r.id, r.status]).sort(), [[shown.id, 'approved'], [photo, 'waiting']].sort());
  assert.equal(s.storage.paths().length, 4);
  // Only the review code cancels.
  const mine = await sent();
  for (const code of [UPLOAD, SCREEN, 'nope']) is(await cancel(mine, code), 403, WRONG_CODE, code);
  assert.equal((await s.rows(`select status from public.drop_photos where id = '${mine}'`))[0].status, 'sending');

  // Storage fails: the row and the files stay, so cancelling again works, and so would the tidy-up.
  s.storage.failRemove = true;
  is(await cancel(mine), 502, { error: "We couldn't delete those photos. Try again.", reason: 'storage' });
  assert.deepEqual(s.logs, [`photo-drop: video ${mine} could not be cancelled: remove: HTTP 500 Internal: Internal Server Error`]);
  assert.equal((await s.rows(`select status from public.drop_photos where id = '${mine}'`))[0].status, 'sending');
  assert.equal(s.storage.paths().length, 6);
  s.storage.failRemove = false;
  is(await cancel(mine), 200, { ok: true });
  assert.equal((await s.rows()).length, 2);
  assert.equal(s.storage.paths().length, 4);

  // video-done finishes the very video that is being cancelled: its files were checked and
  // signed a moment before they were taken out. A row in the show with no files would be a
  // video that never plays, so the cancel takes the row as well.
  const raced = await sent();
  racing = (real, id) => real.videoStored(REVIEW, id, 'Eugene Aiken', true, `${BASE}/storage/v1/object/sign/photo-drop/videos/${id}.mp4?token=one`,
    `${BASE}/storage/v1/object/sign/photo-drop/thumbs/${id}.jpg?token=one`, '2026-12-03T15:00:00Z');
  is(await cancel(raced), 200, { ok: true });
  assert.equal(racing, null, 'the two did cross');
  assert.deepEqual((await s.rows('select id from public.drop_photos')).map((r) => r.id).sort(), [shown.id, photo].sort());
  assert.deepEqual(s.storage.paths().filter((p) => p.includes(raced)), []);
  assert.deepEqual((await s.post('screen', { code: SCREEN })).body.videos.map((v) => v.id), [shown.id]);
  assert.equal(s.logs.length, 1);
  assertQuietLogs(s, VIDEO_SECRETS);
});

test("an upload link takes one file, at its own path, for two hours, under the bucket's rules", async () => {
  const s = await setup();
  const clipFile = mp4(1000000);
  const start = (await s.video({ bytes: clipFile.length })).body;
  const { video: link, poster: posterLink } = start.upload;
  const token = new URL(link).searchParams.get('token');
  const invalid = { statusCode: '400', error: 'InvalidSignature', message: 'The signature is invalid' };
  const send = (url, bytes = clipFile, type = 'video/mp4') => s.put(url, bytes, type);

  // The link is for its own path and no other, and only with the token it came with.
  const elsewhere = {
    "another video's path": link.replace(start.id, NO_ROW),
    "a guest photo's path": `${BASE}/storage/v1/object/upload/sign/photo-drop/photos/${start.id}.jpg?token=${token}`,
    "the poster's token on the video's path": link.replace(token, new URL(posterLink).searchParams.get('token')),
    'a guessed token': link.replace(token, '11111111-1111-4111-8111-111111111111'),
    'no token': link.split('?')[0]
  };
  for (const [what, url] of Object.entries(elsewhere)) assert.deepEqual(await send(url), { status: 400, body: invalid }, what);
  // The bucket's rules hold for an upload by link as for any other: its types, and 50 MB a file.
  assert.equal((await send(link, clipFile, 'video/webm')).status, 415);
  assert.equal((await send(link, clipFile, 'application/octet-stream')).status, 415);
  assert.equal((await send(link, Buffer.alloc(MB50 + 1))).status, 413);
  assert.equal((await send(posterLink, Buffer.alloc(MB50 + 1), 'image/jpeg')).status, 413);
  // The link is a link to PUT to. Anything else there needs the key.
  for (const method of ['POST', 'GET', 'DELETE']) {
    const res = await s.storage.fetch(link, { method, headers: { 'Content-Type': 'video/mp4' }, body: method === 'GET' ? undefined : clipFile });
    assert.equal(res.status, 403, method);
  }
  assert.deepEqual(s.storage.paths(), [], 'none of that stored anything');

  // An upload that broke off can be sent again to the same link: the second replaces the first.
  assert.equal((await send(link, clipFile.subarray(0, 500))).status, 200);
  await s.at('2026-11-19T16:59:59Z');
  assert.equal((await send(link)).status, 200);
  assert.ok(s.storage.read(`videos/${start.id}.mp4`).equals(clipFile));
  // Two hours after it was handed out, the link has run out, and the poster's with it.
  await s.at('2026-11-19T17:00:00Z');
  assert.deepEqual(await send(link), { status: 400, body: invalid });
  assert.deepEqual(await s.put(posterLink, jpeg(480, 270), 'image/jpeg'), { status: 400, body: invalid });
  assert.deepEqual(s.storage.paths(), [`videos/${start.id}.mp4`]);
  // What arrived in time is still taken: the place is held for three hours.
  await s.at('2026-11-19T17:30:00Z');
  is(await s.review('video-done', { id: start.id, by: 'Eugene Aiken' }), 200, { ok: true, id: start.id });
  assert.deepEqual(await s.rows('select status, has_thumb, bytes from public.drop_photos'), [{ status: 'approved', has_thumb: false, bytes: 1000000 }]);

  // A file Storage refused never arrived, as far as the function can tell.
  const next = (await s.video({ bytes: MB50 })).body;
  assert.equal((await send(next.upload.video, Buffer.alloc(MB50 + 1))).status, 413);
  is(await s.review('video-done', { id: next.id, by: 'Eugene Aiken' }), 400, NOT_WHOLE);
  assert.equal((await s.rows()).length, 1);
  assert.deepEqual(s.logs, []);
});

test('the tidy-up gives a video three hours to arrive, and then takes its row and whatever of it is in the bucket', async () => {
  const s = await setup();
  // Half an upload: the poster is in, and the video never came. And one whose files both came,
  // but whose page never said so.
  const half = (await s.video()).body;
  await s.put(half.upload.poster, jpeg(480, 270), 'image/jpeg');
  const silent = (await s.video({ mime: 'video/quicktime' })).body;
  await s.put(silent.upload.poster, jpeg(480, 270), 'image/jpeg');
  await s.put(silent.upload.video, mp4(), 'video/quicktime');
  const shown = await s.clip();
  // A guest's send that died at the same moment, files and all.
  const dead = (await s.h.sql(`select cal_private.drop_reserve($1, 'Lost Upload', 'lost@example.com', null, 1600, 1200, 330000, true, '', null) as r`, [UPLOAD]))[0].r;
  s.storage.seed(dead.path, jpeg(1600, 1200));
  s.storage.seed(dead.thumb_path, jpeg(480, 360));
  const videos = async () => {
    const { settings, photos } = (await s.review('list')).body;
    return [settings.photos, settings.videos, photos.map((p) => p.id)];
  };
  assert.deepEqual(await videos(), [1, 3, [shown.id]]);
  assert.equal(s.calls('remove').length, 0);

  // Sixteen minutes on, the guest's dead send goes, as before. The videos are still expected.
  await s.at('2026-11-19T15:16:00Z');
  assert.deepEqual(await videos(), [0, 3, [shown.id]]);
  assert.deepEqual(s.calls('remove').map((c) => [...c.json.prefixes].sort()), [[dead.path, dead.thumb_path].sort()]);
  // Two hours on, when the upload links run out, they still hold their places.
  await s.at('2026-11-19T17:00:00Z');
  assert.deepEqual(await videos(), [0, 3, [shown.id]]);
  await s.at('2026-11-19T17:59:59Z');
  assert.deepEqual(await videos(), [0, 3, [shown.id]]);
  assert.equal(s.calls('remove').length, 1);
  assert.equal((await s.rows()).length, 3);
  // Three hours and a minute: both are taken, each with both its paths.
  await s.at('2026-11-19T18:01:00Z');
  assert.deepEqual(await videos(), [0, 1, [shown.id]]);
  assert.deepEqual([...s.calls('remove').at(-1).json.prefixes].sort(),
    [`videos/${half.id}.mp4`, `thumbs/${half.id}.jpg`, `videos/${silent.id}.mov`, `thumbs/${silent.id}.jpg`].sort());
  assert.deepEqual((await s.rows()).map((r) => r.id), [shown.id]);
  assert.deepEqual(s.storage.paths(), [`thumbs/${shown.id}.jpg`, `videos/${shown.id}.mp4`]);
  // Too late to finish or to cancel either of them, and neither is an error.
  is(await s.review('video-done', { id: silent.id, by: 'Eugene Aiken' }), 409, VIDEO_GONE);
  is(await s.review('video-cancel', { id: half.id }), 200, { ok: true });
  assert.deepEqual(s.logs, []);
});

test('a video is taken out of the show, put back, rejected and deleted with the actions a photo has', async () => {
  const s = await setup();
  const photo = (await s.send()).body.id;
  await s.at('2026-11-19T15:01:00Z');
  const a = await s.clip();
  await s.at('2026-11-19T15:02:00Z');
  const b = await s.clip({ poster: null, caption: '', by: 'Brother Banks' });
  const playing = async () => {
    const r = (await s.post('screen', { code: SCREEN })).body;
    return [r.photos.map((p) => p.id), r.videos.map((v) => v.id)];
  };
  // Photos and videos on the review page together, oldest first, each saying what it is.
  let list = (await s.review('list')).body;
  assert.deepEqual(list.photos.map((p) => [p.id, p.kind, p.status, p.reviewedBy]),
    [[photo, 'photo', 'waiting', null], [a.id, 'video', 'approved', 'Eugene Aiken'], [b.id, 'video', 'approved', 'Brother Banks']]);
  assert.deepEqual(list.counts, { waiting: 1, approved: 2, rejected: 0 });
  assert.deepEqual([list.settings.photos, list.settings.bytes, list.settings.videos, list.settings.videoBytes], [1, 330000, 2, 4000000]);
  assert.deepEqual(await playing(), [[], [a.id, b.id]], 'a video is in the show as soon as it has arrived');

  // Back to waiting takes a video out. Approved again, it goes to the end of the videos.
  await s.at('2026-11-19T16:00:00Z');
  is(await s.review('set', { ids: [a.id], status: 'waiting', by: 'Eugene Aiken' }), 200, { ok: true, changed: 1 });
  assert.deepEqual(await playing(), [[], [b.id]]);
  list = (await s.review('list')).body;
  assert.deepEqual(list.photos.map((p) => [p.kind, p.status, p.reviewedAt, p.reviewedBy])[1], ['video', 'waiting', null, null]);
  is(await s.review('set', { ids: [a.id, photo], status: 'approved', by: 'Someone Else' }), 200, { ok: true, changed: 2 });
  assert.deepEqual(await playing(), [[photo], [b.id, a.id]], 'the photo among the photos, the video among the videos');
  // Its caption is changed like a photo's.
  is(await s.review('caption', { id: b.id, caption: '  Probate,   2021 ' }), 200, { ok: true });
  assert.deepEqual((await s.post('screen', { code: SCREEN })).body.videos.map((v) => v.caption), ['Probate, 2021', 'Step show, 2019']);

  // An approved video can't be rejected or deleted straight off the screens.
  is(await s.review('set', { ids: [a.id], status: 'rejected' }), 200, { ok: true, changed: 0 });
  is(await s.review('delete', { ids: [a.id, b.id] }), 200, { ok: true, deleted: 0 });
  assert.equal(s.calls('remove').length, 0);
  assert.deepEqual(await playing(), [[photo], [b.id, a.id]]);
  // Back to waiting, rejected, deleted: its two files go with it, and its links open nothing.
  const [row] = await s.rows(`select url, thumb_url from public.drop_photos where id = '${a.id}'`);
  is(await s.review('set', { ids: [a.id, b.id], status: 'waiting' }), 200, { ok: true, changed: 2 });
  is(await s.review('set', { ids: [a.id, b.id], status: 'rejected', by: 'Eugene Aiken' }), 200, { ok: true, changed: 2 });
  assert.deepEqual(await playing(), [[photo], []]);
  assert.deepEqual((await s.review('list')).body.counts, { waiting: 0, approved: 1, rejected: 2 });
  is(await s.review('delete', { ids: [a.id] }), 200, { ok: true, deleted: 1 });
  assert.deepEqual([...s.calls('remove').at(-1).json.prefixes].sort(), [`thumbs/${a.id}.jpg`, `videos/${a.id}.mp4`]);
  assert.deepEqual([s.storage.fileFor(row.url), s.storage.fileFor(row.thumb_url)], [null, null]);
  // The one with no poster has one file to remove.
  is(await s.review('delete', { ids: [b.id] }), 200, { ok: true, deleted: 1 });
  assert.deepEqual(s.calls('remove').at(-1).json.prefixes, [`videos/${b.id}.mp4`]);
  assert.deepEqual(s.storage.paths(), [`photos/${photo}.jpg`, `thumbs/${photo}.jpg`]);
  assert.deepEqual((await s.review('list')).body.settings.videos, 0, 'and their places are free again');
  assert.deepEqual(s.logs, []);
});

test("Delete everything takes the videos' files with the rest, and the sweep finds a file left in the videos' folder", async () => {
  const s = await setup();
  const at = (minutes) => s.at(new Date(Date.parse(NOW) + minutes * 60000).toISOString());
  const photo = (await s.send()).body.id;
  const a = await s.clip();
  const b = await s.clip({ poster: null, mime: 'video/quicktime' });
  // One still on its way in, with both its files already there.
  const coming = (await s.video()).body;
  await s.put(coming.upload.poster, jpeg(480, 270), 'image/jpeg');
  await s.put(coming.upload.video, mp4(), 'video/mp4');
  // What an upload leaves when it lands after its row was given up: files no row points to.
  const stray = ['videos/11111111-1111-4111-8111-111111111111.mp4', 'videos/22222222-2222-4222-8222-222222222222.mov', 'thumbs/11111111-1111-4111-8111-111111111111.jpg'];
  for (const path of stray) s.storage.seed(path, mp4(1000), path.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4');
  assert.equal(s.storage.paths().length, 10);

  await at(11);
  const lists = s.calls('list').length;
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 4, swept: true });
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(s.storage.paths(), [], 'every video, poster, and leftover is out of the bucket');
  // The rows' files went first, the video on its way in included. Then each folder was looked
  // through, the videos' too, and looked through again after its leftovers were removed.
  assert.deepEqual(s.calls('list').slice(lists).map((c) => c.json.prefix), ['photos', 'thumbs', 'thumbs', 'videos', 'videos']);
  assert.deepEqual(s.calls('remove').map((c) => [...c.json.prefixes].sort()), [
    [`photos/${photo}.jpg`, `thumbs/${photo}.jpg`, `videos/${a.id}.mp4`, `thumbs/${a.id}.jpg`, `videos/${b.id}.mov`, `videos/${coming.id}.mp4`, `thumbs/${coming.id}.jpg`].sort(),
    [stray[2]], [stray[0], stray[1]]
  ]);
  assert.deepEqual((await s.post('screen', { code: SCREEN })).body, { ok: true, photos: [], videos: [] });

  // A file in the videos' folder that is under ten minutes old may be an upload arriving now:
  // it is left, and the page is told the bucket isn't clear yet.
  s.storage.seed(stray[0], mp4(1000), 'video/mp4');
  await at(20);
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 0, swept: false });
  assert.deepEqual(s.storage.paths(), [stray[0]]);
  await at(21);
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 0, swept: true });
  assert.deepEqual(s.storage.paths(), []);
  // The videos' folder can't be listed: the answer says the bucket went unchecked.
  s.storage.seed(stray[1], mp4(1000), 'video/quicktime');
  await at(40);
  s.storage.failList = /^videos$/;
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 0, swept: false });
  assert.deepEqual(s.logs, ['photo-drop: Delete everything could not check the bucket for leftover files: list: HTTP 500 Internal: Internal Server Error']);
  assert.deepEqual(s.storage.paths(), [stray[1]]);
  assertQuietLogs(s, VIDEO_SECRETS);
});

test("a video's links are renewed with the photos', and the slideshow is handed the new ones", async () => {
  const s = await setup();
  const a = await s.clip();
  await s.at('2026-11-19T15:01:00Z');
  const b = await s.clip({ poster: null });
  await s.at(NOW);
  const photo = (await s.send()).body.id;
  const showing = async () => (await s.post('screen', { code: SCREEN })).body.videos;
  const old = await showing();
  // With more than 3 days left nothing is signed again.
  const signs = s.calls('sign').length;
  await s.at('2026-11-30T14:00:00Z');
  await s.review('list');
  assert.equal(s.calls('sign').length, signs);
  assert.deepEqual(await showing(), old);
  // Inside the last 3 days every link is renewed for another 14: the video's, and its poster's.
  await s.at('2026-11-30T16:00:00Z');
  const list = (await s.review('list')).body;
  assert.equal(s.calls('sign').length, signs + 1);
  assert.deepEqual([...s.calls('sign').at(-1).json.paths].sort(),
    [`videos/${a.id}.mp4`, `thumbs/${a.id}.jpg`, `videos/${b.id}.mp4`, `photos/${photo}.jpg`, `thumbs/${photo}.jpg`].sort());
  const fresh = await showing();
  assert.deepEqual(fresh.map((v) => [v.id, v.bytes, v.seconds]), old.map((v) => [v.id, v.bytes, v.seconds]), 'the same videos, the same sizes');
  assert.notEqual(fresh[0].url, old[0].url);
  assert.notEqual(fresh[0].thumbUrl, old[0].thumbUrl);
  assert.notEqual(fresh[1].url, old[1].url);
  assert.equal(fresh[1].thumbUrl, '', 'still no poster for the second');
  assert.deepEqual(list.photos.filter((p) => p.kind === 'video').map((p) => [p.url, p.thumbUrl]), fresh.map((v) => [v.url, v.thumbUrl]));
  assert.deepEqual((await s.rows('select signed_until from public.drop_photos')).map((r) => r.signed_until.toISOString()), Array(3).fill('2026-12-14T16:00:00.000Z'));
  // The old link runs out, and the new one opens the whole file.
  await s.at('2026-12-05T00:00:00Z');
  assert.equal(s.storage.fileFor(old[0].url), null);
  assert.ok(s.storage.fileFor(fresh[0].url).equals(a.file));
  assert.equal(s.storage.fileFor(fresh[1].url).length, fresh[1].bytes);
  // A video whose file has gone from the bucket keeps the link it has, and the log counts it.
  await s.at('2026-12-11T16:00:00Z');
  s.storage.files.delete(`videos/${b.id}.mp4`);
  await s.review('list');
  const last = await showing();
  assert.notEqual(last[0].url, fresh[0].url);
  assert.equal(last[1].url, fresh[1].url);
  assert.deepEqual(s.logs, ['photo-drop: 1 photos have no file in the bucket']);
});

test("fifteen 50 MB videos in the show change nothing for a guest, and a guest's code adds no video", async () => {
  const s = await setup();
  // Their rows, without 750 MB of files: more video than the guests' photos may use in all. The
  // videos' own total is raised to let them in.
  await s.h.sql(`update cal_private.config set value = '1000000000' where key = 'drop_video_total_bytes'`);
  for (let n = 0; n < 15; n += 1) {
    const held = (await s.h.sql(`select cal_private.drop_video_reserve($1, 'Eugene Aiken', null, 1920, 1080, $2::bigint, 60, 'video/mp4') as r`, [REVIEW, MB50]))[0].r;
    const stored = (await s.h.sql(`select cal_private.drop_video_stored($1, $2::uuid, 'Eugene Aiken', false, $3, null, '2026-12-03T15:00:00Z') as r`,
      [REVIEW, held.id, `${BASE}/storage/v1/object/sign/photo-drop/${held.path}?token=one`]))[0].r;
    assert.deepEqual(stored, { ok: true, id: held.id });
  }
  assert.ok(15 * MB50 > 750000000);

  // The upload page hears open, with the limits it always had.
  is(await s.post('open', { code: UPLOAD }), 200,
    { ok: true, open: true, reason: null, closesAt: '2026-11-21T17:00:00.000Z', perPerson: 5, limits: { minEdge: 500, maxEdge: 2560, maxBytes: 6291456 } });
  // A guest's photo goes through, and is the first of her five.
  const sent = await s.send();
  is(sent, 200, { ok: true, id: sent.body.id, left: 4 });
  assert.deepEqual(s.storage.paths(), [`photos/${sent.body.id}.jpg`, `thumbs/${sent.body.id}.jpg`]);
  const { settings, counts } = (await s.review('list')).body;
  assert.deepEqual(settings, { open: true, closesAt: '2026-11-21T17:00:00.000Z', state: 'open', perPerson: 5, maxPhotos: 600, maxBytes: 750000000, photos: 1, bytes: 330000,
    videos: 15, videoBytes: 15 * MB50, maxVideos: 40, videoMaxBytes: MB50, videoTotalBytes: 1000000000 });
  assert.deepEqual(counts, { waiting: 1, approved: 15, rejected: 0 });
  const screen = (await s.post('screen', { code: SCREEN })).body;
  assert.deepEqual([screen.photos.length, screen.videos.length, screen.videos.every((v) => v.bytes === MB50 && v.seconds === 60 && v.thumbUrl === '')], [0, 15, true]);

  // The code a guest holds opens none of the three video actions, whatever comes with it.
  const [video] = await s.rows(`select id from public.drop_photos where kind = 'video' limit 1`);
  is(await s.video({}, UPLOAD), 403, WRONG_CODE);
  is(await s.review('video-done', { id: video.id, by: 'Ada Lovelace' }, UPLOAD), 403, WRONG_CODE);
  is(await s.review('video-cancel', { id: video.id }, UPLOAD), 403, WRONG_CODE);
  assert.equal((await s.rows()).length, 16);
  assert.equal(s.calls('link').length, 0);
  assert.deepEqual(s.logs, []);
});

test('the videos together have a total of their own: one that would go over is refused with nothing stored, and a deleted one gives its room back', async () => {
  const s = await setup();
  // Room for 5,000,000 bytes of video in all: 4 whole megabytes, as the refusal says it.
  await s.h.sql(`update cal_private.config set value = '5000000' where key = 'drop_video_total_bytes'`);
  const noRoom = (used) => ({ error: `That video doesn't fit. All the videos together can take 4 MB, and ${used} MB is in use. Delete one to add another.`, reason: 'full' });
  const use = async () => {
    const { settings } = (await s.review('list')).body;
    return [settings.videos, settings.videoBytes, settings.videoTotalBytes, settings.state];
  };
  const a = await s.clip({ file: mp4(2000000) });
  const b = await s.clip({ file: mp4(2000000, 0x71) });
  is(a.done, 200, { ok: true, id: a.id });
  is(b.done, 200, { ok: true, id: b.id });
  assert.deepEqual(await use(), [2, 4000000, 5000000, 'open']);

  // One byte too many: refused before Storage is asked for a link, and nothing is saved.
  const calls = s.storage.calls.length;
  let res = await s.video({ bytes: 1000001 });
  assert.deepEqual([res.status, res.body, res.headers], [409, noRoom(4), CORS]);
  assert.equal(s.storage.calls.length, calls, 'no link was asked for');
  assert.deepEqual((await s.rows('select id from public.drop_photos')).map((r) => r.id).sort(), [a.id, b.id].sort());
  assert.equal(s.storage.paths().length, 4);
  // What is left fits to the byte. On its way in, a video holds its room, and gives it back
  // when it is cancelled.
  const coming = (await s.video({ bytes: 1000000 })).body;
  assert.equal(coming.bytes, 1000000);
  assert.deepEqual(await use(), [3, 5000000, 5000000, 'open']);
  is(await s.video({ bytes: 1 }), 409, noRoom(5));
  is(await s.review('video-cancel', { id: coming.id }), 200, { ok: true });
  assert.deepEqual(await use(), [2, 4000000, 5000000, 'open']);
  // So does one that did not arrive whole.
  const short = (await s.video({ bytes: 1000000 })).body;
  await s.put(short.upload.video, mp4(999999), 'video/mp4');
  is(await s.review('video-done', { id: short.id, by: 'Eugene Aiken' }), 400, NOT_WHOLE);
  const c = await s.clip({ file: mp4(1000000, 0x72), poster: null });
  is(c.done, 200, { ok: true, id: c.id });
  assert.deepEqual(await use(), [3, 5000000, 5000000, 'open']);
  is(await s.video({ bytes: 1 }), 409, noRoom(5));

  // With the videos' room used up, a guest notices nothing: the upload page hears open, and a
  // photo goes through as the first of five.
  is(await s.post('open', { code: UPLOAD }), 200,
    { ok: true, open: true, reason: null, closesAt: '2026-11-21T17:00:00.000Z', perPerson: 5, limits: { minEdge: 500, maxEdge: 2560, maxBytes: 6291456 } });
  const sent = await s.send();
  is(sent, 200, { ok: true, id: sent.body.id, left: 4 });
  const { settings } = (await s.review('list')).body;
  assert.deepEqual([settings.state, settings.photos, settings.bytes, settings.videos, settings.videoBytes], ['open', 1, 330000, 3, 5000000]);
  is(await s.video({ bytes: 1 }), 409, noRoom(5), "a guest's photo takes none of the videos' room, and gives none");

  // A video taken out of the show still has its file, and its room. Deleted, it gives the room back.
  is(await s.review('set', { ids: [a.id], status: 'waiting' }), 200, { ok: true, changed: 1 });
  is(await s.review('set', { ids: [a.id], status: 'rejected', by: 'Eugene Aiken' }), 200, { ok: true, changed: 1 });
  is(await s.video({ bytes: 1 }), 409, noRoom(5));
  is(await s.review('delete', { ids: [a.id] }), 200, { ok: true, deleted: 1 });
  assert.deepEqual(await use(), [2, 3000000, 5000000, 'open']);
  is(await s.video({ bytes: 2000001 }), 409, noRoom(3));
  const d = await s.clip({ file: mp4(2000000, 0x73) });
  is(d.done, 200, { ok: true, id: d.id });
  assert.deepEqual(await use(), [3, 5000000, 5000000, 'open']);
  // More room is a change of the setting, and nothing else.
  await s.h.sql(`update cal_private.config set value = '300000000' where key = 'drop_video_total_bytes'`);
  assert.equal((await s.video({ bytes: MB50 })).status, 200);
  assert.deepEqual(await use(), [4, 5000000 + MB50, 300000000, 'open']);
  assert.deepEqual(s.logs, []);
});

test("deployed before the videos' migration has run, the function serves guests, organizers and the slideshow as before, and adds no video", async () => {
  const VIDEO = '20261118000400_photo_drop_video.sql';
  const earlier = readdirSync(new URL('../../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql') && f < VIDEO);
  assert.ok(earlier.includes('20261118000300_photo_drop_review_order.sql'));
  const s = await setup({ migrations: earlier });
  assert.deepEqual(await s.h.sql(`select column_name from information_schema.columns where table_name = 'drop_photos' and column_name = 'kind'`), []);

  is(await s.post('open', { code: UPLOAD }), 200,
    { ok: true, open: true, reason: null, closesAt: '2026-11-21T17:00:00.000Z', perPerson: 5, limits: { minEdge: 500, maxEdge: 2560, maxBytes: 6291456 } });
  const sent = await s.send();
  is(sent, 200, { ok: true, id: sent.body.id, left: 4 });
  // The review list says every row is a photo, and that no video can be taken.
  let list = (await s.review('list')).body;
  assert.deepEqual(list.settings, { open: true, closesAt: '2026-11-21T17:00:00.000Z', state: 'open', perPerson: 5, maxPhotos: 600, maxBytes: 750000000, photos: 1, bytes: 330000,
    videos: 0, videoBytes: 0, maxVideos: 0, videoMaxBytes: 0, videoTotalBytes: 0 });
  assert.deepEqual(list.photos.map((p) => [p.id, p.kind, p.seconds, p.mime, p.thumbUrl !== p.url]), [[sent.body.id, 'photo', null, null, true]]);
  is(await s.review('set', { ids: [sent.body.id], status: 'approved', by: 'Eugene Aiken' }), 200, { ok: true, changed: 1 });
  list = (await s.review('list')).body;
  // The slideshow gets its photos, and an empty list of videos.
  is(await s.post('screen', { code: SCREEN }), 200, { ok: true, photos: [
    { id: sent.body.id, url: list.photos[0].url, thumbUrl: list.photos[0].thumbUrl, width: 1600, height: 1200, caption: 'Howard, class of 1998' }
  ], videos: [] });

  // Adding a video has to wait for the migration. Storage is asked nothing, and nothing is saved.
  const calls = s.storage.calls.length;
  is(await s.video(), 500, { error: 'Something went wrong. Try again.' });
  is(await s.review('video-done', { id: NO_ROW, by: 'Eugene Aiken' }), 500, { error: 'Something went wrong. Try again.' });
  is(await s.review('video-cancel', { id: NO_ROW }), 500, { error: 'Something went wrong. Try again.' });
  assert.equal(s.storage.calls.length, calls);
  assert.equal(s.logs.length, 3);
  for (const line of s.logs) assert.match(line, /^photo-drop: review failed: function cal_private\.drop_video_(reserve|held)\(/);
  assertQuietLogs(s, VIDEO_SECRETS);
  assert.equal((await s.rows()).length, 1);

  // Delete everything works, and looking in the videos' folder finds nothing to mind.
  await s.at('2026-11-19T15:11:00Z');
  is(await s.review('empty', { confirm: 'DELETE' }), 200, { ok: true, deleted: 1, swept: true });
  assert.deepEqual(s.storage.paths(), []);
});

test('an unexpected failure answers in plain words and logs nothing a person typed', async () => {
  // Postgres quotes the value it could not read. That value can be anything a person sent.
  const failing = (message, more = {}) => (real) => ({
    ...real,
    open: async () => { throw Object.assign(new Error(message), more); },
    reserve: async () => { throw Object.assign(new Error(message), more); },
    reviewList: async () => { throw Object.assign(new Error(message), more); }
  });
  const s = await setup({ db: failing(`invalid input syntax for type uuid: "ada@example.com ${UPLOAD}"`, { code: '22P02' }) });
  const sorry = { error: 'Something went wrong. Try again.' };
  let res = await s.post('open', { code: UPLOAD });
  assert.deepEqual([res.status, res.body, res.headers], [500, sorry, CORS]);
  res = await s.send();
  assert.deepEqual([res.status, res.body], [500, sorry]);
  res = await s.review('list');
  assert.deepEqual([res.status, res.body], [500, sorry]);
  assert.deepEqual(s.logs, [
    'photo-drop: open failed: invalid input syntax for type uuid: (…) (code 22P02)',
    'photo-drop: send failed: invalid input syntax for type uuid: (…) (code 22P02)',
    'photo-drop: review failed: invalid input syntax for type uuid: (…) (code 22P02)'
  ]);
  assert.deepEqual(await s.rows(), []);
  assert.equal(s.storage.calls.length, 0);
  assertQuietLogs(s);

  const named = await setup({ db: failing('new row for relation "drop_photos" violates check constraint "drop_photos_name_check"', { code: '23514', constraint: 'drop_photos_name_check' }) });
  await named.post('open', { code: UPLOAD });
  assert.deepEqual(named.logs, ['photo-drop: open failed: new row for relation (…) violates check constraint (…) (code 23514, drop_photos_name_check)']);
});

test("the Storage stand-in keeps the rules of the real one: the key, the bucket's types and 50 MB, links that run out, and a folder listed by name", async () => {
  const clock = { t: Date.parse(NOW) };
  const storage = new Storage({ url: BASE, key: KEY, now: () => clock.t });
  const call = async (method, path, { key = KEY, headers = {}, body = undefined } = {}) => {
    const res = await storage.fetch(`${BASE}/storage/v1${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers }, body });
    return [res.status, await res.json()];
  };
  const jpegType = { 'Content-Type': 'image/jpeg' };
  const photo = jpeg(1600, 1200);

  // The secret key, on both headers.
  assert.equal((await call('POST', '/object/photo-drop/photos/a.jpg', { key: 'sb_secret_wrong', headers: jpegType, body: photo }))[0], 403);
  const half = await storage.fetch(`${BASE}/storage/v1/object/photo-drop/photos/a.jpg`, { method: 'POST', headers: { apikey: KEY, ...jpegType }, body: photo });
  assert.equal(half.status, 403);
  // The bucket's own rules. Storage goes by the stated type.
  assert.equal((await call('POST', '/object/photo-drop/photos/a.jpg', { headers: { 'Content-Type': 'image/png' }, body: photo }))[0], 415);
  assert.equal((await call('POST', '/object/photo-drop/photos/a.jpg', { body: photo }))[0], 415);
  assert.equal((await call('POST', '/object/photo-drop/photos/a.jpg', { headers: jpegType, body: Buffer.alloc(52428801) }))[0], 413);
  assert.equal((await call('POST', '/object/calendar-files/photos/a.jpg', { headers: jpegType, body: photo }))[0], 404);
  assert.deepEqual(storage.paths(), []);
  assert.equal(storage.read('photos/a.jpg'), null);

  const put = await call('POST', '/object/photo-drop/photos/a.jpg', { headers: jpegType, body: new Uint8Array(photo) });
  assert.deepEqual([put[0], put[1].Key], [200, 'photo-drop/photos/a.jpg']);
  assert.ok(storage.read('photos/a.jpg').equals(photo));
  // A second put to the same path needs x-upsert.
  assert.equal((await call('POST', '/object/photo-drop/photos/a.jpg', { headers: jpegType, body: photo }))[0], 409);
  assert.equal((await call('POST', '/object/photo-drop/photos/a.jpg', { headers: { ...jpegType, 'x-upsert': 'true' }, body: photo }))[0], 200);

  // Signed links: relative, one for each file that exists, good until they run out.
  const json = { 'Content-Type': 'application/json' };
  const [status, links] = await call('POST', '/object/sign/photo-drop', { headers: json, body: JSON.stringify({ expiresIn: 3600, paths: ['photos/a.jpg', 'photos/missing.jpg'] }) });
  assert.equal(status, 200);
  assert.match(links[0].signedURL, /^\/object\/sign\/photo-drop\/photos\/a\.jpg\?token=[0-9a-f-]{36}$/);
  assert.deepEqual(links[1], { error: 'Either the object does not exist or you do not have access to it', path: 'photos/missing.jpg', signedURL: null });
  assert.ok(storage.fileFor(links[0].signedURL).equals(photo), 'the part Storage answers with');
  assert.ok(storage.fileFor(`${BASE}/storage/v1${links[0].signedURL}`).equals(photo), 'or the full link');
  assert.equal(storage.fileFor(links[0].signedURL.replace('a.jpg', 'b.jpg')), null, 'a link is for one file');
  assert.equal(storage.fileFor(`${BASE}/storage/v1/object/sign/photo-drop/photos/a.jpg?token=guess`), null);
  assert.equal(storage.fileFor(`${BASE}/storage/v1/object/sign/photo-drop/photos/a.jpg`), null);
  assert.equal(storage.fileFor('not a link'), null);
  clock.t += 3600 * 1000;
  assert.equal(storage.fileFor(links[0].signedURL), null, 'run out');
  for (const bad of [{ paths: ['photos/a.jpg'] }, { expiresIn: 0, paths: ['photos/a.jpg'] }, { expiresIn: 60, paths: [] }, { expiresIn: 60, paths: 'photos/a.jpg' }]) {
    assert.equal((await call('POST', '/object/sign/photo-drop', { headers: json, body: JSON.stringify(bad) }))[0], 400);
  }

  // Remove answers with the files that were there, and a missing one is not an error.
  const removed = await call('DELETE', '/object/photo-drop', { headers: json, body: JSON.stringify({ prefixes: ['photos/a.jpg', 'photos/missing.jpg'] }) });
  assert.deepEqual(removed, [200, [{ name: 'photos/a.jpg', bucket_id: 'photo-drop' }]]);
  assert.deepEqual(storage.paths(), []);
  assert.equal((await call('DELETE', '/object/photo-drop', { headers: json, body: JSON.stringify({ prefixes: [] }) }))[0], 400);

  // List answers with the files directly in one folder, by name.
  for (const path of ['photos/b.jpg', 'photos/a.jpg', 'photos/inside/c.jpg', 'thumbs/a.jpg']) storage.seed(path, photo);
  const list = (bucket, body) => call('POST', `/object/list/${bucket}`, { headers: json, body: JSON.stringify(body) });
  const listed = await list('photo-drop', { prefix: 'photos', limit: 1000, offset: 0 });
  assert.deepEqual([listed[0], listed[1].map((f) => f.name)], [200, ['a.jpg', 'b.jpg']]);
  // Each file comes with an id, and with when it was put there.
  for (const f of listed[1]) assert.deepEqual([/^[0-9a-f-]{36}$/.test(f.id), f.created_at], [true, new Date(clock.t).toISOString()]);
  assert.deepEqual((await list('photo-drop', { prefix: 'photos/', limit: 1, offset: 1 }))[1].map((f) => f.name), ['b.jpg']);
  assert.deepEqual(await list('photo-drop', { prefix: 'nowhere' }), [200, []]);
  assert.equal((await list('photo-drop', { limit: 1000 }))[0], 400);
  assert.equal((await list('calendar-files', { prefix: 'photos' }))[0], 404);
  storage.failList = /^thumbs$/;
  assert.equal((await list('photo-drop', { prefix: 'thumbs' }))[0], 500);
  assert.equal((await list('photo-drop', { prefix: 'photos' }))[0], 200);
  storage.files.clear();

  // The switches.
  storage.seed('photos/b.jpg', photo);
  storage.failRemove = /^photos\//;
  assert.equal((await call('DELETE', '/object/photo-drop', { headers: json, body: JSON.stringify({ prefixes: ['photos/b.jpg'] }) }))[0], 500);
  storage.failSign = true;
  assert.equal((await call('POST', '/object/sign/photo-drop', { headers: json, body: JSON.stringify({ expiresIn: 60, paths: ['photos/b.jpg'] }) }))[0], 500);
  storage.failPut = /^thumbs\//;
  assert.equal((await call('POST', '/object/photo-drop/thumbs/b.jpg', { headers: jpegType, body: photo }))[0], 500);
  assert.equal((await call('POST', '/object/photo-drop/photos/c.jpg', { headers: jpegType, body: photo }))[0], 200);
  storage.down = true;
  await assert.rejects(() => call('DELETE', '/object/photo-drop', { headers: json, body: '{}' }), /fetch failed/);
  assert.deepEqual(storage.paths(), ['photos/b.jpg', 'photos/c.jpg']);
  assert.equal(storage.calls.length, 28, 'every call is recorded, whatever became of it');
});

test('the Storage stand-in hands out an upload link for the key, takes one file at it without the key, and lists a file with its size and type', async () => {
  const clock = { t: Date.parse(NOW) };
  const storage = new Storage({ url: BASE, key: KEY, now: () => clock.t });
  const call = async (method, path, { key = KEY, headers = {}, body = undefined } = {}) => {
    const res = await storage.fetch(`${BASE}/storage/v1${path}`, { method, headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers }, body });
    return [res.status, await res.json()];
  };
  // A browser's upload: the link as Storage answered it, and no key.
  const upload = async (link, body, headers = { 'Content-Type': 'video/mp4' }) => {
    const res = await storage.fetch(`${BASE}/storage/v1${link}`, { method: 'PUT', headers, body });
    return [res.status, await res.json()];
  };
  const json = { 'Content-Type': 'application/json' };
  const clipFile = mp4(50000);
  const invalid = { statusCode: '400', error: 'InvalidSignature', message: 'The signature is invalid' };

  // The link is handed out for the secret key only, in the bucket that is there, for a path.
  const ask = (path, options = {}) => call('POST', `/object/upload/sign/${path}`, { headers: { ...json, 'x-upsert': 'true' }, body: '{}', ...options });
  assert.equal((await ask('photo-drop/videos/a.mp4', { key: 'sb_secret_wrong' }))[0], 403);
  assert.equal((await ask('calendar-files/videos/a.mp4'))[0], 404);
  assert.equal((await ask('photo-drop/'))[0], 400);
  assert.equal(storage.uploads.size, 0);
  const [status, made] = await ask('photo-drop/videos/a.mp4');
  assert.equal(status, 200);
  // The answer is the link less the project's address, as Storage gives it.
  assert.deepEqual(Object.keys(made), ['url']);
  assert.match(made.url, /^\/object\/upload\/sign\/photo-drop\/videos\/a\.mp4\?token=[0-9a-f-]{36}$/);
  // Asking for a link stores nothing, and a file doesn't have to be there.
  assert.deepEqual(storage.paths(), []);

  // The upload carries no key, and the link is all it needs. With a key it is no different.
  assert.deepEqual(await upload(made.url, clipFile), [200, { Key: 'photo-drop/videos/a.mp4' }]);
  assert.ok(storage.read('videos/a.mp4').equals(clipFile));
  assert.deepEqual([storage.files.get('videos/a.mp4').type, storage.files.get('videos/a.mp4').cacheControl], ['video/mp4', 'no-cache']);
  assert.equal((await upload(made.url, clipFile, { 'Content-Type': 'video/mp4', 'cache-control': 'max-age=31536000', apikey: 'sb_secret_wrong', Authorization: 'Bearer sb_secret_wrong' }))[0], 200);
  assert.equal(storage.files.get('videos/a.mp4').cacheControl, 'max-age=31536000');
  // A link is for one path in one bucket, and its token is not a signed link's.
  assert.deepEqual(await upload(made.url.replace('a.mp4', 'b.mp4'), clipFile), [400, invalid]);
  assert.equal((await upload(made.url.replace('photo-drop', 'calendar-files'), clipFile))[0], 404);
  assert.deepEqual(await upload('/object/upload/sign/photo-drop/videos/a.mp4', clipFile), [400, invalid]);
  const [, links] = await call('POST', '/object/sign/photo-drop', { headers: json, body: JSON.stringify({ expiresIn: 3600, paths: ['videos/a.mp4'] }) });
  assert.deepEqual(await upload(links[0].signedURL.replace('/object/sign/', '/object/upload/sign/'), clipFile), [400, invalid]);
  assert.equal(storage.fileFor(made.url.replace('/object/upload/sign/', '/object/sign/')), null, "and an upload link's token opens no file");

  // Whether a second upload may replace the first was settled when the link was asked for, not
  // by what the upload says.
  const [, once] = await call('POST', '/object/upload/sign/photo-drop/videos/once.mp4', { headers: json, body: '{}' });
  assert.equal((await upload(once.url, clipFile))[0], 200);
  assert.equal((await upload(once.url, clipFile, { 'Content-Type': 'video/mp4', 'x-upsert': 'true' }))[0], 409);
  // The bucket's rules, and the two hours.
  const [, other] = await ask('photo-drop/videos/c.mov');
  assert.equal((await upload(other.url, clipFile, { 'Content-Type': 'video/webm' }))[0], 415);
  assert.equal((await upload(other.url, clipFile, {}))[0], 415);
  assert.equal((await upload(other.url, Buffer.alloc(52428801), { 'Content-Type': 'video/quicktime' }))[0], 413);
  clock.t += 2 * 3600000 - 1;
  assert.equal((await upload(other.url, clipFile, { 'Content-Type': 'video/quicktime' }))[0], 200);
  clock.t += 1;
  assert.deepEqual(await upload(other.url, clipFile, { 'Content-Type': 'video/quicktime' }), [400, invalid], 'run out');
  assert.deepEqual(storage.paths(), ['videos/a.mp4', 'videos/c.mov', 'videos/once.mp4']);

  // A listed file comes with its size and the type it was stored with. search keeps the names
  // that have it in them.
  storage.seed('videos/A-poster.JPG', jpeg(480, 270, { bytes: 20000 }));
  const list = async (body) => (await call('POST', '/object/list/photo-drop', { headers: json, body: JSON.stringify({ limit: 100, offset: 0, ...body }) }))[1].map((f) => [f.name, f.metadata]);
  assert.deepEqual(await list({ prefix: 'videos' }), [
    ['A-poster.JPG', { size: 20000, mimetype: 'image/jpeg' }], ['a.mp4', { size: 50000, mimetype: 'video/mp4' }],
    ['c.mov', { size: 50000, mimetype: 'video/quicktime' }], ['once.mp4', { size: 50000, mimetype: 'video/mp4' }]
  ]);
  assert.deepEqual(await list({ prefix: 'videos', search: 'a.mp4' }), [['a.mp4', { size: 50000, mimetype: 'video/mp4' }]]);
  assert.deepEqual((await list({ prefix: 'videos', search: '.mp4' })).map(([name]) => name), ['a.mp4', 'once.mp4']);
  assert.deepEqual((await list({ prefix: 'videos', search: 'A' })).map(([name]) => name), ['A-poster.JPG', 'a.mp4'], 'whatever the case');
  assert.deepEqual(await list({ prefix: 'videos', search: 'b.mp4' }), []);
  assert.deepEqual((await list({ prefix: 'videos', search: '' })).length, 4);
  assert.deepEqual((await list({ prefix: 'videos', search: 7 })).length, 4, 'a search that is not text is no search');

  // The switches: for handing out a link, and for an upload to one.
  storage.failUploadLink = /^thumbs\//;
  assert.equal((await ask('photo-drop/thumbs/a.jpg'))[0], 500);
  // The first link ran out when the clock moved, so the uploads below go to a new one.
  const [fine, again] = await ask('photo-drop/videos/d.mp4');
  assert.equal(fine, 200);
  storage.failUploadLink = true;
  assert.equal((await ask('photo-drop/videos/d.mp4'))[0], 500);
  storage.failUpload = /^videos\/d/;
  assert.equal((await upload(again.url, clipFile))[0], 500);
  storage.failUpload = false;
  // An upload on a slow connection: the answer is held back. One cut off in the meantime (the
  // browser gave up) stores nothing.
  storage.slowUpload = 30;
  const cut = new AbortController();
  const going = storage.fetch(`${BASE}/storage/v1${again.url}`, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: clipFile, signal: cut.signal });
  cut.abort();
  await assert.rejects(() => going, { name: 'AbortError' });
  assert.equal(storage.read('videos/d.mp4'), null);
  const began = Date.now();
  assert.equal((await upload(again.url, clipFile))[0], 200);
  assert.ok(Date.now() - began >= 25, 'held back');
  assert.ok(storage.read('videos/d.mp4').equals(clipFile));
  storage.slowUpload = 0;
  storage.down = true;
  await assert.rejects(() => upload(again.url, clipFile), /fetch failed/);
  assert.deepEqual(storage.paths(), ['videos/A-poster.JPG', 'videos/a.mp4', 'videos/c.mov', 'videos/d.mp4', 'videos/once.mp4']);
  assert.equal(storage.calls.filter((c) => kindOf(c) === 'link').length, 9);
  assert.equal(storage.calls.filter((c) => kindOf(c) === 'upload').length, 17, 'every call is recorded, whatever became of it');
});

test('the size of a JPEG is read from its frame header, and anything odd is not a photo', () => {
  assert.deepEqual(jpegSize(jpeg(1600, 1200)), { width: 1600, height: 1200 });
  assert.deepEqual(jpegSize(new Uint8Array(jpeg(1200, 1600))), { width: 1200, height: 1600 }, 'a plain byte array, as the function has it');
  assert.deepEqual(jpegSize(jpeg(65535, 1)), { width: 65535, height: 1 });
  assert.deepEqual(jpegSize(jpeg(2560, 1707, { frame: 0xc1 })), { width: 2560, height: 1707 }, 'extended');
  assert.deepEqual(jpegSize(jpeg(2560, 1707, { frame: 0xc2 })), { width: 2560, height: 1707 }, 'progressive');
  assert.deepEqual(jpegSize(jpeg(4032, 3024, { exif: true })), { width: 4032, height: 3024 }, "not the 160 by 120 of the camera's own thumbnail");
  // A real one: the event flyer.
  assert.deepEqual(jpegSize(readFileSync(new URL('../../assets/photo-drop/school-daze-flyer.jpg', import.meta.url))), { width: 1080, height: 1440 });

  // Fill bytes before a marker, and markers that stand alone with no length after them.
  assert.deepEqual(jpegSize(jpeg(800, 600, { before: [0xff, 0xff, 0xff] })), { width: 800, height: 600 });
  assert.deepEqual(jpegSize(jpeg(800, 600, { before: [0xff, 0xd0, 0xff, 0xd7, 0xff, 0x01, 0xff, 0xd8] })), { width: 800, height: 600 });
  // Tables whose markers sit among the frame markers: Huffman (C4) and arithmetic conditioning (CC).
  assert.deepEqual(jpegSize(jpeg(800, 600, { before: [0xff, 0xc4, 0, 4, 9, 9, 0xff, 0xcc, 0, 3, 9] })), { width: 800, height: 600 });

  // Not JPEGs.
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xd8, 0xff]), PNG, Buffer.from('GIF89a'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.alloc(5000)]) {
    assert.equal(jpegSize(bytes), null);
  }
  // JPEGs browsers don't show, or with a frame header that doesn't add up.
  for (const frame of [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) assert.equal(jpegSize(jpeg(800, 600, { frame })), null, frame.toString(16));
  assert.equal(jpegSize(jpeg(800, 600, { precision: 12 })), null, '12 bits a sample');
  assert.equal(jpegSize(jpeg(0, 600)), null);
  assert.equal(jpegSize(jpeg(800, 0)), null);
  const good = jpeg(800, 600);
  const at = good.indexOf(Buffer.from([0xff, 0xc0]));
  const changed = (offset, value) => {
    const copy = Buffer.from(good);
    copy[at + offset] = value;
    return copy;
  };
  assert.equal(jpegSize(changed(3, 16)), null, 'a length that disagrees with the number of colour parts');
  assert.equal(jpegSize(changed(9, 2)), null, 'two colour parts');
  assert.equal(jpegSize(changed(2, 0xff)), null, 'a length running past the end of the file');
  assert.equal(jpegSize(changed(3, 1)), null, 'a length too short to be one');
  // Out of order: picture data, the end of the file, or stray bytes before any frame header.
  assert.equal(jpegSize(jpeg(800, 600, { before: [0xff, 0xda, 0, 2] })), null);
  assert.equal(jpegSize(jpeg(800, 600, { before: [0xff, 0xd9] })), null);
  assert.equal(jpegSize(jpeg(800, 600, { before: [0xff, 0x00] })), null);
  assert.equal(jpegSize(jpeg(800, 600, { before: [0x00, 0x00] })), null);
  assert.equal(jpegSize(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(3000, 0xff)])), null, 'fill bytes to the end');

  // Cut off anywhere, it never reads past the end: nothing until the whole frame header is there.
  const whole = jpeg(1600, 1200, { exif: true });
  const headerEnd = whole.indexOf(Buffer.from([0xff, 0xda]));
  for (let n = 0; n <= headerEnd + 4; n += 1) {
    const size = jpegSize(whole.subarray(0, n));
    assert.deepEqual(size, n >= headerEnd ? { width: 1600, height: 1200 } : null, `cut at ${n} of ${headerEnd}`);
  }
  // And bytes changed at random never make it throw.
  let seed = 1906;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 20000; i += 1) {
    const copy = Buffer.from(whole.subarray(0, headerEnd + 16));
    for (let k = 0; k < 3; k += 1) copy[Math.floor(random() * copy.length)] = Math.floor(random() * 256);
    const size = jpegSize(copy);
    assert.ok(size === null || (Number.isInteger(size.width) && size.width > 0 && Number.isInteger(size.height) && size.height > 0));
  }
});

test('every request is read to its end before it is answered, even one too large to use', async () => {
  const s = await setup();
  // A body that arrives in pieces, with a count of how much of it was taken.
  const stream = (total, piece = 65536) => {
    const seen = { bytes: 0, closed: false };
    let left = total;
    const body = new ReadableStream({
      pull(controller) {
        if (left <= 0) {
          seen.closed = true;
          return controller.close();
        }
        const n = Math.min(piece, left);
        left -= n;
        seen.bytes += n;
        controller.enqueue(new Uint8Array(n).fill(0x41));
      }
    });
    return { body, seen };
  };
  const ask = async (route, total, headers = {}) => {
    const { body, seen } = stream(total);
    const res = await s.answer(await s.handler(new Request(`${FN}/${route}`, { method: 'POST', body, headers, duplex: 'half' })));
    return { ...res, seen };
  };

  // An address that isn't one of ours, with 300 KB behind it.
  const stray = await ask('nothing', 300000);
  assert.equal(stray.status, 404);
  assert.deepEqual([stray.seen.bytes, stray.seen.closed], [300000, true]);

  // JSON far past the limit: refused, and read all the same.
  const long = await ask('open', 400000, { 'content-type': 'text/plain;charset=UTF-8' });
  assert.equal(long.status, 413);
  assert.deepEqual([long.seen.bytes, long.seen.closed], [400000, true]);

  // A form that says it is too large, and one that doesn't say and turns out to be.
  const type = { 'content-type': 'multipart/form-data; boundary=x' };
  const said = await ask('send', MAX_REQUEST_BYTES + 100000, { ...type, 'content-length': String(MAX_REQUEST_BYTES + 100000) });
  assert.deepEqual([said.status, said.body.reason, said.seen.bytes, said.seen.closed], [413, 'size', MAX_REQUEST_BYTES + 100000, true]);
  const unsaid = await ask('send', MAX_REQUEST_BYTES + 100000, type);
  assert.deepEqual([unsaid.status, unsaid.body.reason, unsaid.seen.bytes, unsaid.seen.closed], [413, 'size', MAX_REQUEST_BYTES + 100000, true]);

  // Not a form at all: refused once the whole of it has arrived.
  const plain = await ask('send', 200000, { 'content-type': 'application/octet-stream' });
  assert.deepEqual([plain.status, plain.seen.bytes, plain.seen.closed], [400, 200000, true]);

  // Without end is not read without end.
  const endless = await ask('nothing', DRAIN_MAX + 5000000);
  assert.equal(endless.status, 404);
  assert.ok(endless.seen.bytes > DRAIN_MAX && endless.seen.bytes < DRAIN_MAX + 5000000 && !endless.seen.closed);

  assert.equal((await s.rows()).length, 0);
  assert.equal(s.storage.calls.length, 0);
});
