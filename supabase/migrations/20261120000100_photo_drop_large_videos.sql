-- Photo drop: videos larger than 2 GB.
--
-- A video's size is kept in drop_photos.bytes. That column was an integer, which holds
-- 2,147,483,647 bytes at most, so drop_state and drop_video_reserve never let one video be larger
-- than that, whatever the setting said. This migration makes the column a bigint and takes that
-- ceiling out of the two functions. Nothing else about them changes: each is the function from
-- 20261118000400_photo_drop_video.sql with that one expression replaced.
--
-- * The limits themselves are still settings, and this migration changes none of them. To let a
--   video be larger, raise three things together: Storage's global file size limit (in the
--   Supabase dashboard, under Storage, Settings; a paid plan allows up to 500 GB), the bucket's
--   own limit, and the setting. For 5 GB a video (5120 MB as the pages count megabytes) and
--   25 GB for all the videos together:
--     update storage.buckets set file_size_limit = 5368709120 where id = 'photo-drop';
--     update cal_private.config set value = '5368709120' where key = 'drop_video_max_bytes';
--     update cal_private.config set value = '26843545600' where key = 'drop_video_total_bytes';
-- * A guest's photo is unchanged: its functions still take the size as an integer, and a photo
--   is 6 MB at most.
-- * Changing the column's type rewrites the table once, under a lock, which takes a moment for
--   a table of a few hundred rows.
--
-- * The change of type waits for nothing longer than 5 seconds. If something else is holding the
--   table (an open tab in the SQL Editor, a backup), this stops with a lock timeout and changes
--   nothing, instead of making every upload and every page wait behind it. Run it again.
--
-- Safe to run again.

set lock_timeout = '5s';

alter table public.drop_photos alter column bytes type bigint;

-- ---------------------------------------------------------------------------
-- Open, closed, or full
-- ---------------------------------------------------------------------------

-- Where things stand: the switch, the deadline, the limits, and how much has come in. photos and
-- bytes are the guests' photos alone, and state is decided from them exactly as before. videos
-- and video_bytes are the committee's videos, with their own limits: how many (max_videos), how
-- large one may be (video_max_bytes), and how much they may take together (video_total_bytes). A
-- video still 'sending' counts for its first 3 hours, the time its upload is given.
-- video_max_bytes is the setting as it stands: the size column holds any size a file can have.
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
    'video_max_bytes', cal_private.drop_number('video_max_bytes', 52428800),
    'video_total_bytes', cal_private.drop_number('video_total_bytes', 209715200),
    'videos', v_videos,
    'video_bytes', v_video_bytes
  );
end;
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
  -- The limit as drop_state gives it: the setting.
  v_max_bytes bigint := cal_private.drop_number('video_max_bytes', 52428800);
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

reset lock_timeout;
