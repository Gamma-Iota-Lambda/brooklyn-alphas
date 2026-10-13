-- GIL Content Calendar (calendar.html)
-- Schema, access rules, and checked functions.
--
-- Who can do what
-- * Visitors who are not signed in see nothing, or only the public columns of the calendar
--   (date, title, category, program, format, platforms, status, committee, post idea, event
--   date, and link) when the media team turns the public calendar on.
-- * Brothers sign in once with the chapter code, their name, and a 4 to 6 digit PIN. They see
--   the whole calendar and the request queue, send requests, and edit their own requests until
--   the media team reviews them. On a new device they sign in again with their name and PIN.
-- * The media team signs in with email and password and enters the media code once. They edit
--   the calendar, review requests, and manage access.
--
-- Design notes
-- * Brothers write only through SECURITY DEFINER functions. The media team edits posts directly,
--   guarded by row level security.
-- * Functions use `set search_path = ''` and fully qualified names.
-- * Public names carry a cal_ prefix and internals live in the cal_private schema, so this can
--   share a Supabase project with the Alpha Academy Trading Floor without collisions. In a shared
--   project, run the Trading Floor's migrations first: its core migration revokes every grant on
--   the public schema's tables, which would undo the grants at the end of this file.

create extension if not exists pgcrypto with schema extensions;

-- Internals live in their own schema, which the Data API does not expose. Keeping them out of
-- the shared private schema means another app's blanket grants and revokes there never reach them.
create schema cal_private;
revoke all on schema cal_private from public;
grant usage on schema cal_private to anon, authenticated, service_role;

-- Calendar settings: the public switch and the hashed codes.
create table cal_private.config (
  key text primary key,
  value text not null
);

-- Clock: tests pin time with `set app.now = '...'`. Clients cannot run SET through the Data API.
create or replace function cal_private.clock()
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('app.now', true), '')::timestamptz, now())
$$;

-- The chapter works on New York time.
create or replace function cal_private.today()
returns date
language sql
stable
set search_path = ''
as $$
  select (cal_private.clock() at time zone 'America/New_York')::date
$$;

create or replace function cal_private.clean(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g'), '')
$$;

create or replace function cal_private.norm_code(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.cal_staff (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 60),
  created_at timestamptz not null default now()
);

create table public.cal_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  display_name text not null check (char_length(display_name) between 2 and 40),
  committee text check (committee is null or char_length(committee) <= 60),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create unique index cal_members_name_key on public.cal_members (lower(display_name));

create table cal_private.member_secrets (
  member_id uuid primary key references public.cal_members (id) on delete cascade,
  pin_hash text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz
);

create table public.cal_posts (
  id text primary key default ('p-' || replace(gen_random_uuid()::text, '-', ''))
    check (id ~ '^[a-z0-9][a-z0-9-]{2,120}$'),
  date date not null,
  title text not null check (char_length(title) between 1 and 160),
  category text not null default 'chapter'
    check (category in ('alpha', 'chapter', 'program', 'heritage', 'd9', 'notable', 'series', 'holiday', 'faith')),
  program text check (program in ('vote', 'college', 'project-alpha', 'keeper')),
  format text not null default 'graphic'
    check (format in ('graphic', 'carousel', 'reel', 'story', 'flyer', 'text')),
  platforms text[] not null default '{}'
    check (platforms <@ array['instagram', 'facebook', 'threads', 'x', 'website', 'substack', 'whatsapp']::text[]),
  status text not null default 'planned'
    check (status in ('planned', 'needs-info', 'in-design', 'ready', 'scheduled', 'posted', 'skipped')),
  committee text check (committee is null or char_length(committee) <= 60),
  concept text check (concept is null or char_length(concept) <= 2000),
  caption text check (caption is null or char_length(caption) <= 2200),
  notes text check (notes is null or char_length(notes) <= 2000),
  event_date date,
  link text check (link is null or link ~* '^https?://\S+$'),
  asset_link text check (asset_link is null or asset_link ~* '^https?://\S+$'),
  source text check (source is null or source ~* '^https?://\S+$'),
  request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
create index cal_posts_date_idx on public.cal_posts (date);

create table public.cal_requests (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references public.cal_members (id) on delete set null,
  submitted_by uuid references auth.users (id) on delete set null,
  contact_name text not null check (char_length(contact_name) between 2 and 80),
  committee text not null check (char_length(committee) between 2 and 60),
  title text not null check (char_length(title) between 3 and 120),
  post_date date not null,
  event_date date,
  about text not null check (char_length(about) between 3 and 2000),
  format text not null default 'graphic'
    check (format in ('graphic', 'carousel', 'reel', 'story', 'flyer', 'text')),
  platforms text[] not null
    check (cardinality(platforms) >= 1
           and platforms <@ array['instagram', 'facebook', 'threads', 'x', 'website', 'substack', 'whatsapp']::text[]),
  program text check (program in ('vote', 'college', 'project-alpha', 'keeper')),
  asset_link text check (asset_link is null or asset_link ~* '^https?://\S+$'),
  caption text check (caption is null or char_length(caption) <= 2200),
  link text check (link is null or link ~* '^https?://\S+$'),
  youth boolean not null default false,
  releases boolean not null default false,
  status text not null default 'new' check (status in ('new', 'needs-info', 'approved', 'declined')),
  review_note text check (review_note is null or char_length(review_note) <= 800),
  post_id text references public.cal_posts (id) on delete set null,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not youth or releases)
);
create index cal_requests_member_idx on public.cal_requests (member_id);
create index cal_requests_status_idx on public.cal_requests (status, post_date);

alter table public.cal_posts
  add constraint cal_posts_request_fk foreign key (request_id) references public.cal_requests (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

create or replace function cal_private.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.cal_staff s where s.user_id = (select auth.uid()))
$$;

create or replace function cal_private.member_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from public.cal_members m where m.user_id = (select auth.uid())
$$;

create or replace function cal_private.can_view()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select cal_private.is_staff()) or (select cal_private.member_id()) is not null
$$;

