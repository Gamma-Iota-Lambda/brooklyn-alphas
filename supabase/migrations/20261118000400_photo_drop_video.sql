-- School Daze photo drop, fourth migration: the party committee can add videos to the slideshow.
-- Runs after 20261118000300_photo_drop_review_order.sql. Run it before deploying the photo-drop
-- Edge Function that goes with it; the function before it keeps working with this in place.
--
-- Why
-- * The committee has videos to play on the big screens, in between the guests' photos. Guests
--   still send photos only, and nothing a guest can reach changes.
--
-- What changes
-- * public.drop_photos gets kind ('photo' or 'video'), seconds and mime. A video is a row like any
--   other: its file is at path and its poster, a small JPEG, at thumb_path. Two files a row, as
--   for a photo, so Delete, Delete everything, link renewal and the tidy-up cover it as they are.
--   A video's row holds the organizer's name, the fixed text 'committee' where a guest's email
--   goes, and in bytes the exact size of the video file, without its poster: the slideshow checks
--   what it downloads against that number.
-- * Three settings: drop_video_max_bytes, the most one video may be (50 MB, which is also the most
--   the free Supabase plan takes in one file), drop_max_videos, how many there may be (40), and
--   drop_video_total_bytes, the most all the videos together may take (209715200, which is
--   200 MB as the pages count a video's megabytes: 1,048,576 bytes each). The free plan holds
--   1 GB across the whole project, and the guests' photos may use 750 MB of it, so the videos
--   have a total of their own.
-- * The bucket takes MP4 and MOV files beside JPEGs, up to 50 MB a file. Guests still can't put
--   anything there but a JPEG of 6 MB: their only way in is the Edge Function, which checks the
--   photo it holds.
-- * cal_private.drop_state counts photos and videos apart. Only the photos decide 'full', so a
--   video never takes a guest's place, and a guest's photo never takes a video's.
-- * Every limit is a setting. To raise the most one video may be, change drop_video_max_bytes
--   and the bucket's file_size_limit together: Storage goes by the bucket's.
-- * cal_private.drop_stale gives a video 3 hours to arrive where a photo has 15 minutes.
-- * cal_private.drop_review_list says what kind each row is. cal_private.drop_screen_list lists
--   the approved videos beside the approved photos, under videos.
-- * Three new functions, all for the review code. The organizer's browser sends the video
--   straight to Storage, through a link the Edge Function hands out: drop_video_reserve checks
--   everything and saves the row as 'sending', drop_video_held finds that row again once the
--   browser says the upload is done, and drop_video_stored marks it approved. A video is in the
--   show as soon as it has arrived: the organizer who added it is the one who reviewed it.

alter table public.drop_photos
  add column kind text not null default 'photo'
    constraint drop_photos_kind_check check (kind in ('photo', 'video')),
  -- A video's length, as the organizer's browser read it, or null when it couldn't.
  add column seconds numeric(8,2)
    constraint drop_photos_seconds_check check (seconds is null or (seconds > 0 and seconds <= 86400)),
  -- The type a video was stored with. Null for a photo, which is always a JPEG.
  add column mime text
    constraint drop_photos_mime_check check (mime is null or mime in ('video/mp4', 'video/quicktime'));

insert into cal_private.config (key, value) values
  ('drop_video_max_bytes', '52428800'),
  ('drop_max_videos', '40'),
  ('drop_video_total_bytes', '209715200')
on conflict (key) do nothing;

-- An update, not an insert: the bucket is already there, and the first migration leaves an
-- existing one as it finds it.
update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array['image/jpeg', 'video/mp4', 'video/quicktime']
where id = 'photo-drop';

-- ---------------------------------------------------------------------------
-- Open, closed, or full
-- ---------------------------------------------------------------------------

-- Where things stand: the switch, the deadline, the limits, and how much has come in. photos and
-- bytes are the guests' photos alone, and state is decided from them exactly as before. videos
-- and video_bytes are the committee's videos, with their own limits: how many (max_videos), how
-- large one may be (video_max_bytes), and how much they may take together (video_total_bytes). A
-- video still 'sending' counts for its first 3 hours, the time its upload is given.
-- video_max_bytes is never more than the row's integer column for the size can hold, whatever the
-- setting says.
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
  v_videos bigint;
  v_video_bytes bigint;
begin
  select count(*), coalesce(sum(p.bytes), 0) into v_photos, v_bytes
  from public.drop_photos p
  where p.kind = 'photo' and (p.status <> 'sending' or p.created_at > v_now - interval '15 minutes');
  select count(*), coalesce(sum(p.bytes), 0) into v_videos, v_video_bytes
  from public.drop_photos p
  where p.kind = 'video' and (p.status <> 'sending' or p.created_at > v_now - interval '3 hours');
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
    'bytes', v_bytes,
    'max_videos', cal_private.drop_number('max_videos', 40),
    'video_max_bytes', least(cal_private.drop_number('video_max_bytes', 52428800), 2147483647),
    'video_total_bytes', cal_private.drop_number('video_total_bytes', 209715200),
    'videos', v_videos,
    'video_bytes', v_video_bytes
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Sends that never finished
-- ---------------------------------------------------------------------------

-- Removes the rows of sends that never finished, and returns their file paths (photo and
-- thumbnail, or video and poster) for the Edge Function to take out of the bucket. A photo is
-- given 15 minutes, as before. A video is given 3 hours: its upload link is good for two, and
-- 50 MB on a slow connection takes a while.
create or replace function cal_private.drop_stale()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.drop_photos p
    where p.status = 'sending'
      and p.created_at <= cal_private.clock() - case when p.kind = 'video' then interval '3 hours' else interval '15 minutes' end
    returning p.path, p.thumb_path
  )
  select coalesce(jsonb_agg(f.path), '[]'::jsonb)
  from gone g cross join lateral (values (g.path), (g.thumb_path)) as f(path)
  where f.path is not null
