// Instagram and Threads results: connecting an account, saving each sync, matching posts to the
// calendar, the nightly schedule, and who can read the numbers. Vault, pg_net, and pg_cron are
// local stand-ins (harness.mjs). Run with the other database tests:
//   node --test "tests/calendar/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

const NOW = '2026-10-20T16:00:00Z';
const FUNCTIONS = 'https://uqfoifrpyysqjvwtkgia.supabase.co/functions/v1';
const DAYS_60 = 60 * 86400;
const TABLES = ['cal_social_accounts', 'cal_social_posts', 'cal_social_post_days', 'cal_social_account_days'];

// What the Edge Function does once Instagram or Threads sends the media team member back.
const connect = (h, platform, who, token = `${platform}-token-1`, functionsUrl = FUNCTIONS) =>
  h.sql('select cal_private.social_save_connection($1, $2, $3, $4, $5, $6, $7)',
    [platform, `${platform}-account-1`, 'gil1906', token, DAYS_60, who.id, functionsUrl]);

// What the Edge Function saves after each sync.
const sync = (h, platform, account, posts) =>
  h.sql('select cal_private.social_save_sync($1, $2::jsonb, $3::jsonb) as r',
    [platform, JSON.stringify(account), JSON.stringify(posts)]).then((rows) => rows[0].r);

const secret = (h, name) =>
  h.sql('select decrypted_secret from vault.decrypted_secrets where name = $1', [name]).then((rows) => rows.map((r) => r.decrypted_secret));

test('only the media team reads results and starts a Connect, and each Connect code works once', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff('Eugene Aiken');
  const chair = await h.chair('Farid Adenuga', 'Social & Fundraising');
  const bro = await h.member('David Brown');
  await connect(h, 'instagram', staff);
  await sync(h, 'instagram', { followers: 1500 }, [{ media_id: 'm1', posted_at: '2026-10-19T15:00:00Z', views: 10 }]);

  for (const t of TABLES) {
    await assert.rejects(() => h.select(null, `select * from public.${t}`), /permission denied/, `visitors can't read ${t}`);
    for (const who of [chair, bro]) assert.deepEqual(await h.select(who, `select * from public.${t}`), [], `brothers see no ${t}`);
    assert.equal((await h.select(staff, `select * from public.${t}`)).length, 1, `the media team reads ${t}`);
    await assert.rejects(() => h.select(staff, `delete from public.${t}`), /permission denied/, `the page can't change ${t}`);
  }
  await assert.rejects(() => h.select(staff, `update public.cal_social_posts set views = 1000000`), /permission denied/);
  for (const who of [null, bro, staff]) {
    await assert.rejects(() => h.select(who, 'select decrypted_secret from vault.decrypted_secrets'), /permission denied/);
    await assert.rejects(() => h.select(who, 'select * from cal_private.social_connect_states'), /permission denied/);
  }

  await assert.rejects(() => h.rpc(null, 'cal_social_connect_start', { p_platform: 'instagram' }), /permission denied/);
  await assert.rejects(() => h.rpc(chair, 'cal_social_connect_start', { p_platform: 'instagram' }), /Only the media team/);
  await assert.rejects(() => h.rpc(staff, 'cal_social_connect_start', { p_platform: 'facebook' }), /Instagram or Threads/);
  const state = await h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'threads', p_return: 'https://www.gil1906.org/calendar' });
  assert.match(state, /^[0-9a-f]{48}$/);

  const peek = (s) => h.sql('select * from cal_private.social_connect_peek($1)', [s]);
  const claim = (s) => h.sql('select * from cal_private.social_connect_claim($1)', [s]);
  assert.deepEqual(await peek(state), [{ platform: 'threads', return_to: 'https://www.gil1906.org/calendar' }]);
  assert.deepEqual(await claim(state), [{ platform: 'threads', user_id: staff.id, return_to: 'https://www.gil1906.org/calendar' }]);
  assert.deepEqual(await peek(state), [], 'a used code is gone');
  await assert.rejects(() => claim(state), /That Connect link has expired/);
  await assert.rejects(() => claim('not-a-code'), /That Connect link has expired/);

  // The page can only ask to come back to the chapter site, a preview of it, or a local test server.
  const returns = [
    ['https://gil1906.org/calendar.html', true],
    ['https://brooklyn-alphas-git-feat-calendar-results-gamma-iota-lambda.vercel.app/calendar.html', true],
    ['http://localhost:5181/calendar.html', true],
    ['https://www.gil1906.org.example.com/calendar.html', false],
    ['https://someone-else.vercel.app/calendar.html', false],
    ['javascript:alert(1)', false],
    ['https://www.gil1906.org/calendar.html"><script>', false]
  ];
  for (const [url, kept] of returns) {
    const s = await h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'instagram', p_return: url });
    assert.equal((await peek(s))[0].return_to, kept ? url : null, url);
  }

  // Codes last 30 minutes, and old ones are cleared out the next day.
  const late = await h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'instagram' });
  await h.setNow('2026-10-20T16:31:00Z');
  assert.deepEqual(await peek(late), []);
  await assert.rejects(() => claim(late), /expired/);
  await h.setNow('2026-10-22T16:00:00Z');
  await h.rpc1(staff, 'cal_social_connect_start', { p_platform: 'instagram' });
  assert.equal((await h.sql('select count(*)::int as n from cal_private.social_connect_states'))[0].n, 1);

  // The Edge Function's side runs only as the database owner.
  for (const who of [staff, chair]) {
    await assert.rejects(() => h.select(who, `select * from cal_private.social_connect_peek('x')`), /permission denied/);
    await assert.rejects(() => h.select(who, `select * from cal_private.social_token('instagram')`), /permission denied/);
  }
});