create or replace function cal_private.is_public()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.value from cal_private.config s where s.key = 'calendar_public'), 'false') = 'true'
$$;

create or replace function cal_private.assert_staff()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not cal_private.is_staff() then
    raise exception 'Only the media team can do that.';
  end if;
end;
$$;

-- Codes are compared without regard to case or extra spaces.
create or replace function cal_private.set_code(p_kind text, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := cal_private.norm_code(p_code);
begin
  if p_kind not in ('chapter', 'media') then
    raise exception 'Choose the chapter code or the media code.';
  end if;
  if v_code like 'replace with%' then
    raise exception 'Replace the placeholder with your own code first.';
  end if;
  if p_kind = 'chapter' and char_length(v_code) < 6 then
    raise exception 'Use a chapter code of at least 6 characters.';
  end if;
  if p_kind = 'media' and char_length(v_code) < 10 then
    raise exception 'Use a media code of at least 10 characters.';
  end if;
  insert into cal_private.config (key, value)
  values ('calendar_' || p_kind || '_code_hash', extensions.crypt(v_code, extensions.gen_salt('bf', 10)))
  on conflict (key) do update set value = excluded.value;
end;
$$;

create or replace function cal_private.code_ok(p_kind text, p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select extensions.crypt(cal_private.norm_code(p_code), s.value) = s.value
     from cal_private.config s where s.key = 'calendar_' || p_kind || '_code_hash'),
    false)
$$;

create or replace function cal_private.member_json(m public.cal_members)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('role', 'member', 'name', m.display_name, 'member_id', m.id, 'committee', m.committee)
$$;

-- Keeps updated_at, updated_by, and created_at honest on posts.
create or replace function cal_private.touch_post()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := cal_private.clock();
  new.updated_by := (select auth.uid());
  if tg_op = 'INSERT' then
    new.created_at := coalesce(new.created_at, cal_private.clock());
  else
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger cal_posts_touch
before insert or update on public.cal_posts
for each row execute function cal_private.touch_post();

