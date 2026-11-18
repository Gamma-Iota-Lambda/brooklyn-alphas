// School Daze photo drop, the database side (supabase/migrations/20261118000100_photo_drop.sql and
// 20261118000200_photo_drop_repeats.sql) on real Postgres (PGlite): the three codes, every reason a
// photo is refused and the order they come in, a photo sent twice, the limits, closing, review, the
// slideshow list, and that no API role gets near any of it.
// The Edge Function that calls these is tested in photo-drop-function.test.mjs.
//   node --test "tests/calendar/photo-drop.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

// Two days before the party. Uploads close at noon New York time on Saturday, Nov. 21.
const NOW = '2026-11-19T15:00:00Z';
const UPLOAD = 'Daze-2026-BK';
const REVIEW = 'organizers only review phrase';
const SCREEN = 'venue screen phrase 21';

const WRONG_LINK = "That link isn't right. Use the link in your School Daze email.";
const WRONG_CODE = "That code isn't right.";

async function ready({ codes = true } = {}) {
  const h = await createDb({ codes: false });
  await h.setNow(NOW);
  if (codes) {
    await h.sql(`select cal_private.drop_set_code('upload', $1)`, [UPLOAD]);
    await h.sql(`select cal_private.drop_set_code('review', $1)`, [REVIEW]);
    await h.sql(`select cal_private.drop_set_code('screen', $1)`, [SCREEN]);
  }
  return h;
}

// Calls a cal_private function as the database owner, the way the Edge Function does.
const run = async (h, call, params = []) => (await h.sql(`select cal_private.${call} as r`, params))[0].r;
const ids = (list) => (list ? `{${list.join(',')}}` : null);
const setting = (h, key, value) =>
  h.sql(`insert into cal_private.config (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value`, [key, value]);
const rows = (h, sql = 'select * from public.drop_photos order by created_at, id') => h.sql(sql);
const minutes = (n) => new Date(Date.parse(NOW) + n * 60000).toISOString();

// A photo's fingerprint, as the Edge Function works it out from the bytes: 64 hex characters.
// print('a') is one a test can send again. Left alone, each reserve gets a fingerprint of its
// own, the way each photo has.
let prints = 0;
const print = (letter) => letter.repeat(64);
const reserve = (h, over = {}) => {
  const p = { code: UPLOAD, name: 'Ada Lovelace', email: 'ada@example.com', caption: null, width: 2560, height: 1707,
    bytes: 1500000, thumb: true, ip: '203.0.113.9', original: null, sha: (prints += 1).toString(16).padStart(64, '0'), ...over };
  return run(h, `drop_reserve($1, $2, $3, $4, $5::integer, $6::integer, $7::integer, ($8::text)::boolean, $9, ($10::text)::jsonb, $11)`,
    [p.code, p.name, p.email, p.caption, p.width, p.height, p.bytes, p.thumb === null ? null : String(p.thumb), p.ip,
      p.original === null ? null : JSON.stringify(p.original), p.sha]);
};
const stored = (h, r, until = '2026-12-03T15:00:00Z') =>
  run(h, `drop_stored($1::uuid, $2, $3, ($4::text)::timestamptz)`,
    [r.id, `https://files.example/${r.path}?token=one`, r.thumb_path ? `https://files.example/${r.thumb_path}?token=one` : null, until]);

// A photo that has finished arriving and waits for review. Returns its id.
async function photo(h, over = {}) {
  const r = await reserve(h, over);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await stored(h, r), true);
  return r.id;
}
const set = (h, list, status, by = 'Eugene Aiken', code = REVIEW) =>
  run(h, `drop_review_set($1, ($2::text)::uuid[], $3, $4)`, [code, ids(list), status, by]);

test('each page has its own code, compared without regard to case or extra spaces', async () => {
  const h = await ready({ codes: false });
  // Before the codes are set nothing gets in, an empty code included.
  for (const code of ['', ' ', null, UPLOAD]) {
    assert.equal(await run(h, 'drop_code_ok($1, $2)', ['upload', code]), false);
  }
  assert.deepEqual(await run(h, 'drop_open($1)', [UPLOAD]), { ok: false, status: 403, reason: 'code', error: WRONG_LINK });

  const setCode = (kind, code) => h.sql('select cal_private.drop_set_code($1, $2)', [kind, code]);
  await assert.rejects(() => setCode('media', 'long enough for anything'), /Choose the upload code, the review code, or the screen code/);
  await assert.rejects(() => setCode(null, 'long enough for anything'), /Choose the upload code/);
  await assert.rejects(() => setCode('upload', 'REPLACE WITH THE CODE FOR THE EMAIL LINK'), /Replace the placeholder/);
  await assert.rejects(() => setCode('upload', 'daze-26'), /upload code of at least 8 characters/);
  await assert.rejects(() => setCode('review', 'eleven char'), /review code of at least 12 characters/);
  await assert.rejects(() => setCode('screen', 'eleven char'), /screen code of at least 12 characters/);
  await assert.rejects(() => setCode('upload', 'school daze 2026'), /only letters, numbers, and dashes/);
  await assert.rejects(() => setCode('upload', 'daze&k=2026'), /only letters, numbers, and dashes/);
  await assert.rejects(() => setCode('review', 'x'.repeat(73)), /72 characters or fewer/);

  await setCode('upload', UPLOAD);
  await setCode('review', REVIEW);
  await setCode('screen', SCREEN);
  // One code can't do two jobs: every ticket buyer has the upload code.
  await assert.rejects(() => setCode('review', 'DAZE-2026-bk'), /already the upload code/);
  await assert.rejects(() => setCode('screen', `  ${REVIEW.toUpperCase()} `), /already the review code/);

  const hashes = await h.sql(`select key, value from cal_private.config where key like 'drop\\_%\\_code\\_hash' order by key`);
  assert.deepEqual(hashes.map((r) => r.key), ['drop_review_code_hash', 'drop_screen_code_hash', 'drop_upload_code_hash']);
  for (const r of hashes) assert.match(r.value, /^\$2a\$08\$/, 'kept as a bcrypt hash, never the code');

  assert.equal(await run(h, 'drop_code_ok($1, $2)', ['upload', '  daze-2026-bk ']), true);
  assert.equal(await run(h, 'drop_code_ok($1, $2)', ['review', 'Organizers  ONLY review   phrase']), true);
  assert.equal(await run(h, 'drop_code_ok($1, $2)', ['upload', REVIEW]), false);
  assert.equal(await run(h, 'drop_code_ok($1, $2)', ['review', UPLOAD]), false);
  assert.equal(await run(h, 'drop_code_ok($1, $2)', ['screen', REVIEW]), false);
  assert.equal(await run(h, 'drop_code_ok($1, $2)', ['chapter', UPLOAD]), false, 'only the three kinds');
  assert.equal(await run(h, 'drop_code_ok($1, $2)', [null, UPLOAD]), false);

  // Each function asks for its own code and answers a wrong one the same way, without raising.
  const no = { ok: false, status: 403, reason: 'code', error: WRONG_CODE };
  for (const code of [UPLOAD, SCREEN, 'nope', '', null]) {
    assert.deepEqual(await run(h, 'drop_review_list($1)', [code]), no);
    assert.deepEqual(await set(h, ['00000000-0000-4000-8000-000000000000'], 'approved', 'x', code), no);
    assert.deepEqual(await run(h, 'drop_review_caption($1, $2::uuid, $3)', [code, '00000000-0000-4000-8000-000000000000', 'x']), no);
    assert.deepEqual(await run(h, `drop_review_settings($1, '{"open": false}'::jsonb)`, [code]), no);
    assert.deepEqual(await run(h, 'drop_review_paths($1, null)', [code]), no);
    assert.deepEqual(await run(h, 'drop_review_delete($1, null)', [code]), no);
  }
  assert.equal((await run(h, 'drop_state()')).open, true, 'a wrong code changed nothing');
  // The slideshow takes the screen code and no other. The review code must never be left on the
  // venue's computer, so it opens nothing there.
  for (const code of [UPLOAD, REVIEW, ` ${REVIEW.toUpperCase()} `, 'nope', '', null]) {
    assert.deepEqual(await run(h, 'drop_screen_list($1)', [code]), no, String(code));
  }
  assert.equal((await run(h, 'drop_screen_list($1)', [SCREEN])).ok, true);

  // Changing a code turns the old one off at once.
  await setCode('upload', 'daze-2026-new');
  assert.equal(await run(h, 'drop_code_ok($1, $2)', ['upload', UPLOAD]), false);
  assert.equal((await run(h, 'drop_open($1)', ['Daze-2026-NEW'])).ok, true);
});

