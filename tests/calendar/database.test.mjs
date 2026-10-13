// Content calendar database tests: access rules and checked functions on real Postgres (PGlite).
// Run from the repository root:
//   npm install --no-save @electric-sql/pglite@0.5.8
//   node --test "tests/calendar/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, CHAPTER_CODE, MEDIA_CODE } from './harness.mjs';

const NOW = '2026-10-13T16:00:00Z';

const request = (over = {}) => JSON.stringify({
  contact_name: 'Farid Adenuga',
  committee: 'Social & Fundraising',
  title: 'Wine and Chill flyer',
  post_date: '2026-11-30',
  event_date: '2026-12-18',
  about: 'Promote the December Wine and Chill and toy drive.',
  format: 'flyer',
  platforms: ['instagram', 'facebook'],
  program: '',
  asset_link: 'https://drive.google.com/drive/folders/example',
  caption: '',
  link: '',
  youth: false,
  releases: false,
  ...over
});

const countPosts = (h, who) => h.select(who, 'select count(*)::int as n from public.cal_posts').then((r) => r[0].n);

test('the migration and seed load the 2026-2027 calendar', async () => {
  const h = await createDb();
  const rows = await h.sql('select count(*)::int as n, min(date)::text as first, max(date)::text as last from public.cal_posts');
  assert.equal(rows[0].n, 128);
  assert.equal(rows[0].first, '2026-10-15');
  assert.equal(rows[0].last, '2027-08-30');
  const settings = await h.rpc1(null, 'cal_settings');
  assert.deepEqual(settings, { public: false, lead_days: 21, ready: true });
});

test('visitors see nothing until the media team makes the calendar public, then only public columns', async () => {
  const h = await createDb();
  assert.equal(await countPosts(h, null), 0);
  assert.deepEqual(await h.rpc1(null, 'cal_whoami'), { role: 'visitor' });

  const staff = await h.staff();
  await h.rpc1(staff, 'cal_set_public', { p_on: true });
  const visible = await h.select(null, 'select id, title, concept from public.cal_posts order by date limit 1');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, '2026-10-15-gil-brothers-in-nyacoa-leadership');
  await assert.rejects(() => h.select(null, 'select notes from public.cal_posts limit 1'), /permission denied/);
  await assert.rejects(() => h.select(null, 'select * from public.cal_posts limit 1'), /permission denied/);
  await assert.rejects(() => h.select(null, 'select * from public.cal_requests'), /permission denied/);

  await h.rpc1(staff, 'cal_set_public', { p_on: false });
  assert.equal(await countPosts(h, null), 0);
});

test('a session that has not joined sees no posts, requests, or members', async () => {
  const h = await createDb();
  const stranger = await h.createUser({ anon: true });
  assert.equal(await countPosts(h, stranger), 0);
  assert.equal((await h.select(stranger, 'select * from public.cal_requests')).length, 0);
  assert.equal((await h.select(stranger, 'select * from public.cal_members')).length, 0);
  assert.deepEqual(await h.rpc1(stranger, 'cal_whoami'), { role: 'visitor' });
});

test('joining checks the chapter code, name, and PIN', async () => {
  const h = await createDb();
  const u = await h.createUser({ anon: true });
  await assert.rejects(() => h.rpc(u, 'cal_join', { p_code: 'wrong code', p_name: 'Tyler Ware', p_pin: '1234' }), /chapter code is not right/);
  await assert.rejects(() => h.rpc(u, 'cal_join', { p_code: CHAPTER_CODE, p_name: 'T', p_pin: '1234' }), /2 to 40 characters/);
  await assert.rejects(() => h.rpc(u, 'cal_join', { p_code: CHAPTER_CODE, p_name: 'Tyler Ware', p_pin: '12a4' }), /4 to 6 digits/);
  await assert.rejects(() => h.rpc(null, 'cal_join', { p_code: CHAPTER_CODE, p_name: 'Tyler Ware', p_pin: '1234' }), /permission denied/);

  const me = await h.rpc1(u, 'cal_join', { p_code: '  brooklyn   1945 ', p_name: ' Tyler  Ware ', p_pin: '1234', p_committee: 'Membership' });
  assert.equal(me.role, 'member');
  assert.equal(me.name, 'Tyler Ware');
  assert.equal(me.committee, 'Membership');
  const again = await h.rpc1(u, 'cal_join', { p_code: 'anything', p_name: 'Someone Else', p_pin: '9999' });
  assert.equal(again.member_id, me.member_id, 'joining twice returns the same record');

  const other = await h.createUser({ anon: true });
  await assert.rejects(() => h.rpc(other, 'cal_join', { p_code: CHAPTER_CODE, p_name: 'tyler ware', p_pin: '5555' }), /already signed in as/);
});

