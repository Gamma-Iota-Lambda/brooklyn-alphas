-- GIL Content Calendar, fourth migration: Instagram and Threads results for the media team.
-- Runs after 20261014000100_request_emails.sql.
--
-- How it works
-- * The media team connects @gil1906 from the calendar's Results tab. The calendar-social Edge
--   Function (supabase/functions/calendar-social) handles the sign-in with Instagram or Threads,
--   keeps each long-lived access token in Vault, and renews it before it expires.
-- * Every night pg_cron asks the Edge Function to sync. It saves each post's latest numbers in
--   cal_social_posts, a daily snapshot for each post's first 30 days in cal_social_post_days, and
--   followers per day in cal_social_account_days.
-- * Each platform post is matched to a calendar post by date: when exactly one post went out on a
--   platform that day, and exactly one calendar post that day lists the platform, they match. The
--   media team matches the rest by hand on the Results tab, or marks a post as not on the calendar.
-- * Only the media team can read any of it. The Edge Function writes as the database owner through
--   the cal_private functions below; the page never sees a token.

-- pg_cron comes with Supabase and creates its own cron schema. The test database stands in for it.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One connected account per platform. The token itself lives in Vault.
create table public.cal_social_accounts (
  platform text primary key check (platform in ('instagram', 'threads')),
  account_id text not null check (char_length(account_id) between 1 and 64),
  username text check (username is null or char_length(username) <= 64),
  connected_at timestamptz not null default now(),
  connected_by uuid references auth.users (id) on delete set null,
  token_refreshed_at timestamptz not null default now(),
  token_expires_at timestamptz,
  last_sync_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_error_at timestamptz
);

-- Each platform post with its latest numbers. Metrics a platform doesn't report stay null.
-- match_source: 'date' (matched by date), 'manual' (the media team picked the calendar post),
-- 'none' (the media team marked it as not on the calendar), or null (no match yet).
create table public.cal_social_posts (
  platform text not null check (platform in ('instagram', 'threads')),
  media_id text not null check (char_length(media_id) between 1 and 64),
  posted_at timestamptz not null,
  permalink text check (permalink is null or permalink ~* '^https://\S+$'),
  media_type text check (media_type is null or char_length(media_type) <= 40),
  caption text check (caption is null or char_length(caption) <= 300),
  post_id text references public.cal_posts (id) on delete set null,
  match_source text check (match_source is null or match_source in ('date', 'manual', 'none')),
  views bigint, reach bigint, likes bigint, comments bigint, saves bigint, shares bigint,
  replies bigint, reposts bigint, quotes bigint, interactions bigint,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (platform, media_id),
  check (match_source is distinct from 'none' or post_id is null)
);
create index cal_social_posts_post_idx on public.cal_social_posts (post_id);
create index cal_social_posts_posted_idx on public.cal_social_posts (posted_at);

-- A snapshot of each post's numbers once a day for its first 30 days, to see how posts grow.
create table public.cal_social_post_days (
  platform text not null,
  media_id text not null,
  day date not null,
  views bigint, reach bigint, likes bigint, comments bigint, saves bigint, shares bigint,
  replies bigint, reposts bigint, quotes bigint, interactions bigint,
  primary key (platform, media_id, day),
  foreign key (platform, media_id) references public.cal_social_posts (platform, media_id) on delete cascade
);

-- Followers and post counts once a day.
create table public.cal_social_account_days (
  platform text not null check (platform in ('instagram', 'threads')),
  day date not null,
  followers bigint,
  posts bigint,
  primary key (platform, day)
);

-- One-time codes that tie a Connect click to the sign-in that comes back from Instagram or Threads.
create table cal_private.social_connect_states (
  state text primary key,
  platform text not null check (platform in ('instagram', 'threads')),
  user_id uuid not null references auth.users (id) on delete cascade,
  return_to text,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Tokens and the sync key, in Vault
-- ---------------------------------------------------------------------------

create or replace function cal_private.social_vault_name(p_platform text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'calendar_' || p_platform || '_token'
$$;

-- Creates or replaces a Vault secret by name.
create or replace function cal_private.social_put_secret(p_name text, p_value text, p_description text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name, p_description);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end;
$$;

-- The shared key pg_cron sends to the Edge Function. Created once and never shown to anyone.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'calendar_social_sync_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'calendar_social_sync_key',
      'Shared key between pg_cron and the calendar-social Edge Function');
  end if;
end
$$;

create or replace function cal_private.social_sync_key_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_key, '') <> '' and exists (
    select 1 from vault.decrypted_secrets s where s.name = 'calendar_social_sync_key' and s.decrypted_secret = p_key)