test('the migration starts open until noon on the day, with the limits, a private JPEG bucket, and a closed table', async () => {
  const h = await ready();
  assert.deepEqual(await run(h, 'drop_state()'), {
    open: true, closes_at: '2026-11-21T17:00:00+00:00', state: 'open', per_person: 5, max_photos: 600, max_bytes: 750000000, photos: 0, bytes: 0
  });
  assert.deepEqual(await run(h, 'drop_open($1)', [UPLOAD]), {
    ok: true, open: true, reason: null, closes_at: '2026-11-21T17:00:00+00:00', per_person: 5,
    limits: { min_edge: 500, max_edge: 2560, max_bytes: 6291456 }
  });
  assert.deepEqual(await h.sql(`select id, name, public, file_size_limit::int as file_size_limit, allowed_mime_types from storage.buckets where id = 'photo-drop'`),
    [{ id: 'photo-drop', name: 'photo-drop', public: false, file_size_limit: 8388608, allowed_mime_types: ['image/jpeg'] }]);

  const [table] = await h.sql(`select relrowsecurity from pg_class where oid = 'public.drop_photos'::regclass`);
  assert.equal(table.relrowsecurity, true);
  assert.deepEqual(await h.sql(`select policyname from pg_policies where schemaname = 'public' and tablename = 'drop_photos'`), []);
  assert.deepEqual(await h.sql(`select policyname from pg_policies where schemaname = 'storage' and (qual like '%photo-drop%' or with_check like '%photo-drop%')`), [],
    'no storage policy names the bucket');

  // A setting someone mistyped in SQL Editor falls back to the default instead of breaking the pages.
  await setting(h, 'drop_per_person', 'five');
  await setting(h, 'drop_max_photos', '');
  await setting(h, 'drop_closes_at', 'noon on Saturday');
  const s = await run(h, 'drop_state()');
  assert.deepEqual([s.per_person, s.max_photos, s.closes_at, s.state], [5, 600, null, 'open']);
});

test('a photo is refused for one reason at a time, in the order a person would want to hear them', async () => {
  const h = await ready();
  const no = (status, reason, error) => ({ ok: false, status, reason, error });
  const closed = no(409, 'closed', 'Photo uploads have closed.');
  const full = no(409, 'full', 'We have all the photos we can take. Thank you!');
  const name = no(400, 'input', 'Add your name.');
  const email = no(400, 'input', 'Add the email you bought your ticket with.');
  const caption = no(400, 'input', 'Keep the caption to 80 characters or fewer.');
  const tooSmall = no(400, 'photo', 'That photo is too small to show on a big screen. Send a larger copy.');
  const notPhoto = no(400, 'photo', "That file isn't a photo we can use. Send a JPEG.");
  const perPerson = no(409, 'limit', "You've sent 5 photos, which is the most one person can send.");
  const perIp = no(409, 'limit', 'Too many photos have come from this connection today. Try again tomorrow.');

  // Grace has sent her five, all from one connection, which is at its limit of five too.
  await setting(h, 'drop_per_ip_day', '5');
  for (let i = 0; i < 5; i += 1) await photo(h, { name: 'Grace Hopper', email: 'grace@example.com', ip: '198.51.100.7' });
  const everything = { code: 'nope', name: ' ', email: 'not-an-email', caption: 'x'.repeat(81), width: 400, height: 300, ip: '198.51.100.7' };

  // The link first, even with everything else wrong and uploads closed.
  await setting(h, 'drop_open', 'false');
  assert.deepEqual(await reserve(h, everything), no(403, 'code', WRONG_LINK));
  for (const code of ['', null, REVIEW, SCREEN]) assert.deepEqual(await reserve(h, { code }), no(403, 'code', WRONG_LINK));
  // Then whether photos are being taken at all.
  assert.deepEqual(await reserve(h, { ...everything, code: UPLOAD }), closed);
  await setting(h, 'drop_open', 'true');
  await setting(h, 'drop_max_photos', '5');
  assert.deepEqual(await reserve(h, { ...everything, code: UPLOAD }), full);
  await setting(h, 'drop_max_photos', '600');
  // Then what the person typed: name, email, caption.
  const typed = { ...everything, code: UPLOAD };
  assert.deepEqual(await reserve(h, typed), name);
  assert.deepEqual(await reserve(h, { ...typed, name: null }), name);
  assert.deepEqual(await reserve(h, { ...typed, name: 'x'.repeat(81) }), no(400, 'input', 'Keep your name to 80 characters or fewer.'));
  assert.deepEqual(await reserve(h, { ...typed, name: 'Grace Hopper' }), email);
  for (const bad of ['', null, 'grace', 'grace@example', 'grace @example.com', 'a@b.c@d.e', `${'g'.repeat(109)}@example.com`]) {
    assert.deepEqual(await reserve(h, { ...typed, name: 'Grace Hopper', email: bad }), email, String(bad));
  }
  assert.deepEqual(await reserve(h, { ...typed, name: 'Grace Hopper', email: 'grace@example.com' }), caption);
  // Then the photo, then her own limit, then the connection's.
  const sized = { ...typed, name: 'Grace Hopper', email: 'grace@example.com', caption: 'x'.repeat(80) };
  assert.deepEqual(await reserve(h, sized), tooSmall);
  assert.deepEqual(await reserve(h, { ...sized, width: 499, height: 499 }), tooSmall);
  for (const bad of [{ width: null }, { height: 0 }, { width: 70000 }, { bytes: 0 }, { bytes: null }]) {
    assert.deepEqual(await reserve(h, { ...sized, width: 2560, height: 1707, ...bad }), notPhoto, JSON.stringify(bad));
  }
  assert.deepEqual(await reserve(h, { ...sized, width: 2560, height: 1707 }), perPerson);
  assert.deepEqual(await reserve(h, { ...sized, width: 2560, height: 1707, email: ' GRACE@Example.com ' }), perPerson, 'the same email however it is typed');
  assert.deepEqual(await reserve(h, { ...sized, width: 2560, height: 1707, email: 'someone.else@example.com' }), perIp);

  assert.equal((await rows(h)).length, 5, 'none of the refusals saved anything');
  // From another connection, or with no address to go by, someone else gets in. 500 pixels is enough.
  assert.equal((await reserve(h, { email: 'someone.else@example.com', width: 500, height: 281, ip: '198.51.100.8' })).ok, true);
  assert.equal((await reserve(h, { email: 'third@example.com', ip: '' })).ok, true);
  assert.equal((await reserve(h, { email: 'fourth@example.com', ip: null })).ok, true);
});

