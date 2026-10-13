-- GIL Content Calendar (calendar.html), second migration: committee chairs and request files.
-- Runs after 20261013000100_content_calendar.sql. A project that already ran the first file runs
-- just this one; a new project runs both, in order.
--
-- What changes
-- * Visitors who are not signed in see nothing. The public calendar switch is gone.
-- * Brothers view the calendar. Committee chairs, brothers the media team marks as chairs in
--   Manage access, also see the request queue, send requests with files attached, and edit their
--   own requests until the media team reviews them.
-- * Request files live in the private calendar-files storage bucket. Chairs upload into
--   requests/<their member id>/ and see only their own files; the media team sees all of them.
-- * Facebook leaves the page's platform list (assets/calendar/data.js). The database still
--   accepts it, and posts that already list it keep it; the page hides it while it is off.

-- ---------------------------------------------------------------------------
-- Chairs and request files
-- ---------------------------------------------------------------------------

alter table public.cal_members add column chair boolean not null default false;

-- [{path, name, size, type}] in the calendar-files bucket
alter table public.cal_requests
  add column files jsonb not null default '[]'::jsonb
  check (jsonb_typeof(files) = 'array' and jsonb_array_length(files) <= 10);

create or replace function cal_private.is_chair()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.chair from public.cal_members m where m.user_id = (select auth.uid())), false)
$$;

-- Committee chairs and the media team send and see requests.
create or replace function cal_private.can_request()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select cal_private.is_staff()) or (select cal_private.is_chair())
$$;

create or replace function cal_private.member_json(m public.cal_members)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('role', case when m.chair then 'chair' else 'member' end,
                            'name', m.display_name, 'member_id', m.id, 'committee', m.committee)
$$;

-- ---------------------------------------------------------------------------
-- The public calendar switch goes away: visitors see nothing
-- ---------------------------------------------------------------------------

drop policy "visitors read the public calendar when it is on" on public.cal_posts;
revoke all on public.cal_posts from anon;
drop function public.cal_set_public(boolean);

create or replace function public.cal_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'lead_days', 21,
    'ready', exists (select 1 from cal_private.config where key = 'calendar_chapter_code_hash')
         and exists (select 1 from cal_private.config where key = 'calendar_media_code_hash')
  )
$$;

drop function cal_private.is_public();
delete from cal_private.config where key = 'calendar_public';

-- ---------------------------------------------------------------------------
-- Requests come from committee chairs
-- ---------------------------------------------------------------------------

drop policy "brothers and the media team read requests" on public.cal_requests;
create policy "chairs and the media team read requests"
  on public.cal_requests for select to authenticated using ((select cal_private.can_request()));

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

  -- Attached files: [{path, name, size, type}], uploaded to calendar-files under requests/<folder>/.
  -- submit and update check that a chair's files sit in his own folder.
  if jsonb_typeof(coalesce(p -> 'files', '[]'::jsonb)) <> 'array' then
    raise exception 'Attach files with the form''s upload button.';
  end if;
  if jsonb_array_length(coalesce(p -> 'files', '[]'::jsonb)) > 10 then
    raise exception 'Attach up to 10 files. For more, share a Google Drive link.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p -> 'files', '[]'::jsonb)) f
    where jsonb_typeof(f) <> 'object'
       or coalesce(f ->> 'path', '') !~ '^requests/[A-Za-z0-9_-]{1,64}/[^/]{1,200}$'
       or char_length(coalesce(f ->> 'name', '')) not between 1 and 200
       or coalesce(f ->> 'size', '0') !~ '^[0-9]{1,12}$'
       or char_length(coalesce(f ->> 'type', '')) > 100
  ) then
    raise exception 'One of the attached files didn''t upload correctly. Remove it and attach it again.';
  end if;
  r.files := coalesce((
    select jsonb_agg(jsonb_build_object(
      'path', f ->> 'path', 'name', f ->> 'name',
      'size', coalesce((f ->> 'size')::bigint, 0), 'type', coalesce(f ->> 'type', '')))
    from jsonb_array_elements(coalesce(p -> 'files', '[]'::jsonb)) f), '[]'::jsonb);
  return r;
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
  v_staff boolean := cal_private.is_staff();
  v_now timestamptz := cal_private.clock();
begin
  if not v_staff and not cal_private.is_chair() then
    if v_member is not null then
      raise exception 'Requests come from committee chairs. Ask your chair to send it, or ask the media team to set you up as a chair.';
    end if;
    raise exception 'Sign in as a committee chair to send a request.';
  end if;
  r := cal_private.request_from_json(p_request);
  if r.post_date < cal_private.today() then
    raise exception 'That post date has passed. Choose a future date.';
  end if;
  if not v_staff and exists (
    select 1 from jsonb_array_elements(r.files) f where split_part(f ->> 'path', '/', 2) is distinct from v_member::text
  ) then
    raise exception 'Attach files with this form''s upload button.';
  end if;
  if v_member is not null and (
       select count(*) from public.cal_requests x
       where x.member_id = v_member and x.status in ('new', 'needs-info')) >= 20 then
    raise exception 'You have 20 open requests. Wait for the media team to review some, then send more.';
  end if;
  insert into public.cal_requests (
    member_id, submitted_by, contact_name, committee, title, post_date, event_date, about, format,
    platforms, program, asset_link, caption, link, youth, releases, files, status, created_at, updated_at)
  values (
    v_member, (select auth.uid()), r.contact_name, r.committee, r.title, r.post_date, r.event_date, r.about,
    r.format, r.platforms, r.program, r.asset_link, r.caption, r.link, r.youth, r.releases, r.files, 'new', v_now, v_now)
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
  v_member uuid := cal_private.member_id();
