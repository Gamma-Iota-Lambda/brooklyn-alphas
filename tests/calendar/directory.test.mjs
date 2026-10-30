// Brother directory database tests: access rules, claiming and editing records, the media team's
// tools, and the morning greetings run, on real Postgres (PGlite).
//   node --test "tests/calendar/directory.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const NOW = '2026-10-30T13:00:00Z';

// Sample brothers (not real people).
const SAMPLE = [
  { first_name: 'Marcus', last_name: 'Bell', status: 'current', phone: '718-555-0101', email: 'marcus@example.org',
    address: '12 Hancock St', city: 'Brooklyn', state: 'NY', zip: '11216', birth_date: '1988-10-30', crossing_date: '2016-10-30' },
  { first_name: 'Andre', last_name: 'Pierre', suffix: 'Jr.', status: 'current', life_member: true, phone: '(347) 555-0102',
    email: 'andre@example.org', birth_date: '1976-02-29', crossing_date: '1996-03-16' },
  { first_name: 'Calvin', last_name: 'Reed', status: 'not-current', phone: '9175550103', crossing_date: '2010-10-31' },
  { first_name: 'Walter', last_name: 'Greene', status: 'deceased', birth_date: '1940-10-30', crossing_date: '1961-10-30' },
  { first_name: 'Theo', last_name: 'Mason', status: 'current', email: 'theo@example.org', share_contact: false,
    phone: '7185550105', birth_date: '1990-10-31', crossing_date: '2020-03-07' }
];

async function seeded() {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff('Eugene Aiken');
  const res = await h.rpc1(staff, 'dir_import', { p_rows: JSON.stringify(SAMPLE) });
  assert.deepEqual(res, { added: 5, updated: 0 });
  await h.sql(`select cal_private.set_email_settings('re_testkey_12345678', 'GIL Content Calendar <calendar@mail.gil1906.org>')`);
  return { h, staff };
}

const byName = (rows, last) => rows.find((b) => b.last_name === last);
const calls = (h) => h.sql('select url, body from net.http_calls order by id');

test('the import cleans phones, keeps notes, and updates on a second run', async () => {
  const { h, staff } = await seeded();
  const rows = await h.rpc(staff, 'dir_list');
  const list = rows.map((r) => r.dir_list);
  assert.equal(list.length, 5);
  assert.deepEqual(list.map((b) => b.last_name), ['Bell', 'Greene', 'Mason', 'Pierre', 'Reed'], 'sorted by last name');
  assert.equal(byName(list, 'Pierre').phone, '3475550102');
  assert.equal(byName(list, 'Pierre').name, 'Andre Pierre Jr.');
  assert.equal(byName(list, 'Bell').years, 10);
  assert.equal(byName(list, 'Bell').address, '12 Hancock St', 'the media team sees addresses');

  const again = await h.rpc1(staff, 'dir_import', { p_rows: JSON.stringify([
    { first_name: 'marcus', last_name: 'BELL', city: 'Queens', notes: 'moved' },
    { first_name: 'New', last_name: 'Brother', phone: '718-555-0199' }
  ]) });
  assert.deepEqual(again, { added: 1, updated: 1 });
  const bell = (await h.sql(`select city, email, notes from public.dir_brothers where last_name = 'Bell'`))[0];
  assert.deepEqual(bell, { city: 'Queens', email: 'marcus@example.org', notes: 'moved' }, 'fields not in the row are kept');

  await assert.rejects(() => h.rpc(staff, 'dir_import', { p_rows: JSON.stringify([{ first_name: 'No', last_name: 'Phone', phone: '12345' }]) }), /Row 1: Use a 10-digit phone/);
});

