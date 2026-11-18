// photo-drop on Supabase Edge Functions. Everything it does lives in drop.js; this file connects
// it to the database and the outside world.
//
// Deploy with JWT verification off: the three School Daze pages have no Supabase session. Each
// sends its own code (upload, review, or screen) and the database checks it on every request.
//
// No secrets to set. SUPABASE_URL, SUPABASE_DB_URL, and the secret key for Storage
// (SUPABASE_SECRET_KEYS, or SUPABASE_SERVICE_ROLE_KEY on an older project) come with every project.
import postgres from 'npm:postgres@3.4.5';
import { createHandler, makeDb } from './drop.js';

// The connection runs as the database owner, so the cal_private functions are callable here and
// nowhere else. prepare: false works with Supabase's connection pooler.
const sql = postgres(Deno.env.get('SUPABASE_DB_URL') ?? '', { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 10 });

const handler = createHandler({
  env: (name: string) => Deno.env.get(name) ?? '',
  // deno-lint-ignore no-explicit-any
  db: makeDb((text: string, params: unknown[]) => sql.unsafe(text, params as any[])),
  fetch: (input: string, init?: RequestInit) => fetch(input, init)
});

Deno.serve(handler);
