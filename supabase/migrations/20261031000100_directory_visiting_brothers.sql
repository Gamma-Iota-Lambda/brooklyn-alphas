-- Brother directory: visiting brothers.
-- Runs after 20261030000300_directory_email_design.sql.
--
-- * A new standing, visiting: a brother from another chapter (or not yet affiliated) whose details
--   the chapter keeps for reclamation. Visiting brothers show in the directory with a Visiting
--   mark and get the birthday and anniversary notes like everyone else.
-- * A public form (directory.html#guest) lets a visiting brother add himself with no sign-in. The
--   record arrives marked Visiting and Needs review, his contact details are not shared with other
--   brothers until he or the media team says so, and the media team gets an email about it.
-- * Two new fields: home_chapter (the chapter he is active in now) and guest_note (what brought
--   him and how to follow up).

alter table public.dir_brothers drop constraint dir_brothers_status_check;
alter table public.dir_brothers
  add constraint dir_brothers_status_check check (status in ('current', 'not-current', 'visiting', 'deceased'));
alter table public.dir_brothers
  add column home_chapter text check (home_chapter is null or char_length(home_chapter) <= 80),
  add column guest_note text check (guest_note is null or char_length(guest_note) <= 1000),
  add column created_by uuid references auth.users (id) on delete set null;

-- created_at comes from the same clock as everything else.
create or replace function cal_private.dir_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := cal_private.clock();
  new.updated_by := (select auth.uid());
  if tg_op = 'INSERT' then
    new.created_at := cal_private.clock();
  else
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create or replace function cal_private.dir_public_json(b public.dir_brothers)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', b.id, 'first_name', b.first_name, 'middle_name', b.middle_name, 'last_name', b.last_name, 'suffix', b.suffix,
    'name', cal_private.dir_full_name(b), 'status', b.status, 'life_member', b.life_member,
    'email', case when b.share_contact then b.email end,
    'phone', case when b.share_contact then b.phone end,
    'city', case when b.share_contact then b.city end,
    'state', case when b.share_contact then b.state end,
    'birthday', case when b.birth_date is not null then to_char(b.birth_date, 'MM-DD') end,
    'crossing_date', b.crossing_date, 'initiation_chapter', b.initiation_chapter, 'home_chapter', b.home_chapter,
    'years', cal_private.dir_years(b.crossing_date, cal_private.today()),
    'claimed', b.member_id is not null, 'pending', b.pending
  )
$$;

create or replace function cal_private.dir_private_json(b public.dir_brothers)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select cal_private.dir_public_json(b) || jsonb_build_object(
    'email', b.email, 'phone', b.phone, 'phone_alt', b.phone_alt, 'address', b.address, 'city', b.city, 'state', b.state,
    'zip', b.zip, 'birth_date', b.birth_date, 'active', b.active,
    'emergency_contact_name', b.emergency_contact_name, 'emergency_contact_phone', b.emergency_contact_phone,
    'share_contact', b.share_contact, 'greetings', b.greetings, 'notes', b.notes, 'guest_note', b.guest_note,
    'member_id', b.member_id, 'created_at', b.created_at, 'updated_at', b.updated_at
  )
$$;

