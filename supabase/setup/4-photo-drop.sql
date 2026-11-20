-- School Daze photo drop: the three codes, and the switches.
-- Run in the Supabase SQL Editor after migrations/20261118000100_photo_drop.sql and
-- migrations/20261118000200_photo_drop_repeats.sql.

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
--   nothing else, and it is the only code the slideshow takes: never type the review code on the
--   venue's computer. At least 12 characters. If it will go in the link (screen.html#c=...), use
--   letters, numbers, and dashes only.
--
-- Make the review and screen codes random, not a phrase someone could guess from the event's
-- name: nothing counts wrong guesses.
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
--    drop_per_ip_day: photos one internet connection may send in a day. It starts at 0, which
--                     is off. Check step 7 before turning it on, and turn it off again if guests
--                     see "Too many photos have come from this connection today."
--    The committee's videos have limits of their own (migration 20261118000400):
--    drop_max_videos:        videos the show will take (40).
--    drop_video_total_bytes: storage the videos may use together, in bytes (209715200, which the
--                            pages show as 200 MB).
--    drop_video_max_bytes:   the most one video may be, in bytes (52428800, shown as 50 MB, which
--                            is also the most the free plan takes in one file). Storage goes by
--                            the bucket's own limit too, and by the project's global file size
--                            limit (Storage, then Settings, in the dashboard), so change them
--                            together:
--                            update storage.buckets set file_size_limit = 52428800 where id = 'photo-drop';
--    For School Daze the live project is on the Pro plan, with 5120 MB (5 GB) a video and
--    25600 MB (25 GB) together. A video over 2 GB needs
--    migrations/20261120000100_photo_drop_large_videos.sql to have run, and the global file size
--    limit set to 5 GB or more:
--    update storage.buckets set file_size_limit = 5368709120 where id = 'photo-drop';
--    update cal_private.config set value = '5368709120' where key = 'drop_video_max_bytes';
--    update cal_private.config set value = '26843545600' where key = 'drop_video_total_bytes';
-- update cal_private.config set value = '8' where key = 'drop_per_person';
-- update cal_private.config set value = '60' where key = 'drop_per_ip_day';

-- 7. How many different connections the photos of the last day came from. The per-connection
--    limit is only safe to turn on when photos sent from different places show different
--    connections here (send one from a phone on mobile data and one from a computer on Wi-Fi).
--    One connection with nearly all of them, while people are sending from home, means the
--    platform reports a shared address and the limit would count everyone together: leave it off.
-- select ip_hash, count(*) as photos, count(distinct email) as people from public.drop_photos
-- where created_at > now() - interval '1 day' group by ip_hash order by photos desc limit 10;

-- After the party, remove every photo with Delete everything on the review page. It removes the
-- files as well as the rows. Deleting rows here would leave the files behind in Storage.
