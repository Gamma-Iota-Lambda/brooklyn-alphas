-- Brother directory: greeting emails with the chapter crest and the subject as a heading.
-- Runs after 20261030000200_directory_last_name.sql. Replaces the HTML template and the two functions
-- that call it, so the subject reaches the template.

drop function cal_private.dir_html_email(text);

-- The branded HTML version of a greeting: the chapter crest over a black masthead, the subject as a
-- heading, the message in a serif, and a short footer. Tables and inline styles, for email clients.
create or replace function cal_private.dir_html_email(p_text text, p_title text default null)
returns text
language sql
immutable
set search_path = ''
as $$
  select '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'
    || cal_private.dir_html(coalesce(p_title, 'Gamma Iota Lambda Chapter')) || '</title></head>'
    || '<body style="margin:0;padding:0;background:#f6f5f1;-webkit-font-smoothing:antialiased">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f5f1"><tr><td align="center" style="padding:28px 12px">'
    || '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e3ded1;border-radius:14px;overflow:hidden">'
    -- masthead
    || '<tr><td align="center" style="background:#0a0a0a;padding:30px 28px 24px;border-bottom:3px solid #cfb53b">'
    || '<img src="https://www.gil1906.org/gil-crest.png" width="88" height="88" alt="Gamma Iota Lambda Chapter crest" style="display:block;width:88px;height:88px;border:0;margin:0 auto 14px">'
    || '<div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#cfb53b">Alpha Phi Alpha Fraternity, Inc.</div>'
    || '<div style="font-family:Georgia,''Times New Roman'',serif;font-size:26px;line-height:1.2;color:#ffffff;margin-top:6px">Gamma Iota Lambda Chapter</div>'
    || '<div style="font-family:Helvetica,Arial,sans-serif;font-size:12.5px;letter-spacing:0.04em;color:#cbc3b0;margin-top:5px">The Brooklyn Alphas &middot; Chartered 1945</div>'
    || '</td></tr>'
    -- heading
    || case when p_title is null then '' else
       '<tr><td style="padding:30px 36px 0;font-family:Georgia,''Times New Roman'',serif;font-size:27px;line-height:1.25;color:#17150f">'
       || cal_private.dir_html(p_title) || '</td></tr>'
       || '<tr><td style="padding:14px 36px 0"><div style="width:56px;height:3px;background:#cfb53b"></div></td></tr>' end
    -- body
    || '<tr><td style="padding:' || case when p_title is null then '30px' else '20px' end || ' 36px 10px;font-family:Georgia,''Times New Roman'',serif;font-size:17px;line-height:1.65;color:#17150f">'
    || '<p style="margin:0 0 16px">' || replace(regexp_replace(cal_private.dir_html(p_text), E'\n\n+', '</p><p style="margin:0 0 16px">', 'g'), E'\n', '<br>') || '</p>'
    || '</td></tr>'
    -- footer
    || '<tr><td style="padding:18px 36px 28px;border-top:1px solid #e3ded1;font-family:Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.55;color:#5d5747">'
    || '<div style="font-style:italic;font-family:Georgia,''Times New Roman'',serif;font-size:14px;color:#17150f;margin-bottom:8px">We educate the Village, serve the Community, and empower both to thrive.</div>'
    || 'You get this because you are in the chapter directory at <a href="https://www.gil1906.org/directory" style="color:#7a640e">gil1906.org/directory</a>, where you can update your details or turn these messages off.'
    || '</td></tr></table>'
    || '<div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#958d7b;margin-top:14px">Gamma Iota Lambda Chapter &middot; Brooklyn, NY &middot; <a href="https://www.gil1906.org" style="color:#958d7b">gil1906.org</a></div>'
    || '</td></tr></table></body></html>'
$$;

