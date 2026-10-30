-- Brother directory: check the greetings setup, and run today's by hand if you want to.
-- Run in the Supabase SQL Editor after migrations/20261030000100_brother_directory.sql.

-- 1. The schedule. Expect gil-directory-greetings at 35 12 * * * (12:35 UTC each day), active.
select jobname, schedule, active from cron.job where jobname = 'gil-directory-greetings';

-- 2. Email. ready is true once setup/2-request-emails.sql has run.
select exists (select 1 from vault.decrypted_secrets where name = 'calendar_resend_api_key') as key_saved,
       coalesce((select value from cal_private.config where key = 'dir_email_from'),
                (select value from cal_private.config where key = 'email_from')) as sender;

-- 3. The next 30 days of celebrations, with whether an email will go out.
select d as day, c.kind, cal_private.dir_full_name(c.brother) as brother, c.years,
       case when (c.brother).email is null then 'no email on file'
            when not (c.brother).greetings then 'asked for no email'
            else 'email goes out' end as email
from generate_series(cal_private.today(), cal_private.today() + 30, interval '1 day') as g(d)
cross join lateral cal_private.dir_celebrations(g.d::date) as c
order by d, c.kind, brother;

-- 4. Optional: run today's greetings now. Safe to repeat; nothing goes out twice.
-- select cal_private.dir_run_greetings();

-- 5. What went out.
select kind, day, sent_to, subject, sent_at from public.dir_messages order by sent_at desc limit 20;