test('what a reserved photo keeps: tidy text, a lower-case email, its paths, its fingerprint, and only a hash of the address', async () => {
  const h = await ready();
  const original = { name: 'IMG_0042.HEIC', width: 4032, height: 3024, bytes: 2310456, type: 'image/heic' };
  const sha = '0123456789abcdef'.repeat(4);
  const r = await reserve(h, { code: '  daze-2026-bk', name: '  Ada   Lovelace ', email: ' Ada@Example.COM ', caption: '  Howard,  class of 1998 ', original,
    sha: ` ${sha.toUpperCase()} ` });
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(r, { ok: true, id: r.id, path: `photos/${r.id}.jpg`, thumb_path: `thumbs/${r.id}.jpg`, left: 4 });
  const [row] = await rows(h);
  assert.deepEqual({ ...row, created_at: row.created_at.toISOString() }, {
    id: r.id, status: 'sending', name: 'Ada Lovelace', email: 'ada@example.com', caption: 'Howard, class of 1998',
    width: 2560, height: 1707, bytes: 1500000, has_thumb: true, original, path: `photos/${r.id}.jpg`, thumb_path: `thumbs/${r.id}.jpg`,
    url: null, thumb_url: null, signed_until: null, ip_hash: row.ip_hash, sha256: sha, created_at: '2026-11-19T15:00:00.000Z',
    stored_at: null, reviewed_at: null, reviewed_by: null
  });
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  const [plain] = await h.sql(`select encode(sha256(convert_to('203.0.113.9', 'UTF8')), 'hex') as hash`);
  assert.notEqual(row.ip_hash, plain.hash, 'salted, so the hash can not be looked up');
  assert.ok(!JSON.stringify(row).includes('203.0.113'), 'the address itself is nowhere in the row');

  // No thumbnail, no caption, no fingerprint, and things that aren't a small object in place of
  // the original.
  const bare = await reserve(h, { thumb: false, caption: '   ', original: ['IMG_1.jpg'], ip: '', sha: null });
  assert.deepEqual(bare, { ok: true, id: bare.id, path: `photos/${bare.id}.jpg`, thumb_path: null, left: 3 });
  const big = await reserve(h, { thumb: null, original: { name: 'x'.repeat(600) }, sha: print('b') });
  const kept = await rows(h, `select id, has_thumb, thumb_path, caption, original, ip_hash, sha256 from public.drop_photos where id <> '${r.id}' order by created_at, id`);
  for (const k of kept) {
    assert.deepEqual({ has_thumb: k.has_thumb, thumb_path: k.thumb_path, caption: k.caption, original: k.original }, { has_thumb: false, thumb_path: null, caption: null, original: null });
  }
  assert.equal(kept.find((k) => k.id === bare.id).ip_hash, null);
  assert.deepEqual([kept.find((k) => k.id === bare.id).sha256, kept.find((k) => k.id === big.id).sha256], [null, print('b')]);
  assert.equal(big.left, 2);

  // The files are in: the photo waits for review. It only happens once, and only with a link.
  assert.equal(await run(h, `drop_stored($1::uuid, '', null, '2026-12-03T15:00:00Z')`, [r.id]), false);
  assert.equal(await stored(h, r), true);
  assert.equal(await stored(h, r), false, 'already waiting');
  assert.equal(await stored(h, { id: '00000000-0000-4000-8000-000000000000', path: 'photos/x.jpg', thumb_path: null }), false, 'no such row');
  const [waiting] = await rows(h, `select status, url, thumb_url, signed_until, stored_at from public.drop_photos where id = '${r.id}'`);
  assert.deepEqual({ ...waiting, signed_until: waiting.signed_until.toISOString(), stored_at: waiting.stored_at.toISOString() }, {
    status: 'waiting', url: `https://files.example/photos/${r.id}.jpg?token=one`, thumb_url: `https://files.example/thumbs/${r.id}.jpg?token=one`,
    signed_until: '2026-12-03T15:00:00.000Z', stored_at: '2026-11-19T15:00:00.000Z'
  });

  // Storage failed: the row goes, and the sender gets the place back. A photo that arrived stays.
  await run(h, 'drop_abandon($1::uuid)', [bare.id]);
  await run(h, 'drop_abandon($1::uuid)', [r.id]);
  assert.deepEqual((await rows(h, 'select id from public.drop_photos order by created_at, id')).map((x) => x.id).sort(), [r.id, big.id].sort());
  assert.equal((await reserve(h)).left, 2);
});

