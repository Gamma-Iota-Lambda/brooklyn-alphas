-- Brother directory: the greeting messages accept {last_name} alongside {first_name} and {name}.
-- Runs after 20261030000100_brother_directory.sql.

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
  t := replace(t, '{last_name}', b.last_name);
  t := replace(t, '{name}', cal_private.dir_full_name(b));
  t := replace(t, '{years}', coalesce(v_years::text, ''));
  t := replace(t, '{years_text}', case when v_years is null then '' when v_years = 1 then '1 year' else v_years || ' years' end);
  t := replace(t, '{ordinal}', coalesce(cal_private.dir_ordinal(v_years), ''));
  t := replace(t, '{crossing_year}', coalesce(to_char(b.crossing_date, 'YYYY'), ''));
  t := replace(t, '{date}', to_char(p_day, 'FMMonth FMDD, YYYY'));
  return t;
end;
$$;