$$;

-- ---------------------------------------------------------------------------
-- Connecting an account: the media team clicks Connect, and the Edge Function finishes
-- ---------------------------------------------------------------------------

-- Starts a Connect and returns a one-time code the page passes to the Edge Function. The return
-- address must be the chapter site, one of its Vercel previews, or a local test server.
create or replace function public.cal_social_connect_start(p_platform text, p_return text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text := encode(extensions.gen_random_bytes(24), 'hex');
  v_return text := nullif(trim(coalesce(p_return, '')), '');
begin
  perform cal_private.assert_staff();
  if p_platform is null or p_platform not in ('instagram', 'threads') then
    raise exception 'Choose Instagram or Threads.';
  end if;
  if v_return is not null and v_return !~ '^(https://(www\.)?gil1906\.org/|https://brooklyn-alphas[a-z0-9-]*\.vercel\.app/|http://(localhost|127\.0\.0\.1):[0-9]{2,5}/)[^\s<>"'']*$' then
    v_return := null;
  end if;
  delete from cal_private.social_connect_states where created_at < cal_private.clock() - interval '1 day';
  insert into cal_private.social_connect_states (state, platform, user_id, return_to, created_at)
  values (v_state, p_platform, (select auth.uid()), v_return, cal_private.clock());
  return v_state;
end;
$$;

-- The platform and return address for a fresh, unused code, or no row. The Edge Function checks
-- this before it sends the browser to Instagram or Threads.
create or replace function cal_private.social_connect_peek(p_state text)
returns table (platform text, return_to text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.platform, c.return_to from cal_private.social_connect_states c
  where c.state = p_state and c.used_at is null and c.created_at > cal_private.clock() - interval '30 minutes'
$$;

-- Uses up a code when the sign-in comes back. Raises if it's unknown, used, or over 30 minutes old.
create or replace function cal_private.social_connect_claim(p_state text)
returns table (platform text, user_id uuid, return_to text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    update cal_private.social_connect_states c
    set used_at = cal_private.clock()
    where c.state = p_state and c.used_at is null and c.created_at > cal_private.clock() - interval '30 minutes'
    returning c.platform, c.user_id, c.return_to;
  if not found then
    raise exception 'That Connect link has expired. Start again from the Results tab.';
  end if;
end;
$$;

-- Saves a new connection: the account, and the long-lived token in Vault. Also saves the Edge
-- Functions address, so the nightly sync knows where to go.
create or replace function cal_private.social_save_connection(
  p_platform text, p_account_id text, p_username text, p_token text, p_expires_in integer,
  p_user uuid, p_functions_url text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := cal_private.clock();
begin
  if p_platform is null or p_platform not in ('instagram', 'threads') then
    raise exception 'Unknown platform %', p_platform;
  end if;
  if coalesce(p_token, '') = '' then
    raise exception 'No access token came back from %.', p_platform;
  end if;
  perform cal_private.social_put_secret(cal_private.social_vault_name(p_platform), p_token,
    'Long-lived ' || p_platform || ' token for the content calendar Results tab');
  insert into public.cal_social_accounts (platform, account_id, username, connected_at, connected_by,
    token_refreshed_at, token_expires_at, last_error, last_error_at)
  values (p_platform, p_account_id, nullif(left(p_username, 64), ''), v_now, p_user, v_now,
    case when p_expires_in > 0 then v_now + make_interval(secs => p_expires_in) end, null, null)
  on conflict (platform) do update
  set account_id = excluded.account_id, username = excluded.username, connected_at = excluded.connected_at,
      connected_by = excluded.connected_by, token_refreshed_at = excluded.token_refreshed_at,
      token_expires_at = excluded.token_expires_at, last_error = null, last_error_at = null;
  if p_functions_url ~ '^https?://[^\s/]+(:[0-9]+)?/functions/v1$' then
    insert into cal_private.config (key, value) values ('functions_url', p_functions_url)
    on conflict (key) do update set value = excluded.value;
  end if;
end;
$$;

-- The current token for a platform, with when it was last renewed.
create or replace function cal_private.social_token(p_platform text)
returns table (token text, refreshed_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret, a.token_refreshed_at, a.token_expires_at
  from public.cal_social_accounts a
  join vault.decrypted_secrets s on s.name = cal_private.social_vault_name(a.platform)
  where a.platform = p_platform
$$;

-- Saves a renewed token.
create or replace function cal_private.social_save_token(p_platform text, p_token text, p_expires_in integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := cal_private.clock();
begin
  if coalesce(p_token, '') = '' then
    raise exception 'No token to save.';
  end if;
  if not exists (select 1 from public.cal_social_accounts where platform = p_platform) then
    raise exception '% is not connected.', p_platform;
  end if;
  perform cal_private.social_put_secret(cal_private.social_vault_name(p_platform), p_token,
    'Long-lived ' || p_platform || ' token for the content calendar Results tab');
  update public.cal_social_accounts
  set token_refreshed_at = v_now,
      token_expires_at = case when p_expires_in > 0 then v_now + make_interval(secs => p_expires_in) else token_expires_at end
  where platform = p_platform;
end;
$$;

-- The platforms with a saved connection.
create or replace function cal_private.social_connected()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select a.platform from public.cal_social_accounts a order by a.platform
$$;

-- Posts the calendar already has numbers for, so a sync can leave older ones for the weekly refresh.
create or replace function cal_private.social_known_media(p_platform text)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select s.media_id from public.cal_social_posts s where s.platform = p_platform
$$;

-- Disconnects a platform and forgets its token. Posts and numbers already saved stay.
create or replace function public.cal_social_disconnect(p_platform text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  delete from vault.secrets where name = cal_private.social_vault_name(p_platform);
  delete from public.cal_social_accounts where platform = p_platform;
end;
$$;

-- ---------------------------------------------------------------------------
-- Matching platform posts to calendar posts
-- ---------------------------------------------------------------------------

-- Works out date matches fresh each time, so moving a calendar post or skipping it updates the
-- match. Matches the media team made by hand stay. Stories aren't matched: Instagram's API lists
-- feed posts and reels only.
create or replace function cal_private.social_match(p_platform text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Start date matches over. A hand match whose calendar post was deleted goes back to automatic.
  update public.cal_social_posts s set post_id = null, match_source = null
  where s.platform = p_platform
    and (s.match_source = 'date' or (s.match_source = 'manual' and s.post_id is null));

  with open_days as (
    -- Days with exactly one post on this platform still to match.
    select (s.posted_at at time zone 'America/New_York')::date as day
    from public.cal_social_posts s
    where s.platform = p_platform and s.match_source is null
    group by 1
    having count(*) = 1
  ),
  candidates as (
    -- Of those days, the ones with exactly one calendar post for this platform that isn't skipped,
    -- isn't a story, and isn't already matched to another post on this platform.
    select d.day, min(p.id) as post_id
    from open_days d
    join public.cal_posts p
      on p.date = d.day and p_platform = any (p.platforms) and p.status <> 'skipped' and p.format <> 'story'
    where not exists (
      select 1 from public.cal_social_posts x where x.platform = p_platform and x.post_id = p.id)
    group by d.day
    having count(*) = 1
  )
  update public.cal_social_posts s set post_id = c.post_id, match_source = 'date'
  from candidates c
  where s.platform = p_platform and s.match_source is null
    and (s.posted_at at time zone 'America/New_York')::date = c.day;
end;
$$;

-- The media team's hand match from the Results tab: a calendar post id matches it to that post;
-- null marks it as not on the calendar; p_auto goes back to matching by date.
create or replace function public.cal_social_set_match(
  p_platform text, p_media_id text, p_post_id text default null, p_auto boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  if not exists (select 1 from public.cal_social_posts s where s.platform = p_platform and s.media_id = p_media_id) then
    raise exception 'That post is no longer in the results.';
  end if;
  if coalesce(p_auto, false) then
    update public.cal_social_posts set post_id = null, match_source = null
    where platform = p_platform and media_id = p_media_id;
  elsif p_post_id is null then
    update public.cal_social_posts set post_id = null, match_source = 'none'
    where platform = p_platform and media_id = p_media_id;
  else
    if not exists (select 1 from public.cal_posts p where p.id = p_post_id) then
      raise exception 'That calendar post no longer exists.';
    end if;
    update public.cal_social_posts set post_id = p_post_id, match_source = 'manual'
    where platform = p_platform and media_id = p_media_id;
  end if;
  perform cal_private.social_match(p_platform);
end;
$$;

-- Matching runs again whenever calendar posts are added, deleted, moved, or change platforms or
-- status, so the Results tab follows edits right away instead of waiting for the next sync.
create or replace function cal_private.social_rematch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_platform text;
begin
  for v_platform in select distinct s.platform from public.cal_social_posts s loop
    perform cal_private.social_match(v_platform);
  end loop;
  return null;
end;
$$;

create trigger cal_posts_social_rematch
after insert or delete or update of date, platforms, status, format on public.cal_posts
for each statement execute function cal_private.social_rematch();

-- ---------------------------------------------------------------------------
-- Saving a sync
-- ---------------------------------------------------------------------------

-- Saves one sync for a platform. p_account: {username, followers, posts}. p_posts: a list of
-- {media_id, posted_at, permalink, media_type, caption, views, reach, likes, comments, saves,
-- shares, replies, reposts, quotes, interactions}. A metric left out keeps its saved value.
create or replace function cal_private.social_save_sync(p_platform text, p_account jsonb, p_posts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := cal_private.clock();
  v_today date := cal_private.today();
  v_saved integer;
  v_matched integer;
begin
  if not exists (select 1 from public.cal_social_accounts where platform = p_platform) then
    raise exception '% is not connected.', p_platform;
  end if;
  if jsonb_typeof(coalesce(p_posts, '[]'::jsonb)) <> 'array' then
    raise exception 'Posts must be a list.';
  end if;

  insert into public.cal_social_posts as s (platform, media_id, posted_at, permalink, media_type, caption,
    views, reach, likes, comments, saves, shares, replies, reposts, quotes, interactions, first_seen_at, updated_at)
  select p_platform, left(x.media_id, 64), x.posted_at,
    case when x.permalink ~* '^https://\S+$' then x.permalink end,
    left(nullif(x.media_type, ''), 40),
    left(nullif(trim(regexp_replace(coalesce(x.caption, ''), '\s+', ' ', 'g')), ''), 300),
    x.views, x.reach, x.likes, x.comments, x.saves, x.shares, x.replies, x.reposts, x.quotes, x.interactions,
    v_now, v_now
  from jsonb_to_recordset(coalesce(p_posts, '[]'::jsonb)) as x(
    media_id text, posted_at timestamptz, permalink text, media_type text, caption text,
    views bigint, reach bigint, likes bigint, comments bigint, saves bigint, shares bigint,
    replies bigint, reposts bigint, quotes bigint, interactions bigint)
  where coalesce(x.media_id, '') <> '' and x.posted_at is not null
  on conflict (platform, media_id) do update
  set posted_at = excluded.posted_at, permalink = coalesce(excluded.permalink, s.permalink),
      media_type = coalesce(excluded.media_type, s.media_type), caption = coalesce(excluded.caption, s.caption),
      views = coalesce(excluded.views, s.views), reach = coalesce(excluded.reach, s.reach),
      likes = coalesce(excluded.likes, s.likes), comments = coalesce(excluded.comments, s.comments),
      saves = coalesce(excluded.saves, s.saves), shares = coalesce(excluded.shares, s.shares),
      replies = coalesce(excluded.replies, s.replies), reposts = coalesce(excluded.reposts, s.reposts),
      quotes = coalesce(excluded.quotes, s.quotes), interactions = coalesce(excluded.interactions, s.interactions),
      updated_at = excluded.updated_at;
  get diagnostics v_saved = row_count;

  -- Today's snapshot of every post from the last 30 days.
  insert into public.cal_social_post_days as d (platform, media_id, day, views, reach, likes, comments, saves,
    shares, replies, reposts, quotes, interactions)
  select s.platform, s.media_id, v_today, s.views, s.reach, s.likes, s.comments, s.saves, s.shares, s.replies,
    s.reposts, s.quotes, s.interactions
  from public.cal_social_posts s
  where s.platform = p_platform and s.posted_at > v_now - interval '30 days' and s.updated_at = v_now
  on conflict (platform, media_id, day) do update
  set views = excluded.views, reach = excluded.reach, likes = excluded.likes, comments = excluded.comments,
      saves = excluded.saves, shares = excluded.shares, replies = excluded.replies, reposts = excluded.reposts,
      quotes = excluded.quotes, interactions = excluded.interactions;

  if jsonb_typeof(p_account) = 'object' then
    insert into public.cal_social_account_days as a (platform, day, followers, posts)
    values (p_platform, v_today, (p_account ->> 'followers')::bigint, (p_account ->> 'posts')::bigint)
    on conflict (platform, day) do update
    set followers = coalesce(excluded.followers, a.followers), posts = coalesce(excluded.posts, a.posts);
    if coalesce(p_account ->> 'username', '') <> '' then
      update public.cal_social_accounts set username = left(p_account ->> 'username', 64) where platform = p_platform;
    end if;
  end if;

  perform cal_private.social_match(p_platform);
  select count(*) into v_matched from public.cal_social_posts where platform = p_platform and post_id is not null;

  update public.cal_social_accounts set last_sync_at = v_now, last_error = null, last_error_at = null
  where platform = p_platform;
  return jsonb_build_object('posts', v_saved, 'matched', v_matched);
end;
$$;

-- Records why a sync didn't finish, for the Results tab.
create or replace function cal_private.social_sync_failed(p_platform text, p_message text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.cal_social_accounts
  set last_error = left(coalesce(nullif(trim(p_message), ''), 'The sync did not finish.'), 500),
      last_error_at = cal_private.clock()
  where platform = p_platform
$$;

-- ---------------------------------------------------------------------------
-- The nightly sync, and Refresh now
-- ---------------------------------------------------------------------------

-- Asks the Edge Function to sync. Does nothing until an account is connected (connecting saves the
-- functions address). Returns the pg_net request id, or null.
create or replace function cal_private.social_sync_request()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from public.cal_social_accounts) then
    return null;
  end if;
  select c.value into v_url from cal_private.config c where c.key = 'functions_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'calendar_social_sync_key';
  if v_url is null or v_key is null then
    return null;
  end if;
  return net.http_post(
    url := v_url || '/calendar-social/sync',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', v_key),
    timeout_milliseconds := 30000
  );
end;
$$;

-- Refresh now, from the Results tab. Once every 10 minutes at most.
create or replace function public.cal_social_sync_now()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last timestamptz;
  v_id bigint;
begin
  perform cal_private.assert_staff();
  select (c.value)::timestamptz into v_last from cal_private.config c where c.key = 'social_sync_requested_at';
  if v_last is not null and v_last > cal_private.clock() - interval '10 minutes' then
    return jsonb_build_object('ok', false, 'message', 'A refresh is already on its way. Check back in a few minutes.');
  end if;
  v_id := cal_private.social_sync_request();
  if v_id is null then
    return jsonb_build_object('ok', false, 'message', 'Connect Instagram or Threads first.');
  end if;
  insert into cal_private.config (key, value) values ('social_sync_requested_at', cal_private.clock()::text)
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('ok', true, 'message', 'Refreshing. New numbers show up in a minute or two.');
end;
$$;

-- Every night at 4:20 a.m. New York time during daylight saving time, 3:20 a.m. in winter.
-- Running this again updates the same job.
select cron.schedule('gil-calendar-social-sync', '20 8 * * *', 'select cal_private.social_sync_request()');

-- ---------------------------------------------------------------------------
-- Access: the media team reads, and only the database writes
-- ---------------------------------------------------------------------------

alter table public.cal_social_accounts enable row level security;
alter table public.cal_social_posts enable row level security;
alter table public.cal_social_post_days enable row level security;
alter table public.cal_social_account_days enable row level security;

create policy "the media team reads connected accounts"
  on public.cal_social_accounts for select to authenticated using ((select cal_private.is_staff()));
create policy "the media team reads post results"
  on public.cal_social_posts for select to authenticated using ((select cal_private.is_staff()));
create policy "the media team reads daily post results"
  on public.cal_social_post_days for select to authenticated using ((select cal_private.is_staff()));
create policy "the media team reads daily account results"
  on public.cal_social_account_days for select to authenticated using ((select cal_private.is_staff()));

revoke all on public.cal_social_accounts, public.cal_social_posts, public.cal_social_post_days,
  public.cal_social_account_days from anon, authenticated;
grant select on public.cal_social_accounts, public.cal_social_posts, public.cal_social_post_days,
  public.cal_social_account_days to authenticated;
revoke all on cal_private.social_connect_states from public, anon, authenticated;

revoke execute on function
  cal_private.social_vault_name(text), cal_private.social_put_secret(text, text, text),
  cal_private.social_sync_key_ok(text), cal_private.social_connect_peek(text),
  cal_private.social_connect_claim(text),
  cal_private.social_save_connection(text, text, text, text, integer, uuid, text),
  cal_private.social_token(text), cal_private.social_save_token(text, text, integer),
  cal_private.social_connected(), cal_private.social_known_media(text), cal_private.social_match(text),
  cal_private.social_rematch(), cal_private.social_save_sync(text, jsonb, jsonb),
  cal_private.social_sync_failed(text, text), cal_private.social_sync_request()
  from public, anon, authenticated;

revoke execute on function
  public.cal_social_connect_start(text, text), public.cal_social_disconnect(text),
  public.cal_social_set_match(text, text, text, boolean), public.cal_social_sync_now()
  from public, anon;
grant execute on function
  public.cal_social_connect_start(text, text), public.cal_social_disconnect(text),
  public.cal_social_set_match(text, text, text, boolean), public.cal_social_sync_now()
  to authenticated;