test('the same photo sent again from the same email is kept once, and is answered with the one already here', async () => {
  const h = await ready();
  const first = await reserve(h, { sha: print('a') });
  assert.equal(first.left, 4);
  assert.equal(await stored(h, first), true);
  await photo(h);
  const same = { ok: true, duplicate: true, id: first.id, left: 3 };

  // Her phone never heard the answer and sends the photo again. She has two photos here, so
  // three left: the repeat doesn't use one up.
  assert.deepEqual(await reserve(h, { sha: print('a') }), same);
  // The same email however it is typed, the fingerprint in capitals, from another connection.
  assert.deepEqual(await reserve(h, { sha: ` ${print('A')} `, email: ' ADA@Example.com ', ip: '198.51.100.7' }), same);
  // It is the photo already here, so nothing else that came with it is looked at.
  assert.deepEqual(await reserve(h, { sha: print('a'), name: ' ', caption: 'x'.repeat(81), width: 400, height: 300, bytes: null }), same);
  // The link still comes first.
  assert.deepEqual(await reserve(h, { sha: print('a'), code: 'nope' }), { ok: false, status: 403, reason: 'code', error: WRONG_LINK });
  // Whatever the organizers have made of the photo since.
  for (const status of ['approved', 'rejected', 'waiting']) {
    assert.deepEqual(await set(h, [first.id], status), { ok: true, changed: 1 });
    assert.deepEqual(await reserve(h, { sha: print('a') }), same, status);
  }

  // A repeat is answered before anything that turns a new photo away: uploads closed by the
  // switch, a full drop, her own limit, her connection's, and the deadline.
  const fresh = async () => {
    const r = await reserve(h);
    return [r.reason, r.error];
  };
  await setting(h, 'drop_open', 'false');
  assert.deepEqual(await reserve(h, { sha: print('a') }), same);
  assert.deepEqual(await fresh(), ['closed', 'Photo uploads have closed.']);
  await setting(h, 'drop_open', 'true');
  await setting(h, 'drop_max_photos', '2');
  assert.deepEqual(await reserve(h, { sha: print('a') }), same);
  assert.deepEqual(await fresh(), ['full', 'We have all the photos we can take. Thank you!']);
  await setting(h, 'drop_max_photos', '600');
  await setting(h, 'drop_per_person', '2');
  assert.deepEqual(await reserve(h, { sha: print('a') }), { ...same, left: 0 });
  assert.deepEqual(await fresh(), ['limit', "You've sent 2 photos, which is the most one person can send."]);
  await setting(h, 'drop_per_person', '1');
  assert.deepEqual(await reserve(h, { sha: print('a') }), { ...same, left: 0 }, 'never fewer than none left');
  await setting(h, 'drop_per_person', '5');
  await setting(h, 'drop_per_ip_day', '1');
  assert.deepEqual(await reserve(h, { sha: print('a') }), same);
  assert.deepEqual(await fresh(), ['limit', 'Too many photos have come from this connection today. Try again tomorrow.']);
  await setting(h, 'drop_per_ip_day', '0');
  await h.setNow('2026-11-21T17:00:00Z');
  assert.deepEqual(await reserve(h, { sha: print('a') }), same);
  assert.deepEqual(await fresh(), ['closed', 'Photo uploads have closed.']);

  assert.equal((await rows(h)).length, 2, 'none of that saved a second copy, or anything else');
  assert.deepEqual(await rows(h, `select id from public.drop_photos where sha256 = '${print('a')}'`), [{ id: first.id }]);

  // Once the organizers delete it, the same photo is a new one.
  await h.setNow(NOW);
  assert.deepEqual(await run(h, 'drop_review_delete($1, ($2::text)::uuid[])', [REVIEW, ids([first.id])]), { ok: true, deleted: 1 });
  const anew = await reserve(h, { sha: print('a') });
  assert.deepEqual(anew, { ok: true, id: anew.id, path: `photos/${anew.id}.jpg`, thumb_path: `thumbs/${anew.id}.jpg`, left: 3 });
  assert.notEqual(anew.id, first.id);
});

test('a repeat of a photo still on its way in is asked to wait, and after 15 minutes it goes through as new', async () => {
  const h = await ready();
  const busy = { ok: false, status: 409, reason: 'busy', error: 'That photo is still on its way in. Give it a minute, then try again.' };
  const first = await reserve(h, { sha: print('a') });
  // Sent twice at once, or sent again while the first is still going into the bucket.
  assert.deepEqual(await reserve(h, { sha: print('a') }), busy);
  assert.deepEqual(await reserve(h, { sha: print('A'), email: ' ADA@Example.com ' }), busy);
  // Like a repeat that arrived, it is answered before closed, and after the link.
  await setting(h, 'drop_open', 'false');
  assert.deepEqual(await reserve(h, { sha: print('a') }), busy);
  assert.deepEqual(await reserve(h, { sha: print('a'), code: 'nope' }), { ok: false, status: 403, reason: 'code', error: WRONG_LINK });
  await setting(h, 'drop_open', 'true');
  await h.setNow(minutes(14));
  assert.deepEqual(await reserve(h, { sha: print('a') }), busy);
  assert.deepEqual((await rows(h)).map((r) => [r.id, r.status]), [[first.id, 'sending']], 'being asked to wait saves nothing');

  // 15 minutes after the first: it never finished, so it is passed over and the photo is taken.
  await h.setNow(minutes(15));
  const second = await reserve(h, { sha: print('a') });
  assert.deepEqual(second, { ok: true, id: second.id, path: `photos/${second.id}.jpg`, thumb_path: `thumbs/${second.id}.jpg`, left: 4 });
  assert.notEqual(second.id, first.id);
  // Now the second is the one on its way in. Once it arrives, it is the one a repeat hears about.
  assert.deepEqual(await reserve(h, { sha: print('a') }), busy);
  assert.equal(await stored(h, second), true);
  assert.deepEqual(await reserve(h, { sha: print('a') }), { ok: true, duplicate: true, id: second.id, left: 4 });
  assert.equal((await rows(h)).length, 2);

  // A send that Storage failed is forgotten at once, so its photo can be tried again straight away.
  const failed = await reserve(h, { sha: print('b') });
  assert.deepEqual(await reserve(h, { sha: print('b') }), busy);
  await run(h, 'drop_abandon($1::uuid)', [failed.id]);
  const retried = await reserve(h, { sha: print('b') });
  assert.deepEqual([retried.ok, retried.duplicate, retried.left], [true, undefined, 3]);
});

test('the same photo from another email is a new photo, and with no fingerprint to go by nothing is compared', async () => {
  const h = await ready();
  const hers = await photo(h, { sha: print('a') });
  // Two people at one table can send the same picture. Each has their own five.
  const his = await reserve(h, { sha: print('a'), name: 'Charles Babbage', email: 'charles@example.com' });
  assert.deepEqual(his, { ok: true, id: his.id, path: `photos/${his.id}.jpg`, thumb_path: `thumbs/${his.id}.jpg`, left: 4 });
  assert.notEqual(his.id, hers);
  assert.equal(await stored(h, his), true);
  assert.deepEqual(await rows(h, `select email from public.drop_photos where sha256 = '${print('a')}' order by email`),
    [{ email: 'ada@example.com' }, { email: 'charles@example.com' }]);
  // A repeat from either of them is answered with their own.
  assert.deepEqual(await reserve(h, { sha: print('a'), email: 'charles@example.com' }), { ok: true, duplicate: true, id: his.id, left: 4 });
  assert.deepEqual(await reserve(h, { sha: print('a') }), { ok: true, duplicate: true, id: hers, left: 4 });

  // A fingerprint that is missing, or isn't 64 hex characters, is not kept and not compared:
  // sent twice, the photo is saved twice.
  const unusable = [null, '', '   ', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `${'a'.repeat(32)} ${'a'.repeat(31)}`, `sha256:${'a'.repeat(57)}`];
  for (const [i, sha] of unusable.entries()) {
    const email = `guest${i}@example.com`;
    const once = await reserve(h, { email, sha });
    const twice = await reserve(h, { email, sha });
    assert.deepEqual([once.ok, once.left, twice.ok, twice.duplicate, twice.left], [true, 4, true, undefined, 3], JSON.stringify(sha));
    assert.notEqual(twice.id, once.id);
  }
  assert.deepEqual(await rows(h, `select count(*)::int as photos, count(sha256)::int as fingerprints from public.drop_photos where email like 'guest%'`),
    [{ photos: 16, fingerprints: 0 }]);

  // The ten-argument form, which the Edge Function deployed before this migration calls, still
  // takes photos. It has no fingerprint to give, so it checks for no repeats.
  const old = (code, email) => run(h, `drop_reserve($1, ' Grace  Hopper ', $2, 'Vassar, class of 1928', 2560, 1707, 1500000, true, '198.51.100.7', '{"name": "IMG_1.jpg"}'::jsonb)`, [code, email]);
  const one = await old(UPLOAD, 'Grace@Example.com');
  const two = await old(UPLOAD, 'grace@example.com');
  assert.deepEqual(one, { ok: true, id: one.id, path: `photos/${one.id}.jpg`, thumb_path: `thumbs/${one.id}.jpg`, left: 4 });
  assert.deepEqual(two, { ok: true, id: two.id, path: `photos/${two.id}.jpg`, thumb_path: `thumbs/${two.id}.jpg`, left: 3 });
  const kept = await rows(h, `select status, name, caption, original, sha256, ip_hash is not null as hashed from public.drop_photos where email = 'grace@example.com'`);
  assert.deepEqual(kept, Array.from({ length: 2 }, () => (
    { status: 'sending', name: 'Grace Hopper', caption: 'Vassar, class of 1928', original: { name: 'IMG_1.jpg' }, sha256: null, hashed: true })));
  // And it refuses what it always refused.
  assert.deepEqual(await old('nope', 'grace@example.com'), { ok: false, status: 403, reason: 'code', error: WRONG_LINK });
  assert.deepEqual(await old(UPLOAD, 'grace at example dot com'), { ok: false, status: 400, reason: 'input', error: 'Add the email you bought your ticket with.' });
  await setting(h, 'drop_open', 'false');
  assert.deepEqual(await old(UPLOAD, 'grace@example.com'), { ok: false, status: 409, reason: 'closed', error: 'Photo uploads have closed.' });
});