-- The same checks as before, plus home_chapter and guest_note, and the visiting standing.
create or replace function cal_private.dir_from_json(p jsonb, cur public.dir_brothers, p_all boolean)
returns public.dir_brothers
language plpgsql
stable
set search_path = ''
as $$
declare
  b public.dir_brothers := cur;
  has text[];
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Fill in the form.';
  end if;
  has := array(select jsonb_object_keys(p));

  if 'first_name' = any (has) then b.first_name := cal_private.clean(p ->> 'first_name'); end if;
  if 'middle_name' = any (has) then b.middle_name := cal_private.clean(p ->> 'middle_name'); end if;
  if 'last_name' = any (has) then b.last_name := cal_private.clean(p ->> 'last_name'); end if;
  if 'suffix' = any (has) then b.suffix := cal_private.clean(p ->> 'suffix'); end if;
  if 'email' = any (has) then b.email := lower(cal_private.clean(p ->> 'email')); end if;
  if 'phone' = any (has) then b.phone := cal_private.dir_digits(p ->> 'phone'); end if;
  if 'phone_alt' = any (has) then b.phone_alt := cal_private.dir_digits(p ->> 'phone_alt'); end if;
  if 'address' = any (has) then b.address := cal_private.clean(p ->> 'address'); end if;
  if 'city' = any (has) then b.city := cal_private.clean(p ->> 'city'); end if;
  if 'state' = any (has) then b.state := upper(cal_private.clean(p ->> 'state')); end if;
  if 'zip' = any (has) then b.zip := nullif(regexp_replace(coalesce(p ->> 'zip', ''), '\D', '', 'g'), ''); end if;
  if 'initiation_chapter' = any (has) then b.initiation_chapter := cal_private.clean(p ->> 'initiation_chapter'); end if;
  if 'home_chapter' = any (has) then b.home_chapter := cal_private.clean(p ->> 'home_chapter'); end if;
  if 'guest_note' = any (has) then b.guest_note := nullif(trim(coalesce(p ->> 'guest_note', '')), ''); end if;
  if 'emergency_contact_name' = any (has) then b.emergency_contact_name := cal_private.clean(p ->> 'emergency_contact_name'); end if;
  if 'emergency_contact_phone' = any (has) then b.emergency_contact_phone := cal_private.dir_digits(p ->> 'emergency_contact_phone'); end if;
  if 'share_contact' = any (has) then b.share_contact := coalesce((p ->> 'share_contact')::boolean, true); end if;
  if 'greetings' = any (has) then b.greetings := coalesce((p ->> 'greetings')::boolean, true); end if;
  begin
    if 'birth_date' = any (has) then b.birth_date := nullif(p ->> 'birth_date', '')::date; end if;
    if 'crossing_date' = any (has) then b.crossing_date := nullif(p ->> 'crossing_date', '')::date; end if;
  exception when others then
    raise exception 'Use real dates, like 2024-03-23.';
  end;
  if p_all then
    if 'status' = any (has) then b.status := coalesce(nullif(p ->> 'status', ''), 'current'); end if;
    if 'life_member' = any (has) then b.life_member := coalesce((p ->> 'life_member')::boolean, false); end if;
    if 'active' = any (has) then b.active := (p ->> 'active')::boolean; end if;
    if 'pending' = any (has) then b.pending := coalesce((p ->> 'pending')::boolean, false); end if;
    if 'notes' = any (has) then b.notes := nullif(trim(coalesce(p ->> 'notes', '')), ''); end if;
  end if;

  if b.first_name is null or b.last_name is null then
    raise exception 'Add a first and last name.';
  end if;
  if char_length(b.first_name) > 60 or char_length(b.last_name) > 60 or char_length(coalesce(b.middle_name, '')) > 60 then
    raise exception 'Keep each part of the name under 60 characters.';
  end if;
  if char_length(coalesce(b.suffix, '')) > 10 then
    raise exception 'Keep the suffix short, like Jr. or III.';
  end if;
  if b.email is not null and b.email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That email address does not look right.';
  end if;
  if (b.phone is not null and b.phone !~ '^[0-9]{10}$') or (b.phone_alt is not null and b.phone_alt !~ '^[0-9]{10}$')
     or (b.emergency_contact_phone is not null and b.emergency_contact_phone !~ '^[0-9]{10}$') then
    raise exception 'Use a 10-digit phone number, like 718-555-0100.';
  end if;
  if b.state is not null and b.state !~ '^[A-Z]{2}$' then
    raise exception 'Use the two-letter state, like NY.';
  end if;
  if b.zip is not null and b.zip !~ '^[0-9]{5}$' then
    raise exception 'Use a 5-digit ZIP code.';
  end if;
  if char_length(coalesce(b.address, '')) > 160 or char_length(coalesce(b.city, '')) > 80 then
    raise exception 'Keep the address under 160 characters and the city under 80.';
  end if;
  if b.birth_date is not null and (b.birth_date > cal_private.today() or b.birth_date < date '1900-01-01') then
    raise exception 'That birthdate is not possible.';
  end if;
  if b.crossing_date is not null and (b.crossing_date > cal_private.today() or b.crossing_date < date '1906-12-04') then
    raise exception 'A crossing date falls between December 4, 1906 and today.';
  end if;
  if b.birth_date is not null and b.crossing_date is not null and b.crossing_date < b.birth_date + interval '16 years' then
    raise exception 'The birthdate and crossing date are less than 16 years apart. Check both.';
  end if;
  if b.status not in ('current', 'not-current', 'visiting', 'deceased') then
    raise exception 'Choose a standing from the list.';
  end if;
  if char_length(coalesce(b.initiation_chapter, '')) > 80 or char_length(coalesce(b.home_chapter, '')) > 80
     or char_length(coalesce(b.emergency_contact_name, '')) > 80 then
    raise exception 'Keep the chapter and contact names under 80 characters.';
  end if;
  if char_length(coalesce(b.guest_note, '')) > 1000 then
    raise exception 'Keep the note under 1,000 characters.';
  end if;
  if char_length(coalesce(b.notes, '')) > 2000 then
    raise exception 'Keep the notes under 2,000 characters.';
  end if;
  return b;
