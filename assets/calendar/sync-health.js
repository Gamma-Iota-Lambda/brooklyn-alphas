// How a connected account's nightly sync is doing, worked out from what the database keeps about
// it. On its own so the tests can check each case (tests/calendar/sync-health.test.mjs).
//
// state: 'ok', 'reconnect' (the sign-in has to be redone), or 'stuck' (numbers aren't coming in,
// and signing in again isn't the fix).
// failed: the latest try saved nothing. A note saved along with a sync (some numbers waiting for
//   the next one) carries the sync's own time; an error from a later try is a failure.
// quiet: no failure on record, yet nothing has come in for two nights. The sync isn't reaching the
//   calendar at all. An old note doesn't hide it.
// waiting: connected, or connected again, since the last sync that saved, and nothing wrong so far.
export const STUCK_AFTER = 48 * 3600000; // two missed nights

export function syncHealth(a, now = Date.now()) {
  const at = (ts) => (ts ? Date.parse(ts) : NaN);
  const synced = at(a.lastSyncAt), tried = at(a.lastErrorAt), expires = at(a.tokenExpiresAt), connected = at(a.connectedAt);
  const expired = expires <= now;
  const failed = !!a.lastError && !(tried - synced <= 10000);
  const waiting = !failed && !Number.isNaN(connected) && !(synced >= connected);
  const since = Math.max(Number.isNaN(synced) ? -Infinity : synced, Number.isNaN(connected) ? -Infinity : connected);
  const quiet = !failed && Number.isFinite(since) && now - since > STUCK_AFTER;
  const state = expired || /\bchoose reconnect\b/i.test(a.lastError || '') ? 'reconnect' : failed || quiet ? 'stuck' : 'ok';
  return { state, expired, failed, quiet, waiting, expires };
}