-- The morning run. Emails each brother celebrating today, then the media team about tomorrow.
-- Safe to run more than once a day: dir_messages remembers what went out.
create or replace function cal_private.dir_run_greetings(p_day date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := coalesce(p_day, cal_private.today());
  v_on boolean := cal_private.dir_config('dir_greetings', 'on') = 'on';
  v_digest boolean := cal_private.dir_config('dir_digest', 'on') = 'on';
  c record;
  v_subject text;
  v_text text;
  v_req bigint;
  v_sent int := 0;
  v_skipped int := 0;
  v_lines text[];
  v_team text[];
  v_tomorrow date := v_day + 1;
  v_digest_sent boolean := false;
begin
  if v_on then
    for c in select * from cal_private.dir_celebrations(v_day) loop
      if not (c.brother).greetings or (c.brother).email is null
         or exists (select 1 from public.dir_messages m where m.brother_id = (c.brother).id and m.kind = c.kind and m.day = v_day) then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      if c.kind = 'birthday' then
        v_subject := cal_private.dir_render(cal_private.dir_config('dir_birthday_subject', cal_private.dir_default('birthday_subject')), c.brother, v_day);
        v_text := cal_private.dir_render(cal_private.dir_config('dir_birthday_text', cal_private.dir_default('birthday_text')), c.brother, v_day);
      else
        v_subject := cal_private.dir_render(cal_private.dir_config('dir_anniversary_subject', cal_private.dir_default('anniversary_subject')), c.brother, v_day);
        v_text := cal_private.dir_render(cal_private.dir_config('dir_anniversary_text', cal_private.dir_default('anniversary_text')), c.brother, v_day);
      end if;
      v_req := cal_private.dir_send_email(array[(c.brother).email], v_subject, v_text, cal_private.dir_html_email(v_text, v_subject));
      if v_req is null then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      insert into public.dir_messages (brother_id, kind, day, sent_to, subject, request_id, sent_at)
      values ((c.brother).id, c.kind, v_day, (c.brother).email, v_subject, v_req, cal_private.clock());
      v_sent := v_sent + 1;
    end loop;
  end if;

  -- Tomorrow's celebrations, to the media team, once per day.
  if v_digest and not exists (select 1 from public.dir_messages m where m.kind = 'digest' and m.day = v_tomorrow) then
    select array_agg(x.email order by x.email) into v_team
    from (select distinct lower(u.email::text) as email from public.cal_staff s join auth.users u on u.id = s.user_id
          where coalesce(u.email::text, '') <> '') x;
    v_lines := array[]::text[];
    for c in select * from cal_private.dir_celebrations(v_tomorrow) loop
      v_lines := v_lines || format('%s: %s%s%s',
        case c.kind when 'birthday' then 'Birthday' else 'Alpha anniversary' end,
        cal_private.dir_full_name(c.brother),
        case when c.kind = 'anniversary' then format(' (%s, crossed %s)', case when c.years = 1 then '1 year' else c.years || ' years' end,
                                                      to_char((c.brother).crossing_date, 'FMMonth FMDD, YYYY')) else '' end,
        case when (c.brother).email is null then '. No email on file, so no email goes out; a call or text would be welcome'
                                                  || case when (c.brother).phone is not null then ' (' || regexp_replace((c.brother).phone, '^(\d{3})(\d{3})(\d{4})$', '\1-\2-\3') || ')' else '' end
             when not (c.brother).greetings then '. Asked not to get greeting emails'
             else '' end);
    end loop;
    if cardinality(v_lines) > 0 and v_team is not null then
      v_subject := format('Tomorrow, %s: %s', to_char(v_tomorrow, 'FMDay, FMMonth FMDD'),
                          case when cardinality(v_lines) = 1 then v_lines[1] else cardinality(v_lines) || ' brothers to celebrate' end);
      v_text := format('Celebrations on %s:', to_char(v_tomorrow, 'FMDay, FMMonth FMDD, YYYY')) || E'\n\n'
             || array_to_string(v_lines, E'\n') || E'\n\n'
             || 'Each brother with an email on file and greetings turned on gets an email from the chapter that morning. '
             || 'The directory: https://www.gil1906.org/directory' || E'\n\n'
             || 'You get this because you have a media team login.';
      v_req := cal_private.dir_send_email(v_team, v_subject, v_text, cal_private.dir_html_email(v_text, v_subject));
      if v_req is not null then
        insert into public.dir_messages (brother_id, kind, day, sent_to, subject, request_id, sent_at)
        values (null, 'digest', v_tomorrow, array_to_string(v_team, ', '), v_subject, v_req, cal_private.clock());
        v_digest_sent := true;
      end if;
    end if;
  end if;

  return jsonb_build_object('day', v_day, 'sent', v_sent, 'skipped', v_skipped, 'digest', v_digest_sent);
exception when others then
  raise warning 'GIL directory: the greetings run for % failed: %', v_day, sqlerrm;
  return jsonb_build_object('day', v_day, 'error', sqlerrm);
end;
$$;

-- Sends the media team member a sample of a message, rendered for his own record (or a sample
-- brother when he has none), so he can see how it reads.
create or replace function public.dir_send_test(p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  b public.dir_brothers;
  v_subject text;
  v_text text;
  v_req bigint;
begin
  perform cal_private.assert_staff();
  if p_kind not in ('birthday', 'anniversary') then
    raise exception 'Choose the birthday or the anniversary message.';
  end if;
  select lower(u.email::text) into v_email from auth.users u where u.id = v_uid;
  if coalesce(v_email, '') = '' then
    raise exception 'Your login has no email address.';
  end if;
  select x.* into b from public.dir_brothers x
  where x.email = v_email or x.member_id = cal_private.member_id()
  order by x.email = v_email desc limit 1;
  if not found then
    b.first_name := 'Sample';
    b.last_name := 'Brother';
    b.crossing_date := cal_private.today() - interval '10 years';
    b.birth_date := cal_private.today() - interval '35 years';
  end if;
  if p_kind = 'birthday' then
    v_subject := cal_private.dir_render(cal_private.dir_config('dir_birthday_subject', cal_private.dir_default('birthday_subject')), b, cal_private.today());
    v_text := cal_private.dir_render(cal_private.dir_config('dir_birthday_text', cal_private.dir_default('birthday_text')), b, cal_private.today());
  else
    if b.crossing_date is null then
      b.crossing_date := cal_private.today() - interval '10 years';
    end if;
    v_subject := cal_private.dir_render(cal_private.dir_config('dir_anniversary_subject', cal_private.dir_default('anniversary_subject')), b, cal_private.today());
    v_text := cal_private.dir_render(cal_private.dir_config('dir_anniversary_text', cal_private.dir_default('anniversary_text')), b, cal_private.today());
  end if;
  v_req := cal_private.dir_send_email(array[v_email], '[Test] ' || v_subject, v_text, cal_private.dir_html_email(v_text, v_subject));
  if v_req is null then
    raise exception 'Email is not set up yet. Run supabase/setup/2-request-emails.sql first.';
  end if;
  insert into public.dir_messages (brother_id, kind, day, sent_to, subject, request_id, sent_at)
  values (null, 'test', cal_private.today(), v_email, v_subject, v_req, cal_private.clock())
  on conflict (brother_id, kind, day) do update set sent_to = excluded.sent_to, subject = excluded.subject,
    request_id = excluded.request_id, sent_at = excluded.sent_at;
  return jsonb_build_object('to', v_email, 'subject', v_subject, 'text', v_text);
end;
$$;

revoke execute on function cal_private.dir_html_email(text, text) from public, anon, authenticated;