-- Turns a request payload into checked fields, with messages written for chairs.
create or replace function cal_private.request_from_json(p jsonb)
returns public.cal_requests
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.cal_requests;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Fill in the request form.';
  end if;
  r.contact_name := cal_private.clean(p ->> 'contact_name');
  r.committee := cal_private.clean(p ->> 'committee');
  r.title := cal_private.clean(p ->> 'title');
  r.about := nullif(trim(coalesce(p ->> 'about', '')), '');
  r.format := coalesce(nullif(p ->> 'format', ''), 'graphic');
  r.program := nullif(p ->> 'program', '');
  r.asset_link := nullif(trim(coalesce(p ->> 'asset_link', '')), '');
  r.caption := nullif(trim(coalesce(p ->> 'caption', '')), '');
  r.link := nullif(trim(coalesce(p ->> 'link', '')), '');
  r.youth := coalesce((p ->> 'youth')::boolean, false);
  r.releases := coalesce((p ->> 'releases')::boolean, false);
  begin
    r.post_date := nullif(p ->> 'post_date', '')::date;
    r.event_date := nullif(p ->> 'event_date', '')::date;
  exception when others then
    raise exception 'Use real dates for the post and the event.';
  end;
  if jsonb_typeof(coalesce(p -> 'platforms', '[]'::jsonb)) <> 'array' then
    raise exception 'Choose at least one place to post.';
  end if;
  r.platforms := array(select distinct x from jsonb_array_elements_text(coalesce(p -> 'platforms', '[]'::jsonb)) x order by x);

  if r.contact_name is null or char_length(r.contact_name) < 2 then
    raise exception 'Add your name.';
  end if;
  if char_length(r.contact_name) > 80 then
    raise exception 'Keep your name under 80 characters.';
  end if;
  if r.committee is null or char_length(r.committee) < 2 then
    raise exception 'Choose your committee.';
  end if;
  if char_length(r.committee) > 60 then
    raise exception 'Keep the committee name under 60 characters.';
  end if;
  if r.title is null or char_length(r.title) < 3 then
    raise exception 'Say what the post is about in a few words.';
  end if;
  if char_length(r.title) > 120 then
    raise exception 'Keep the title under 120 characters.';
  end if;
  if r.post_date is null then
    raise exception 'Choose a post date.';
  end if;
  if r.about is null or char_length(r.about) < 3 then
    raise exception 'Add the details: who, what, when, and where.';
  end if;
  if char_length(r.about) > 2000 then
    raise exception 'Keep the details under 2,000 characters.';
  end if;
  if r.format not in ('graphic', 'carousel', 'reel', 'story', 'flyer', 'text') then
    raise exception 'Choose a format from the list.';
  end if;
  if r.program is not null and r.program not in ('vote', 'college', 'project-alpha', 'keeper') then
    raise exception 'Choose a national program from the list.';
  end if;
  if cardinality(r.platforms) = 0 then
    raise exception 'Choose at least one place to post.';
  end if;
  if not r.platforms <@ array['instagram', 'facebook', 'threads', 'x', 'website', 'substack', 'whatsapp']::text[] then
    raise exception 'Choose places to post from the list.';
  end if;
  if (r.asset_link is not null and r.asset_link !~* '^https?://\S+$')
     or (r.link is not null and r.link !~* '^https?://\S+$') then
    raise exception 'Links need to start with https://.';
  end if;
  if char_length(coalesce(r.caption, '')) > 2200 then
    raise exception 'Keep the caption under 2,200 characters, the Instagram limit.';
  end if;
  if r.youth and not r.releases then
    raise exception 'Confirm that media releases are on file, or remove photos of young people.';
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security: reads. Brothers write through the functions below.
-- ---------------------------------------------------------------------------

alter table public.cal_staff enable row level security;
alter table public.cal_members enable row level security;
alter table public.cal_posts enable row level security;
alter table public.cal_requests enable row level security;

create policy "visitors read the public calendar when it is on"
  on public.cal_posts for select to anon using ((select cal_private.is_public()));
create policy "brothers and the media team read the calendar"
  on public.cal_posts for select to authenticated using ((select cal_private.can_view()));
create policy "the media team adds posts"
  on public.cal_posts for insert to authenticated with check ((select cal_private.is_staff()));
create policy "the media team edits posts"
  on public.cal_posts for update to authenticated
  using ((select cal_private.is_staff())) with check ((select cal_private.is_staff()));
create policy "the media team deletes posts"
  on public.cal_posts for delete to authenticated using ((select cal_private.is_staff()));

