-- GIL Content Calendar, third migration: email the media team when a chair sends a request.
-- Runs after 20261013000200_chairs_and_request_files.sql.
--
-- How it works
-- * When a new request is saved, a trigger emails everyone with a media team login (cal_staff
--   joined to auth.users) through Resend's email API, using the pg_net extension.
-- * pg_net sends after the request is committed, in the background. A slow or failed email never
--   slows down or blocks the chair, and anything that goes wrong is logged as a warning.
-- * The Resend API key lives in Supabase Vault (calendar_resend_api_key) and the sender in
--   cal_private.config (email_from). Until both are set, requests save and no email goes out.
--   Set both with supabase/setup/2-request-emails.sql.
-- * A media team member who sends a request himself isn't emailed about it.
-- * Only new requests send email. Edits and reviews don't.

-- pg_net comes with Supabase. The local test database stands in for it. Supabase keeps extensions in
-- the extensions schema; pg_net's own functions and tables live in the net schema either way.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
end
$$;

-- Saves the Resend API key in Vault and the sender address. Run it again to change either.
create or replace function cal_private.set_email_settings(
  p_api_key text,
  p_from text default 'GIL Content Calendar <calendar@mail.gil1906.org>'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := trim(coalesce(p_api_key, ''));
  v_from text := trim(coalesce(p_from, ''));
  v_id uuid;
begin
  if v_key !~ '^re_[A-Za-z0-9_-]{8,}$' then
    raise exception 'Paste the Resend API key between the quotes. It starts with re_.';
  end if;
  if v_from !~ '^([^<>@]+<)?[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>?$' or (v_from ~ '<') <> (v_from ~ '>$') then
    raise exception 'Use a sender like GIL Content Calendar <calendar@mail.gil1906.org>.';
  end if;
  select s.id into v_id from vault.secrets s where s.name = 'calendar_resend_api_key';
  if v_id is null then
    perform vault.create_secret(v_key, 'calendar_resend_api_key', 'Resend API key for content calendar request emails');
  else
    perform vault.update_secret(v_id, v_key);
  end if;
  insert into cal_private.config (key, value)
  values ('email_from', v_from)
  on conflict (key) do update set value = excluded.value;
end;
$$;

-- Emails everyone with a media team login, except p_skip_user. Returns the pg_net request id, or
-- null when emails aren't set up yet or there's no one to email.
create or replace function cal_private.email_media_team(p_subject text, p_text text, p_skip_user uuid default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_from text;
  v_to text[];
begin
  select s.decrypted_secret into v_key
  from vault.decrypted_secrets s
  where s.name = 'calendar_resend_api_key'
  limit 1;
  select c.value into v_from from cal_private.config c where c.key = 'email_from';
  if coalesce(v_key, '') = '' or coalesce(v_from, '') = '' then
    return null;
  end if;

  select array_agg(x.email order by x.email) into v_to
  from (
    select distinct lower(u.email::text) as email
    from public.cal_staff s
    join auth.users u on u.id = s.user_id
    where coalesce(u.email::text, '') <> ''
      and u.id is distinct from p_skip_user
  ) x;
  if v_to is null then
    return null;
  end if;

  return net.http_post(
    url := 'https://api.resend.com/emails',
    body := jsonb_build_object('from', v_from, 'to', to_jsonb(v_to), 'subject', p_subject, 'text', p_text),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    timeout_milliseconds := 10000
  );
end;
$$;

-- Writes the email for a new request and hands it to email_media_team. Labels match
-- assets/calendar/data.js.
create or replace function cal_private.email_new_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_formats constant jsonb := '{"graphic": "Single graphic", "carousel": "Carousel", "reel": "Reel or video",
    "story": "Story", "flyer": "Event flyer", "text": "Text post"}';
  v_platforms constant jsonb := '{"instagram": "Instagram", "facebook": "Facebook", "threads": "Threads", "x": "X",
    "website": "gil1906.org", "substack": "Substack", "whatsapp": "WhatsApp"}';
  v_programs constant jsonb := '{"vote": "A Voteless People Is a Hopeless People",
    "college": "Go-To-High-School, Go-To-College", "project-alpha": "Project Alpha", "keeper": "Brother''s Keeper"}';
  v_days int := new.post_date - cal_private.today();
  v_files int := coalesce(jsonb_array_length(new.files), 0);
  v_lines text[];
begin
  v_lines := array[
    format('%s (%s) sent a content request.', new.contact_name, new.committee),
    '',
    'Title: ' || new.title,
    'Requested post date: ' || to_char(new.post_date, 'FMDay, FMMonth FMDD, YYYY')
  ];
  if v_days < 21 then
    v_lines := v_lines || case
      when v_days <= 0 then 'Short notice: the post date is today.'
      when v_days = 1 then 'Short notice: the post date is tomorrow, under the three-week lead time.'
      else format('Short notice: the post date is in %s days, under the three-week lead time.', v_days)
    end;
  end if;
  if new.event_date is not null then
    v_lines := v_lines || ('Event date: ' || to_char(new.event_date, 'FMDay, FMMonth FMDD, YYYY'));
  end if;
  v_lines := v_lines || ('Format: ' || coalesce(v_formats ->> new.format, new.format));
  v_lines := v_lines || ('Platforms: ' || (
    select string_agg(coalesce(v_platforms ->> p.key, p.key), ', ' order by p.ord)
    from unnest(new.platforms) with ordinality as p(key, ord)));
  if new.program is not null then
    v_lines := v_lines || ('National program: ' || coalesce(v_programs ->> new.program, new.program));
  end if;
  if v_files > 0 then
    v_lines := v_lines || format('Files: %s attached', v_files);
  end if;
  if new.asset_link is not null then
    v_lines := v_lines || ('Shared link: ' || new.asset_link);
  end if;
  if new.link is not null then
    v_lines := v_lines || ('Link for the post: ' || new.link);
  end if;
  if new.youth then
    v_lines := v_lines || 'Photos of young people: the chair confirmed media releases are on file.'::text;
  end if;
  v_lines := v_lines || array['', 'Details:', new.about];
  if new.caption is not null then
    v_lines := v_lines || array['', 'Draft caption:', new.caption];
  end if;
  v_lines := v_lines || array[
    '',
    'Review it in the calendar: https://www.gil1906.org/calendar.html#requests',
    '',
    'You get this email because you have a media team login for the GIL content calendar.'
  ];

  perform cal_private.email_media_team(
    format('New content request: %s', new.title), array_to_string(v_lines, E'\n'), new.submitted_by);
  return null;
exception when others then
  raise warning 'GIL content calendar: the email about request % was not sent: %', new.id, sqlerrm;
  return null;
end;
$$;

create trigger cal_requests_email_media_team
after insert on public.cal_requests
for each row execute function cal_private.email_new_request();

-- These read the Vault secret and send email, so only the database itself runs them.
revoke execute on function
  cal_private.set_email_settings(text, text), cal_private.email_media_team(text, text, uuid),
  cal_private.email_new_request()
  from public, anon, authenticated;