test('visitors and strangers see nothing; brothers see shared details only', async () => {
  const { h } = await seeded();
  await assert.rejects(() => h.rpc(null, 'dir_list'), /permission denied/);
  await assert.rejects(() => h.select(null, 'select * from public.dir_brothers'), /permission denied/);
  const stranger = await h.createUser({ anon: true });
  await assert.rejects(() => h.rpc(stranger, 'dir_list'), /Sign in with the chapter code/);
  assert.equal((await h.select(stranger, 'select * from public.dir_brothers')).length, 0);

  const bro = await h.member('Marcus Bell', '1906');
  assert.equal((await h.select(bro, 'select * from public.dir_brothers')).length, 0, 'the table itself stays closed');
  assert.equal((await h.select(bro, 'select * from public.dir_messages')).length, 0);
  const list = (await h.rpc(bro, 'dir_list')).map((r) => r.dir_list);
  assert.equal(list.length, 5);
  const bell = byName(list, 'Bell');
  assert.equal(bell.phone, '7185550101');
  assert.equal(bell.birthday, '10-30');
  assert.equal(bell.birth_date, undefined, 'no birth year');
  assert.equal(bell.address, undefined, 'no street address');
  assert.equal(bell.notes, undefined);
  assert.equal(bell.claimed, false);
  const theo = byName(list, 'Mason');
  assert.equal(theo.phone, null, 'a brother who does not share contact details');
  assert.equal(theo.email, null);
  assert.equal(theo.birthday, '10-31', 'birthdays still show for shoutouts');
  assert.equal(await h.rpc1(bro, 'dir_me'), null);
});

test('a brother claims his record with the last four digits of his phone, then edits it', async () => {
  const { h } = await seeded();
  const bro = await h.member('Marcus Bell', '1906');
  const other = await h.member('Calvin Reed', '2222');
  const id = (await h.sql(`select id from public.dir_brothers where last_name = 'Bell'`))[0].id;
  const greeneId = (await h.sql(`select id from public.dir_brothers where last_name = 'Greene'`))[0].id;

  await assert.rejects(() => h.rpc(bro, 'dir_claim', { p_id: id, p_check: '0000' }), /do not match/);
  await assert.rejects(() => h.rpc(bro, 'dir_claim', { p_id: id, p_check: '01' }), /do not match/);
  await assert.rejects(() => h.rpc(bro, 'dir_claim', { p_id: greeneId, p_check: '0101' }), /no phone number on file/);
  const me = await h.rpc1(bro, 'dir_claim', { p_id: id, p_check: '0101' });
  assert.equal(me.name, 'Marcus Bell');
  assert.equal(me.address, '12 Hancock St');
  assert.equal(me.birth_date, '1988-10-30');
  await assert.rejects(() => h.rpc(other, 'dir_claim', { p_id: id, p_check: '0101' }), /already claimed/);
  await assert.rejects(() => h.rpc(bro, 'dir_claim', { p_id: greeneId, p_check: '0101' }), /already have a record/);
  assert.equal((await h.rpc1(bro, 'dir_me')).id, id);

  const saved = await h.rpc1(bro, 'dir_update_me', { p: JSON.stringify({
    email: 'Marcus.Bell@Example.org', phone: '718 555 0111', city: 'Brooklyn', greetings: false, status: 'deceased', notes: 'hacked', life_member: true
  }) });
  assert.equal(saved.email, 'marcus.bell@example.org');
  assert.equal(saved.phone, '7185550111');
  assert.equal(saved.greetings, false);
  assert.equal(saved.status, 'current', 'a brother cannot change his standing');
  assert.equal(saved.life_member, false);
  assert.equal(saved.notes, null);
  await assert.rejects(() => h.rpc(bro, 'dir_update_me', { p: JSON.stringify({ birth_date: '2030-01-01' }) }), /not possible/);
  await assert.rejects(() => h.rpc(bro, 'dir_update_me', { p: JSON.stringify({ crossing_date: '1990-01-01' }) }), /less than 16 years apart/);
  await assert.rejects(() => h.rpc(bro, 'dir_update_me', { p: JSON.stringify({ first_name: '' }) }), /first and last name/);
  await assert.rejects(() => h.rpc(other, 'dir_update_me', { p: JSON.stringify({ city: 'X' }) }), /Claim your record first/);
});

