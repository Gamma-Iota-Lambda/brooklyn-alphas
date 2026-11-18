-- School Daze photo drop, third migration: two organizers can't undo each other by accident.
-- Runs after 20261118000200_photo_drop_repeats.sql. The photo-drop Edge Function needs no change
-- for it.
--
-- Why
-- * Two organizers reviewing at once each see a list up to a minute old. One rejected a photo,
--   the other, still seeing it as waiting, approved it, and the later tap won: the photo went on
--   the big screens with nobody told. The same gap let a Delete from a stale list remove a photo
--   that had since been moved back and approved.
-- * A send that died partway (the function was cut off between saving the row and storing the
--   file) left the same photo answering "still on its way in" for 15 minutes.
--
-- What changes
-- * cal_private.drop_review_set: Approve and Reject move only a photo that is waiting. To change
--   a decision, send the photo back to waiting first, which is what the review page offers. The
--   page asks for the list again whenever fewer photos changed than it sent.
-- * cal_private.drop_review_paths: Delete for chosen photos takes only rejected ones. Delete
--   everything (no ids) still takes every row.
-- * cal_private.drop_reserve: "still on its way in" lasts 2 minutes, far longer than a real send
--   takes. After that an unfinished copy of the same photo is dropped and the photo is taken anew.

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
  -- Approve and reject apply to waiting photos only, so a tap on a list that is a minute old
  -- can't overturn what another organizer has decided since. Back to waiting applies to any.
  update public.drop_photos p
  set status = p_status,
      reviewed_at = case when p_status <> 'waiting' then v_now end,
      reviewed_by = case when p_status <> 'waiting' then v_by end
  where p.id = any(p_ids) and p.status not in ('sending', p_status)
    and (p_status = 'waiting' or p.status = 'waiting');
  get diagnostics v_changed = row_count;
  return jsonb_build_object('ok', true, 'changed', v_changed);
end;
$$;

-- The rows about to be deleted and their files: { ok, ids, paths }. Chosen photos are deleted
-- only while they are rejected, so a photo someone has since moved back or approved stays. A null
-- p_ids means every row, for emptying the drop after the party. The Edge Function removes the
-- files, then deletes exactly these ids, so a photo that arrives in between keeps its row.
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
      where p_ids is null or (p.id = any(p_ids) and p.status = 'rejected')
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

-- Checks one photo against everything and saves its row as 'sending'. As in the second migration,
-- with one change: a copy of the same photo that is still 'sending' answers 409 'busy' for 2
-- minutes only. After that it is taken to have died, and is dropped.
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

  -- An unfinished copy of this very photo that is over 2 minutes old was cut off partway: a real
  -- send takes seconds. Drop it, so the photo can be taken now and doesn't hold one of the
  -- sender's places.
  if v_sha is not null then
    delete from public.drop_photos p
    where p.email = v_email and p.sha256 = v_sha and p.status = 'sending'
      and p.created_at <= v_now - interval '2 minutes';
  end if;

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

-- Only the database owner runs these: the Edge Function's connection, and SQL Editor.
revoke execute on function
  cal_private.drop_review_set(text, uuid[], text, text), cal_private.drop_review_paths(text, uuid[]),
  cal_private.drop_reserve(text, text, text, text, integer, integer, integer, boolean, text, jsonb, text)
  from public, anon, authenticated, service_role;
