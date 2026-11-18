// The photo-drop Edge Function (supabase/functions/photo-drop/drop.js), run in Node against the
// real migrations in PGlite, with Storage simulated (storage-sim.mjs). Covers what the three
// School Daze pages ask of it: opening the upload page, sending a photo and every way that is
// refused, a photo sent twice, a Storage failure partway, the organizers' review actions, the
// slideshow's list, and what never reaches the log.
// Run with the other database tests: node --test "tests/calendar/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

async function setup({ now = NOW, env = ENV, db = (real) => real } = {}) {
  const h = await createDb({ codes: false });
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
    fetch: storage.fetch,
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
  return {
    h, storage, logs, handler, post, send, answer,
    at: async (iso) => {
      clock.t = Date.parse(iso);
      await h.setNow(iso);
    },
    review: (action, more = {}, code = REVIEW) => post('review', { ...more, code, action }),
    rows: (sql = 'select * from public.drop_photos order by created_at, id') => h.sql(sql),
    // Storage calls by kind: put, sign, list, or remove.
    calls: (kind) => storage.calls.filter((c) => {
      if (c.method !== 'POST') return kind === 'remove' && c.method === 'DELETE';
      if (c.path.includes('/object/sign/')) return kind === 'sign';
      return kind === (c.path.includes('/object/list/') ? 'list' : 'put');
    })
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
    stored_at: '2026-11-19T15:00:00.000Z', reviewed_at: null, reviewed_by: null
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

  // Storage refuses the bucket's own rules: a wrong key, then a file over the bucket's 8 MB.
  s.storage.key = 'sb_secret_another';
  res = await s.send(same);
  assert.deepEqual([res.status, res.body], [502, failed]);
  assert.match(s.logs[2], /was not saved: put: HTTP 403 Unauthorized/);
  s.storage.key = KEY;
  s.storage.maxBytes = 1000;
  res = await s.send(same);
  assert.deepEqual([res.status, res.body], [502, failed]);
  assert.match(s.logs[3], /was not saved: put: HTTP 413 Payload too large/);
  s.storage.maxBytes = 8388608;
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
    settings: { open: true, closesAt: '2026-11-21T17:00:00.000Z', state: 'open', perPerson: 5, maxPhotos: 600, maxBytes: 750000000, photos: 3, bytes: 960000 },
    counts: { waiting: 2, approved: 0, rejected: 0 },
    photos: [
      { id: first, status: 'waiting', name: 'Ada Lovelace', email: 'ada@example.com', caption: 'Howard, class of 1998', width: 1600, height: 1200, bytes: 330000,
        original: { name: 'IMG_0042.HEIC', width: 4032, height: 3024, bytes: 2310456, type: 'image/heic' },
        createdAt: '2026-11-19T15:00:00.000Z', reviewedAt: null, reviewedBy: null, url: row.url, thumbUrl: row.thumb_url },
      { id: second, status: 'waiting', name: 'Grace Hopper', email: 'grace@example.com', caption: null, width: 1600, height: 1200, bytes: 300000,
        original: { name: 'IMG_0042.HEIC', width: 4032, height: 3024, bytes: 2310456, type: 'image/heic' },
        createdAt: '2026-11-19T15:01:00.000Z', reviewedAt: null, reviewedBy: null, url: res.body.photos[1].url, thumbUrl: res.body.photos[1].url }
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
  const settings = { open: true, closesAt: '2026-11-21T17:00:00.000Z', state: 'open', perPerson: 5, maxPhotos: 600, maxBytes: 750000000, photos: 3, bytes: 990000 };
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
  assert.deepEqual(s.calls('list').map((c) => `${c.method} ${c.path} ${c.json.prefix}`), ['photos', 'photos', 'thumbs', 'thumbs'].map((folder) => `POST /storage/v1/object/list/photo-drop ${folder}`));
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
  assert.deepEqual(s.calls('list').slice(before.list).map((c) => c.json.prefix), ['photos', 'thumbs', 'thumbs', 'thumbs']);
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
  assert.deepEqual(s.calls('list').map((c) => c.json.prefix), ['photos', 'thumbs'], 'it looked, and found nothing old enough');
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

  assert.deepEqual((await s.post('screen', { code: SCREEN })).body, { ok: true, photos: [] }, 'nothing is approved yet');
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
  ] });
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
  assert.deepEqual((await s.post('screen', { code: SCREEN })).body, { ok: true, photos: [] });
  assert.deepEqual(s.logs, []);
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

test('the Storage stand-in keeps the rules of the real one: the key, JPEG only, 8 MB, links that run out, and a folder listed by name', async () => {
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
  assert.equal((await call('POST', '/object/photo-drop/photos/a.jpg', { headers: jpegType, body: Buffer.alloc(8388609) }))[0], 413);
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
