-- School Daze photo drop (school-daze/photos.html, review.html, and screen.html).
-- Runs after 20261114000100_social_sync_health.sql. Run it before deploying the photo-drop Edge
-- Function, then set the three codes with supabase/setup/4-photo-drop.sql.
--
-- What it adds
-- * public.drop_photos: one row for each photo a ticket buyer sends, with who sent it, its size,
--   where its file is, and whether the organizers have approved it for the big screens.
-- * A private Storage bucket, photo-drop, for the photos and their thumbnails. JPEG only, 8 MB a
--   file.
-- * Settings in cal_private.config, all starting drop_: the three hashed codes, the open switch,
--   the deadline, and the limits.
-- * The cal_private.drop_ functions, which are everything the photo-drop Edge Function does in
--   the database.
--
-- How it works
-- * The three pages talk to the Edge Function and nothing else. The function connects as the
--   database owner, the way calendar-social does, and calls the functions below. No API role can
--   run them or read the table, and the bucket has no storage policies: only the Edge Function's
--   secret key reaches the files.
-- * Each page has its own code. The upload code travels in the link in the ticket email, the
--   organizers type the review code, and the venue's computer has the screen code. Codes are kept
--   as bcrypt hashes and compared without regard to case or extra spaces.
-- * Functions that take a code check it themselves. A wrong code, a closed drop, or a limit comes
--   back as { ok: false, status, reason, error } instead of an exception, and the Edge Function
--   sends that to the page as it stands.
-- * Sending a photo takes three steps. drop_reserve checks everything and saves the row as
--   'sending'. The Edge Function puts the files in the bucket. drop_stored marks the row 'waiting'
--   for review. A row still 'sending' after 15 minutes was never finished: it stops counting
--   toward the limits, and the next time an organizer opens the review page it is removed.
-- * Every time comes from cal_private.clock(), so the tests can set the date.

-- ---------------------------------------------------------------------------
-- The photos
-- ---------------------------------------------------------------------------

create table public.drop_photos (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'sending',
  name text not null,
  email text not null,
  caption text,
  width integer not null,
  height integer not null,
  -- The photo and its thumbnail together: what the row takes up in the bucket.
  bytes integer not null,
  has_thumb boolean not null default false,
  -- The file the person picked, before the page shrank it: { name, width, height, bytes, type }.
  original jsonb,
  path text not null unique,
  thumb_path text,
  -- Signed links to the two files, and when they run out. The Edge Function renews them.
  url text,
  thumb_url text,
  signed_until timestamptz,
  ip_hash text,
  created_at timestamptz not null,
  stored_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,
  constraint drop_photos_status_check check (status in ('sending', 'waiting', 'approved', 'rejected')),
  constraint drop_photos_name_check check (char_length(name) between 1 and 80),
  constraint drop_photos_email_check check (char_length(email) between 3 and 120 and email = lower(email)),
  constraint drop_photos_caption_check check (caption is null or char_length(caption) between 1 and 80),
  constraint drop_photos_size_check check (width between 1 and 65535 and height between 1 and 65535 and bytes > 0),
  constraint drop_photos_reviewed_by_check check (reviewed_by is null or char_length(reviewed_by) <= 60)
);
create index drop_photos_email_idx on public.drop_photos (email);
create index drop_photos_status_idx on public.drop_photos (status, reviewed_at);

-- Row level security with no policies: the Data API can do nothing with this table.
alter table public.drop_photos enable row level security;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- Uploads close at noon New York time on the day of the party, so the organizers have the
-- afternoon to review. setup/4-photo-drop.sql shows how to change any of these.
insert into cal_private.config (key, value) values
  ('drop_open', 'true'),
  ('drop_closes_at', '2026-11-21T12:00:00-05:00'),
  ('drop_per_person', '5'),
  ('drop_max_photos', '600'),
  ('drop_max_bytes', '750000000'),
  ('drop_per_ip_day', '60'),
  -- Mixed into each connection's address before it is hashed, so the hashes can't be looked up.
  ('drop_ip_salt', encode(extensions.gen_random_bytes(16), 'hex'))
on conflict (key) do nothing;

create or replace function cal_private.drop_setting(p_key text, p_default text default null)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select c.value from cal_private.config c where c.key = 'drop_' || p_key), p_default)
$$;