$$;

-- ---------------------------------------------------------------------------
-- Adding a video
-- ---------------------------------------------------------------------------

-- Checks one video against everything and saves its row as 'sending'. For the review code: only
-- the committee adds videos, and it can add one whether or not guests' uploads are open. The
-- checks run in the order a person would want to hear about them: the code, then what they typed,
-- then the file, then whether there is room: for one more video, then for this one's size beside
-- the rest. Returns { ok, id, path, thumb_path, bytes, mime }.
-- The Edge Function then hands the organizer's browser a link to send each of the two files to.
-- p_bytes is the size of the video file, and drop_video_stored's caller holds the stored file to
-- it. p_seconds is its length, or null when the browser couldn't read one.
create or replace function cal_private.drop_video_reserve(
  p_code text, p_by text, p_caption text, p_width integer, p_height integer,
  p_bytes bigint, p_seconds numeric, p_mime text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := cal_private.clock();
  v_by text := left(cal_private.clean(p_by), 60);
  v_caption text := cal_private.clean(p_caption);
  -- The limit as drop_state gives it: the setting, and never more than the row's integer column
  -- for the size can hold.
  v_max_bytes bigint := least(cal_private.drop_number('video_max_bytes', 52428800), 2147483647);
  v_total_bytes bigint := cal_private.drop_number('video_total_bytes', 209715200);
  v_seconds numeric;
  v_videos bigint;
  v_video_bytes bigint;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_thumb_path text;
  v_not_video constant text := 'That file isn''t a video we can use. Add an MP4 or MOV file.';
begin
  if not cal_private.drop_code_ok('review', p_code) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;

  if v_by is null then
    return cal_private.drop_no(400, 'input', 'Add your name.');
  end if;
  if char_length(v_caption) > 80 then
    return cal_private.drop_no(400, 'input', 'Keep the caption to 80 characters or fewer.');
  end if;

  -- The organizer's browser read these from the file. Storage is asked for the stored file's
  -- real size and type before the row is approved.
  if p_mime is null or p_mime not in ('video/mp4', 'video/quicktime') then
    return cal_private.drop_no(400, 'video', v_not_video);
  end if;
  if p_bytes is null or p_bytes < 1 or p_width is null or p_height is null
     or p_width not between 1 and 65535 or p_height not between 1 and 65535 then
    return cal_private.drop_no(400, 'video', v_not_video);
  end if;
  if p_bytes > v_max_bytes then
    return cal_private.drop_no(400, 'size',
      format('That video is too large. One video can be %s MB at most.', v_max_bytes / 1048576));
  end if;
  -- A length that can't be right is left out, never refused: the video plays without it. Under
  -- half a hundredth of a second rounds to nothing, which is no length either.
  if p_seconds > 0 and p_seconds <= 86400 then
    v_seconds := nullif(round(p_seconds, 2), 0);
  end if;

  -- One at a time from here on, under the lock a guest's photo takes, so two videos added at the
  -- same moment can't both slip under a limit.
  perform pg_advisory_xact_lock(1906120421);

  -- Videos are counted the way drop_state counts them.
  select count(*), coalesce(sum(p.bytes), 0) into v_videos, v_video_bytes
  from public.drop_photos p
  where p.kind = 'video' and (p.status <> 'sending' or p.created_at > v_now - interval '3 hours');
  if v_videos >= cal_private.drop_number('max_videos', 40) then
    return cal_private.drop_no(409, 'full', 'The show has all the videos it can take. Delete one to add another.');
  end if;
  -- The videos share the project's storage with the guests' photos and the calendar's files, so
  -- together they have a total of their own. Said in whole megabytes: the limit rounded down and
  -- what is in use rounded up, so the two never promise room that isn't there.
  if v_video_bytes + p_bytes > v_total_bytes then
    return cal_private.drop_no(409, 'full',
      format('That video doesn''t fit. All the videos together can take %s MB, and %s MB is in use. Delete one to add another.',
        v_total_bytes / 1048576, (v_video_bytes + 1048575) / 1048576));
  end if;

  v_path := 'videos/' || v_id || case when p_mime = 'video/quicktime' then '.mov' else '.mp4' end;
  v_thumb_path := 'thumbs/' || v_id || '.jpg';
  -- 'committee' stands where a guest's email goes. The pages never show it for a video.
  insert into public.drop_photos (
    id, status, kind, name, email, caption, width, height, bytes, has_thumb, seconds, mime, path, thumb_path, created_at)
  values (
    v_id, 'sending', 'video', v_by, 'committee', v_caption, p_width, p_height, p_bytes, false, v_seconds, p_mime,
    v_path, v_thumb_path, v_now);

  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'path', v_path,
    'thumb_path', v_thumb_path,
    'bytes', p_bytes,
    'mime', p_mime
  );