test('brothers read the full calendar and requests but cannot change posts directly', async () => {
  const h = await createDb();
  const bro = await h.member('David Brown');
  assert.equal(await countPosts(h, bro), 128);
  const notes = await h.select(bro, `select notes from public.cal_posts where id = '2026-11-16-spring-2027-informational-seminar'`);
  assert.match(notes[0].notes, /IMDP/);

  await assert.rejects(
    () => h.select(bro, `insert into public.cal_posts (date, title) values ('2026-12-01', 'Sneaky post')`),
    /row-level security/
  );
  const updated = await h.select(bro, `update public.cal_posts set title = 'Changed' where id = '2026-12-25-christmas' returning id`);
  assert.equal(updated.length, 0);
  const deleted = await h.select(bro, `delete from public.cal_posts where id = '2026-12-25-christmas' returning id`);
  assert.equal(deleted.length, 0);
  assert.equal(await countPosts(h, bro), 128);

  await assert.rejects(() => h.select(bro, 'select * from cal_private.member_secrets'), /permission denied/);
  const members = await h.select(bro, 'select display_name from public.cal_members');
  assert.deepEqual(members.map((m) => m.display_name), ['David Brown'], 'a brother sees only his own record');
  assert.equal((await h.select(bro, 'select * from public.cal_staff')).length, 0);
});

test('signing in on a new device needs the right PIN and locks after five misses', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const first = await h.member('Jean Louis', '24680');
  const phone = await h.createUser({ anon: true });

  let res = await h.rpc1(phone, 'cal_rejoin', { p_name: 'Nobody Here', p_pin: '24680' });
  assert.equal(res.ok, false);
  assert.match(res.message, /No one has signed in with that name/);

  for (let i = 1; i <= 4; i++) {
    res = await h.rpc1(phone, 'cal_rejoin', { p_name: 'jean louis', p_pin: '11111' });
    assert.equal(res.ok, false);
    assert.match(res.message, /does not match/);
  }
  res = await h.rpc1(phone, 'cal_rejoin', { p_name: 'Jean Louis', p_pin: '11111' });
  assert.match(res.message, /locked for 10 minutes/);
  res = await h.rpc1(phone, 'cal_rejoin', { p_name: 'Jean Louis', p_pin: '24680' });
  assert.equal(res.ok, false, 'the right PIN waits out the lock');
  assert.match(res.message, /Try again in 10 minutes/);

  await h.setNow('2026-10-13T16:11:00Z');
  res = await h.rpc1(phone, 'cal_rejoin', { p_name: 'Jean Louis', p_pin: '11111' });
  assert.match(res.message, /does not match/, 'the count starts over after a lock expires');
  res = await h.rpc1(phone, 'cal_rejoin', { p_name: 'Jean Louis', p_pin: '24680' });
  assert.equal(res.ok, true);
  assert.equal(res.member.member_id, first.memberId);

  assert.equal(await countPosts(h, phone), 128, 'the new device can read');
  assert.equal(await countPosts(h, first), 0, 'the old device is signed out of the record');
});