test('connecting keeps the token in Vault, renewals replace it, and disconnecting forgets it', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff();
  const chair = await h.chair('Farid Adenuga');
  await connect(h, 'instagram', staff, 'IG-token-1');

  assert.deepEqual(await secret(h, 'calendar_instagram_token'), ['IG-token-1']);
  const [account] = await h.select(staff, 'select * from public.cal_social_accounts');
  assert.equal(account.platform, 'instagram');
  assert.equal(account.username, 'gil1906');
  assert.equal(account.connected_by, staff.id);
  assert.equal(account.token_expires_at.toISOString(), '2026-12-19T16:00:00.000Z');
  assert.ok(!JSON.stringify(account).includes('IG-token'), 'the page never sees the token');
  assert.deepEqual(await h.sql(`select value from cal_private.config where key = 'functions_url'`), [{ value: FUNCTIONS }]);

  const token = () => h.sql(`select * from cal_private.social_token('instagram')`);
  assert.equal((await token())[0].token, 'IG-token-1');

  await h.setNow('2026-10-27T16:00:00Z');
  await h.sql(`select cal_private.social_save_token('instagram', 'IG-token-2', $1)`, [DAYS_60]);
  const [renewed] = await token();
  assert.equal(renewed.token, 'IG-token-2');
  assert.equal(renewed.refreshed_at.toISOString(), '2026-10-27T16:00:00.000Z');
  assert.equal(renewed.expires_at.toISOString(), '2026-12-26T16:00:00.000Z');
  assert.deepEqual(await secret(h, 'calendar_instagram_token'), ['IG-token-2'], 'one secret, replaced');
  await h.sql(`select cal_private.social_save_token('instagram', 'IG-token-3', 0)`);
  assert.equal((await token())[0].expires_at.toISOString(), '2026-12-26T16:00:00.000Z', 'no expiry given keeps the last one');
  await assert.rejects(() => h.sql(`select cal_private.social_save_token('instagram', '', $1)`, [DAYS_60]), /No token/);
  await assert.rejects(() => h.sql(`select cal_private.social_save_token('threads', 'TH', $1)`, [DAYS_60]), /not connected/);

  // A second platform, with an address that isn't an Edge Functions address: the saved one stays.
  await connect(h, 'threads', staff, 'TH-token-1', 'javascript:alert(1)');
  assert.deepEqual(await h.sql(`select value from cal_private.config where key = 'functions_url'`), [{ value: FUNCTIONS }]);
  await assert.rejects(() => connect(h, 'threads', staff, ''), /No access token came back/);
  await assert.rejects(() => connect(h, 'facebook', staff), /Unknown platform/);
  assert.deepEqual(await h.sql('select * from cal_private.social_connected() as p'), [{ p: 'instagram' }, { p: 'threads' }]);

  await assert.rejects(() => h.rpc(chair, 'cal_social_disconnect', { p_platform: 'instagram' }), /Only the media team/);
  await h.rpc(staff, 'cal_social_disconnect', { p_platform: 'instagram' });
  assert.deepEqual(await secret(h, 'calendar_instagram_token'), []);
  assert.deepEqual(await token(), []);
  assert.deepEqual((await h.select(staff, 'select platform from public.cal_social_accounts')).map((r) => r.platform), ['threads']);
  assert.deepEqual(await secret(h, 'calendar_threads_token'), ['TH-token-1']);
});

