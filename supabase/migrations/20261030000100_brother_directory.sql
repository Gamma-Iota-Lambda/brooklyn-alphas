-- GIL Brother Directory (directory.html), first migration.
-- Runs after the content calendar's four migrations in the same Supabase project, and shares its
-- sign-in: brothers use the chapter code, their name, and their PIN; the media team uses its email
-- login. Public names carry a dir_ prefix; internals live in cal_private alongside the calendar's.
--
-- Who can do what
-- * Visitors see nothing.
-- * Brothers see the directory (names, standing, crossing dates, birthdays as month and day, and
--   the contact details each brother chooses to share). Each brother claims his own record once
--   with the last four digits of the phone on file, then edits it himself.
-- * The media team sees and edits every record, adds and removes brothers, links a record to a
--   sign-in, imports a spreadsheet, and manages the greeting emails.
-- * Every morning, pg_cron emails each brother on his birthday and on the anniversary of his
--   crossing, and emails the media team the day before so a post or a call can go out.
--
-- Design notes
-- * Brothers write only through SECURITY DEFINER functions with `set search_path = ''`.
-- * Email goes through Resend with pg_net, the same path as request emails, using the API key the
--   calendar already keeps in Vault (calendar_resend_api_key).
-- * dir_messages records every send, one per brother, kind, and day, so a rerun never repeats one.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.dir_brothers (
  id uuid primary key default gen_random_uuid(),
  member_id uuid unique references public.cal_members (id) on delete set null,
  first_name text not null check (char_length(first_name) between 1 and 60),
  middle_name text check (middle_name is null or char_length(middle_name) <= 60),
  last_name text not null check (char_length(last_name) between 1 and 60),
  suffix text check (suffix is null or char_length(suffix) <= 10),
  status text not null default 'current' check (status in ('current', 'not-current', 'deceased')),
  life_member boolean not null default false,
  active boolean,
  email text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (phone is null or phone ~ '^[0-9]{10}$'),
  phone_alt text check (phone_alt is null or phone_alt ~ '^[0-9]{10}$'),
  address text check (address is null or char_length(address) <= 160),
  city text check (city is null or char_length(city) <= 80),
  state text check (state is null or state ~ '^[A-Z]{2}$'),
  zip text check (zip is null or zip ~ '^[0-9]{5}$'),
  birth_date date,
  crossing_date date,
  initiation_chapter text check (initiation_chapter is null or char_length(initiation_chapter) <= 80),
  emergency_contact_name text check (emergency_contact_name is null or char_length(emergency_contact_name) <= 80),
  emergency_contact_phone text check (emergency_contact_phone is null or emergency_contact_phone ~ '^[0-9]{10}$'),
  share_contact boolean not null default true,
  greetings boolean not null default true,
  pending boolean not null default false,
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
create index dir_brothers_name_idx on public.dir_brothers (lower(last_name), lower(first_name));

-- One row per greeting sent. day is the birthday or anniversary (this year) or the digest's day.
create table public.dir_messages (
  id bigint generated always as identity primary key,
  brother_id uuid references public.dir_brothers (id) on delete cascade,
  kind text not null check (kind in ('birthday', 'anniversary', 'digest', 'test')),
  day date not null,
  sent_to text not null,
  subject text not null,
  request_id bigint,
  sent_at timestamptz not null default now(),
  unique nulls not distinct (brother_id, kind, day)
);
create index dir_messages_day_idx on public.dir_messages (day desc);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function cal_private.dir_digits(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(regexp_replace(
    case when regexp_replace(coalesce(p, ''), '\D', '', 'g') ~ '^1[0-9]{10}$'
         then substr(regexp_replace(p, '\D', '', 'g'), 2)
         else regexp_replace(coalesce(p, ''), '\D', '', 'g') end, '\D', '', 'g'), '')
$$;

create or replace function cal_private.dir_years(p_from date, p_on date)
returns int
language sql
immutable
set search_path = ''
as $$
  select case when p_from is null then null else extract(year from age(p_on, p_from))::int end
$$;

-- True when d falls on the same month and day as p_today. February 29 counts on February 28 in
-- a year without one.
create or replace function cal_private.dir_same_day(d date, p_today date)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select d is not null and (
    (extract(month from d) = extract(month from p_today) and extract(day from d) = extract(day from p_today))
    or (extract(month from d) = 2 and extract(day from d) = 29
        and extract(month from p_today) = 2 and extract(day from p_today) = 28
        and extract(day from (make_date(extract(year from p_today)::int, 3, 1) - 1)) = 28)
  )
$$;

create or replace function cal_private.dir_html(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;

create or replace function cal_private.dir_ordinal(n int)
returns text
language sql
immutable
set search_path = ''
as $$
  select n::text || case
    when n % 100 between 11 and 13 then 'th'
    when n % 10 = 1 then 'st' when n % 10 = 2 then 'nd' when n % 10 = 3 then 'rd' else 'th' end
$$;

create or replace function cal_private.dir_full_name(b public.dir_brothers)
returns text
language sql
immutable
set search_path = ''
as $$
  select concat_ws(' ', b.first_name, b.last_name, b.suffix)
$$;

create or replace function cal_private.dir_config(p_key text, p_default text default null)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select c.value from cal_private.config c where c.key = p_key), p_default)
$$;

-- What a brother sees of another brother: never the street address, birth year, emergency
-- contact, notes, or anything he chose not to share.
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
    'crossing_date', b.crossing_date, 'initiation_chapter', b.initiation_chapter,
    'years', cal_private.dir_years(b.crossing_date, cal_private.today()),
    'claimed', b.member_id is not null, 'pending', b.pending
  )