test('the limits count a photo on its way in for 15 minutes and no longer', async () => {
  const h = await ready();
  await setting(h, 'drop_per_person', '2');
  await setting(h, 'drop_max_photos', '4');
  const first = await reserve(h);
  assert.equal(first.left, 1);
  await h.setNow(minutes(10));
  const second = await reserve(h);
  assert.equal(second.left, 0);
  // Both are still 'sending', and both hold their place.
  assert.deepEqual(await reserve(h), { ok: false, status: 409, reason: 'limit', error: "You've sent 2 photos, which is the most one person can send." });
  assert.equal((await run(h, 'drop_state()')).photos, 2);
  assert.equal((await run(h, 'drop_state()')).bytes, 3000000);

  // 15 minutes after the first: it never finished, so it stops counting. The second still does.
  await h.setNow(minutes(15));
  assert.equal((await run(h, 'drop_state()')).photos, 1);
  const third = await reserve(h);
  assert.equal(third.left, 0);
  assert.deepEqual(await reserve(h), { ok: false, status: 409, reason: 'limit', error: "You've sent 2 photos, which is the most one person can send." });

  // The chapter-wide limits work the same way: photos count once stored, however old.
  await stored(h, second);
  await stored(h, third);
  await photo(h, { email: 'grace@example.com' });
  await h.setNow(minutes(60));
  assert.deepEqual([(await run(h, 'drop_state()')).photos, (await run(h, 'drop_state()')).state], [3, 'open']);
  const fourth = await reserve(h, { email: 'grace@example.com' });
  assert.equal(fourth.ok, true);
  assert.equal((await run(h, 'drop_state()')).state, 'full');
  assert.deepEqual(await run(h, 'drop_open($1)', [UPLOAD]), {
    ok: true, open: false, reason: 'full', closes_at: '2026-11-21T17:00:00+00:00', per_person: 2, limits: { min_edge: 500, max_edge: 2560, max_bytes: 6291456 }
  });
  assert.equal((await reserve(h, { email: 'new@example.com' })).reason, 'full');
  await h.setNow(minutes(76));
  assert.equal((await run(h, 'drop_state()')).state, 'open', 'the fourth never finished, so there is room again');
  assert.equal((await reserve(h, { email: 'new@example.com' })).ok, true);

  // The storage limit, in bytes.
  await setting(h, 'drop_max_photos', '600');
  await setting(h, 'drop_max_bytes', '6000001');
  assert.deepEqual([(await run(h, 'drop_state()')).bytes, (await run(h, 'drop_state()')).state], [6000000, 'open']);
  await photo(h, { email: 'more@example.com', bytes: 1 });
  assert.equal((await run(h, 'drop_state()')).state, 'full');
  assert.equal((await reserve(h, { email: 'last@example.com' })).reason, 'full');

  // The tidy-up removes sends that never finished and hands back their files, thumbnails included.
  const gone = await run(h, 'drop_stale()');
  assert.deepEqual([...gone].sort(), [first.path, first.thumb_path, fourth.path, fourth.thumb_path].sort());
  assert.deepEqual(await run(h, 'drop_stale()'), []);
  assert.deepEqual((await rows(h, 'select status, count(*)::int as n from public.drop_photos group by status order by status')),
    [{ status: 'sending', n: 1 }, { status: 'waiting', n: 4 }], 'the one sent a minute ago is still on its way');

  // A lowered limit reads sensibly for someone already over it, and for a limit of one.
  await setting(h, 'drop_max_bytes', '750000000');
  await setting(h, 'drop_per_person', '1');
  assert.equal((await reserve(h)).error, "You've sent 2 photos. The most one person can send is 1.");
  assert.equal((await reserve(h, { email: 'more@example.com' })).error, "You've sent 1 photo, which is the most one person can send.");
});

test('the limit on one connection is off after the migrations, and turned on it counts a day of photos', async () => {
  const h = await ready();
  const from = (n, ip = '198.51.100.7') => reserve(h, { email: `guest${n}@example.com`, ip });
  const no = { ok: false, status: 409, reason: 'limit', error: 'Too many photos have come from this connection today. Try again tomorrow.' };

  // Off to begin with: nobody has checked yet which address the platform reports for a guest, and
  // a shared one would stop everybody. More than the 60 the first migration allowed get in from
  // one address.
  assert.deepEqual(await h.sql(`select value from cal_private.config where key = 'drop_per_ip_day'`), [{ value: '0' }]);
  for (let n = 101; n <= 161; n += 1) assert.equal((await from(n, '198.51.100.99')).ok, true, `photo ${n - 100} from one address`);
  // A setting that is mistyped or missing counts as off too.
  await setting(h, 'drop_per_ip_day', 'sixty');
  assert.equal((await from(162, '198.51.100.99')).ok, true);
  await h.sql(`delete from cal_private.config where key = 'drop_per_ip_day'`);
  assert.equal((await from(163, '198.51.100.99')).ok, true);
  // The address is still kept as a hash, so the hashes can be looked over before the limit goes on.
  assert.deepEqual(await h.sql(`select count(*)::int as photos, count(ip_hash)::int as hashed, count(distinct ip_hash)::int as addresses from public.drop_photos`),
    [{ photos: 63, hashed: 63, addresses: 1 }]);
  // Turned on, it counts what that address sent while it was off.
  await setting(h, 'drop_per_ip_day', '3');
  assert.deepEqual(await from(164, '198.51.100.99'), no);

  for (let n = 1; n <= 3; n += 1) assert.equal((await from(n)).ok, true);
  assert.deepEqual(await from(4), no);
  assert.equal((await from(4, '198.51.100.8')).ok, true, 'another connection is fine');
  await h.setNow(minutes(23 * 60 + 59));
  assert.deepEqual(await from(5), no);
  await h.setNow(minutes(24 * 60));
  for (let n = 5; n <= 7; n += 1) assert.equal((await from(n)).ok, true, 'a day on, the first three no longer count');
  assert.deepEqual(await from(8), no);
  await setting(h, 'drop_per_ip_day', '0');
  assert.equal((await from(8)).ok, true, '0 turns the limit off');
});