test('a sync saves each post, a daily snapshot for recent posts, and followers', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  await h.sql('delete from public.cal_posts');
  const staff = await h.staff();
  await assert.rejects(() => sync(h, 'instagram', {}, []), /instagram is not connected/);
  await connect(h, 'instagram', staff);

  const long = 'Brothers, '.repeat(60);
  let saved = await sync(h, 'instagram', { username: 'gil1906', followers: 1500, posts: 320 }, [
    {
      media_id: '1801', posted_at: '2026-10-19T22:15:00+0000', permalink: 'https://www.instagram.com/p/DQ1abc/',
      media_type: 'CAROUSEL_ALBUM', caption: `  Founders'\n\nDay   ${long}`,
      views: 900, reach: 700, likes: 80, comments: 6, saves: 9, shares: 12, interactions: 107
    },
    { media_id: '1702', posted_at: '2026-08-01T14:00:00Z', permalink: 'javascript:alert(1)', media_type: 'REELS', views: 5000, likes: 300 },
    { media_id: '', posted_at: '2026-10-01T14:00:00Z', views: 1 },
    { media_id: '1603', posted_at: null, views: 1 }
  ]);
  assert.deepEqual(saved, { posts: 2, matched: 0 }, 'posts without an id or a date are left out');

  const posts = () => h.select(staff, `
    select media_id, posted_at, permalink, media_type, caption, views::int, reach::int, likes::int, comments::int, saves::int,
      shares::int, replies::int, interactions::int
    from public.cal_social_posts order by media_id`);
  let [reel, carousel] = await posts();
  assert.equal(reel.permalink, null, 'only https links are kept');
  assert.equal(reel.media_type, 'REELS');
  assert.equal(reel.caption, null);
  assert.deepEqual([reel.views, reel.likes, reel.reach, reel.replies], [5000, 300, null, null]);
  assert.equal(carousel.posted_at.toISOString(), '2026-10-19T22:15:00.000Z');
  assert.equal(carousel.caption.length, 300);
  assert.ok(carousel.caption.startsWith("Founders' Day Brothers, Brothers,"), 'captions keep one line, trimmed');
  assert.deepEqual([carousel.views, carousel.reach, carousel.likes, carousel.comments, carousel.saves, carousel.shares, carousel.interactions],
    [900, 700, 80, 6, 9, 12, 107]);

  const days = () => h.select(staff, 'select media_id, day::text, views::int, likes::int from public.cal_social_post_days order by media_id, day');
  assert.deepEqual(await days(), [{ media_id: '1801', day: '2026-10-20', views: 900, likes: 80 }], 'snapshots cover the last 30 days');
  const followers = () => h.select(staff, 'select platform, day::text, followers::int, posts::int from public.cal_social_account_days order by day');
  assert.deepEqual(await followers(), [{ platform: 'instagram', day: '2026-10-20', followers: 1500, posts: 320 }]);

  // The next night, newer numbers for the recent post and just the like count for the older one.
  await h.setNow('2026-10-21T16:00:00Z');
  saved = await sync(h, 'instagram', { followers: 1504 }, [
    { media_id: '1801', posted_at: '2026-10-19T22:15:00Z', views: 1300, likes: 95, comments: 7 },
    { media_id: '1702', posted_at: '2026-08-01T14:00:00Z', likes: 302 }
  ]);
  assert.deepEqual(saved, { posts: 2, matched: 0 });
  [reel, carousel] = await posts();
  assert.deepEqual([reel.views, reel.likes], [5000, 302], 'numbers a sync leaves out stay');
  assert.deepEqual([carousel.views, carousel.reach, carousel.likes, carousel.comments], [1300, 700, 95, 7]);
  assert.equal(carousel.permalink, 'https://www.instagram.com/p/DQ1abc/');
  assert.ok(carousel.caption.startsWith("Founders' Day"));

  // Refresh now, later the same day, updates today's snapshot.
  await h.setNow('2026-10-21T18:00:00Z');
  await sync(h, 'instagram', { followers: 1506, posts: 321 }, [{ media_id: '1801', posted_at: '2026-10-19T22:15:00Z', views: 1400, likes: 96 }]);
  assert.deepEqual(await days(), [
    { media_id: '1801', day: '2026-10-20', views: 900, likes: 80 },
    { media_id: '1801', day: '2026-10-21', views: 1400, likes: 96 }
  ]);
  assert.deepEqual(await followers(), [
    { platform: 'instagram', day: '2026-10-20', followers: 1500, posts: 320 },
    { platform: 'instagram', day: '2026-10-21', followers: 1506, posts: 321 }
  ]);

  // A sync that doesn't finish leaves a note for the Results tab; the next good one clears it.
  await h.sql(`select cal_private.social_sync_failed('instagram', $1)`, ['x'.repeat(600)]);
  let [account] = await h.select(staff, 'select last_error, last_error_at, last_sync_at from public.cal_social_accounts');
  assert.equal(account.last_error.length, 500);
  assert.equal(account.last_error_at.toISOString(), '2026-10-21T18:00:00.000Z');
  await h.sql(`select cal_private.social_sync_failed('instagram', '  ')`);
  [account] = await h.select(staff, 'select last_error from public.cal_social_accounts');
  assert.equal(account.last_error, 'The sync did not finish.');
  await h.setNow('2026-10-22T08:20:00Z');
  await sync(h, 'instagram', {}, []);
  [account] = await h.select(staff, 'select last_error, last_error_at, last_sync_at from public.cal_social_accounts');
  assert.deepEqual([account.last_error, account.last_error_at, account.last_sync_at.toISOString()], [null, null, '2026-10-22T08:20:00.000Z']);
  await assert.rejects(() => sync(h, 'instagram', {}, { media_id: '1801' }), /Posts must be a list/);
});