begin
  if not v_staff and not cal_private.is_chair() then
    raise exception 'Requests come from committee chairs. Ask your chair, or ask the media team to set you up as a chair.';
  end if;
  select * into cur from public.cal_requests where id = p_id for update;
  if not found then
    raise exception 'That request no longer exists.';
  end if;
  if not v_staff and (cur.member_id is null or cur.member_id is distinct from v_member) then
    raise exception 'You can edit only your own requests.';
  end if;
  if not v_staff and cur.status not in ('new', 'needs-info') then
    raise exception 'The media team already reviewed this request. Send a new request for changes.';
  end if;
  r := cal_private.request_from_json(p_request);
  if r.post_date < cal_private.today() and r.post_date is distinct from cur.post_date then
    raise exception 'That post date has passed. Choose a future date.';
  end if;
  if not v_staff and exists (
    select 1 from jsonb_array_elements(r.files) f where split_part(f ->> 'path', '/', 2) is distinct from v_member::text
  ) then
    raise exception 'Attach files with this form''s upload button.';
  end if;
  update public.cal_requests
  set contact_name = r.contact_name, committee = r.committee, title = r.title, post_date = r.post_date,
      event_date = r.event_date, about = r.about, format = r.format, platforms = r.platforms,
      program = r.program, asset_link = r.asset_link, caption = r.caption, link = r.link,
      youth = r.youth, releases = r.releases, files = r.files,
      status = case when cur.status = 'needs-info' and not v_staff then 'new' else cur.status end,
      updated_at = cal_private.clock()
  where id = p_id
  returning * into r;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- The media team marks chairs
-- ---------------------------------------------------------------------------

-- The member list gains a chair column, so it is dropped and created again.
drop function public.cal_member_list();

create or replace function public.cal_member_list()
returns table (
  id uuid, display_name text, committee text, chair boolean, created_at timestamptz, last_seen_at timestamptz,
  requests bigint, locked boolean, signed_in boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  return query
    select m.id, m.display_name, m.committee, m.chair, m.created_at, m.last_seen_at,
           (select count(*) from public.cal_requests r where r.member_id = m.id),
           coalesce(s.locked_until > cal_private.clock(), false),
           m.user_id is not null
    from public.cal_members m
    left join cal_private.member_secrets s on s.member_id = m.id
    order by m.chair desc, lower(m.display_name);
end;
$$;

-- Marks a brother as a committee chair, or back to a brother who views. Chairs send requests.
create or replace function public.cal_set_chair(p_member_id uuid, p_chair boolean, p_committee text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.cal_members;
  v_committee text := cal_private.clean(p_committee);
begin
  perform cal_private.assert_staff();
  select * into m from public.cal_members where id = p_member_id for update;
  if not found then
    raise exception 'That brother is no longer on the list.';
  end if;
  if v_committee is not null and char_length(v_committee) > 60 then
    raise exception 'Keep the committee name under 60 characters.';
  end if;
  if coalesce(p_chair, false) and coalesce(v_committee, m.committee) is null then
    raise exception 'Choose the committee he chairs.';
  end if;
  update public.cal_members
  set chair = coalesce(p_chair, false), committee = coalesce(v_committee, committee)
  where id = p_member_id
  returning * into m;
  return cal_private.member_json(m);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function cal_private.is_chair(), cal_private.can_request() from public, anon, authenticated;

-- Policies, including the storage policies below, call these as the signed-in person. Visitors no
-- longer read anything, so they no longer need them.
revoke execute on function
  cal_private.clock(), cal_private.is_staff(), cal_private.member_id(), cal_private.can_view()
  from anon;
grant execute on function
  cal_private.clock(), cal_private.is_staff(), cal_private.member_id(), cal_private.can_view(),
  cal_private.is_chair(), cal_private.can_request()
  to authenticated;

revoke execute on function public.cal_member_list(), public.cal_set_chair(uuid, boolean, text) from public, anon;
grant execute on function public.cal_member_list(), public.cal_set_chair(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Request files: a private storage bucket. A chair uploads into requests/<his member id>/ and sees
-- only his own files. The media team adds, reads, and removes anything in the bucket. Nobody else
-- can see it. Up to 50 MB a file, the Supabase Free plan's limit.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('calendar-files', 'calendar-files', false, 52428800, array['image/*', 'video/*', 'application/pdf'])
on conflict (id) do nothing;

create policy "calendar: chairs add files to their own folder, the media team anywhere"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'calendar-files'
    and ((select cal_private.is_staff())
         or ((select cal_private.is_chair())
             and (storage.foldername(name))[1] = 'requests'
             and (storage.foldername(name))[2] = (select cal_private.member_id())::text))
  );

create policy "calendar: chairs read their own files, the media team reads all"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'calendar-files'
    and ((select cal_private.is_staff())
         or ((select cal_private.is_chair())
             and (storage.foldername(name))[1] = 'requests'
             and (storage.foldername(name))[2] = (select cal_private.member_id())::text))
  );

create policy "calendar: chairs remove their own files, the media team removes any"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'calendar-files'
    and ((select cal_private.is_staff())
         or ((select cal_private.is_chair())
             and (storage.foldername(name))[1] = 'requests'
             and (storage.foldername(name))[2] = (select cal_private.member_id())::text))
  );