test('requests: brothers send and edit their own, with checks written for chairs', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const farid = await h.member('Farid Adenuga', '1906', 'Social & Fundraising');
  const david = await h.member('David Brown');

  const r = await h.rpc1(farid, 'cal_submit_request', { p_request: request() });
  assert.equal(r.status, 'new');
  assert.equal(r.member_id, farid.memberId);
  assert.deepEqual(r.platforms, ['facebook', 'instagram']);

  await assert.rejects(() => h.rpc(farid, 'cal_submit_request', { p_request: request({ platforms: [] }) }), /at least one place to post/);
  await assert.rejects(() => h.rpc(farid, 'cal_submit_request', { p_request: request({ post_date: '2026-10-01' }) }), /date has passed/);
  await assert.rejects(() => h.rpc(farid, 'cal_submit_request', { p_request: request({ youth: true }) }), /media releases/);
  await assert.rejects(() => h.rpc(farid, 'cal_submit_request', { p_request: request({ link: 'javascript:alert(1)' }) }), /https/);
  await assert.rejects(() => h.rpc(farid, 'cal_submit_request', { p_request: request({ platforms: ['myspace'] }) }), /from the list/);
  await assert.rejects(() => h.rpc(farid, 'cal_submit_request', { p_request: request({ post_date: 'next week' }) }), /real dates/);
  const stranger = await h.createUser({ anon: true });
  await assert.rejects(() => h.rpc(stranger, 'cal_submit_request', { p_request: request() }), /Sign in with the chapter code/);

  const edited = await h.rpc1(farid, 'cal_update_request', { p_id: r.id, p_request: request({ title: 'Wine and Chill flyer, final' }) });
  assert.equal(edited.title, 'Wine and Chill flyer, final');
  await assert.rejects(() => h.rpc(david, 'cal_update_request', { p_id: r.id, p_request: request() }), /only your own/);

  const queue = await h.select(david, 'select title from public.cal_requests');
  assert.equal(queue.length, 1, 'every brother sees the queue');
  await assert.rejects(() => h.rpc(david, 'cal_review_request', { p_id: r.id, p_status: 'declined', p_note: 'No' }), /Only the media team/);
  await assert.rejects(() => h.rpc(farid, 'cal_approve_request', { p_id: r.id, p_post: JSON.stringify({ date: '2026-11-30', title: 'x' }) }), /Only the media team/);
});

test('review: needs info, the chair answers, then approval puts it on the calendar', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff();
  const farid = await h.member('Farid Adenuga', '1906', 'Social & Fundraising');
  const r = await h.rpc1(farid, 'cal_submit_request', { p_request: request() });

  await assert.rejects(() => h.rpc(staff, 'cal_review_request', { p_id: r.id, p_status: 'needs-info' }), /Add a note/);
  const asked = await h.rpc1(staff, 'cal_review_request', { p_id: r.id, p_status: 'needs-info', p_note: 'Send the final flyer.' });
  assert.equal(asked.status, 'needs-info');
  assert.equal(asked.review_note, 'Send the final flyer.');

  const answered = await h.rpc1(farid, 'cal_update_request', { p_id: r.id, p_request: request({ asset_link: 'https://drive.google.com/final' }) });
  assert.equal(answered.status, 'new', 'an answer sends it back for review');

  const post = await h.rpc1(staff, 'cal_approve_request', {
    p_id: r.id,
    p_post: JSON.stringify({ date: '2026-11-30', title: 'Wine and Chill', category: 'chapter', format: 'flyer', platforms: ['instagram'], committee: 'Social & Fundraising' })
  });
  assert.equal(post.request_id, r.id);
  assert.equal(post.updated_by, staff.id);
  assert.match(post.id, /^p-[0-9a-f]{32}$/);
  const after = await h.sql('select status, post_id, review_note from public.cal_requests where id = $1', [r.id]);
  assert.deepEqual(after[0], { status: 'approved', post_id: post.id, review_note: null });
  await assert.rejects(() => h.rpc(farid, 'cal_update_request', { p_id: r.id, p_request: request() }), /already reviewed/);
  await assert.rejects(() => h.rpc(staff, 'cal_approve_request', { p_id: r.id, p_post: JSON.stringify({ date: '2026-11-30', title: 'Again' }) }), /already on the calendar/);
  assert.equal(await countPosts(h, farid), 129);
});