-- A whole-number setting. Anything else typed into the setting counts as the default, so a slip
-- in SQL Editor can't take the pages down.
create or replace function cal_private.drop_number(p_key text, p_default bigint)
returns bigint
language sql
stable
set search_path = ''
as $$
  select case when s.v ~ '^[0-9]{1,15}$' then s.v::bigint else p_default end
  from (select trim(cal_private.drop_setting(p_key, ''))) as s(v)
$$;

-- When uploads close, or null for no deadline. A deadline that can't be read counts as none, for
-- the same reason. The review page shows what is in force.
create or replace function cal_private.drop_closes_at()
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text text := nullif(trim(cal_private.drop_setting('closes_at', '')), '');
  v_time timestamptz;
begin
  if v_text is null then
    return null;
  end if;
  v_time := v_text::timestamptz;
  return case when isfinite(v_time) then v_time end;
exception when others then
  return null;
end;
$$;

-- A refusal, in the shape the Edge Function passes on to the page.
create or replace function cal_private.drop_no(p_status integer, p_reason text, p_error text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'status', p_status, 'reason', p_reason, 'error', p_error)
$$;

-- ---------------------------------------------------------------------------
-- Codes
-- ---------------------------------------------------------------------------

create or replace function cal_private.drop_code_ok(p_kind text, p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_kind in ('upload', 'review', 'screen')
    and cal_private.norm_code(p_code) <> ''
    and (select extensions.crypt(cal_private.norm_code(p_code), s.value) = s.value
         from cal_private.config s where s.key = 'drop_' || p_kind || '_code_hash'),
    false)
$$;