$$;

-- Everything, for the brother himself and the media team.
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
    'share_contact', b.share_contact, 'greetings', b.greetings, 'notes', b.notes, 'member_id', b.member_id,
    'created_at', b.created_at, 'updated_at', b.updated_at
  )
$$;

create or replace function cal_private.dir_mine()
returns public.dir_brothers
language sql
stable
security definer
set search_path = ''
as $$
  select b.* from public.dir_brothers b where b.member_id = (select cal_private.member_id())
$$;

-- Reads a record from a form payload. cur carries the current values; p_all lets every field change
-- (the media team), otherwise only the fields a brother may change on his own record.
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
  if b.status not in ('current', 'not-current', 'deceased') then
    raise exception 'Choose a standing from the list.';
  end if;
  if char_length(coalesce(b.initiation_chapter, '')) > 80 or char_length(coalesce(b.emergency_contact_name, '')) > 80 then
    raise exception 'Keep the chapter and contact names under 80 characters.';
  end if;
  if char_length(coalesce(b.notes, '')) > 2000 then
    raise exception 'Keep the notes under 2,000 characters.';
  end if;
  return b;
end;
$$;

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
    new.created_at := coalesce(new.created_at, cal_private.clock());
  else
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

create trigger dir_brothers_touch
before insert or update on public.dir_brothers
for each row execute function cal_private.dir_touch();

-- ---------------------------------------------------------------------------
-- Row level security: the media team reads the tables. Brothers read through functions.
-- ---------------------------------------------------------------------------

alter table public.dir_brothers enable row level security;
alter table public.dir_messages enable row level security;

create policy "the media team reads every brother"
  on public.dir_brothers for select to authenticated using ((select cal_private.is_staff()));
create policy "the media team reads the message log"
  on public.dir_messages for select to authenticated using ((select cal_private.is_staff()));

-- ---------------------------------------------------------------------------
-- Everyone who is signed in
-- ---------------------------------------------------------------------------

