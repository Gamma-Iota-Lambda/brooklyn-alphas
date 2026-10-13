// Runs the content calendar migration inside PGlite (Postgres compiled to WebAssembly) with a small
// stand-in for Supabase's auth schema and roles, so row level security and SECURITY DEFINER
// functions behave the way they do in production. Adapted from the Alpha Academy Trading Floor.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant anon, authenticated, service_role to postgres;
create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key,
  email text,
  is_anonymous boolean not null default false,
  created_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants new public tables and functions to the API roles by default.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
set timezone = 'UTC';
`;

// postgrestTypes: return dates as YYYY-MM-DD, timestamps as ISO strings, and bigints as numbers,
// the way the Supabase Data API sends them. The live stand-in (live-server.mjs) uses this.
export async function createDb({ codes = true, postgrestTypes = false } = {}) {
  const parsers = postgrestTypes
    ? {
        20: (v) => Number(v),
        1082: (v) => v,
        1184: (v) => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString()
      }
    : undefined;
  const db = new PGlite({ extensions: { pgcrypto }, ...(parsers ? { parsers } : {}) });
  await db.exec(SUPABASE_STUB);
  const dir = join(root, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  await db.exec(readFileSync(join(root, 'supabase', 'seed.sql'), 'utf8'));
  const h = new Harness(db);
  if (codes) {
    await h.sql(`select cal_private.set_code('chapter', $1)`, [CHAPTER_CODE]);
    await h.sql(`select cal_private.set_code('media', $1)`, [MEDIA_CODE]);
  }
  return h;
}

export const CHAPTER_CODE = 'Brooklyn 1945';
export const MEDIA_CODE = 'black and old gold media team';

export class Harness {
  constructor(db) {
    this.db = db;
  }

  async setNow(iso) {
    await this.db.query(`select set_config('app.now', $1, false)`, [iso]);
  }

  async createUser({ email = null, anon = false } = {}) {
    const id = randomUUID();
    await this.db.query('insert into auth.users (id, email, is_anonymous) values ($1, $2, $3)', [id, email, anon]);
    return { id, email, anon };
  }

  // Runs fn in a transaction as a principal: a user object, 'service', or null for a visitor (anon).
  async as(who, fn) {
    const db = this.db;
    await db.exec('begin');
    try {
      if (who === 'service') {
        await db.exec('set local role service_role');
      } else if (who) {
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: who.id, role: 'authenticated', is_anonymous: !!who.anon })
        ]);
        await db.exec('set local role authenticated');
      } else {
        await db.exec('set local role anon');
      }
      const out = await fn(db);
      await db.exec('commit');
      return out;
    } catch (e) {
      await db.exec('rollback');
      throw e;
    }
  }

  async rpc(who, fn, args = {}) {
    const keys = Object.keys(args);
    const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    return this.as(who, async (db) => (await db.query(sql, keys.map((k) => args[k]))).rows);
  }

  // One value: a scalar or json result, or the single row of a composite result.
  async rpc1(who, fn, args = {}) {
    const rows = await this.rpc(who, fn, args);
    const row = rows[0];
    if (row && Object.keys(row).length === 1 && Object.keys(row)[0] === fn) return row[fn];
    return row;
  }

  async select(who, sql, params = []) {
    return this.as(who, async (db) => (await db.query(sql, params)).rows);
  }

  // Superuser query that bypasses row level security, for setup and assertions.
  async sql(sql, params = []) {
    return (await this.db.query(sql, params)).rows;
  }

  // A brother who has signed in with the chapter code.
  async member(name, pin = '1906', committee = 'Education') {
    const user = await this.createUser({ anon: true });
    const me = await this.rpc1(user, 'cal_join', { p_code: CHAPTER_CODE, p_name: name, p_pin: pin, p_committee: committee });
    return { ...user, memberId: me.member_id, name };
  }

  // A media team member with an email login.
  async staff(name = 'Eugene Aiken') {
    const user = await this.createUser({ email: `${name.split(' ')[0].toLowerCase()}@example.org` });
    await this.rpc1(user, 'cal_claim_staff', { p_code: MEDIA_CODE, p_name: name });
    return { ...user, name };
  }
}