test('a brother not in the directory adds himself, marked for review', async () => {
  const { h, staff } = await seeded();
  const bro = await h.member('Jamal Hart', '3333');
  await assert.rejects(() => h.rpc(bro, 'dir_add_self', { p: JSON.stringify({ first_name: 'Marcus', last_name: 'Bell' }) }), /Claim it instead/);
  const me = await h.rpc1(bro, 'dir_add_self', { p: JSON.stringify({ first_name: 'Jamal', last_name: 'Hart', phone: '718-555-0120', status: 'deceased' }) });
  assert.equal(me.pending, true);
  assert.equal(me.status, 'current');
  await assert.rejects(() => h.rpc(bro, 'dir_add_self', { p: JSON.stringify({ first_name: 'Jamal', last_name: 'Hart' }) }), /already have a record/);
  const list = (await h.rpc(staff, 'dir_list')).map((r) => r.dir_list);
  assert.equal(byName(list, 'Hart').pending, true);
  const ok = await h.rpc1(staff, 'dir_save', { p_id: me.id, p: JSON.stringify({ pending: false, notes: 'Confirmed at the November meeting' }) });
  assert.equal(ok.pending, false);
});

test('the media team edits anyone, links sign-ins, and removes records', async () => {
  const { h, staff } = await seeded();
  const bro = await h.member('Calvin Reed', '2222');
  const id = (await h.sql(`select id from public.dir_brothers where last_name = 'Reed'`))[0].id;
  const bellId = (await h.sql(`select id from public.dir_brothers where last_name = 'Bell'`))[0].id;

  await assert.rejects(() => h.rpc(bro, 'dir_save', { p_id: id, p: JSON.stringify({ city: 'X' }) }), /Only the media team/);
  await assert.rejects(() => h.rpc(bro, 'dir_link', { p_id: id, p_member_id: bro.memberId }), /Only the media team/);
  await assert.rejects(() => h.rpc(bro, 'dir_delete', { p_id: id }), /Only the media team/);
  await assert.rejects(() => h.rpc(bro, 'dir_set_settings', { p: '{}' }), /Only the media team/);

  const linked = await h.rpc1(staff, 'dir_link', { p_id: id, p_member_id: bro.memberId });
  assert.equal(linked.member_id, bro.memberId);
  assert.equal((await h.rpc1(bro, 'dir_me')).id, id);
  await assert.rejects(() => h.rpc(staff, 'dir_link', { p_id: bellId, p_member_id: bro.memberId }), /already linked to another record/);
  const unlinked = await h.rpc1(staff, 'dir_link', { p_id: id, p_member_id: null });
  assert.equal(unlinked.member_id, null);

  const saved = await h.rpc1(staff, 'dir_save', { p_id: id, p: JSON.stringify({ status: 'current', life_member: true, notes: 'Paid dues Oct. 2026', birth_date: '1980-05-05' }) });
  assert.equal(saved.status, 'current');
  assert.equal(saved.life_member, true);
  assert.equal(saved.notes, 'Paid dues Oct. 2026');
  const added = await h.rpc1(staff, 'dir_save', { p_id: null, p: JSON.stringify({ first_name: 'Omar', last_name: 'Diallo', phone: '718-555-0130' }) });
  assert.equal(added.name, 'Omar Diallo');
  await h.rpc(staff, 'dir_delete', { p_id: added.id });
  assert.equal((await h.sql(`select count(*)::int n from public.dir_brothers where last_name = 'Diallo'`))[0].n, 0);
  await assert.rejects(() => h.rpc(staff, 'dir_delete', { p_id: added.id }), /no longer in the directory/);

  // The media team reads the table directly too.
  assert.equal((await h.select(staff, 'select * from public.dir_brothers')).length, 5);
});