test('posts match calendar posts by date, and the media team fixes the rest by hand', async () => {
  const h = await createDb();
  await h.setNow('2026-11-10T16:00:00Z');
  await h.sql('delete from public.cal_posts');
  const staff = await h.staff();
  const chair = await h.chair('Farid Adenuga');
  const calendar = [
    ['p-a', '2026-11-02', '{instagram,threads}', 'planned', 'graphic'],
    ['p-b', '2026-11-03', '{instagram}', 'planned', 'story'],
    ['p-c', '2026-11-04', '{instagram}', 'planned', 'graphic'],
    ['p-d', '2026-11-04', '{instagram}', 'planned', 'carousel'],
    ['p-e', '2026-11-05', '{threads}', 'planned', 'text'],
    ['p-f', '2026-11-06', '{instagram}', 'skipped', 'graphic'],
    ['p-g', '2026-11-07', '{instagram}', 'planned', 'graphic'],
    ['p-h', '2026-11-08', '{instagram}', 'posted', 'reel']
  ];
  for (const [id, date, platforms, status, format] of calendar) {
    await h.sql('insert into public.cal_posts (id, date, title, platforms, status, format) values ($1, $2, $3, $4, $5, $6)',
      [id, date, `Calendar post ${id}`, platforms, status, format]);
  }
  await connect(h, 'instagram', staff);
  await connect(h, 'threads', staff);

  // New York time decides the day: Nov. 9 at 02:00 UTC is 9 p.m. on Nov. 8.
  const ig = [
    ['m1', '2026-11-02T23:00:00Z'], ['m2', '2026-11-03T17:00:00Z'], ['m3', '2026-11-04T17:00:00Z'],
    ['m4', '2026-11-05T17:00:00Z'], ['m5', '2026-11-06T17:00:00Z'], ['m6', '2026-11-07T15:00:00Z'],
    ['m7', '2026-11-07T20:00:00Z'], ['m8', '2026-11-09T02:00:00Z']
  ];
  const th = [['t1', '2026-11-02T23:05:00Z'], ['t2', '2026-11-05T18:00:00Z'], ['t3', '2026-11-04T18:00:00Z']];
  const asPosts = (list) => list.map(([media_id, posted_at]) => ({ media_id, posted_at, views: 100 }));
  assert.deepEqual(await sync(h, 'instagram', {}, asPosts(ig)), { posts: 8, matched: 2 });
  assert.deepEqual(await sync(h, 'threads', {}, asPosts(th)), { posts: 3, matched: 2 });

  const matches = async () => Object.fromEntries((await h.select(staff, `
    select platform || ':' || media_id as k, coalesce(post_id, '-') || ' ' || coalesce(match_source, '-') as v
    from public.cal_social_posts order by 1`)).map((r) => [r.k, r.v]));
  const expected = {
    'instagram:m1': 'p-a date', // one post that day, one calendar post for Instagram
    'instagram:m2': '- -', // the calendar post that day is a story
    'instagram:m3': '- -', // two calendar posts that day
    'instagram:m4': '- -', // the calendar post that day is for Threads only
    'instagram:m5': '- -', // the calendar post that day was skipped
    'instagram:m6': '- -', // two posts went out that day
    'instagram:m7': '- -',
    'instagram:m8': 'p-h date', // 9 p.m. on Nov. 8 in New York
    'threads:t1': 'p-a date', // one calendar post can match on each platform
    'threads:t2': 'p-e date',
    'threads:t3': '- -' // the calendar posts that day are for Instagram
  };
  assert.deepEqual(await matches(), expected);

  // Hand matches stay put, and take that calendar post out of date matching.
  const setMatch = (who, media, post, auto = false) =>
    h.rpc(who, 'cal_social_set_match', { p_platform: media.startsWith('t') ? 'threads' : 'instagram', p_media_id: media, p_post_id: post, p_auto: auto });
  await assert.rejects(() => setMatch(chair, 'm3', 'p-c'), /Only the media team/);
  await assert.rejects(() => setMatch(staff, 'm99', 'p-c'), /no longer in the results/);
  await assert.rejects(() => setMatch(staff, 'm3', 'p-zzz'), /no longer exists/);
  await setMatch(staff, 'm3', 'p-c');
  await setMatch(staff, 'm6', 'p-g');
  await setMatch(staff, 'm2', null);
  Object.assign(expected, { 'instagram:m3': 'p-c manual', 'instagram:m6': 'p-g manual', 'instagram:m2': '- none' });
  assert.deepEqual(await matches(), expected, 'm7 stays open: p-g already has its post');
  await sync(h, 'instagram', {}, asPosts(ig));
  assert.deepEqual(await matches(), expected, 'the next sync keeps hand matches');

  // Calendar edits rematch right away.
  const edit = (sql) => h.select(staff, sql);
  await edit(`update public.cal_posts set status = 'planned' where id = 'p-f'`);
  expected['instagram:m5'] = 'p-f date';
  assert.deepEqual(await matches(), expected, 'un-skipping a post');
  await edit(`update public.cal_posts set date = '2026-11-10' where id = 'p-a'`);
  assert.deepEqual(await matches(), { ...expected, 'instagram:m1': '- -', 'threads:t1': '- -' }, 'moving a post');
  await edit(`update public.cal_posts set date = '2026-11-02' where id = 'p-a'`);
  assert.deepEqual(await matches(), expected);
  await edit(`update public.cal_posts set platforms = '{instagram}' where id = 'p-e'`);
  Object.assign(expected, { 'instagram:m4': 'p-e date', 'threads:t2': '- -' });
  assert.deepEqual(await matches(), expected, 'changing platforms');
  await edit(`delete from public.cal_posts where id = 'p-h'`);
  expected['instagram:m8'] = '- -';
  assert.deepEqual(await matches(), expected, 'deleting a post');
  await edit(`delete from public.cal_posts where id = 'p-c'`);
  expected['instagram:m3'] = 'p-d date';
  assert.deepEqual(await matches(), expected, 'a hand match whose calendar post is deleted goes back to matching by date');

  await setMatch(staff, 'm6', null, true);
  expected['instagram:m6'] = '- -';
  assert.deepEqual(await matches(), expected, 'back to automatic: two posts that day, so no match');
  await setMatch(staff, 'm2', null, true);
  expected['instagram:m2'] = '- -';
  assert.deepEqual(await matches(), expected);
});