create or replace function cal_private.dir_default(p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_key
    when 'birthday_subject' then 'Happy birthday, Brother {first_name}'
    when 'birthday_text' then
      'Happy birthday, Brother {first_name}.' || E'\n\n' ||
      'The brothers of Gamma Iota Lambda celebrate you today. We hope the year ahead brings you good health, good company, and work that matters.' || E'\n\n' ||
      'Enjoy your day.' || E'\n\n' || '06'
    when 'anniversary_subject' then 'Happy Alpha anniversary, Brother {first_name}: {years_text} in the bond'
    when 'anniversary_text' then
      'Happy anniversary, Brother {first_name}.' || E'\n\n' ||
      'On this day in {crossing_year} you crossed into Alpha Phi Alpha. That is {years_text} of brotherhood, scholarship, and service, and Gamma Iota Lambda is better for it.' || E'\n\n' ||
      'Thank you for every one of them.' || E'\n\n' || '06'
  end
$$;

-- Settings the page needs. Templates and switches come only to the media team.
create or replace function public.dir_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email_ready boolean := exists (select 1 from vault.decrypted_secrets s where s.name = 'calendar_resend_api_key')
                           and cal_private.dir_config('email_from') is not null;
  v jsonb;
begin
  v := jsonb_build_object(
    'ready', exists (select 1 from cal_private.config where key = 'calendar_chapter_code_hash'),
    'email_ready', v_email_ready,
    'count', (select count(*) from public.dir_brothers where status <> 'deceased')
  );
  if cal_private.is_staff() then
    v := v || jsonb_build_object(
      'greetings_on', cal_private.dir_config('dir_greetings', 'on') = 'on',
      'digest_on', cal_private.dir_config('dir_digest', 'on') = 'on',
      'from', cal_private.dir_config('dir_email_from', cal_private.dir_config('email_from')),
      'birthday_subject', cal_private.dir_config('dir_birthday_subject', cal_private.dir_default('birthday_subject')),
      'birthday_text', cal_private.dir_config('dir_birthday_text', cal_private.dir_default('birthday_text')),
      'anniversary_subject', cal_private.dir_config('dir_anniversary_subject', cal_private.dir_default('anniversary_subject')),
      'anniversary_text', cal_private.dir_config('dir_anniversary_text', cal_private.dir_default('anniversary_text')),
      'last_run', (select max(sent_at) from public.dir_messages where kind <> 'test')
    );
  end if;
  return v;
end;
$$;

-- The directory. Full records for the media team; shared details for brothers.
create or replace function public.dir_list()
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_staff boolean := cal_private.is_staff();
begin
  if not cal_private.can_view() then
    raise exception 'Sign in with the chapter code to see the directory.';
  end if;
  return query
    select case when v_staff then cal_private.dir_private_json(b) else cal_private.dir_public_json(b) end
    from public.dir_brothers b
    order by lower(b.last_name), lower(b.first_name);
end;
$$;

-- The signed-in brother's own record, or null until he claims one.
create or replace function public.dir_me()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select cal_private.dir_private_json(b) from cal_private.dir_mine() b where b.id is not null
$$;

-- A brother claims his record with the last four digits of the phone on file.
create or replace function public.dir_claim(p_id uuid, p_check text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member uuid := cal_private.member_id();
  v_check text := regexp_replace(coalesce(p_check, ''), '\D', '', 'g');
  b public.dir_brothers;
begin
  if v_member is null then
    raise exception 'Sign in with the chapter code first.';
  end if;
  if exists (select 1 from public.dir_brothers x where x.member_id = v_member) then
    raise exception 'You already have a record. Open My record to change it.';
  end if;
  select * into b from public.dir_brothers where id = p_id for update;
  if not found then
    raise exception 'That record is no longer in the directory.';
  end if;
  if b.member_id is not null then
    raise exception 'Someone already claimed this record. If it is yours, ask the media team to fix it.';
  end if;
  if b.phone is null and b.phone_alt is null then
    raise exception 'There is no phone number on file for this record, so the media team needs to link it to you. Ask them.';
  end if;
  if v_check !~ '^[0-9]{4}$' or (right(coalesce(b.phone, ''), 4) <> v_check and right(coalesce(b.phone_alt, ''), 4) <> v_check) then
    raise exception 'Those digits do not match the phone number on file. If your number changed, ask the media team to link the record for you.';
  end if;
  update public.dir_brothers set member_id = v_member where id = b.id returning * into b;
  return cal_private.dir_private_json(b);
end;
$$;

-- A brother who is not in the directory yet adds himself. The media team sees it marked for review.
create or replace function public.dir_add_self(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member uuid := cal_private.member_id();
  blank public.dir_brothers;
  b public.dir_brothers;
begin
  if v_member is null then
    raise exception 'Sign in with the chapter code first.';
  end if;
  if exists (select 1 from public.dir_brothers x where x.member_id = v_member) then
    raise exception 'You already have a record. Open My record to change it.';
  end if;
  blank.status := 'current';
  blank.life_member := false;
  blank.share_contact := true;
  blank.greetings := true;
  blank.pending := true;
  b := cal_private.dir_from_json(p, blank, false);
  if exists (select 1 from public.dir_brothers x
             where lower(x.first_name) = lower(b.first_name) and lower(x.last_name) = lower(b.last_name) and x.member_id is null) then
    raise exception 'A record with your name is already in the directory. Claim it instead of adding a new one.';
  end if;
  insert into public.dir_brothers (
    member_id, first_name, middle_name, last_name, suffix, status, life_member, email, phone, phone_alt, address, city, state,
    zip, birth_date, crossing_date, initiation_chapter, emergency_contact_name, emergency_contact_phone, share_contact,
    greetings, pending)
  values (
    v_member, b.first_name, b.middle_name, b.last_name, b.suffix, 'current', false, b.email, b.phone, b.phone_alt, b.address,
    b.city, b.state, b.zip, b.birth_date, b.crossing_date, b.initiation_chapter, b.emergency_contact_name,
    b.emergency_contact_phone, b.share_contact, b.greetings, true)
  returning * into b;
  return cal_private.dir_private_json(b);
end;
$$;

-- A brother updates his own record.
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
      emergency_contact_name = b.emergency_contact_name, emergency_contact_phone = b.emergency_contact_phone,
      share_contact = b.share_contact, greetings = b.greetings
  where id = cur.id
  returning * into b;
  return cal_private.dir_private_json(b);
end;
$$;

-- ---------------------------------------------------------------------------
-- Media team
-- ---------------------------------------------------------------------------

-- Adds (p_id null) or edits a brother.
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
      zip, birth_date, crossing_date, initiation_chapter, emergency_contact_name, emergency_contact_phone, share_contact,
      greetings, pending, notes)
    values (
      b.first_name, b.middle_name, b.last_name, b.suffix, b.status, b.life_member, b.active, b.email, b.phone, b.phone_alt,
      b.address, b.city, b.state, b.zip, b.birth_date, b.crossing_date, b.initiation_chapter, b.emergency_contact_name,
      b.emergency_contact_phone, b.share_contact, b.greetings, b.pending, b.notes)
    returning * into b;
  else
    update public.dir_brothers
    set first_name = b.first_name, middle_name = b.middle_name, last_name = b.last_name, suffix = b.suffix, status = b.status,
        life_member = b.life_member, active = b.active, email = b.email, phone = b.phone, phone_alt = b.phone_alt,
        address = b.address, city = b.city, state = b.state, zip = b.zip, birth_date = b.birth_date,
        crossing_date = b.crossing_date, initiation_chapter = b.initiation_chapter,
        emergency_contact_name = b.emergency_contact_name, emergency_contact_phone = b.emergency_contact_phone,
        share_contact = b.share_contact, greetings = b.greetings, pending = b.pending, notes = b.notes
    where id = p_id
    returning * into b;
  end if;
  return cal_private.dir_private_json(b);
end;
$$;

create or replace function public.dir_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  delete from public.dir_brothers where id = p_id;
  if not found then
    raise exception 'That record is no longer in the directory.';
  end if;
end;
$$;

-- Links a record to a brother's sign-in (p_member_id null unlinks it).
create or replace function public.dir_link(p_id uuid, p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.dir_brothers;
begin
  perform cal_private.assert_staff();
  if p_member_id is not null and not exists (select 1 from public.cal_members m where m.id = p_member_id) then
    raise exception 'That sign-in no longer exists.';
  end if;
  if p_member_id is not null and exists (select 1 from public.dir_brothers x where x.member_id = p_member_id and x.id <> p_id) then
    raise exception 'That sign-in is already linked to another record. Unlink it there first.';
  end if;
  update public.dir_brothers set member_id = p_member_id where id = p_id returning * into b;
  if not found then
    raise exception 'That record is no longer in the directory.';
  end if;
  return cal_private.dir_private_json(b);
end;
$$;

-- Imports rows from a spreadsheet: [{first_name, last_name, ...}]. A row whose first name, last
-- name, and suffix match an existing record updates the fields it carries; the rest are added.
-- Returns {added, updated}.
create or replace function public.dir_import(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  cur public.dir_brothers;
  b public.dir_brothers;
  v_added int := 0;
  v_updated int := 0;
  v_n int := 0;
begin
  perform cal_private.assert_staff();
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Nothing to import.';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception 'Import at most 1,000 rows at a time.';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1;
    begin
      select * into cur from public.dir_brothers x
      where lower(x.first_name) = lower(cal_private.clean(r ->> 'first_name'))
        and lower(x.last_name) = lower(cal_private.clean(r ->> 'last_name'))
        and lower(coalesce(x.suffix, '')) = lower(coalesce(cal_private.clean(r ->> 'suffix'), ''))
      order by x.created_at limit 1;
      if found then
        -- The names matched, so the record keeps its own spelling and capitalization.
        perform public.dir_save(cur.id, r - 'first_name' - 'last_name' - 'suffix');
        v_updated := v_updated + 1;
      else
        perform public.dir_save(null, r);
        v_added := v_added + 1;
      end if;
    exception when others then
      raise exception 'Row %: %', v_n, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('added', v_added, 'updated', v_updated);
end;
$$;

-- Greeting settings: switches, sender, and the subject and text of each message.
create or replace function public.dir_set_settings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  k text;
  v text;
begin
  perform cal_private.assert_staff();
  for k in select * from jsonb_object_keys(coalesce(p, '{}'::jsonb)) loop
    v := nullif(trim(coalesce(p ->> k, '')), '');
    if k in ('greetings_on', 'digest_on') then
      insert into cal_private.config (key, value)
      values ('dir_' || replace(k, '_on', ''), case when (p ->> k)::boolean then 'on' else 'off' end)
      on conflict (key) do update set value = excluded.value;
    elsif k in ('birthday_subject', 'birthday_text', 'anniversary_subject', 'anniversary_text') then
      if v is null or v = cal_private.dir_default(k) then
        delete from cal_private.config where key = 'dir_' || k;
      else
        if char_length(v) > 4000 then
          raise exception 'Keep each message under 4,000 characters.';
        end if;
        insert into cal_private.config (key, value) values ('dir_' || k, v)
        on conflict (key) do update set value = excluded.value;
      end if;
    elsif k = 'from' then
      if v is null then
        delete from cal_private.config where key = 'dir_email_from';
      elsif v !~ '^([^<>@]+<)?[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>?$' or (v ~ '<') <> (v ~ '>$') then
        raise exception 'Use a sender like Gamma Iota Lambda <brothers@mail.gil1906.org>.';
      else
        insert into cal_private.config (key, value) values ('dir_email_from', v)
        on conflict (key) do update set value = excluded.value;
      end if;
    else
      raise exception 'Unknown setting: %', k;
    end if;
  end loop;
  return public.dir_settings();
end;
$$;

-- ---------------------------------------------------------------------------
-- Greetings: rendering, sending, the morning run
-- ---------------------------------------------------------------------------

create or replace function cal_private.dir_render(p_template text, b public.dir_brothers, p_day date)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_years int := cal_private.dir_years(b.crossing_date, p_day);
  t text := coalesce(p_template, '');
begin
  t := replace(t, '{first_name}', b.first_name);
  t := replace(t, '{name}', cal_private.dir_full_name(b));
  t := replace(t, '{years}', coalesce(v_years::text, ''));
  t := replace(t, '{years_text}', case when v_years is null then '' when v_years = 1 then '1 year' else v_years || ' years' end);
  t := replace(t, '{ordinal}', coalesce(cal_private.dir_ordinal(v_years), ''));
  t := replace(t, '{crossing_year}', coalesce(to_char(b.crossing_date, 'YYYY'), ''));
  t := replace(t, '{date}', to_char(p_day, 'FMMonth FMDD, YYYY'));
  return t;
end;
$$;

-- A short branded HTML version of a plain-text message: black and old gold, Georgia and system sans.
create or replace function cal_private.dir_html_email(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f6f5f1;font-family:Georgia,''Times New Roman'',serif;color:#17150f">'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f1;padding:24px 0"><tr><td align="center">'
    || '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e3ded1;border-radius:12px;overflow:hidden">'
    || '<tr><td style="background:#0a0a0a;padding:22px 28px;border-bottom:3px solid #cfb53b">'
    || '<div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#cfb53b">Alpha Phi Alpha Fraternity, Inc.</div>'
    || '<div style="font-size:24px;line-height:1.2;color:#ffffff;margin-top:6px">Gamma Iota Lambda Chapter</div>'
    || '<div style="font-family:Helvetica,Arial,sans-serif;font-size:12.5px;color:#cbc3b0;margin-top:4px">The Brooklyn Alphas &middot; Chartered 1945</div>'
    || '</td></tr>'
    || '<tr><td style="padding:28px 28px 8px;font-size:17px;line-height:1.6">'
    || '<p style="margin:0 0 16px">' || replace(regexp_replace(cal_private.dir_html(p_text), E'\n\n+', '</p><p style="margin:0 0 16px">', 'g'), E'\n', '<br>') || '</p>'
    || '</td></tr>'
    || '<tr><td style="padding:8px 28px 26px;font-family:Helvetica,Arial,sans-serif;font-size:12.5px;line-height:1.5;color:#5d5747;border-top:1px solid #e3ded1">'
    || 'You get this because you are in the chapter directory at <a href="https://www.gil1906.org/directory" style="color:#7a640e">gil1906.org/directory</a>, where you can update your details or turn these messages off.'
    || '</td></tr></table></td></tr></table></body></html>'
$$;

-- Sends one email through Resend. Returns the pg_net request id, or null when email isn't set up.
create or replace function cal_private.dir_send_email(p_to text[], p_subject text, p_text text, p_html text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_from text;
  v_body jsonb;
begin
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'calendar_resend_api_key' limit 1;
  v_from := cal_private.dir_config('dir_email_from', cal_private.dir_config('email_from'));
  if coalesce(v_key, '') = '' or coalesce(v_from, '') = '' or p_to is null or cardinality(p_to) = 0 then
    return null;
  end if;
  v_body := jsonb_build_object('from', v_from, 'to', to_jsonb(p_to), 'subject', p_subject, 'text', p_text);
  if p_html is not null then
    v_body := v_body || jsonb_build_object('html', p_html);
  end if;
  return net.http_post(
    url := 'https://api.resend.com/emails',
    body := v_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    timeout_milliseconds := 10000
  );
end;
$$;

-- Who has a birthday or anniversary on a day. Deceased brothers are never listed.
create or replace function cal_private.dir_celebrations(p_day date)
returns table (brother public.dir_brothers, kind text, years int)
language sql
stable
set search_path = ''
as $$
  select b, 'birthday', null::int
  from public.dir_brothers b
  where b.status <> 'deceased' and cal_private.dir_same_day(b.birth_date, p_day)
  union all
  select b, 'anniversary', cal_private.dir_years(b.crossing_date, p_day)
  from public.dir_brothers b
  where b.status <> 'deceased' and cal_private.dir_same_day(b.crossing_date, p_day)
    and cal_private.dir_years(b.crossing_date, p_day) >= 1
  order by 2, 1
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
      v_req := cal_private.dir_send_email(array[(c.brother).email], v_subject, v_text, cal_private.dir_html_email(v_text));
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
      v_req := cal_private.dir_send_email(v_team, v_subject, v_text, cal_private.dir_html_email(v_text));
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

-- The media team runs today's greetings by hand (for example after turning them on late in the day).
create or replace function public.dir_run_now()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform cal_private.assert_staff();
  return cal_private.dir_run_greetings();
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
  v_req := cal_private.dir_send_email(array[v_email], '[Test] ' || v_subject, v_text, cal_private.dir_html_email(v_text));
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

-- What a message will say, without sending it.
create or replace function public.dir_preview(p_kind text, p_subject text, p_text text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b public.dir_brothers;
begin
  perform cal_private.assert_staff();
  b.first_name := 'Charles';
  b.last_name := 'Wesley';
  b.crossing_date := cal_private.today() - interval '10 years';
  b.birth_date := cal_private.today() - interval '35 years';
  return jsonb_build_object(
    'subject', cal_private.dir_render(coalesce(nullif(p_subject, ''), cal_private.dir_default(p_kind || '_subject')), b, cal_private.today()),
    'text', cal_private.dir_render(coalesce(nullif(p_text, ''), cal_private.dir_default(p_kind || '_text')), b, cal_private.today()));
end;
$$;

-- ---------------------------------------------------------------------------
-- Schedule: every morning at 12:35 UTC (8:35 a.m. New York in summer, 7:35 in winter).
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('gil-directory-greetings', '35 12 * * *', $job$select cal_private.dir_run_greetings()$job$);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on public.dir_brothers, public.dir_messages from anon, authenticated;
grant select on public.dir_brothers, public.dir_messages to authenticated;
grant all on public.dir_brothers, public.dir_messages to service_role;

revoke execute on function
  cal_private.dir_digits(text), cal_private.dir_years(date, date), cal_private.dir_same_day(date, date), cal_private.dir_html(text),
  cal_private.dir_ordinal(int), cal_private.dir_full_name(public.dir_brothers), cal_private.dir_config(text, text),
  cal_private.dir_public_json(public.dir_brothers), cal_private.dir_private_json(public.dir_brothers), cal_private.dir_mine(),
  cal_private.dir_from_json(jsonb, public.dir_brothers, boolean), cal_private.dir_touch(), cal_private.dir_default(text),
  cal_private.dir_render(text, public.dir_brothers, date), cal_private.dir_html_email(text),
  cal_private.dir_send_email(text[], text, text, text), cal_private.dir_celebrations(date), cal_private.dir_run_greetings(date)
  from public, anon, authenticated;

revoke execute on function
  public.dir_settings(), public.dir_list(), public.dir_me(), public.dir_claim(uuid, text), public.dir_add_self(jsonb),
  public.dir_update_me(jsonb), public.dir_save(uuid, jsonb), public.dir_delete(uuid), public.dir_link(uuid, uuid),
  public.dir_import(jsonb), public.dir_set_settings(jsonb), public.dir_run_now(), public.dir_send_test(text),
  public.dir_preview(text, text, text)
  from public, anon;

grant execute on function public.dir_settings() to anon, authenticated;
grant execute on function
  public.dir_list(), public.dir_me(), public.dir_claim(uuid, text), public.dir_add_self(jsonb), public.dir_update_me(jsonb),
  public.dir_save(uuid, jsonb), public.dir_delete(uuid), public.dir_link(uuid, uuid), public.dir_import(jsonb),
  public.dir_set_settings(jsonb), public.dir_run_now(), public.dir_send_test(text), public.dir_preview(text, text, text)
  to authenticated;