create policy "brothers and the media team read requests"
  on public.cal_requests for select to authenticated using ((select cal_private.can_view()));

create policy "a brother sees his own record and the media team sees all"
  on public.cal_members for select to authenticated
  using (user_id = (select auth.uid()) or (select cal_private.is_staff()));

create policy "the media team sees the media team"
  on public.cal_staff for select to authenticated
  using (user_id = (select auth.uid()) or (select cal_private.is_staff()));

-- ---------------------------------------------------------------------------
-- Everyone
-- ---------------------------------------------------------------------------

create or replace function public.cal_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'public', cal_private.is_public(),
    'lead_days', 21,
    'ready', exists (select 1 from cal_private.config where key = 'calendar_chapter_code_hash')
         and exists (select 1 from cal_private.config where key = 'calendar_media_code_hash')
  )
$$;

create or replace function public.cal_whoami()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  s public.cal_staff;
  m public.cal_members;
begin
  if v_uid is null then
    return jsonb_build_object('role', 'visitor');
  end if;
  select * into s from public.cal_staff where user_id = v_uid;
  if found then
    return jsonb_build_object('role', 'staff', 'name', s.display_name);
  end if;
  select * into m from public.cal_members where user_id = v_uid;
  if found then
    return cal_private.member_json(m);
  end if;
  return jsonb_build_object('role', 'visitor');
end;
$$;

-- ---------------------------------------------------------------------------
-- Brothers
-- ---------------------------------------------------------------------------

create or replace function public.cal_join(p_code text, p_name text, p_pin text, p_committee text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_now timestamptz := cal_private.clock();
  v_name text := cal_private.clean(p_name);
  v_committee text := cal_private.clean(p_committee);
  m public.cal_members;
begin
  if v_uid is null then
    raise exception 'Start a session first, then sign in.';
  end if;
  select * into m from public.cal_members where user_id = v_uid;
  if found then
    return cal_private.member_json(m);
  end if;
  if not exists (select 1 from cal_private.config where key = 'calendar_chapter_code_hash') then
    raise exception 'Sign-in is not set up yet. Ask the media team to set the chapter code.';
  end if;
  if not cal_private.code_ok('chapter', p_code) then
    raise exception 'That chapter code is not right. Check it with the media team.';
  end if;
  if v_name is null or char_length(v_name) not between 2 and 40 or v_name ~ '[[:cntrl:]<>]' then
    raise exception 'Use 2 to 40 characters for your name.';
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4,6}$' then
    raise exception 'Your PIN must be 4 to 6 digits.';
  end if;
  if v_committee is not null and char_length(v_committee) > 60 then
    raise exception 'Keep the committee name under 60 characters.';
  end if;
  if exists (select 1 from public.cal_members x where lower(x.display_name) = lower(v_name)) then
    raise exception 'Someone already signed in as "%". If that is you, choose "I''ve signed in before."', v_name;
  end if;

  insert into public.cal_members (user_id, display_name, committee, created_at, last_seen_at)
  values (v_uid, v_name, v_committee, v_now, v_now)
  returning * into m;
  insert into cal_private.member_secrets (member_id, pin_hash)
  values (m.id, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)));
  return cal_private.member_json(m);
end;
$$;