-- Sets one of the three codes. Run from SQL Editor (setup/4-photo-drop.sql).
create or replace function cal_private.drop_set_code(p_kind text, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := cal_private.norm_code(p_code);
  v_other text;
begin
  if p_kind is null or p_kind not in ('upload', 'review', 'screen') then
    raise exception 'Choose the upload code, the review code, or the screen code.';
  end if;
  if v_code like 'replace with%' then
    raise exception 'Replace the placeholder with your own code first.';
  end if;
  if p_kind = 'upload' and char_length(v_code) < 8 then
    raise exception 'Use an upload code of at least 8 characters.';
  end if;
  if p_kind in ('review', 'screen') and char_length(v_code) < 12 then
    raise exception 'Use a % code of at least 12 characters.', p_kind;
  end if;
  -- bcrypt reads the first 72 bytes and no more.
  if octet_length(v_code) > 72 then
    raise exception 'Keep the code to 72 characters or fewer.';
  end if;
  -- The upload code is part of a link. A space, &, #, + or % would break the link in an email.
  if p_kind = 'upload' and v_code !~ '^[a-z0-9_-]+$' then
    raise exception 'Use only letters, numbers, and dashes in the upload code. It goes inside a link.';
  end if;
  -- Every ticket buyer has the upload code and the venue has the screen code, so neither may
  -- double as the review code.
  foreach v_other in array array['upload', 'review', 'screen'] loop
    if v_other <> p_kind and cal_private.drop_code_ok(v_other, v_code) then
      raise exception 'That is already the % code. Give each of the three its own.', v_other;
    end if;
  end loop;
  insert into cal_private.config (key, value)
  values ('drop_' || p_kind || '_code_hash', extensions.crypt(v_code, extensions.gen_salt('bf', 8)))
  on conflict (key) do update set value = excluded.value;
end;
$$;

-- ---------------------------------------------------------------------------
-- Open, closed, or full
-- ---------------------------------------------------------------------------

-- Where things stand: the switch, the deadline, the limits, and how much has come in. state is
-- 'closed' (switched off, or past the deadline), 'full' (a chapter-wide limit is reached), or
-- 'open'. A row still 'sending' counts for its first 15 minutes, so photos on their way in hold
-- their place.
create or replace function cal_private.drop_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := cal_private.clock();
  v_open boolean := lower(trim(cal_private.drop_setting('open', 'true'))) <> 'false';
  v_closes timestamptz := cal_private.drop_closes_at();
  v_max_photos bigint := cal_private.drop_number('max_photos', 600);
  v_max_bytes bigint := cal_private.drop_number('max_bytes', 750000000);
  v_photos bigint;
  v_bytes bigint;
begin
  select count(*), coalesce(sum(p.bytes), 0) into v_photos, v_bytes
  from public.drop_photos p
  where p.status <> 'sending' or p.created_at > v_now - interval '15 minutes';
  return jsonb_build_object(
    'open', v_open,
    'closes_at', v_closes,
    'state', case
      when not v_open or (v_closes is not null and v_closes <= v_now) then 'closed'
      when v_photos >= v_max_photos or v_bytes >= v_max_bytes then 'full'
      else 'open' end,
    'per_person', cal_private.drop_number('per_person', 5),
    'max_photos', v_max_photos,
    'max_bytes', v_max_bytes,
    'photos', v_photos,
    'bytes', v_bytes
  );
end;
$$;

-- The upload page's first question: is this link good, and are photos still being taken? The
-- limits are what the page shrinks each photo to before sending. The Edge Function holds the same
-- numbers (drop.js) and checks every photo against them.
create or replace function cal_private.drop_open(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state jsonb;
begin
  if not cal_private.drop_code_ok('upload', p_code) then
    return cal_private.drop_no(403, 'code', 'That link isn''t right. Use the link in your School Daze email.');
  end if;
  v_state := cal_private.drop_state();
  return jsonb_build_object(
    'ok', true,
    'open', v_state ->> 'state' = 'open',
    'reason', case when v_state ->> 'state' <> 'open' then v_state ->> 'state' end,
    'closes_at', v_state -> 'closes_at',
    'per_person', v_state -> 'per_person',
    'limits', jsonb_build_object('min_edge', 500, 'max_edge', 2560, 'max_bytes', 6291456)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Sending a photo
-- ---------------------------------------------------------------------------

-- Checks one photo against everything and saves its row as 'sending'. The checks run in the order
-- a person would want to hear about them: the link, then whether photos are still being taken,
-- then what they typed, then the limits. Returns { ok, id, path, thumb_path, left }, where left is
-- how many more this email may send. p_ip is the sender's address, or empty when it isn't known;
-- only a hash of it is kept.
create or replace function cal_private.drop_reserve(
  p_code text, p_name text, p_email text, p_caption text, p_width integer, p_height integer,
  p_bytes integer, p_has_thumb boolean, p_ip text, p_original jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := cal_private.clock();
  v_name text := cal_private.clean(p_name);
  v_email text := lower(trim(coalesce(p_email, '')));
  v_caption text := cal_private.clean(p_caption);
  v_thumb boolean := coalesce(p_has_thumb, false);
  v_ip text := trim(coalesce(p_ip, ''));
  v_ip_hash text;
  v_state text;
  v_per_person bigint;
  v_per_ip bigint;
  v_sent bigint;
  v_id uuid := gen_random_uuid();
begin
  if not cal_private.drop_code_ok('upload', p_code) then
    return cal_private.drop_no(403, 'code', 'That link isn''t right. Use the link in your School Daze email.');
  end if;

  -- One photo at a time from here on, so two sent at the same moment can't both slip under a
  -- limit. The lock lasts until this call's transaction ends. Any fixed number works as its name.
  perform pg_advisory_xact_lock(1906120421);

  v_state := cal_private.drop_state() ->> 'state';
  if v_state = 'closed' then
    return cal_private.drop_no(409, 'closed', 'Photo uploads have closed.');
  end if;
  if v_state = 'full' then
    return cal_private.drop_no(409, 'full', 'We have all the photos we can take. Thank you!');
  end if;

  if v_name is null then
    return cal_private.drop_no(400, 'input', 'Add your name.');
  end if;
  if char_length(v_name) > 80 then
    return cal_private.drop_no(400, 'input', 'Keep your name to 80 characters or fewer.');
  end if;
  if char_length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return cal_private.drop_no(400, 'input', 'Add the email you bought your ticket with.');
  end if;
  if char_length(v_caption) > 80 then
    return cal_private.drop_no(400, 'input', 'Keep the caption to 80 characters or fewer.');
  end if;

  -- The Edge Function has already read the photo's real size. These hold if anything else calls.
  if p_width is null or p_height is null or p_bytes is null
     or p_width not between 1 and 65535 or p_height not between 1 and 65535 or p_bytes < 1 then
    return cal_private.drop_no(400, 'photo', 'That file isn''t a photo we can use. Send a JPEG.');
  end if;
  if greatest(p_width, p_height) < 500 then
    return cal_private.drop_no(400, 'photo', 'That photo is too small to show on a big screen. Send a larger copy.');
  end if;

  -- Every photo this email has sent counts, whatever became of it, apart from sends that never
  -- finished.
  v_per_person := cal_private.drop_number('per_person', 5);
  select count(*) into v_sent
  from public.drop_photos p
  where p.email = v_email and (p.status <> 'sending' or p.created_at > v_now - interval '15 minutes');
  if v_sent >= v_per_person then
    return cal_private.drop_no(409, 'limit', case
      when v_sent = v_per_person then
        format('You''ve sent %s %s, which is the most one person can send.', v_sent, case when v_sent = 1 then 'photo' else 'photos' end)
      else
        format('You''ve sent %s %s. The most one person can send is %s.', v_sent, case when v_sent = 1 then 'photo' else 'photos' end, v_per_person)
      end);
  end if;

  -- One connection can only send so many in a day, whatever names and emails come with them.
  -- Setting drop_per_ip_day to 0 turns this off.
  if v_ip <> '' then
    v_ip_hash := encode(sha256(convert_to(cal_private.drop_setting('ip_salt', '') || v_ip, 'UTF8')), 'hex');
    v_per_ip := cal_private.drop_number('per_ip_day', 60);
    if v_per_ip > 0 and (
      select count(*) from public.drop_photos p
      where p.ip_hash = v_ip_hash and p.created_at > v_now - interval '1 day'
    ) >= v_per_ip then
      return cal_private.drop_no(409, 'limit', 'Too many photos have come from this connection today. Try again tomorrow.');
    end if;
  end if;

  insert into public.drop_photos (
    id, status, name, email, caption, width, height, bytes, has_thumb, original, path, thumb_path, ip_hash, created_at)
  values (
    v_id, 'sending', v_name, v_email, v_caption, p_width, p_height, p_bytes, v_thumb,
    case when jsonb_typeof(p_original) = 'object' and char_length(p_original::text) < 600 then p_original end,
    'photos/' || v_id || '.jpg',
    case when v_thumb then 'thumbs/' || v_id || '.jpg' end,
    v_ip_hash, v_now);

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'path', 'photos/' || v_id || '.jpg',
    'thumb_path', case when v_thumb then 'thumbs/' || v_id || '.jpg' end,
    'left', greatest(v_per_person - v_sent - 1, 0)
  );
end;
$$;

-- The files are in the bucket: the photo is ready for review. False when the row is gone or was
-- never 'sending', and the Edge Function then takes the files back out.
create or replace function cal_private.drop_stored(p_id uuid, p_url text, p_thumb_url text, p_signed_until timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(p_url, '') = '' or p_signed_until is null then
    return false;
  end if;
  update public.drop_photos
  set status = 'waiting', url = p_url, thumb_url = nullif(p_thumb_url, ''), signed_until = p_signed_until,
      stored_at = cal_private.clock()
  where id = p_id and status = 'sending';
  return found;
end;
$$;

-- Storage failed partway: forget the photo, so it doesn't count against the sender.
create or replace function cal_private.drop_abandon(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.drop_photos where id = p_id and status = 'sending'
$$;

-- Removes the rows of sends that never finished, and returns their file paths (photo and
-- thumbnail) for the Edge Function to take out of the bucket.
create or replace function cal_private.drop_stale()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.drop_photos p
    where p.status = 'sending' and p.created_at <= cal_private.clock() - interval '15 minutes'
    returning p.path, p.thumb_path
  )
  select coalesce(jsonb_agg(f.path), '[]'::jsonb)
  from gone g cross join lateral (values (g.path), (g.thumb_path)) as f(path)
  where f.path is not null
$$;

-- ---------------------------------------------------------------------------
-- Review
-- ---------------------------------------------------------------------------

-- Everything the review page shows: the settings, the counts, and every photo that has finished
-- arriving, oldest first.
create or replace function cal_private.drop_review_list(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not cal_private.drop_code_ok('review', p_code) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;
  return jsonb_build_object(
    'ok', true,
    'settings', cal_private.drop_state(),
    'counts', (
      select jsonb_build_object(
        'waiting', count(*) filter (where p.status = 'waiting'),
        'approved', count(*) filter (where p.status = 'approved'),
        'rejected', count(*) filter (where p.status = 'rejected'))
      from public.drop_photos p),
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'status', p.status, 'name', p.name, 'email', p.email, 'caption', p.caption,
        'width', p.width, 'height', p.height, 'bytes', p.bytes, 'original', p.original,
        'created_at', p.created_at, 'reviewed_at', p.reviewed_at, 'reviewed_by', p.reviewed_by,
        'url', p.url, 'thumb_url', coalesce(p.thumb_url, p.url)
      ) order by p.created_at, p.id)
      from public.drop_photos p
      where p.status <> 'sending'), '[]'::jsonb)
  );
end;
$$;

-- Approve, reject, or send back to waiting. A photo already in that state is left as it is, so
-- approving twice doesn't move it in the slideshow's order. Sending back to waiting clears who
-- reviewed it and when.
create or replace function cal_private.drop_review_set(p_code text, p_ids uuid[], p_status text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := cal_private.clock();
  v_by text := left(cal_private.clean(p_by), 60);
  v_changed integer;
begin
  if not cal_private.drop_code_ok('review', p_code) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;
  if p_status is null or p_status not in ('approved', 'rejected', 'waiting') then
    return cal_private.drop_no(400, 'input', 'Choose approve, reject, or back to waiting.');
  end if;
  if coalesce(cardinality(p_ids), 0) not between 1 and 200 then
    return cal_private.drop_no(400, 'input', 'Choose between 1 and 200 photos at a time.');
  end if;
  update public.drop_photos p
  set status = p_status,
      reviewed_at = case when p_status <> 'waiting' then v_now end,
      reviewed_by = case when p_status <> 'waiting' then v_by end
  where p.id = any(p_ids) and p.status not in ('sending', p_status);
  get diagnostics v_changed = row_count;
  return jsonb_build_object('ok', true, 'changed', v_changed);
end;
$$;

-- Changes or clears the line shown with a photo.
create or replace function cal_private.drop_review_caption(p_code text, p_id uuid, p_caption text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caption text := cal_private.clean(p_caption);
begin
  if not cal_private.drop_code_ok('review', p_code) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;
  if char_length(v_caption) > 80 then
    return cal_private.drop_no(400, 'input', 'Keep the caption to 80 characters or fewer.');
  end if;
  update public.drop_photos set caption = v_caption where id = p_id and status <> 'sending';
  if not found then
    return cal_private.drop_no(400, 'input', 'That photo is no longer here. Refresh to see the latest.');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- The open switch and the deadline. p holds only what is changing: open (true or false) and
-- closes_at (a time, or null for no deadline). Nothing is saved unless all of it reads right.
create or replace function cal_private.drop_review_settings(p_code text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_time timestamptz;
begin
  if not cal_private.drop_code_ok('review', p_code) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;
  if v ? 'open' and jsonb_typeof(v -> 'open') <> 'boolean' then
    return cal_private.drop_no(400, 'input', 'Choose open or closed.');
  end if;
  if v ? 'closes_at' and jsonb_typeof(v -> 'closes_at') <> 'null' then
    begin
      if jsonb_typeof(v -> 'closes_at') = 'string' then
        v_time := (v ->> 'closes_at')::timestamptz;
      end if;
    exception when others then
      v_time := null;
    end;
    if v_time is null or not isfinite(v_time) then
      return cal_private.drop_no(400, 'input', 'That date and time didn''t read right. Choose them again.');
    end if;
  end if;

  if v ? 'open' then
    insert into cal_private.config (key, value)
    values ('drop_open', case when (v -> 'open')::boolean then 'true' else 'false' end)
    on conflict (key) do update set value = excluded.value;
  end if;
  if v ? 'closes_at' then
    if v_time is null then
      delete from cal_private.config where key = 'drop_closes_at';
    else
      insert into cal_private.config (key, value)
      values ('drop_closes_at', to_char(v_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      on conflict (key) do update set value = excluded.value;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'settings', cal_private.drop_state());
end;
$$;

-- The rows about to be deleted and their files: { ok, ids, paths }. A null p_ids means every row,
-- for emptying the drop after the party. The Edge Function removes the files, then deletes
-- exactly these ids, so a photo that arrives in between keeps its row.
create or replace function cal_private.drop_review_paths(p_code text, p_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not cal_private.drop_code_ok('review', p_code) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;
  return (
    with chosen as (
      select p.id, p.path, p.thumb_path, p.created_at
      from public.drop_photos p
      where p_ids is null or p.id = any(p_ids)
    )
    select jsonb_build_object(
      'ok', true,
      'ids', coalesce((select jsonb_agg(c.id order by c.created_at, c.id) from chosen c), '[]'::jsonb),
      'paths', coalesce((
        select jsonb_agg(f.path)
        from chosen c cross join lateral (values (c.path), (c.thumb_path)) as f(path)
        where f.path is not null), '[]'::jsonb))
  );
end;
$$;

-- Deletes rows whose files are already out of the bucket. Only the ids given: null deletes
-- nothing.
create or replace function cal_private.drop_review_delete(p_code text, p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if not cal_private.drop_code_ok('review', p_code) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;
  delete from public.drop_photos p where p.id = any(p_ids);
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_deleted);
end;
$$;

-- ---------------------------------------------------------------------------
-- The slideshow
-- ---------------------------------------------------------------------------

-- Approved photos in the order they were approved, with nothing about who sent them. The venue's
-- computer uses the screen code. The review code works too, so an organizer can preview.
create or replace function cal_private.drop_screen_list(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (cal_private.drop_code_ok('screen', p_code) or cal_private.drop_code_ok('review', p_code)) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;
  return jsonb_build_object(
    'ok', true,
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'url', p.url, 'thumb_url', coalesce(p.thumb_url, p.url),
        'width', p.width, 'height', p.height, 'caption', p.caption
      ) order by p.reviewed_at, p.created_at, p.id)
      from public.drop_photos p
      where p.status = 'approved' and p.url is not null), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Keeping the signed links alive
-- ---------------------------------------------------------------------------

-- Photos whose links run out within 3 days: [{ id, path, thumb_path }].
create or replace function cal_private.drop_resign_due()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'path', p.path, 'thumb_path', p.thumb_path)
                            order by p.created_at, p.id), '[]'::jsonb)
  from public.drop_photos p
  where p.status <> 'sending'
    and (p.signed_until is null or p.signed_until <= cal_private.clock() + interval '3 days')
$$;

-- Saves fresh links: [{ id, url, thumb_url, signed_until }]. Returns how many rows it updated.
create or replace function cal_private.drop_resign_save(p jsonb)
returns integer
language sql
security definer
set search_path = ''
as $$
  with fresh as (
    select (x ->> 'id')::uuid as id, x ->> 'url' as url, nullif(x ->> 'thumb_url', '') as thumb_url,
           (x ->> 'signed_until')::timestamptz as signed_until
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) as x
  ), saved as (
    update public.drop_photos d
    set url = f.url, thumb_url = f.thumb_url, signed_until = f.signed_until
    from fresh f
    where d.id = f.id and d.status <> 'sending' and coalesce(f.url, '') <> '' and f.signed_until is not null
    returning 1
  )
  select count(*)::integer from saved
$$;

-- ---------------------------------------------------------------------------
-- The bucket. No storage policies: only the Edge Function's secret key reaches the files, and
-- the pages see them through signed links.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photo-drop', 'photo-drop', false, 8388608, array['image/jpeg'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Grants. Listed one by one so this never touches another app's objects.
-- ---------------------------------------------------------------------------

-- Supabase grants new public tables to the API roles. Nothing reads this one through the Data API.
revoke all on public.drop_photos from public, anon, authenticated, service_role;

-- Only the database owner runs these: the Edge Function's connection, and SQL Editor.
revoke execute on function
  cal_private.drop_setting(text, text), cal_private.drop_number(text, bigint), cal_private.drop_closes_at(),
  cal_private.drop_no(integer, text, text), cal_private.drop_code_ok(text, text), cal_private.drop_set_code(text, text),
  cal_private.drop_state(), cal_private.drop_open(text),
  cal_private.drop_reserve(text, text, text, text, integer, integer, integer, boolean, text, jsonb),
  cal_private.drop_stored(uuid, text, text, timestamptz), cal_private.drop_abandon(uuid), cal_private.drop_stale(),
  cal_private.drop_review_list(text), cal_private.drop_review_set(text, uuid[], text, text),
  cal_private.drop_review_caption(text, uuid, text), cal_private.drop_review_settings(text, jsonb),
  cal_private.drop_review_paths(text, uuid[]), cal_private.drop_review_delete(text, uuid[]),
  cal_private.drop_screen_list(text), cal_private.drop_resign_due(), cal_private.drop_resign_save(jsonb)
  from public, anon, authenticated, service_role;