test('the morning run emails birthdays and anniversaries once, and the media team about tomorrow', async () => {
  const { h, staff } = await seeded();
  // October 30, 2026: Marcus Bell's birthday and 10-year anniversary; Walter Greene is deceased and skipped.
  let res = await h.sql(`select cal_private.dir_run_greetings() as r`);
  assert.deepEqual(res[0].r, { day: '2026-10-30', sent: 2, skipped: 0, digest: true });
  let sent = await calls(h);
  assert.equal(sent.length, 3);
  assert.ok(sent.every((c) => c.url === 'https://api.resend.com/emails'));
  const birthday = sent.find((c) => /birthday/i.test(c.body.subject));
  assert.deepEqual(birthday.body.to, ['marcus@example.org']);
  assert.equal(birthday.body.subject, 'Happy birthday, Brother Marcus');
  assert.match(birthday.body.text, /celebrate you today/);
  assert.match(birthday.body.html, /Gamma Iota Lambda Chapter/);
  assert.match(birthday.body.html, /gil1906.org\/directory/);
  const anniv = sent.find((c) => /anniversary/i.test(c.body.subject));
  assert.equal(anniv.body.subject, 'Happy Alpha anniversary, Brother Marcus: 10 years in the bond');
  assert.match(anniv.body.text, /On this day in 2016/);
  assert.match(anniv.body.text, /10 years of brotherhood/);
  const digest = sent.find((c) => /Tomorrow/.test(c.body.subject));
  assert.deepEqual(digest.body.to, ['eugene@example.org']);
  assert.match(digest.body.subject, /^Tomorrow, Saturday, October 31: 2 brothers to celebrate$/);
  assert.match(digest.body.text, /Birthday: Theo Mason/);
  assert.match(digest.body.text, /Alpha anniversary: Calvin Reed \(16 years, crossed October 31, 2010\)\. No email on file.*917-555-0103/);

  // A second run the same morning sends nothing new.
  res = await h.sql(`select cal_private.dir_run_greetings() as r`);
  assert.deepEqual(res[0].r, { day: '2026-10-30', sent: 0, skipped: 2, digest: false });
  assert.equal((await calls(h)).length, 3);
  const log = await h.select(staff, 'select kind, day, sent_to from public.dir_messages order by id');
  assert.deepEqual(log.map((m) => m.kind).sort(), ['anniversary', 'birthday', 'digest']);

  // The next day: Theo asked for no greetings? No: he gets his birthday email; Calvin has no email.
  await h.setNow('2026-10-31T13:00:00Z');
  res = await h.sql(`select cal_private.dir_run_greetings() as r`);
  assert.equal(res[0].r.sent, 1);
  assert.equal(res[0].r.skipped, 1);
  assert.equal(res[0].r.digest, false, 'nothing to report for November 1');
});

test('greetings respect each brother\'s choice, the master switch, and leap-day birthdays', async () => {
  const { h, staff } = await seeded();
  await h.sql(`update public.dir_brothers set greetings = false where last_name = 'Bell'`);
  let res = (await h.sql(`select cal_private.dir_run_greetings() as r`))[0].r;
  assert.equal(res.sent, 0);
  assert.equal(res.skipped, 2);

  await h.rpc(staff, 'dir_set_settings', { p: JSON.stringify({ greetings_on: false, digest_on: false }) });
  await h.sql(`update public.dir_brothers set greetings = true where last_name = 'Bell'`);
  res = (await h.sql(`select cal_private.dir_run_greetings() as r`))[0].r;
  assert.deepEqual(res, { day: '2026-10-30', sent: 0, skipped: 0, digest: false });
  const s = await h.rpc1(staff, 'dir_settings');
  assert.equal(s.greetings_on, false);
  assert.equal(s.digest_on, false);
  assert.equal(s.email_ready, true);

  await h.rpc(staff, 'dir_set_settings', { p: JSON.stringify({ greetings_on: true }) });
  // 2027 has no February 29: Andre's birthday goes out on the 28th.
  await h.setNow('2027-02-28T13:00:00Z');
  res = (await h.sql(`select cal_private.dir_run_greetings() as r`))[0].r;
  assert.equal(res.sent, 1);
  const last = (await calls(h)).pop();
  assert.deepEqual(last.body.to, ['andre@example.org']);
  // 2028 has one: the 28th sends nothing, the 29th does.
  await h.setNow('2028-02-28T13:00:00Z');
  assert.equal((await h.sql(`select cal_private.dir_run_greetings() as r`))[0].r.sent, 0);
  await h.setNow('2028-02-29T13:00:00Z');
  assert.equal((await h.sql(`select cal_private.dir_run_greetings() as r`))[0].r.sent, 1);
});