-- Returns {ok, message, member}. A wrong PIN returns ok false instead of raising, so the
-- attempt counter is saved. Five wrong PINs lock the name for 10 minutes.
create or replace function public.cal_rejoin(p_name text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_now timestamptz := cal_private.clock();
  m public.cal_members;
  sec cal_private.member_secrets;
  v_other public.cal_members;
  v_fails int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'message', 'Start a session first, then sign in.');
  end if;
  select * into m from public.cal_members where lower(display_name) = lower(cal_private.clean(p_name)) for update;
  if not found then
    return jsonb_build_object('ok', false, 'message',
      'No one has signed in with that name. Check the spelling, or choose "First time here."');
  end if;
  select * into sec from cal_private.member_secrets where member_id = m.id for update;
  if sec.locked_until is not null and sec.locked_until > v_now then
    return jsonb_build_object('ok', false, 'message',
      format('Too many wrong PINs. Try again in %s minutes, or ask the media team to reset your PIN.',
             ceil(extract(epoch from (sec.locked_until - v_now)) / 60)::int));
  end if;
  v_fails := case when sec.locked_until is not null then 0 else sec.failed_attempts end;

  if extensions.crypt(coalesce(p_pin, ''), sec.pin_hash) <> sec.pin_hash then
    v_fails := v_fails + 1;
    update cal_private.member_secrets
    set failed_attempts = v_fails,
        locked_until = case when v_fails >= 5 then v_now + interval '10 minutes' end
    where member_id = m.id;
    return jsonb_build_object('ok', false, 'message',
      case when v_fails >= 5
           then 'Too many wrong PINs. This name is locked for 10 minutes. The media team can reset your PIN.'
           else 'That PIN does not match. Try again.' end);
  end if;

  if m.user_id is distinct from v_uid then
    select * into v_other from public.cal_members where user_id = v_uid;
    if found then
      return jsonb_build_object('ok', false, 'message',
        format('This device is signed in as %s. Sign out first to switch.', v_other.display_name));
    end if;
  end if;

  update public.cal_members set user_id = v_uid, last_seen_at = v_now where id = m.id returning * into m;
  update cal_private.member_secrets set failed_attempts = 0, locked_until = null where member_id = m.id;
  return jsonb_build_object('ok', true, 'member', cal_private.member_json(m));
end;
$$;

create or replace function public.cal_submit_request(p_request jsonb)
returns public.cal_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.cal_requests;
  v_member uuid := cal_private.member_id();
  v_now timestamptz := cal_private.clock();
begin
  if not cal_private.can_view() then
    raise exception 'Sign in with the chapter code to send a request.';
  end if;
  r := cal_private.request_from_json(p_request);
  if r.post_date < cal_private.today() then
    raise exception 'That post date has passed. Choose a future date.';
  end if;
  if v_member is not null and (
       select count(*) from public.cal_requests x
       where x.member_id = v_member and x.status in ('new', 'needs-info')) >= 20 then
    raise exception 'You have 20 open requests. Wait for the media team to review some, then send more.';
  end if;
  insert into public.cal_requests (
    member_id, submitted_by, contact_name, committee, title, post_date, event_date, about, format,
    platforms, program, asset_link, caption, link, youth, releases, status, created_at, updated_at)
  values (
    v_member, (select auth.uid()), r.contact_name, r.committee, r.title, r.post_date, r.event_date, r.about,
    r.format, r.platforms, r.program, r.asset_link, r.caption, r.link, r.youth, r.releases, 'new', v_now, v_now)
  returning * into r;
  return r;
end;
$$;

create or replace function public.cal_update_request(p_id uuid, p_request jsonb)
returns public.cal_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  cur public.cal_requests;
  r public.cal_requests;
  v_staff boolean := cal_private.is_staff();
begin
  select * into cur from public.cal_requests where id = p_id for update;
  if not found then
    raise exception 'That request no longer exists.';
  end if;
  if not v_staff and (cur.member_id is null or cur.member_id is distinct from cal_private.member_id()) then
    raise exception 'You can edit only your own requests.';
  end if;
  if not v_staff and cur.status not in ('new', 'needs-info') then
    raise exception 'The media team already reviewed this request. Send a new request for changes.';
  end if;
  r := cal_private.request_from_json(p_request);
  if r.post_date < cal_private.today() and r.post_date is distinct from cur.post_date then
    raise exception 'That post date has passed. Choose a future date.';
  end if;
  update public.cal_requests
  set contact_name = r.contact_name, committee = r.committee, title = r.title, post_date = r.post_date,
      event_date = r.event_date, about = r.about, format = r.format, platforms = r.platforms,
      program = r.program, asset_link = r.asset_link, caption = r.caption, link = r.link,
      youth = r.youth, releases = r.releases,
      status = case when cur.status = 'needs-info' and not v_staff then 'new' else cur.status end,
      updated_at = cal_private.clock()
  where id = p_id
  returning * into r;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Media team
-- ---------------------------------------------------------------------------