test('the media team signs up with an email login and the media code, then edits posts', async () => {
  const h = await createDb();
  const anonUser = await h.createUser({ anon: true });
  await assert.rejects(() => h.rpc(anonUser, 'cal_claim_staff', { p_code: MEDIA_CODE, p_name: 'Someone' }), /email account/);
  const email = await h.createUser({ email: 'media@example.org' });
  await assert.rejects(() => h.rpc(email, 'cal_claim_staff', { p_code: 'wrong code entirely', p_name: 'Eugene Aiken' }), /media code is not right/);
  const me = await h.rpc1(email, 'cal_claim_staff', { p_code: 'BLACK AND OLD GOLD MEDIA TEAM', p_name: 'Eugene Aiken' });
  assert.deepEqual(me, { role: 'staff', name: 'Eugene Aiken' });
  assert.deepEqual(await h.rpc1(email, 'cal_whoami'), { role: 'staff', name: 'Eugene Aiken' });

  const inserted = await h.select(email, `insert into public.cal_posts (id, date, title, category, platforms) values ('p-test-post', '2026-12-02', 'Test post', 'chapter', '{instagram}') returning updated_by`);
  assert.equal(inserted[0].updated_by, email.id);
  await h.select(email, `update public.cal_posts set status = 'posted' where id = '2026-10-16-mlk-memorial-15-years'`);
  const status = await h.sql(`select status, updated_by from public.cal_posts where id = '2026-10-16-mlk-memorial-15-years'`);
  assert.deepEqual(status[0], { status: 'posted', updated_by: email.id });
  await assert.rejects(
    () => h.select(email, `insert into public.cal_posts (date, title, platforms) values ('2026-12-02', 'Bad', '{myspace}')`),
    /check constraint/
  );
  await h.select(email, `delete from public.cal_posts where id = 'p-test-post'`);
  assert.equal(await countPosts(h, email), 128);
});

test('managing access: list, reset a PIN, remove a brother, change the chapter code', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff();
  const bro = await h.member('Chris Gooding', '4321', 'Education');
  await h.rpc1(bro, 'cal_submit_request', { p_request: request({ contact_name: 'Chris Gooding', committee: 'Education' }) });

  const list = await h.rpc(staff, 'cal_member_list');
  assert.equal(list.length, 1);
  assert.equal(list[0].display_name, 'Chris Gooding');
  assert.equal(Number(list[0].requests), 1);
  assert.equal(list[0].signed_in, true);
  await assert.rejects(() => h.rpc(bro, 'cal_member_list'), /Only the media team/);

  await h.rpc(staff, 'cal_reset_pin', { p_member_id: bro.memberId, p_pin: '777777' });
  const laptop = await h.createUser({ anon: true });
  const res = await h.rpc1(laptop, 'cal_rejoin', { p_name: 'Chris Gooding', p_pin: '777777' });
  assert.equal(res.ok, true);

  await h.rpc(staff, 'cal_remove_member', { p_member_id: bro.memberId });
  const kept = await h.sql('select member_id, contact_name from public.cal_requests');
  assert.deepEqual(kept[0], { member_id: null, contact_name: 'Chris Gooding' }, 'requests stay with the name on them');
  assert.equal(await countPosts(h, laptop), 0);

  await assert.rejects(() => h.rpc(staff, 'cal_set_chapter_code', { p_code: 'short' }), /at least 6/);
  await h.rpc(staff, 'cal_set_chapter_code', { p_code: 'Spring 2027 code' });
  const newbie = await h.createUser({ anon: true });
  await assert.rejects(() => h.rpc(newbie, 'cal_join', { p_code: CHAPTER_CODE, p_name: 'Remington Allen', p_pin: '2468' }), /not right/);
  const ok = await h.rpc1(newbie, 'cal_join', { p_code: 'spring 2027 code', p_name: 'Remington Allen', p_pin: '2468' });
  assert.equal(ok.role, 'member');
});

test('setup guards: placeholder codes are refused and sign-in waits for the codes', async () => {
  const h = await createDb({ codes: false });
  await assert.rejects(() => h.sql(`select cal_private.set_code('chapter', 'REPLACE WITH THE CHAPTER CODE')`), /placeholder/);
  assert.equal((await h.rpc1(null, 'cal_settings')).ready, false);
  const u = await h.createUser({ anon: true });
  await assert.rejects(() => h.rpc(u, 'cal_join', { p_code: 'anything', p_name: 'Sadiqq Elcock', p_pin: '1234' }), /not set up yet/);
  const email = await h.createUser({ email: 'x@example.org' });
  await assert.rejects(() => h.rpc(email, 'cal_claim_staff', { p_code: 'anything at all here', p_name: 'X Person' }), /not set up yet/);
});
