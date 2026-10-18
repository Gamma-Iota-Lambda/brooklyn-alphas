// Runs the content calendar migrations inside PGlite (Postgres compiled to WebAssembly) with a small
// stand-in for Supabase's auth schema and roles, storage, Vault, pg_net, and pg_cron, so row level
// security and SECURITY DEFINER functions behave the way they do in production. Adapted from the
// Alpha Academy Trading Floor.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = join(root, 'supabase', 'migrations');

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
-- Storage: the bucket and object tables and the folder helper, as Supabase defines them.
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner_id text,
  metadata jsonb,
  created_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
-- pg_net: records each request in net.http_calls instead of sending it.
-- set app.net_fail = 'on' to make it fail the way an unavailable extension would.
create schema net;
create table net.http_calls (
  id bigserial primary key,
  url text not null,
  body jsonb,
  headers jsonb,
  timeout_milliseconds int,
  created timestamptz default now()
);
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$
declare
  v_id bigint;
begin
  if current_setting('app.net_fail', true) = 'on' then
    raise exception 'pg_net is not available';
  end if;
  insert into net.http_calls (url, body, headers, timeout_milliseconds)
  values (http_post.url, http_post.body, http_post.headers, http_post.timeout_milliseconds)
  returning id into v_id;
  return v_id;
end
$$;
-- Supabase Vault: secrets stored as plain text here; only the database owner can read them.
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '',
  new_key_id uuid default null)
returns uuid language sql as $$
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, coalesce(new_description, ''))
  returning id
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null)
returns void language sql as $$
  update vault.secrets
  set secret = coalesce(new_secret, secret), name = coalesce(new_name, name),
      description = coalesce(new_description, description), updated_at = now()
  where id = secret_id
$$;
-- pg_cron: keeps the job list without running anything.
create schema cron;
create table cron.job (
  jobid bigserial primary key,
  jobname text unique,
  schedule text not null,
  command text not null,
  active boolean not null default true
);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values ($1, $2, $3)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  with gone as (delete from cron.job where jobname = $1 returning 1) select exists (select 1 from gone)
$$;
-- Supabase grants new public tables and functions to the API roles by default.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
set timezone = 'UTC';
`;

// postgrestTypes: return dates as YYYY-MM-DD, timestamps as ISO strings, and bigints as numbers,
// the way the Supabase Data API sends them. The live stand-in (live-server.mjs) uses this.
// migrations: run only these files from supabase/migrations, to test upgrading a project that ran
// an earlier set. By default every migration runs, in order.
export async function createDb({ codes = true, postgrestTypes = false, migrations = null } = {}) {
  const parsers = postgrestTypes
    ? {
        20: (v) => Number(v),
        1082: (v) => v,
        1184: (v) => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString()
      }
    : undefined;
  const db = new PGlite({ extensions: { pgcrypto }, ...(parsers ? { parsers } : {}) });
  await db.exec(SUPABASE_STUB);
  const files = readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort();
  for (const f of migrations ? files.filter((x) => migrations.includes(x)) : files) {
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
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

  // Runs one migration file, the way the media team pastes it into SQL Editor.
  async migrate(file) {
    await this.db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
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

  // A brother who has signed in with the chapter code. He can view the calendar.
  async member(name, pin = '1906', committee = 'Education') {
    const user = await this.createUser({ anon: true });
    const me = await this.rpc1(user, 'cal_join', { p_code: CHAPTER_CODE, p_name: name, p_pin: pin, p_committee: committee });
    return { ...user, memberId: me.member_id, name };
  }

  // A committee chair: a brother the media team has marked as chair. He can send requests.
  async chair(name, committee = 'Education', pin = '1906') {
    const bro = await this.member(name, pin, committee);
    await this.sql('update public.cal_members set chair = true where id = $1', [bro.memberId]);
    return bro;
  }

  // Adds a file record to the calendar-files bucket as the given person, the way Supabase Storage
  // does on upload, so the storage policies decide.
  async upload(who, path) {
    return this.select(who, `insert into storage.objects (bucket_id, name, owner_id) values ('calendar-files', $1, $2) returning name`,
      [path, who && who.id ? who.id : null]);
  }

  // A media team member with an email login.
  async staff(name = 'Eugene Aiken') {
    const user = await this.createUser({ email: `${name.split(' ')[0].toLowerCase()}@example.org` });
    await this.rpc1(user, 'cal_claim_staff', { p_code: MEDIA_CODE, p_name: name });
    return { ...user, name };
  }
}