end;
$$;

-- The video that is on its way in under this id: { ok, id, path, thumb_path, bytes, mime }. The
-- Edge Function asks once the browser says both uploads are done, and again to cancel one.
create or replace function cal_private.drop_video_held(p_code text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_held jsonb;
begin
  if not cal_private.drop_code_ok('review', p_code) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;
  select jsonb_build_object('ok', true, 'id', p.id, 'path', p.path, 'thumb_path', p.thumb_path, 'bytes', p.bytes, 'mime', p.mime)
  into v_held
  from public.drop_photos p
  where p.id = p_id and p.kind = 'video' and p.status = 'sending';
  if v_held is null then
    return cal_private.drop_no(409, 'input', 'That video is no longer here. Add it again.');
  end if;
  return v_held;
end;
$$;

-- The video is in the bucket, whole: it goes straight into the show. Approved, not waiting,
-- because the organizer who added it has already seen it, and theirs is the name on the review.
-- With no poster the row lets go of the poster's path, so nothing later looks for a file that
-- isn't there. Refused when the row is gone or was never a video on its way in, and the Edge
-- Function then takes the files back out.
create or replace function cal_private.drop_video_stored(
  p_code text, p_id uuid, p_by text, p_has_thumb boolean, p_url text, p_thumb_url text, p_signed_until timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := cal_private.clock();
  v_thumb boolean := coalesce(p_has_thumb, false);
begin
  if not cal_private.drop_code_ok('review', p_code) then
    return cal_private.drop_no(403, 'code', 'That code isn''t right.');
  end if;
  if coalesce(p_url, '') <> '' and p_signed_until is not null then
    update public.drop_photos
    set status = 'approved', has_thumb = v_thumb, url = p_url, thumb_url = nullif(p_thumb_url, ''),
        thumb_path = case when v_thumb then thumb_path end, signed_until = p_signed_until,
        stored_at = v_now, reviewed_at = v_now,
        reviewed_by = coalesce(left(cal_private.clean(p_by), 60), name)
    where id = p_id and kind = 'video' and status = 'sending';
    if found then
      return jsonb_build_object('ok', true, 'id', p_id);
    end if;
  end if;
  return cal_private.drop_no(400, 'input', 'That video is no longer here. Add it again.');
end;
$$;

-- ---------------------------------------------------------------------------
-- Review
-- ---------------------------------------------------------------------------

-- Everything the review page shows: the settings, the counts, and every photo and video that has
-- finished arriving, oldest first. Each row says what kind it is, and a video its length and
-- type. A photo with no thumbnail stands in for its own. A video never does: with no poster its
-- thumb_url is null, so a page is never handed a video file where it expects a picture.
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
        'url', p.url,
        'thumb_url', case when p.kind = 'video' then p.thumb_url else coalesce(p.thumb_url, p.url) end,
        'kind', p.kind, 'seconds', p.seconds, 'mime', p.mime
      ) order by p.created_at, p.id)
      from public.drop_photos p
      where p.status <> 'sending'), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The slideshow
-- ---------------------------------------------------------------------------

-- Approved photos in the order they were approved, and beside them, under videos, the approved
-- videos in theirs, with nothing about who sent or added them. A video comes with the exact size
-- of its file and its length: the slideshow brings the whole file down before it plays it. Only
-- the screen code opens the list, as before.
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
      where p.kind = 'photo' and p.status = 'approved' and p.url is not null), '[]'::jsonb),
    'videos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'url', p.url, 'thumb_url', p.thumb_url,
        'width', p.width, 'height', p.height, 'caption', p.caption, 'bytes', p.bytes, 'seconds', p.seconds
      ) order by p.reviewed_at, p.created_at, p.id)
      from public.drop_photos p
      where p.kind = 'video' and p.status = 'approved' and p.url is not null), '[]'::jsonb)
  );
end;
$$;

-- Only the database owner runs these: the Edge Function's connection, and SQL Editor.
revoke execute on function
  cal_private.drop_state(), cal_private.drop_stale(),
  cal_private.drop_video_reserve(text, text, text, integer, integer, bigint, numeric, text),
  cal_private.drop_video_held(text, uuid),
  cal_private.drop_video_stored(text, uuid, text, boolean, text, text, timestamptz),
  cal_private.drop_review_list(text), cal_private.drop_screen_list(text)
  from public, anon, authenticated, service_role;
