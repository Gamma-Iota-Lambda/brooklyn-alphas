// What the Results tab makes of each connected account: fine, needs a new sign-in, or stuck.
// The rules are in assets/calendar/sync-health.js; the notes are the Edge Function's own, so a
// change of wording there that the page would misread fails here.
// Run with the other tests: node --test "tests/calendar/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncHealth, STUCK_AFTER } from '../../assets/calendar/sync-health.js';
import { friendly, GraphError } from '../../supabase/functions/calendar-social/social.js';

const NOW = Date.parse('2026-11-16T15:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3600000, D = 24 * H;
const account = (over = {}) => ({
  platform: 'instagram', username: 'gil1906', connectedAt: ago(28 * D), tokenExpiresAt: new Date(NOW + 50 * D).toISOString(),
  lastSyncAt: ago(7 * H), lastError: '', lastErrorAt: '', ...over
});
const health = (over) => syncHealth(account(over), NOW);
const BLOCKED = friendly(new GraphError('API access blocked.', { kind: 'blocked', code: 200 }), 'Instagram');
const TOKEN = friendly(new GraphError('Session has expired.', { kind: 'token', code: 190 }), 'Instagram');
const RATE_NOTE = 'Instagram asked the calendar to slow down. Numbers for some posts update on the next sync.';

test('an account that synced last night is fine, with or without a note from that sync', () => {
  assert.deepEqual(health(), { state: 'ok', expired: false, failed: false, quiet: false, silent: false, waiting: false, expires: NOW + 50 * D });
  // A note saved with the sync carries the sync's time, give or take the moment between statements.
  for (const gap of [0, 400, 10000]) {
    const h = health({ lastError: RATE_NOTE, lastErrorAt: new Date(NOW - 7 * H + gap).toISOString() });
    assert.deepEqual([h.state, h.failed], ['ok', false], `${gap} ms after the sync`);
  }
  assert.equal(health({ lastError: RATE_NOTE, lastErrorAt: new Date(NOW - 7 * H + 10001).toISOString() }).failed, true, 'anything later is another try');
});

test('a try that saved nothing shows as stuck, and a block never asks for a new sign-in', () => {
  // One failed night.
  let h = health({ lastSyncAt: ago(31 * H), lastError: "Instagram didn't answer. The next sync tries again.", lastErrorAt: ago(7 * H) });
  assert.deepEqual([h.state, h.failed, h.quiet], ['stuck', true, false]);
  // Blocked for weeks: the function's note today, and the one the earlier function left.
  for (const note of [BLOCKED, 'Instagram sent an error: API access blocked.']) {
    h = health({ lastSyncAt: ago(28 * D), lastError: note, lastErrorAt: ago(7 * H) });
    assert.deepEqual([h.state, h.failed], ['stuck', true], note);
  }
  assert.doesNotMatch(BLOCKED, /reconnect/i, 'pages still open from before this change look for that word');
  // Never synced, and the first try failed.
  h = health({ connectedAt: ago(2 * H), lastSyncAt: '', lastError: BLOCKED, lastErrorAt: ago(2 * H) });
  assert.deepEqual([h.state, h.failed, h.waiting], ['stuck', true, false]);
});

test('a failure with no try since means the sync has stopped running too', () => {
  // Blocked, and still trying every night.
  assert.equal(health({ lastSyncAt: ago(28 * D), lastError: BLOCKED, lastErrorAt: ago(7 * H) }).silent, false);
  assert.equal(health({ lastSyncAt: ago(28 * D), lastError: BLOCKED, lastErrorAt: ago(STUCK_AFTER) }).silent, false);
  // The same note, but the last try was two weeks ago: the nightly request no longer arrives.
  const h = health({ lastSyncAt: ago(28 * D), lastError: BLOCKED, lastErrorAt: ago(14 * D) });
  assert.deepEqual([h.state, h.failed, h.silent, h.quiet], ['stuck', true, true, false]);
  // A note that came with a sync is never a failure, however old; quiet covers that.
  const old = health({ lastSyncAt: ago(5 * D), lastError: RATE_NOTE, lastErrorAt: new Date(NOW - 5 * D + 300).toISOString() });
  assert.deepEqual([old.silent, old.quiet], [false, true]);
});

test('a sign-in that stopped working or ran out asks for Reconnect', () => {
  assert.match(TOKEN, /Choose Reconnect/);
  assert.equal(health({ lastSyncAt: ago(31 * H), lastError: TOKEN, lastErrorAt: ago(7 * H) }).state, 'reconnect');
  assert.equal(health({ lastSyncAt: ago(31 * H), lastError: 'The Instagram connection expired. Choose Reconnect on the Results tab.', lastErrorAt: ago(7 * H) }).state, 'reconnect');
  // The reminder that renewing failed comes with a sync that saved.
  const reminder = "Renewing the Instagram connection didn't work. Choose Reconnect on the Results tab before December 17.";
  assert.deepEqual([health({ lastError: reminder, lastErrorAt: ago(7 * H) }).state, health({ lastError: reminder, lastErrorAt: ago(7 * H) }).failed], ['reconnect', false]);
  const h = health({ tokenExpiresAt: ago(H) });
  assert.deepEqual([h.state, h.expired], ['reconnect', true]);
  assert.equal(health({ tokenExpiresAt: new Date(NOW + 1).toISOString() }).expired, false);
});

test('two nights with nothing coming in is stuck even with no error, and an old note does not hide it', () => {
  assert.deepEqual([health({ lastSyncAt: ago(STUCK_AFTER) }).state, health({ lastSyncAt: ago(STUCK_AFTER + 1) }).state], ['ok', 'stuck']);
  let h = health({ lastSyncAt: ago(5 * D) });
  assert.deepEqual([h.state, h.quiet, h.failed], ['stuck', true, false]);
  // The last sync that saved left a note, then the nightly request stopped arriving.
  h = health({ lastSyncAt: ago(5 * D), lastError: "Threads didn't send the follower count this time.", lastErrorAt: new Date(NOW - 5 * D + 400).toISOString() });
  assert.deepEqual([h.state, h.quiet, h.failed], ['stuck', true, false]);
  // Connected two days ago and never synced.
  h = health({ connectedAt: ago(STUCK_AFTER + H), lastSyncAt: '' });
  assert.deepEqual([h.state, h.quiet], ['stuck', true]);
});

test('a new or renewed connection is waiting for its sync, not stuck', () => {
  let h = health({ connectedAt: ago(3000), lastSyncAt: '' });
  assert.deepEqual([h.state, h.waiting, h.quiet], ['ok', true, false]);
  // Reconnected after six days with a dead sign-in: the old numbers are stale, but nothing is wrong now.
  h = health({ connectedAt: ago(3000), lastSyncAt: ago(6 * D) });
  assert.deepEqual([h.state, h.waiting, h.quiet], ['ok', true, false]);
  // Its first sync saved.
  h = health({ connectedAt: ago(60000), lastSyncAt: ago(20000) });
  assert.deepEqual([h.state, h.waiting], ['ok', false]);
  // Its first sync was refused.
  h = health({ connectedAt: ago(60000), lastSyncAt: ago(6 * D), lastError: BLOCKED, lastErrorAt: ago(20000) });
  assert.deepEqual([h.state, h.failed, h.waiting], ['stuck', true, false]);
  // Reconnected three days ago and nothing since.
  h = health({ connectedAt: ago(3 * D), lastSyncAt: ago(9 * D) });
  assert.deepEqual([h.state, h.quiet], ['stuck', true]);
});

test('missing dates never read as a problem', () => {
  const h = syncHealth({ platform: 'threads', lastError: '', lastSyncAt: '', lastErrorAt: '', connectedAt: '', tokenExpiresAt: '' }, NOW);
  assert.deepEqual([h.state, h.expired, h.failed, h.quiet, h.waiting], ['ok', false, false, false, false]);
  assert.equal(syncHealth({ platform: 'threads' }, NOW).state, 'ok');
});