test('the media team edits the messages, previews them, and sends a test', async () => {
  const { h, staff } = await seeded();
  const bro = await h.member('Marcus Bell', '1906');
  await assert.rejects(() => h.rpc(bro, 'dir_send_test', { p_kind: 'birthday' }), /Only the media team/);
  await assert.rejects(() => h.rpc(bro, 'dir_preview', { p_kind: 'birthday', p_subject: '', p_text: '' }), /Only the media team/);

  const prev = await h.rpc1(staff, 'dir_preview', { p_kind: 'anniversary', p_subject: '', p_text: 'Brother {name}, {years_text} ({ordinal}) since {crossing_year}. {date}' });
  assert.equal(prev.subject, 'Happy Alpha anniversary, Brother Charles: 10 years in the bond');
  assert.equal(prev.text, 'Brother Charles Wesley, 10 years (10th) since 2016. October 30, 2026');

  const s = await h.rpc1(staff, 'dir_set_settings', { p: JSON.stringify({ birthday_subject: 'Many happy returns, {first_name}', birthday_text: 'Enjoy the day, Brother {first_name}.' }) });
  assert.equal(s.birthday_subject, 'Many happy returns, {first_name}');
  await assert.rejects(() => h.rpc(staff, 'dir_set_settings', { p: JSON.stringify({ from: 'not an address' }) }), /Use a sender like/);
  await assert.rejects(() => h.rpc(staff, 'dir_set_settings', { p: JSON.stringify({ nope: 1 }) }), /Unknown setting/);

  const t = await h.rpc1(staff, 'dir_send_test', { p_kind: 'birthday' });
  assert.equal(t.to, 'eugene@example.org');
  assert.equal(t.subject, 'Many happy returns, Sample');
  const last = (await calls(h)).pop();
  assert.equal(last.body.subject, '[Test] Many happy returns, Sample');
  assert.equal(last.body.text, 'Enjoy the day, Brother Sample.');
  // Resetting a template to its default clears the override.
  const back = await h.rpc1(staff, 'dir_set_settings', { p: JSON.stringify({ birthday_subject: '' }) });
  assert.equal(back.birthday_subject, 'Happy birthday, Brother {first_name}');

  // Without email set up, tests say so and the morning run sends nothing.
  await h.sql(`delete from vault.secrets where name = 'calendar_resend_api_key'`);
  await assert.rejects(() => h.rpc(staff, 'dir_send_test', { p_kind: 'birthday' }), /Email is not set up yet/);
  const res = (await h.sql(`select cal_private.dir_run_greetings() as r`))[0].r;
  assert.equal(res.sent, 0);
  assert.equal((await h.rpc1(null, 'dir_settings')).email_ready, false);
});

test('the run never throws: a failing mail path is logged and reported', async () => {
  const { h } = await seeded();
  await h.sql(`select set_config('app.net_fail', 'on', false)`);
  const res = (await h.sql(`select cal_private.dir_run_greetings() as r`))[0].r;
  assert.equal(res.day, '2026-10-30');
  assert.match(res.error, /pg_net is not available/);
});