test('every night pg_cron asks the Edge Function to sync, and the media team can refresh sooner', async () => {
  const h = await createDb();
  await h.setNow(NOW);
  const staff = await h.staff();
  const chair = await h.chair('Farid Adenuga');
  const [job] = await h.sql(`select schedule, command, active from cron.job where jobname = 'gil-calendar-social-sync'`);
  assert.deepEqual(job, { schedule: '20 8 * * *', command: 'select cal_private.social_sync_request()', active: true });

  const calls = () => h.sql('select url, body, headers, timeout_milliseconds from net.http_calls order by id');
  const nightly = () => h.sql(job.command); // pg_cron runs it as the database owner
  await nightly();
  assert.equal((await calls()).length, 0, 'nothing to sync before an account is connected');
  assert.deepEqual(await h.rpc1(staff, 'cal_social_sync_now'), { ok: false, message: 'Connect Instagram or Threads first.' });

  await connect(h, 'instagram', staff);
  await nightly();
  const [call] = await calls();
  assert.equal(call.url, `${FUNCTIONS}/calendar-social/sync`);
  assert.deepEqual(call.body, {});
  assert.equal(call.timeout_milliseconds, 30000);
  const key = call.headers['x-sync-key'];
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual(await secret(h, 'calendar_social_sync_key'), [key]);
  const keyOk = (k) => h.sql('select cal_private.social_sync_key_ok($1) as ok', [k]).then((rows) => rows[0].ok);
  assert.equal(await keyOk(key), true);
  for (const wrong of ['wrong', '', null, key.toUpperCase()]) assert.equal(await keyOk(wrong), false, String(wrong));

  await assert.rejects(() => h.rpc(null, 'cal_social_sync_now'), /permission denied/);
  await assert.rejects(() => h.rpc(chair, 'cal_social_sync_now'), /Only the media team/);
  assert.deepEqual(await h.rpc1(staff, 'cal_social_sync_now'), { ok: true, message: 'Refreshing. New numbers show up in a minute or two.' });
  assert.deepEqual(await h.rpc1(staff, 'cal_social_sync_now'),
    { ok: false, message: 'A refresh is already on its way. Check back in a few minutes.' });
  await h.setNow('2026-10-20T16:11:00Z');
  assert.equal((await h.rpc1(staff, 'cal_social_sync_now')).ok, true);
  assert.equal((await calls()).length, 3);

  for (const who of [null, chair, staff]) {
    await assert.rejects(() => h.select(who, 'select cal_private.social_sync_request()'), /permission denied/);
    await assert.rejects(() => h.select(who, `select cal_private.social_save_sync('instagram', '{}', '[]')`), /permission denied/);
    await assert.rejects(() => h.select(who, `select cal_private.social_sync_key_ok('x')`), /permission denied/);
  }
});

