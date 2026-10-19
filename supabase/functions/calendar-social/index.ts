// calendar-social on Supabase Edge Functions. Everything it does lives in social.js; this file
// connects it to the database and the outside world.
//
// Deploy with JWT verification off: browsers reach /connect and /callback without a Supabase
// session, the one-time Connect code protects those, and /sync checks its own key.
//
// Secrets, set once in the Supabase dashboard (Edge Functions, then Secrets):
//   INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, THREADS_APP_ID, THREADS_APP_SECRET
// SUPABASE_URL and SUPABASE_DB_URL come with every project.
import postgres from 'npm:postgres@3.4.5';
import { createHandler, makeDb } from './social.js';

// The connection runs as the database owner, so the cal_private functions are callable here and
// nowhere else. prepare: false works with Supabase's connection pooler.
const sql = postgres(Deno.env.get('SUPABASE_DB_URL') ?? '', { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 });

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const handler = createHandler({
  env: (name: string) => Deno.env.get(name) ?? '',
  // deno-lint-ignore no-explicit-any
  db: makeDb((text: string, params: unknown[]) => sql.unsafe(text, params as any[])),
  fetch: (input: string, init?: RequestInit) => fetch(input, init),
  // Keeps the function alive for the sync after it has answered.
  waitUntil: (promise: Promise<unknown>) => {
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(promise);
  }
});

Deno.serve(handler);