test('uploads close by the switch and by the clock, and the upload page is told which', async () => {
  const h = await ready();
  const asked = async () => {
    const r = await run(h, 'drop_open($1)', [UPLOAD]);
    return [r.open, r.reason];
  };
  assert.deepEqual(await asked(), [true, null]);
  // One second before noon in New York on the day, then noon.
  await h.setNow('2026-11-21T16:59:59Z');
  assert.deepEqual(await asked(), [true, null]);
  await photo(h);
  await h.setNow('2026-11-21T17:00:00Z');
  assert.deepEqual(await asked(), [false, 'closed']);
  assert.deepEqual(await reserve(h), { ok: false, status: 409, reason: 'closed', error: 'Photo uploads have closed.' });
  assert.equal((await run(h, 'drop_state()')).open, true, 'the switch is still on: the deadline closed it');

  // The organizers move the deadline, take it away, and use the switch.
  const change = (p) => run(h, 'drop_review_settings($1, ($2::text)::jsonb)', [REVIEW, JSON.stringify(p)]);
  let r = await change({ closes_at: '2026-11-21T15:00:00-05:00' });
  assert.deepEqual([r.ok, r.settings.closes_at, r.settings.state], [true, '2026-11-21T20:00:00+00:00', 'open']);
  assert.deepEqual(await h.sql(`select value from cal_private.config where key = 'drop_closes_at'`), [{ value: '2026-11-21T20:00:00Z' }]);
  r = await change({ open: false });
  assert.deepEqual([r.settings.open, r.settings.closes_at, r.settings.state], [false, '2026-11-21T20:00:00+00:00', 'closed'], 'the deadline was not in the request, so it stays');
  assert.deepEqual(await asked(), [false, 'closed']);
  r = await change({ open: true, closes_at: null });
  assert.deepEqual([r.settings.open, r.settings.closes_at, r.settings.state], [true, null, 'open']);
  await h.setNow('2027-01-01T00:00:00Z');
  assert.deepEqual(await asked(), [true, null], 'no deadline');
  assert.deepEqual(await change({}), { ok: true, settings: await run(h, 'drop_state()') });

  // Nothing is saved unless all of it reads right.
  const bad = (error) => ({ ok: false, status: 400, reason: 'input', error });
  assert.deepEqual(await change({ open: false, closes_at: 'next Tuesday' }), bad("That date and time didn't read right. Choose them again."));
  assert.deepEqual(await change({ open: false, closes_at: 20261121 }), bad("That date and time didn't read right. Choose them again."));
  assert.deepEqual(await change({ open: false, closes_at: 'infinity' }), bad("That date and time didn't read right. Choose them again."));
  assert.deepEqual(await change({ open: 'no', closes_at: '2026-11-21T15:00:00-05:00' }), bad('Choose open or closed.'));
  assert.deepEqual([(await run(h, 'drop_state()')).open, (await run(h, 'drop_state()')).closes_at], [true, null]);

  // Closed beats full: there is no point telling people to wait for room.
  await setting(h, 'drop_max_photos', '1');
  assert.deepEqual(await asked(), [false, 'full']);
  await change({ open: false });
  assert.deepEqual(await asked(), [false, 'closed']);
});

test('the organizers list, approve, reject, send back, and caption', async () => {
  const h = await ready();
  const a = await photo(h, { caption: 'Howard, class of 1998', original: { name: 'IMG_0042.HEIC', width: 4032, height: 3024, bytes: 2310456, type: 'image/heic' } });
  await h.setNow(minutes(1));
  const b = await photo(h, { name: 'Grace Hopper', email: 'grace@example.com', thumb: false, bytes: 900000 });
  await h.setNow(minutes(2));
  const c = await photo(h, { name: 'Grace Hopper', email: 'grace@example.com' });
  const unfinished = await reserve(h, { name: 'Still Sending', email: 'slow@example.com' });

  let list = await run(h, 'drop_review_list($1)', [REVIEW]);
  assert.deepEqual(list.settings, { open: true, closes_at: '2026-11-21T17:00:00+00:00', state: 'open', per_person: 5, max_photos: 600, max_bytes: 750000000, photos: 4, bytes: 5400000 });
  assert.deepEqual(list.counts, { waiting: 3, approved: 0, rejected: 0 });
  assert.deepEqual(list.photos.map((p) => p.id), [a, b, c], 'oldest first, without the one still on its way');
  assert.deepEqual(list.photos[0], {
    id: a, status: 'waiting', name: 'Ada Lovelace', email: 'ada@example.com', caption: 'Howard, class of 1998',
    width: 2560, height: 1707, bytes: 1500000, original: { name: 'IMG_0042.HEIC', width: 4032, height: 3024, bytes: 2310456, type: 'image/heic' },
    created_at: '2026-11-19T15:00:00+00:00', reviewed_at: null, reviewed_by: null,
    url: `https://files.example/photos/${a}.jpg?token=one`, thumb_url: `https://files.example/thumbs/${a}.jpg?token=one`
  });
  assert.equal(list.photos[1].thumb_url, list.photos[1].url, 'no thumbnail: the photo stands in');

  await h.setNow(minutes(5));
  assert.deepEqual(await set(h, [a, c], 'approved', '  Eugene   Aiken '), { ok: true, changed: 2 });
  await h.setNow(minutes(6));
  assert.deepEqual(await set(h, [b], 'rejected', 'x'.repeat(70)), { ok: true, changed: 1 });
  // Approving again changes nothing, so the photo keeps its place in the slideshow's order.
  assert.deepEqual(await set(h, [a, c], 'approved', 'Someone Else'), { ok: true, changed: 0 });
  // A photo still arriving, and an id that isn't there, are left alone.
  assert.deepEqual(await set(h, [unfinished.id, '00000000-0000-4000-8000-000000000000'], 'approved'), { ok: true, changed: 0 });
  list = await run(h, 'drop_review_list($1)', [REVIEW]);
  assert.deepEqual(list.counts, { waiting: 0, approved: 2, rejected: 1 });
  assert.deepEqual(list.photos.map((p) => [p.status, p.reviewed_at, p.reviewed_by]), [
    ['approved', '2026-11-19T15:05:00+00:00', 'Eugene Aiken'],
    ['rejected', '2026-11-19T15:06:00+00:00', 'x'.repeat(60)],
    ['approved', '2026-11-19T15:05:00+00:00', 'Eugene Aiken']
  ]);
  assert.deepEqual(await set(h, [a, b], 'waiting'), { ok: true, changed: 2 });
  assert.deepEqual(await set(h, [c], 'rejected', null), { ok: true, changed: 1 });
  list = await run(h, 'drop_review_list($1)', [REVIEW]);
  assert.deepEqual(list.photos.map((p) => [p.status, p.reviewed_at, p.reviewed_by]), [
    ['waiting', null, null], ['waiting', null, null], ['rejected', '2026-11-19T15:06:00+00:00', null]
  ]);

  const bad = (error) => ({ ok: false, status: 400, reason: 'input', error });
  assert.deepEqual(await set(h, [a], 'sending'), bad('Choose approve, reject, or back to waiting.'));
  assert.deepEqual(await set(h, [a], null), bad('Choose approve, reject, or back to waiting.'));
  assert.deepEqual(await set(h, [], 'approved'), bad('Choose between 1 and 200 photos at a time.'));
  assert.deepEqual(await set(h, null, 'approved'), bad('Choose between 1 and 200 photos at a time.'));
  assert.deepEqual(await set(h, Array.from({ length: 201 }, () => a), 'approved'), bad('Choose between 1 and 200 photos at a time.'));

  const caption = (id, text) => run(h, 'drop_review_caption($1, $2::uuid, $3)', [REVIEW, id, text]);
  assert.deepEqual(await caption(b, '  Spelman,   class of 2001 '), { ok: true });
  assert.deepEqual(await caption(a, '  '), { ok: true });
  assert.deepEqual(await caption(c, 'x'.repeat(80)), { ok: true });
  assert.deepEqual(await caption(c, 'x'.repeat(81)), bad('Keep the caption to 80 characters or fewer.'));
  assert.deepEqual(await caption(unfinished.id, 'too soon'), bad('That photo is no longer here. Refresh to see the latest.'));
  assert.deepEqual(await caption('00000000-0000-4000-8000-000000000000', 'gone'), bad('That photo is no longer here. Refresh to see the latest.'));
  assert.deepEqual((await run(h, 'drop_review_list($1)', [REVIEW])).photos.map((p) => p.caption), [null, 'Spelman, class of 2001', 'x'.repeat(80)]);
});

