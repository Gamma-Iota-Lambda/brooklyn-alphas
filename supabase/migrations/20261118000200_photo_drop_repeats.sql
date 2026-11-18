-- School Daze photo drop, second migration: a photo sent twice is kept once.
-- Runs after 20261118000100_photo_drop.sql. Run it before deploying the photo-drop Edge Function
-- that goes with it; the function before it keeps working with this in place.
--
-- Why
-- * A phone can lose the answer to a photo that did arrive: the signal drops, the phone locks,
--   the browser throws the tab away. Try again then stored the same photo a second time, and
--   each copy used up one of the guest's five.
-- * The slideshow took the organizers' review code as well as its own. An organizer who typed
--   the review code on the venue's computer left it there, with everything it opens.
-- * Nobody has yet checked which address the platform reports for a guest. If it reports a
--   shared one, the limit on photos from one connection would stop every guest after the 60th
--   photo of the day.
--
-- What changes
-- * public.drop_photos.sha256: the SHA-256 of the photo's bytes, worked out by the Edge Function.
-- * cal_private.drop_reserve takes that fingerprint as an eleventh argument. The same photo from
--   the same email that has already arrived answers { ok, duplicate: true, id, left } and saves
--   nothing. One that is still on its way in answers 409 'busy'. The ten-argument form stays,
--   for the function deployed before this ran, and checks for no repeats.
-- * cal_private.drop_screen_list takes the screen code only.
-- * drop_per_ip_day becomes 0, which turns that limit off. setup/4-photo-drop.sql says how to
--   check the addresses and turn it back on.

alter table public.drop_photos
  add column sha256 text,
  add constraint drop_photos_sha256_check check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');
create index drop_photos_repeat_idx on public.drop_photos (email, sha256);

update cal_private.config set value = '0' where key = 'drop_per_ip_day';

-- Checks one photo against everything and saves its row as 'sending'. The checks run in the order
-- a person would want to hear about them: the link, then whether we already have this photo, then
-- whether photos are still being taken, then what they typed, then the limits. Returns
-- { ok, id, path, thumb_path, left }, where left is how many more this email may send. p_ip is
-- the sender's address, or empty when it isn't known; only a hash of it is kept. p_sha256 is the
-- photo's fingerprint, or null to skip the check for a repeat.
create or replace function cal_private.drop_reserve(
  p_code text, p_name text, p_email text, p_caption text, p_width integer, p_height integer,
  p_bytes integer, p_has_thumb boolean, p_ip text, p_original jsonb, p_sha256 text)
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
  v_sha text := lower(trim(coalesce(p_sha256, '')));
  v_ip_hash text;
  v_state text;
  v_per_person bigint;
  v_per_ip bigint;
  v_sent bigint;
  v_old_id uuid;
  v_old_status text;
  v_id uuid := gen_random_uuid();
begin
  if not cal_private.drop_code_ok('upload', p_code) then
    return cal_private.drop_no(403, 'code', 'That link isn''t right. Use the link in your School Daze email.');
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    v_sha := null;
  end if;

  -- One photo at a time from here on, so two sent at the same moment can't both slip under a
  -- limit. The lock lasts until this call's transaction ends. Any fixed number works as its name.
  perform pg_advisory_xact_lock(1906120421);

  -- Every photo this email has sent counts, whatever became of it, apart from sends that never
  -- finished.
  v_per_person := cal_private.drop_number('per_person', 5);
  select count(*) into v_sent
  from public.drop_photos p
  where p.email = v_email and (p.status <> 'sending' or p.created_at > v_now - interval '15 minutes');

  -- The same photo from the same email. If it arrived, say so and keep the one we have: the
  -- sender's phone lost our first answer and is trying again. This comes before closed and full,
  -- because a photo we already hold is in whatever happened since.
  if v_sha is not null then
    select p.id, p.status into v_old_id, v_old_status
    from public.drop_photos p
    where p.email = v_email and p.sha256 = v_sha
      and (p.status <> 'sending' or p.created_at > v_now - interval '15 minutes')
    order by (p.status = 'sending'), p.created_at, p.id
    limit 1;
    if v_old_id is not null and v_old_status = 'sending' then
      return cal_private.drop_no(409, 'busy', 'That photo is still on its way in. Give it a minute, then try again.');
    end if;
    if v_old_id is not null then
      return jsonb_build_object('ok', true, 'duplicate', true, 'id', v_old_id, 'left', greatest(v_per_person - v_sent, 0));
    end if;
  end if;

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

  if v_sent >= v_per_person then
    return cal_private.drop_no(409, 'limit', case
      when v_sent = v_per_person then
        format('You''ve sent %s %s, which is the most one person can send.', v_sent, case when v_sent = 1 then 'photo' else 'photos' end)
      else
        format('You''ve sent %s %s. The most one person can send is %s.', v_sent, case when v_sent = 1 then 'photo' else 'photos' end, v_per_person)
      end);
  end if;

  -- One connection can only send so many in a day, whatever names and emails come with them.
  -- drop_per_ip_day at 0 turns this off, and the address is still kept as a hash, so the hashes
  -- can be checked before the limit is turned on.
  if v_ip <> '' then
    v_ip_hash := encode(sha256(convert_to(cal_private.drop_setting('ip_salt', '') || v_ip, 'UTF8')), 'hex');
    v_per_ip := cal_private.drop_number('per_ip_day', 0);
    if v_per_ip > 0 and (
      select count(*) from public.drop_photos p
      where p.ip_hash = v_ip_hash and p.created_at > v_now - interval '1 day'
    ) >= v_per_ip then
      return cal_private.drop_no(409, 'limit', 'Too many photos have come from this connection today. Try again tomorrow.');
    end if;
  end if;

  insert into public.drop_photos (
    id, status, name, email, caption, width, height, bytes, has_thumb, original, path, thumb_path, ip_hash, sha256, created_at)
  values (
    v_id, 'sending', v_name, v_email, v_caption, p_width, p_height, p_bytes, v_thumb,
    case when jsonb_typeof(p_original) = 'object' and char_length(p_original::text) < 600 then p_original end,
    'photos/' || v_id || '.jpg',
    case when v_thumb then 'thumbs/' || v_id || '.jpg' end,
    v_ip_hash, v_sha, v_now);

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'path', 'photos/' || v_id || '.jpg',
    'thumb_path', case when v_thumb then 'thumbs/' || v_id || '.jpg' end,
    'left', greatest(v_per_person - v_sent - 1, 0)
  );
end;
$$;

-- The form the first Edge Function calls: no fingerprint, so no check for a repeat.
create or replace function cal_private.drop_reserve(
  p_code text, p_name text, p_email text, p_caption text, p_width integer, p_height integer,
  p_bytes integer, p_has_thumb boolean, p_ip text, p_original jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select cal_private.drop_reserve(p_code, p_name, p_email, p_caption, p_width, p_height, p_bytes, p_has_thumb, p_ip, p_original, null)
$$;

-- Approved photos in the order they were approved, with nothing about who sent them. Only the
-- screen code opens it: the venue's computer keeps the code it was given, and the review code
-- must never be left on it.
create or replace function cal_private.drop_screen_list(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not cal_private.drop_code_ok('screen', p_code) then
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

-- Only the database owner runs these: the Edge Function's connection, and SQL Editor.
revoke execute on function
  cal_private.drop_reserve(text, text, text, text, integer, integer, integer, boolean, text, jsonb, text),
  cal_private.drop_reserve(text, text, text, text, integer, integer, integer, boolean, text, jsonb),
  cal_private.drop_screen_list(text)
  from public, anon, authenticated, service_role;