test('the results migration runs on a project that already ran the first three', async () => {
  const h = await createDb({
    migrations: ['20261013000100_content_calendar.sql', '20261013000200_chairs_and_request_files.sql', '20261014000100_request_emails.sql']
  });
  await h.setNow(NOW);
  const staff = await h.staff();
  const chair = await h.chair('Farid Adenuga', 'Social & Fundraising');
  const sent = await h.rpc1(chair, 'cal_submit_request', {
    p_request: JSON.stringify({
      contact_name: 'Farid Adenuga', committee: 'Social & Fundraising', title: 'Wine and Chill flyer', post_date: '2026-11-30',
      about: 'Promote the December Wine and Chill.', format: 'flyer', platforms: ['instagram'], youth: false, releases: false
    })
  });

  await h.migrate('20261018000100_social_results.sql');

  assert.equal((await h.select(staff, 'select id from public.cal_posts')).length, 128);
  assert.deepEqual((await h.select(staff, 'select id from public.cal_requests')).map((r) => r.id), [sent.id]);
  for (const t of TABLES) assert.deepEqual(await h.select(staff, `select * from public.${t}`), []);
  assert.equal((await secret(h, 'calendar_social_sync_key')).length, 1);
  await h.select(staff, `update public.cal_posts set status = 'posted' where id = '2026-11-03-election-day'`);
  assert.equal((await h.sql(`select status from public.cal_posts where id = '2026-11-03-election-day'`))[0].status, 'posted');
});