test('deleting: the files are listed first, then exactly those rows go', async () => {
  const h = await ready();
  const a = await photo(h);
  await h.setNow(minutes(1));
  const b = await photo(h, { thumb: false });
  await h.setNow(minutes(2));
  const c = await photo(h, { email: 'grace@example.com' });
  const unfinished = await reserve(h, { email: 'slow@example.com' });
  const paths = (list) => run(h, 'drop_review_paths($1, ($2::text)::uuid[])', [REVIEW, ids(list)]);
  const remove = (list) => run(h, 'drop_review_delete($1, ($2::text)::uuid[])', [REVIEW, ids(list)]);

  const some = await paths([a, b, '00000000-0000-4000-8000-000000000000']);
  assert.deepEqual(some.ids, [a, b]);
  assert.deepEqual([...some.paths].sort(), [`photos/${a}.jpg`, `photos/${b}.jpg`, `thumbs/${a}.jpg`].sort());
  assert.equal((await rows(h)).length, 4, 'listing the files deletes nothing');
  assert.deepEqual(await remove(null), { ok: true, deleted: 0 }, 'no ids, nothing deleted');
  assert.deepEqual(await remove([]), { ok: true, deleted: 0 });
  assert.deepEqual(await remove(some.ids), { ok: true, deleted: 2 });
  assert.deepEqual(await remove(some.ids), { ok: true, deleted: 0 });

  // Everything, for after the party: a photo still on its way in is included.
  const all = await paths(null);
  assert.deepEqual([...all.ids].sort(), [c, unfinished.id].sort());
  assert.equal(all.paths.length, 4);
  // A photo that arrives between the two steps keeps its row: its files were never listed.
  const late = await photo(h, { email: 'late@example.com' });
  assert.deepEqual(await remove(all.ids), { ok: true, deleted: 2 });
  assert.deepEqual((await rows(h)).map((r) => r.id), [late]);
  assert.deepEqual(await paths([]), { ok: true, ids: [], paths: [] });
  // Deleted photos give their sender the place back.
  assert.equal((await reserve(h)).left, 4);
});

test('the slideshow gets approved photos in the order they were approved, and nothing about who sent them', async () => {
  const h = await ready();
  const a = await photo(h, { name: 'Ada Lovelace', email: 'ada@example.com', caption: 'Howard, class of 1998' });
  await h.setNow(minutes(1));
  const b = await photo(h, { name: 'Grace Hopper', email: 'grace@example.com', thumb: false, width: 1200, height: 1600 });
  await h.setNow(minutes(2));
  const c = await photo(h, { name: 'Katherine Johnson', email: 'katherine@example.com' });
  const d = await photo(h, { name: 'Dorothy Vaughan', email: 'dorothy@example.com' });
  const unfinished = await reserve(h, { email: 'slow@example.com' });
  assert.deepEqual(await run(h, 'drop_screen_list($1)', [SCREEN]), { ok: true, photos: [] });

  await h.setNow(minutes(10));
  await set(h, [c], 'approved');
  await h.setNow(minutes(11));
  await set(h, [b, a], 'approved');
  await set(h, [d], 'rejected');
  await set(h, [unfinished.id], 'approved');
  const list = await run(h, 'drop_screen_list($1)', [SCREEN]);
  assert.deepEqual(list, { ok: true, photos: [
    { id: c, url: `https://files.example/photos/${c}.jpg?token=one`, thumb_url: `https://files.example/thumbs/${c}.jpg?token=one`, width: 2560, height: 1707, caption: null },
    // Approved together: the older photo first.
    { id: a, url: `https://files.example/photos/${a}.jpg?token=one`, thumb_url: `https://files.example/thumbs/${a}.jpg?token=one`, width: 2560, height: 1707, caption: 'Howard, class of 1998' },
    { id: b, url: `https://files.example/photos/${b}.jpg?token=one`, thumb_url: `https://files.example/photos/${b}.jpg?token=one`, width: 1200, height: 1600, caption: null }
  ] });
  assert.doesNotMatch(JSON.stringify(list), /Lovelace|Hopper|Johnson|example\.com|reviewed|Eugene|status|original/);

  // Sent back to waiting, a photo leaves the slideshow. Approved again, it goes to the end.
  await h.setNow(minutes(20));
  await set(h, [c], 'waiting');
  assert.deepEqual((await run(h, 'drop_screen_list($1)', [SCREEN])).photos.map((p) => p.id), [a, b]);
  await set(h, [c], 'approved');
  assert.deepEqual((await run(h, 'drop_screen_list($1)', [SCREEN])).photos.map((p) => p.id), [a, b, c]);

  // The list opens to the screen code only. The review code, typed on the venue's computer, would
  // stay there with everything it opens, so it is turned away like any other.
  for (const code of [REVIEW, UPLOAD]) {
    assert.deepEqual(await run(h, 'drop_screen_list($1)', [code]), { ok: false, status: 403, reason: 'code', error: WRONG_CODE });
  }
});

