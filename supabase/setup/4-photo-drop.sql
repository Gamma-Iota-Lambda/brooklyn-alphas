-- School Daze photo drop: the three codes, and the switches.
-- Run in the Supabase SQL Editor after migrations/20261118000100_photo_drop.sql.

-- 1. The codes. Replace all three phrases, then run these three lines once. Case and extra spaces
--    don't matter when a code is typed. Each of the three must be different.
--
-- Upload code: it goes at the end of the link in the ticket email, after ?k= (the link ends
--   school-daze/photos.html?k= and then the code). Everyone with a ticket has it. At least
--   8 characters; letters, numbers, and dashes only, because it travels inside a link.
-- Review code: the organizers type it on school-daze/review.html. It lets a person see every
--   photo with its sender's name and email, approve, and delete. Keep it to the organizers.
--   At least 12 characters.
-- Screen code: for the venue's computer, on school-daze/screen.html. It shows approved photos and
--   nothing else. At least 12 characters. If it will go in the link (screen.html#c=...), use
--   letters, numbers, and dashes only.
--
-- Run a line again any time to change that code. The old code stops working at once, so a new
-- upload code means a new link for ticket buyers.

select cal_private.drop_set_code('upload', 'REPLACE WITH THE CODE FOR THE EMAIL LINK');
select cal_private.drop_set_code('review', 'REPLACE WITH A LONG PHRASE ONLY THE ORGANIZERS KNOW');
select cal_private.drop_set_code('screen', 'REPLACE WITH A PHRASE FOR THE VENUE COMPUTER');

-- 2. Where things stand: open or closed, the deadline, the limits, and how much has come in.
--    state is open, closed (switched off, or past the deadline), or full (a limit is reached).
select cal_private.drop_state();

-- 3. How many photos are in each state, and how many different people sent them.
select status, count(*) as photos, count(distinct email) as people, pg_size_pretty(sum(bytes)) as size
from public.drop_photos group by status order by status;

-- The rest is optional. Take the two dashes off the front of a line to run it.

-- 4. Close uploads, or open them again. The organizers can also do this on the review page.
-- update cal_private.config set value = 'false' where key = 'drop_open';
-- update cal_private.config set value = 'true' where key = 'drop_open';

-- 5. Change the deadline. Uploads close at noon New York time on Saturday, Nov. 21 unless you
--    change it. Keep the -05:00 on the end: it says the time is New York's.
-- insert into cal_private.config (key, value) values ('drop_closes_at', '2026-11-21T15:00:00-05:00')
-- on conflict (key) do update set value = excluded.value;
--    Or no deadline at all (the switch in step 4 still works):
-- delete from cal_private.config where key = 'drop_closes_at';

-- 6. Change a limit. Whole numbers only.
--    drop_per_person: photos one email may send (5).
--    drop_max_photos: photos the chapter will take in all (600).
--    drop_max_bytes:  storage the photos may use, in bytes (750000000, which is 750 MB; the free
--                     Supabase plan holds 1 GB across the whole project).
--    drop_per_ip_day: photos one internet connection may send in a day (60). People on the same
--                     Wi-Fi share a connection. 0 turns this limit off: do that if guests see
--                     "Too many photos have come from this connection today."
-- update cal_private.config set value = '8' where key = 'drop_per_person';
-- update cal_private.config set value = '0' where key = 'drop_per_ip_day';

-- 7. How many different connections the photos of the last day came from. One connection with
--    nearly all of them, while people are sending from home, means the per-connection limit is
--    counting everyone together: turn it off as in step 6.
-- select ip_hash, count(*) as photos, count(distinct email) as people from public.drop_photos
-- where created_at > now() - interval '1 day' group by ip_hash order by photos desc limit 10;

-- After the party, remove every photo with Delete everything on the review page. It removes the
-- files as well as the rows. Deleting rows here would leave the files behind in Storage.
