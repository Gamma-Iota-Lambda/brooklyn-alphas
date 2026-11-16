-- GIL Content Calendar: noticing when the Instagram and Threads numbers stop updating.
-- Runs after 20261018000100_social_results.sql. Run it before deploying the calendar-social Edge
-- Function that goes with it; the function works with either order.
--
-- Why
-- * The nightly job only asks the Edge Function to sync, and the function answers before it starts.
--   pg_cron reports "succeeded" and pg_net reports 202 on a night when nothing was saved. From
--   Oct. 20, 2026 Meta refused every request ("API access blocked.") and nothing said so for 26
--   nights.
--
-- How it works
-- * cal_social_accounts.last_sync_at only moves when a sync saves. A second nightly job,
--   cal_private.social_health_check(), emails the media team once a connected account has gone two
--   days without one, and again each week while it lasts. It reads the table, so it also notices
--   the Edge Function being down or the nightly request never arriving.
-- * When a sync saves nothing, the Edge Function keeps what Instagram or Threads sent with the
--   error (the request's host and path, HTTP status, code, subcode, type, and trace) in
--   cal_social_accounts.last_error_detail. The function's log lasts a day; this lasts until the
--   next sync that saves. The email quotes it, for Meta support. It never holds a token.

alter table public.cal_social_accounts
  add column last_error_detail jsonb,
  add column stale_alerted_at timestamptz;

-- Records why a sync saved nothing, with what Instagram or Threads sent. A sign-in that runs out
-- while Meta is refusing requests keeps what Meta last sent: nothing is asked after that, and Meta
-- support needs the trace.
create or replace function cal_private.social_sync_failed(p_platform text, p_message text, p_detail jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.cal_social_accounts
  set last_error = left(coalesce(nullif(trim(p_message), ''), 'The sync did not finish.'), 500),
      last_error_at = cal_private.clock(),
      last_error_detail = case
        when p_detail ->> 'kind' = 'expired' and last_error_detail ->> 'kind' = 'blocked' then last_error_detail
        when jsonb_typeof(p_detail) = 'object' and char_length(p_detail::text) <= 1000 then p_detail
      end
  where platform = p_platform
$$;

-- The two-argument form stays for notes after a sync that saved, such as numbers for some posts
-- waiting for the next sync. A note has no detail, and replaces an earlier error's.
create or replace function cal_private.social_sync_failed(p_platform text, p_message text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.cal_social_accounts
  set last_error = left(coalesce(nullif(trim(p_message), ''), 'The sync did not finish.'), 500),
      last_error_at = cal_private.clock(),
      last_error_detail = null
  where platform = p_platform
$$;

-- The detail goes when its note does, and the next gap in the numbers gets its own first email.
create or replace function cal_private.social_account_tidy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.last_error is null then
    new.last_error_detail := null;
  end if;
  if new.last_sync_at is distinct from old.last_sync_at then
    new.stale_alerted_at := null;
  end if;
  return new;
end;
$$;

create trigger cal_social_accounts_tidy
before update on public.cal_social_accounts
for each row execute function cal_private.social_account_tidy();

-- Emails the media team about connected accounts whose numbers have stopped coming in: once an
-- account has gone two days without a sync that saved, then weekly while it lasts. One email lists
-- every stuck account. Returns how many it listed, or 0 when there was nothing to send or emails
-- aren't set up (it tries again the next day). An error stops it, and shows as a failed run in
-- cron.job_run_details.
create or replace function cal_private.social_health_check()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := cal_private.clock();
  v_today date := cal_private.today();
  v_labels constant jsonb := '{"instagram": "Instagram", "threads": "Threads"}';
  v_names text[] := '{}';
  v_lines text[] := '{}';
  v_detail text;
  v_why boolean;
  v_count integer := 0;
  a record;
begin
  -- pg_cron starts a job a fraction of a second early or late, so "a week" is six and a half days.
  if not exists (
    select 1 from public.cal_social_accounts s
    where coalesce(s.last_sync_at, s.connected_at) < v_now - interval '2 days'
      and (s.stale_alerted_at is null or s.stale_alerted_at <= v_now - interval '6 days 12 hours')
  ) then
    return 0;
  end if;

  for a in
    select s.*, (coalesce(s.last_sync_at, s.connected_at) at time zone 'America/New_York')::date as since_day
    from public.cal_social_accounts s
    where coalesce(s.last_sync_at, s.connected_at) < v_now - interval '2 days'
    order by s.platform
  loop
    v_count := v_count + 1;
    v_names := v_names || (v_labels ->> a.platform);
    -- A note that came with the last sync that saved isn't why the numbers stopped. A note from a
    -- later try is.
    v_why := a.last_error is not null and (a.last_sync_at is null or a.last_error_at > a.last_sync_at + interval '10 seconds');
    v_lines := v_lines || array[
      '',
      (v_labels ->> a.platform) || coalesce(' (@' || a.username || ')', ''),
      case when a.last_sync_at is null
        then format('No numbers have come in since it was connected on %s.', to_char(a.since_day, 'FMDay, FMMonth FMDD, YYYY'))
        else format('Last updated: %s (%s days ago)', to_char(a.since_day, 'FMDay, FMMonth FMDD, YYYY'), v_today - a.since_day)
      end,
      case when v_why
        then format('Latest note (%s): %s', to_char(a.last_error_at at time zone 'America/New_York', 'FMDay, FMMonth FMDD'), a.last_error)
        else 'No note. Nothing has reported in since then, so the nightly update may not be running. Whoever looks after the website should check it.'
      end
    ];
    if v_why and a.last_error_at < v_now - interval '36 hours' then
      v_lines := v_lines || 'Nothing has reported in since that note either, so the nightly update may have stopped running. Whoever looks after the website should check it.'::text;
    end if;
    if v_why and a.last_error_detail is not null then
      v_detail := concat_ws(', ',
        a.last_error_detail ->> 'request',
        'HTTP ' || (a.last_error_detail ->> 'status'),
        'code ' || (a.last_error_detail ->> 'code'),
        'subcode ' || (a.last_error_detail ->> 'subcode'),
        a.last_error_detail ->> 'type',
        'trace ' || (a.last_error_detail ->> 'trace'));
      if v_detail <> '' then
        v_lines := v_lines || ('Details, for Meta support: ' || v_detail);
      end if;
    end if;
    -- When the note already says to choose Reconnect, a date to wait for would only confuse.
    if a.token_expires_at is not null and not (v_why and a.last_error ~* 'choose reconnect') then
      v_lines := v_lines || case when a.token_expires_at <= v_now
        then 'The saved sign-in has expired. Choose Reconnect on the Results tab.'
        else format('The saved sign-in lasts until %s. After that, choose Reconnect on the Results tab, once the problem has cleared.',
          to_char(a.token_expires_at at time zone 'America/New_York', 'FMDay, FMMonth FMDD'))
      end;
    end if;
  end loop;

  v_lines := array[format('The %s numbers on the content calendar have stopped updating. The numbers saved so far are still there.',
    array_to_string(v_names, ' and '))] || v_lines || array[
    '',
    'What to do',
    '- Open Results on the calendar and read the note on each account: https://www.gil1906.org/calendar.html#results',
    '- If a note says to choose Reconnect, do that. Otherwise leave the connection in place and don''t choose Disconnect: the saved sign-in picks up by itself once the problem clears.',
    '- Not sure what to do? Forward this email to whoever looks after the website. The setup guide covers it under "When the numbers stop updating".',
    '',
    'This email comes again in a week if the numbers are still stuck. You get it because you have a media team login for the GIL content calendar.'
  ];

  if cal_private.email_media_team(
    format('The %s numbers have stopped updating', array_to_string(v_names, ' and ')), array_to_string(v_lines, E'\n')) is null then
    return 0;
  end if;
  update public.cal_social_accounts s
  set stale_alerted_at = v_now
  where coalesce(s.last_sync_at, s.connected_at) < v_now - interval '2 days';
  return v_count;
end;
$$;

-- Only the database runs these.
revoke execute on function
  cal_private.social_sync_failed(text, text, jsonb), cal_private.social_account_tidy(),
  cal_private.social_health_check()
  from public, anon, authenticated;

-- Every morning at 9:10 UTC, 50 minutes after the nightly sync: 5:10 a.m. New York time during
-- daylight saving time, 4:10 a.m. in winter. Running this again updates the same job.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('gil-calendar-social-health', '10 9 * * *', $job$select cal_private.social_health_check()$job$);
  end if;
end
$$;