test('links that run out within three days are due for renewal, and fresh ones are saved', async () => {
  const h = await ready();
  const a = await photo(h);
  const b = await photo(h, { thumb: false });
  const unfinished = await reserve(h, { email: 'slow@example.com' });
  assert.deepEqual(await run(h, 'drop_resign_due()'), [], 'signed until Dec. 3, two weeks off');
  await h.setNow('2026-11-30T14:59:59Z');
  assert.deepEqual(await run(h, 'drop_resign_due()'), []);
  await h.setNow('2026-11-30T15:00:00Z');
  const due = await run(h, 'drop_resign_due()');
  assert.deepEqual([...due].sort((x, y) => x.id.localeCompare(y.id)), [
    { id: a, path: `photos/${a}.jpg`, thumb_path: `thumbs/${a}.jpg` },
    { id: b, path: `photos/${b}.jpg`, thumb_path: null }
  ].sort((x, y) => x.id.localeCompare(y.id)));

  const fresh = [
    { id: a, url: 'https://files.example/a?token=two', thumb_url: 'https://files.example/a-thumb?token=two', signed_until: '2026-12-14T15:00:00.000Z' },
    { id: b, url: 'https://files.example/b?token=two', thumb_url: null, signed_until: '2026-12-14T15:00:00.000Z' },
    // Never saved: no link, a photo still on its way in, and a row that isn't there.
    { id: a, url: '', thumb_url: null, signed_until: '2026-12-14T15:00:00.000Z' },
    { id: unfinished.id, url: 'https://files.example/u?token=two', thumb_url: null, signed_until: '2026-12-14T15:00:00.000Z' },
    { id: '00000000-0000-4000-8000-000000000000', url: 'https://files.example/x?token=two', thumb_url: null, signed_until: '2026-12-14T15:00:00.000Z' }
  ];
  assert.equal(await run(h, 'drop_resign_save(($1::text)::jsonb)', [JSON.stringify(fresh)]), 2);
  assert.equal(await run(h, 'drop_resign_save(($1::text)::jsonb)', ['{"not": "a list"}']), 0);
  const saved = await rows(h, `select url, thumb_url, signed_until from public.drop_photos where status = 'waiting' order by url`);
  assert.deepEqual(saved.map((r) => [r.url, r.thumb_url, r.signed_until.toISOString()]), [
    ['https://files.example/a?token=two', 'https://files.example/a-thumb?token=two', '2026-12-14T15:00:00.000Z'],
    ['https://files.example/b?token=two', null, '2026-12-14T15:00:00.000Z']
  ]);
  assert.deepEqual(await run(h, 'drop_resign_due()'), []);
});

test('no API role can run any of the functions, read a row, or reach the bucket', async () => {
  const h = await ready();
  await photo(h);
  const user = await h.createUser({ anon: true });
  const staff = await h.createUser({ email: 'eugene@example.org' });

  // Every function the migration adds, found by name so a new one can't be forgotten.
  const fns = await h.sql(`
    select p.oid::regprocedure::text as signature,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
           has_function_privilege('service_role', p.oid, 'execute') as service_role
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cal_private' and p.proname like 'drop\\_%'
    order by 1`);
  assert.equal(fns.length, 22);
  for (const f of fns) {
    assert.deepEqual([f.anon, f.authenticated, f.service_role], [false, false, false], f.signature);
  }
  // Both forms of drop_reserve are among them: the one that takes a fingerprint, and the one the
  // first Edge Function calls.
  assert.deepEqual(fns.filter((f) => f.signature.startsWith('cal_private.drop_reserve(')), [
    { signature: 'cal_private.drop_reserve(text,text,text,text,integer,integer,integer,boolean,text,jsonb)', anon: false, authenticated: false, service_role: false },
    { signature: 'cal_private.drop_reserve(text,text,text,text,integer,integer,integer,boolean,text,jsonb,text)', anon: false, authenticated: false, service_role: false }
  ]);
  assert.deepEqual(await h.sql(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'drop%'`), [],
    'nothing is exposed through the Data API');

  for (const who of [null, user, staff, 'service']) {
    await assert.rejects(() => h.select(who, 'select cal_private.drop_state()'), /permission denied/);
    await assert.rejects(() => h.select(who, 'select cal_private.drop_open($1)', [UPLOAD]), /permission denied/);
    await assert.rejects(() => h.select(who, 'select cal_private.drop_code_ok($1, $2)', ['review', REVIEW]), /permission denied/);
    await assert.rejects(() => h.select(who, 'select cal_private.drop_review_list($1)', [REVIEW]), /permission denied/);
    await assert.rejects(() => h.select(who, 'select cal_private.drop_screen_list($1)', [SCREEN]), /permission denied/);
    await assert.rejects(() => h.select(who, `select cal_private.drop_reserve($1, 'Ada Lovelace', 'ada@example.com', null, 2560, 1707, 1500000, true, '', null, $2)`,
      [UPLOAD, print('a')]), /permission denied/);
    await assert.rejects(() => h.select(who, `select cal_private.drop_reserve($1, 'Ada Lovelace', 'ada@example.com', null, 2560, 1707, 1500000, true, '', null)`,
      [UPLOAD]), /permission denied/);
    await assert.rejects(() => h.select(who, 'select cal_private.drop_set_code($1, $2)', ['review', 'a new review code of mine']), /permission denied/);
    await assert.rejects(() => h.select(who, 'select cal_private.drop_stale()'), /permission denied/);
    await assert.rejects(() => h.select(who, 'select * from public.drop_photos'), /permission denied/);
    await assert.rejects(() => h.select(who, 'select count(*) from public.drop_photos'), /permission denied/);
    await assert.rejects(() => h.select(who, `update public.drop_photos set status = 'approved'`), /permission denied/);
    await assert.rejects(() => h.select(who, 'delete from public.drop_photos'), /permission denied/);
    await assert.rejects(() => h.select(who, `select value from cal_private.config where key like 'drop%'`), /permission denied/);
  }
  // The bucket has no policy of its own, and the calendar's policies name another bucket.
  for (const who of [null, user, staff]) {
    await assert.rejects(() => h.select(who, `insert into storage.objects (bucket_id, name) values ('photo-drop', 'photos/x.jpg')`), /row-level security/);
  }
  await h.sql(`insert into storage.objects (bucket_id, name) values ('photo-drop', 'photos/y.jpg')`);
  for (const who of [null, user, staff]) {
    assert.deepEqual(await h.select(who, `select name from storage.objects where bucket_id = 'photo-drop'`), []);
  }
  assert.equal((await rows(h)).length, 1, 'and nothing changed');
});