create or replace function public.cal_claim_staff(p_code text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := cal_private.clean(p_name);
begin
  if v_uid is null then
    raise exception 'Sign in with your email account first.';
  end if;
  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'The media team signs in with an email account.';
  end if;
  if not exists (select 1 from cal_private.config where key = 'calendar_media_code_hash') then
    raise exception 'Media team sign-up is not set up yet. Run supabase/setup/1-codes.sql first.';
  end if;
  if not cal_private.code_ok('media', p_code) then
    raise exception 'That media code is not right.';
  end if;
  if v_name is null or char_length(v_name) not between 2 and 60 then
    raise exception 'Use 2 to 60 characters for your name.';
  end if;
  insert into public.cal_staff (user_id, display_name)
  values (v_uid, v_name)
  on conflict (user_id) do update set display_name = excluded.display_name;
  return jsonb_build_object('role', 'staff', 'name', v_name);
end;
$$;

create or replace function public.cal_review_request(p_id uuid, p_status text, p_note text default null)
returns public.cal_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.cal_requests;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform cal_private.assert_staff();
  if p_status not in ('new', 'needs-info', 'declined') then
    raise exception 'Choose New, Needs info, or Declined.';
  end if;
  if p_status in ('needs-info', 'declined') and v_note is null then
    raise exception 'Add a note for the chair.';
  end if;
  if char_length(coalesce(v_note, '')) > 800 then
    raise exception 'Keep the note under 800 characters.';
  end if;
  update public.cal_requests
  set status = p_status, review_note = v_note, reviewed_by = (select auth.uid()),
      reviewed_at = cal_private.clock(), updated_at = cal_private.clock()
  where id = p_id
  returning * into r;
  if not found then
    raise exception 'That request no longer exists.';
  end if;
  return r;
end;
$$;

-- Adds a request to the calendar as a post and marks the request approved, in one step.
create or replace function public.cal_approve_request(p_id uuid, p_post jsonb)
returns public.cal_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  req public.cal_requests;
  p public.cal_posts;
  v_date date;
begin
  perform cal_private.assert_staff();
  select * into req from public.cal_requests where id = p_id for update;
  if not found then
    raise exception 'That request no longer exists.';
  end if;
  if req.status = 'approved' and req.post_id is not null then
    raise exception 'This request is already on the calendar.';
  end if;
  begin
    v_date := nullif(p_post ->> 'date', '')::date;
  exception when others then
    raise exception 'Use a real post date.';
  end;
  if v_date is null then
    raise exception 'Choose a post date.';
  end if;
  if cal_private.clean(p_post ->> 'title') is null then
    raise exception 'Add a title.';
  end if;

  insert into public.cal_posts (
    id, date, title, category, program, format, platforms, status, committee, concept, caption,
    notes, event_date, link, asset_link, source, request_id)
  values (
    coalesce(nullif(p_post ->> 'id', ''), 'p-' || replace(gen_random_uuid()::text, '-', '')),
    v_date,
    cal_private.clean(p_post ->> 'title'),
    coalesce(nullif(p_post ->> 'category', ''), 'chapter'),
    nullif(p_post ->> 'program', ''),
    coalesce(nullif(p_post ->> 'format', ''), req.format),
    case when jsonb_typeof(p_post -> 'platforms') = 'array'
         then array(select jsonb_array_elements_text(p_post -> 'platforms'))
         else req.platforms end,
    coalesce(nullif(p_post ->> 'status', ''), 'planned'),
    nullif(trim(coalesce(p_post ->> 'committee', '')), ''),
    nullif(trim(coalesce(p_post ->> 'concept', '')), ''),
    nullif(trim(coalesce(p_post ->> 'caption', '')), ''),
    nullif(trim(coalesce(p_post ->> 'notes', '')), ''),
    nullif(p_post ->> 'event_date', '')::date,
    nullif(trim(coalesce(p_post ->> 'link', '')), ''),
    nullif(trim(coalesce(p_post ->> 'asset_link', '')), ''),
    nullif(trim(coalesce(p_post ->> 'source', '')), ''),
    p_id)
  returning * into p;

  update public.cal_requests
  set status = 'approved', post_id = p.id, review_note = null, reviewed_by = (select auth.uid()),
      reviewed_at = cal_private.clock(), updated_at = cal_private.clock()
  where id = p_id;
  return p;
end;
$$;

create or replace function public.cal_member_list()
returns table (
  id uuid, display_name text, committee text, created_at timestamptz, last_seen_at timestamptz,
  requests bigint, locked boolean, signed_in boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  return query
    select m.id, m.display_name, m.committee, m.created_at, m.last_seen_at,
           (select count(*) from public.cal_requests r where r.member_id = m.id),
           coalesce(s.locked_until > cal_private.clock(), false),
           m.user_id is not null
    from public.cal_members m
    left join cal_private.member_secrets s on s.member_id = m.id
    order by lower(m.display_name);
end;
$$;

create or replace function public.cal_reset_pin(p_member_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  if coalesce(p_pin, '') !~ '^[0-9]{4,6}$' then
    raise exception 'The new PIN must be 4 to 6 digits.';
  end if;
  update cal_private.member_secrets
  set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), failed_attempts = 0, locked_until = null
  where member_id = p_member_id;
  if not found then
    raise exception 'That brother is no longer on the list.';
  end if;
end;
$$;

-- Removes a brother's sign-in. His requests stay, with his name on them.
create or replace function public.cal_remove_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  delete from public.cal_members where id = p_member_id;
  if not found then
    raise exception 'That brother is no longer on the list.';
  end if;
end;
$$;

create or replace function public.cal_set_public(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  insert into cal_private.config (key, value)
  values ('calendar_public', case when coalesce(p_on, false) then 'true' else 'false' end)
  on conflict (key) do update set value = excluded.value;
  return public.cal_settings();
end;
$$;

create or replace function public.cal_set_chapter_code(p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  perform cal_private.set_code('chapter', p_code);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Listed one by one so this never touches another app's objects.
-- ---------------------------------------------------------------------------

revoke all on public.cal_staff, public.cal_members, public.cal_posts, public.cal_requests from anon, authenticated;
revoke all on cal_private.member_secrets, cal_private.config from public, anon, authenticated;

grant select (id, date, title, category, program, format, platforms, status, committee, concept, event_date, link)
  on public.cal_posts to anon;
grant select, insert, update, delete on public.cal_posts to authenticated;
grant select on public.cal_requests, public.cal_members, public.cal_staff to authenticated;
grant all on public.cal_staff, public.cal_members, public.cal_posts, public.cal_requests to service_role;

revoke execute on function
  cal_private.clock(), cal_private.today(), cal_private.clean(text), cal_private.norm_code(text),
  cal_private.is_staff(), cal_private.member_id(), cal_private.can_view(), cal_private.is_public(),
  cal_private.assert_staff(), cal_private.set_code(text, text), cal_private.code_ok(text, text),
  cal_private.member_json(public.cal_members), cal_private.touch_post(), cal_private.request_from_json(jsonb)
  from public, anon, authenticated;

-- Policies and the post trigger call these as the signed-in person.
grant execute on function
  cal_private.clock(), cal_private.is_staff(), cal_private.member_id(), cal_private.can_view(), cal_private.is_public()
  to anon, authenticated;

revoke execute on function
  public.cal_settings(), public.cal_whoami(), public.cal_join(text, text, text, text), public.cal_rejoin(text, text),
  public.cal_submit_request(jsonb), public.cal_update_request(uuid, jsonb), public.cal_claim_staff(text, text),
  public.cal_review_request(uuid, text, text), public.cal_approve_request(uuid, jsonb), public.cal_member_list(),
  public.cal_reset_pin(uuid, text), public.cal_remove_member(uuid), public.cal_set_public(boolean),
  public.cal_set_chapter_code(text)
  from public, anon;

grant execute on function public.cal_settings(), public.cal_whoami() to anon, authenticated;

grant execute on function
  public.cal_join(text, text, text, text), public.cal_rejoin(text, text), public.cal_submit_request(jsonb),
  public.cal_update_request(uuid, jsonb), public.cal_claim_staff(text, text), public.cal_review_request(uuid, text, text),
  public.cal_approve_request(uuid, jsonb), public.cal_member_list(), public.cal_reset_pin(uuid, text),
  public.cal_remove_member(uuid), public.cal_set_public(boolean), public.cal_set_chapter_code(text)
  to authenticated;