end;
$$;

-- The media team's add and edit, now carrying the new fields.
create or replace function public.dir_save(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cur public.dir_brothers;
  b public.dir_brothers;
begin
  perform cal_private.assert_staff();
  if p_id is not null then
    select * into cur from public.dir_brothers where id = p_id for update;
    if not found then
      raise exception 'That record is no longer in the directory.';
    end if;
  else
    cur.status := 'current';
    cur.life_member := false;
    cur.share_contact := true;
    cur.greetings := true;
    cur.pending := false;
  end if;
  b := cal_private.dir_from_json(p, cur, true);
  if p_id is null then
    insert into public.dir_brothers (
      first_name, middle_name, last_name, suffix, status, life_member, active, email, phone, phone_alt, address, city, state,
      zip, birth_date, crossing_date, initiation_chapter, home_chapter, guest_note, emergency_contact_name,
      emergency_contact_phone, share_contact, greetings, pending, notes, created_by)
    values (
      b.first_name, b.middle_name, b.last_name, b.suffix, b.status, b.life_member, b.active, b.email, b.phone, b.phone_alt,
      b.address, b.city, b.state, b.zip, b.birth_date, b.crossing_date, b.initiation_chapter, b.home_chapter, b.guest_note,
      b.emergency_contact_name, b.emergency_contact_phone, b.share_contact, b.greetings, b.pending, b.notes, (select auth.uid()))
    returning * into b;
  else
    update public.dir_brothers
    set first_name = b.first_name, middle_name = b.middle_name, last_name = b.last_name, suffix = b.suffix, status = b.status,
        life_member = b.life_member, active = b.active, email = b.email, phone = b.phone, phone_alt = b.phone_alt,
        address = b.address, city = b.city, state = b.state, zip = b.zip, birth_date = b.birth_date,
        crossing_date = b.crossing_date, initiation_chapter = b.initiation_chapter, home_chapter = b.home_chapter,
        guest_note = b.guest_note, emergency_contact_name = b.emergency_contact_name,
        emergency_contact_phone = b.emergency_contact_phone, share_contact = b.share_contact, greetings = b.greetings,
        pending = b.pending, notes = b.notes
    where id = p_id
    returning * into b;
  end if;
  return cal_private.dir_private_json(b);
end;
$$;

-- A brother's own edit, now carrying home_chapter.
create or replace function public.dir_update_me(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cur public.dir_brothers;
  b public.dir_brothers;
begin
  select * into cur from public.dir_brothers where member_id = cal_private.member_id() for update;
  if not found then
    raise exception 'Claim your record first.';
  end if;
  b := cal_private.dir_from_json(p, cur, false);
  update public.dir_brothers
  set first_name = b.first_name, middle_name = b.middle_name, last_name = b.last_name, suffix = b.suffix, email = b.email,
      phone = b.phone, phone_alt = b.phone_alt, address = b.address, city = b.city, state = b.state, zip = b.zip,
      birth_date = b.birth_date, crossing_date = b.crossing_date, initiation_chapter = b.initiation_chapter,
      home_chapter = b.home_chapter, emergency_contact_name = b.emergency_contact_name,
      emergency_contact_phone = b.emergency_contact_phone, share_contact = b.share_contact, greetings = b.greetings
  where id = cur.id
  returning * into b;
  return cal_private.dir_private_json(b);
end;
$$;

-- A visiting brother adds himself from the public form. Needs only a session (the page starts an
-- anonymous one), no chapter code. The record is marked visiting and needs review, contact details
-- stay unshared, and the media team is emailed. A second submission with the same email updates the
-- first. p_website is a honeypot: real people leave it empty.
create or replace function public.dir_guest_submit(p jsonb, p_website text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  blank public.dir_brothers;
  cur public.dir_brothers;
  b public.dir_brothers;
  v_existing public.dir_brothers;
  v_lines text[];
  v_team text[];
  v_updated boolean := false;
begin
  if v_uid is null then
    raise exception 'Reload the page and try again.';
  end if;
  if coalesce(p_website, '') <> '' then
    -- Looks automated. Say nothing useful.
    return jsonb_build_object('ok', true);
  end if;
  if (select count(*) from public.dir_brothers x where x.created_by = v_uid and x.created_at > cal_private.clock() - interval '1 day') >= 3 then
    raise exception 'That is enough for today. Ask the media team to add anyone else.';
  end if;
  blank.status := 'visiting';
  blank.life_member := false;
  blank.share_contact := false;
  blank.greetings := true;
  blank.pending := true;
  b := cal_private.dir_from_json(p - 'share_contact', blank, false);
  if b.email is null and b.phone is null then
    raise exception 'Add an email or a phone number so the chapter can reach you.';
  end if;

  -- A brother already on the roll should sign in instead of adding a visiting record.
  select * into v_existing from public.dir_brothers x
  where x.status <> 'visiting'
    and lower(x.first_name) = lower(b.first_name) and lower(x.last_name) = lower(b.last_name)
  limit 1;
  if found then
    raise exception 'A brother with your name is already on the chapter roll. Sign in with the chapter code and claim your record instead. Ask any brother for the code.';
  end if;

  -- The same visiting brother again: update what he sent.
  if b.email is not null then
    select * into cur from public.dir_brothers x where x.status = 'visiting' and x.email = b.email limit 1 for update;
  end if;
  if found then
    update public.dir_brothers
    set first_name = b.first_name, middle_name = b.middle_name, last_name = b.last_name, suffix = b.suffix,
        phone = coalesce(b.phone, phone), phone_alt = coalesce(b.phone_alt, phone_alt), address = coalesce(b.address, address),
        city = coalesce(b.city, city), state = coalesce(b.state, state), zip = coalesce(b.zip, zip),
        birth_date = coalesce(b.birth_date, birth_date), crossing_date = coalesce(b.crossing_date, crossing_date),
        initiation_chapter = coalesce(b.initiation_chapter, initiation_chapter), home_chapter = coalesce(b.home_chapter, home_chapter),
        guest_note = coalesce(b.guest_note, guest_note), greetings = b.greetings, pending = true
    where id = cur.id
    returning * into b;
    v_updated := true;
  else
    insert into public.dir_brothers (
      first_name, middle_name, last_name, suffix, status, life_member, email, phone, phone_alt, address, city, state, zip,
      birth_date, crossing_date, initiation_chapter, home_chapter, guest_note, share_contact, greetings, pending, created_by)
    values (
      b.first_name, b.middle_name, b.last_name, b.suffix, 'visiting', false, b.email, b.phone, b.phone_alt, b.address, b.city,
      b.state, b.zip, b.birth_date, b.crossing_date, b.initiation_chapter, b.home_chapter, b.guest_note, false, b.greetings,
      true, v_uid)
    returning * into b;
  end if;

  -- Tell the media team.
  begin
    select array_agg(x.email order by x.email) into v_team
    from (select distinct lower(u.email::text) as email from public.cal_staff s join auth.users u on u.id = s.user_id
          where coalesce(u.email::text, '') <> '') x;
    v_lines := array[
      format('%s added himself as a visiting brother%s.', cal_private.dir_full_name(b), case when v_updated then ' (an update to his earlier entry)' else '' end),
      '',
      'Email: ' || coalesce(b.email, 'none'),
      'Phone: ' || coalesce(regexp_replace(b.phone, '^(\d{3})(\d{3})(\d{4})$', '\1-\2-\3'), 'none'),
      'Chapter of initiation: ' || coalesce(b.initiation_chapter, 'not given'),
      'Chapter now: ' || coalesce(b.home_chapter, 'not given'),
      'Crossed: ' || coalesce(to_char(b.crossing_date, 'FMMonth FMDD, YYYY'), 'not given'),
      'Lives in: ' || coalesce(concat_ws(', ', b.city, b.state), 'not given')
    ];
    if b.guest_note is not null then
      v_lines := v_lines || array['', 'His note:', b.guest_note];
    end if;
    v_lines := v_lines || array['', 'Review it under Manage: https://www.gil1906.org/directory#manage', '',
      'You get this because you have a media team login.'];
    perform cal_private.dir_send_email(v_team, 'Visiting brother: ' || cal_private.dir_full_name(b),
      array_to_string(v_lines, E'\n'), cal_private.dir_html_email(array_to_string(v_lines, E'\n'), 'Visiting brother: ' || cal_private.dir_full_name(b)));
  exception when others then
    raise warning 'GIL directory: the email about visiting brother % was not sent: %', b.id, sqlerrm;
  end;

  return jsonb_build_object('ok', true, 'updated', v_updated, 'name', cal_private.dir_full_name(b));
end;
$$;

revoke execute on function public.dir_guest_submit(jsonb, text) from public, anon;
grant execute on function public.dir_guest_submit(jsonb, text) to authenticated;
