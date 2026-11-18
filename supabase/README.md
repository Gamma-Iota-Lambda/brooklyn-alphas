# Content calendar: Supabase setup

`calendar.html` (www.gil1906.org/calendar) is the media team's content calendar for the 2026-2027 fraternal year. Brothers see what's coming up there, and committee chairs request posts. It runs in one of two modes:

- **Demo**, while `assets/calendar/config.js` is empty. The page uses sample data saved only in each visitor's browser, with a switch to view it as the media team, a committee chair, a brother, or a visitor. Files attached in the demo stay in that browser tab. Safe to merge and preview.
- **Live**, once `config.js` has a Supabase project's address and key. Posts, requests, and request files live in that project, and everyone sees the same calendar.

The live project is **GIL Content Calendar** in the Gamma Iota Lambda organization on Supabase (East US, reference `uqfoifrpyysqjvwtkgia`).

This folder holds everything the live mode needs:

| File | What it does |
|---|---|
| `migrations/20261013000100_content_calendar.sql` | Tables, access rules, and the functions brothers write through |
| `migrations/20261013000200_chairs_and_request_files.sql` | Committee chairs, request files and their private storage bucket, and no access for visitors |
| `migrations/20261014000100_request_emails.sql` | Emails the media team about each new request |
| `migrations/20261018000100_social_results.sql` | Instagram and Threads results: tables, matching, token storage, and the nightly schedule |
| `migrations/20261030000100_brother_directory.sql` | The brother directory (directory.html): records, who sees what, self-service edits, and the morning birthday and anniversary emails |
| `migrations/20261030000200_directory_last_name.sql` | `{last_name}` in the greeting messages |
| `migrations/20261030000300_directory_email_design.sql` | Greeting emails with the chapter crest and a heading |
| `migrations/20261031000100_directory_visiting_brothers.sql` | The Visiting standing and the public visiting-brother form |
| `migrations/20261114000100_social_sync_health.sql` | Results: an email to the media team when the numbers stop updating, and what Instagram or Threads sent with each error |
| `migrations/20261118000100_photo_drop.sql` | The School Daze photo drop (school-daze/): the photos table, its private storage bucket, the three codes, the limits, and the functions its Edge Function calls |
| `migrations/20261118000200_photo_drop_repeats.sql` | Photo drop: a photo sent twice is kept once, the slideshow takes the screen code only, and the per-connection limit starts turned off |
| `migrations/20261118000300_photo_drop_review_order.sql` | Photo drop: Approve and Reject apply to waiting photos only, Delete takes only rejected ones, and a send that was cut off stops holding up its photo after 2 minutes |
| `seed.sql` | The 128 planned posts for October 2026 to August 2027 |
| `setup/1-codes.sql` | Sets the chapter code and the media code |
| `setup/2-request-emails.sql` | Saves the Resend API key that request emails and directory greetings use |
| `setup/3-directory-greetings.sql` | Checks the directory's greetings setup and runs today's by hand |
| `setup/4-photo-drop.sql` | Sets the photo drop's three codes, and shows how to check on it and change its deadline and limits |
| `functions/calendar-social/` | The Edge Function that connects Instagram and Threads and brings in their numbers each night |
| `functions/photo-drop/` | The Edge Function behind the three School Daze pages: it takes in the photos, serves the organizers' review page, and feeds the slideshow |

## Who can do what

- **Visitors** see a sign-in prompt and nothing else.
- **Brothers** sign in once with the chapter code, their name, and a PIN of 4 to 6 digits. They view the whole calendar, including captions and notes. On another phone or computer they sign in with their name and PIN. A name stays signed in on one device at a time.
- **Committee chairs** are brothers the media team has marked as chairs. They sign in the same way. They also see the request queue, send post requests with photos, videos, or PDFs attached, and edit their own requests until the media team reviews them. Every request comes from a chair.
- **The media team** signs in with an email and password, then enters the media code once. They add and edit posts, review requests, open request files, choose the chairs, reset PINs, and remove brothers.

The database enforces all of this, down to who can open each file. The page only shows what the database allows.

The home page's top menu has a **Sign in** button, in the phone menu too, that opens the calendar's sign-in.

## Request files

Chairs attach files in the request form: up to 10 per request, 50 MB each, as photos, videos, or PDFs. For more or larger files, they share a Google Drive link in the same form.

- Files go to the private `calendar-files` bucket, which the second migration creates. Each chair's files sit in his own folder, `requests/<his member id>/`.
- Only the chair who sent a file and the media team can open it. The page opens files through links that last an hour.
- When a chair removes a file from his request and saves, the file is deleted.
- The Free plan includes 1 GB of file storage, enough for a few hundred photos or a few dozen short videos. To make room, open Storage in the Supabase dashboard, then `calendar-files`, and delete files from posts that have already gone out. The dashboard shows when each file was added. A request whose files are gone lists them as no longer available. The School Daze photos count toward the same 1 GB until they are deleted; see Photo drop below.

## Request emails

Each new request sends an email to everyone with a media team login: the title, the chair and committee, the requested post and event dates, the format and platforms, how many files are attached, the details, and a link to Requests. A request due in less than three weeks is marked as short notice. A media team member who sends a request himself isn't emailed about it. Edits and reviews don't send email.

The database sends them through [Resend](https://resend.com), using Supabase's pg_net extension. Sending happens after the request is saved, in the background, so a slow or failed email never holds up a chair. Resend's free plan covers 3,000 emails a month and 100 a day.

Setup, once:

1. **Resend account and domain.** At resend.com, create a free account. Under Domains, add `mail.gil1906.org` and add the DNS records Resend lists at Namecheap (Domain List, then gil1906.org, then Manage, then Advanced DNS). Its MX record needs Mail Settings set to Custom MX. Then choose Verify in Resend.
2. **API key.** In Resend, create an API key with sending access to `mail.gil1906.org`.
3. **Run the SQL.** In SQL Editor, run `migrations/20261014000100_request_emails.sql`, then `setup/2-request-emails.sql` with the key pasted between the quotes. The key goes into Supabase Vault, encrypted, and never into the repository or the page.
4. **Send a test.** In SQL Editor, run `select cal_private.email_media_team('Test from the content calendar', 'Request emails are working.');`. Everyone on the media team should get it within a minute. If it doesn't arrive, run `select status_code, content, error_msg from net._http_response order by created desc limit 1;` to see Resend's answer.

Later:

- **New key or sender:** run `setup/2-request-emails.sql` again. A sender other than `calendar@mail.gil1906.org` goes in as a second value, and Resend has to have verified its domain.
- **Turn the emails off:** run `delete from cal_private.config where key = 'email_from';`. Running `setup/2-request-emails.sql` again turns them back on.
- **Who gets them:** the media team list in Manage access. Adding or removing someone from the media team changes the emails too.

## Instagram and Threads results

The Results tab, for the media team only, shows how posts do on Instagram and Threads: posts, views, interactions, and followers, followers over time, planned posts against what went out each month, average views by category, format, and national program, top posts, and posts still to match. Each calendar post's panel also shows its numbers.

- **How it works.** The media team connects @gil1906 once from the Results tab. The `calendar-social` Edge Function handles the sign-in with Instagram or Threads, keeps each 60-day access token in Supabase Vault, and renews it every week. Every night at 4:20 a.m. New York time (3:20 in winter), pg_cron asks the function to sync. It brings in each post from the last 400 days with its views, reach, likes, comments, shares, and saves (on Threads, replies, reposts, and quotes), and each account's follower count. Posts from the last 60 days get fresh numbers every night; older ones on Sundays. Refresh now on the Results tab asks for a sync sooner, once every 10 minutes at most.
- **Matching.** A platform post matches a calendar post by date, in New York time, when exactly one post went out on that platform that day and exactly one calendar post that day lists the platform. Stories and skipped posts don't count, since Instagram doesn't share stories after a day. The media team matches the rest by hand under Not matched yet, or marks a post as not on the calendar. Hand matches stay; moving or deleting a calendar post updates date matches right away.
- **Who sees it.** Only the media team can read the results. The tokens stay in Vault, and only the database and the Edge Function use them.

Setup, once:

1. **Meta developer apps.** At developers.facebook.com, signed in with a Facebook account, create two apps. Both stay in Development mode, which covers accounts with a role on the app and needs no app review.
   - **Instagram:** a Business app. Choose Add Product, then Instagram, then Set up. Under Instagram, then API setup with Instagram login, then Set up Instagram business login, open Business login settings and enter the three addresses below. The **Instagram app ID** and **Instagram app secret** are on that screen; they differ from the app ID at the top of the page.
   - **Threads:** an app with the Access the Threads API use case. Under Use cases, Customize, add the `threads_manage_insights` permission and enter the three addresses. The **Threads app ID** and **Threads app secret** are under App settings, then Basic.
   - The addresses: OAuth or redirect callback `https://uqfoifrpyysqjvwtkgia.supabase.co/functions/v1/calendar-social/callback`; deauthorize or uninstall `.../calendar-social/uninstall`; data deletion `.../calendar-social/delete`.
   - In each app, under App roles, then Roles, add `gil1906` as an Instagram Tester or a Threads Tester. Accept on instagram.com as gil1906 (Settings, then Apps and websites, then Tester invites) and in Threads as gil1906 (Settings, then Account, then Website permissions, then Invites).
2. **Run the SQL.** In SQL Editor, run `migrations/20261018000100_social_results.sql`, then `migrations/20261114000100_social_sync_health.sql`. The first turns on pg_cron and schedules the nightly sync; the second schedules the morning check that emails the media team when the numbers stop updating. On a project that already sends request emails, the first file also moves pg_net into the extensions schema, which clears a Security Advisor warning; SQL Editor asks you to confirm that step, so choose Run this query.
3. **Deploy the Edge Function** `functions/calendar-social` with JWT verification off. Browsers reach its sign-in steps and pg_cron reaches its sync without a Supabase session; a one-time Connect code and a shared key in Vault protect them. With the Supabase CLI: `supabase functions deploy calendar-social --no-verify-jwt`.
4. **Add its secrets** in the Supabase dashboard under Edge Functions, then Secrets: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `THREADS_APP_ID`, and `THREADS_APP_SECRET`. The function also reads `SUPABASE_URL` and `SUPABASE_DB_URL`, which every project has.
5. **Connect.** On the calendar, open Results and choose Connect Instagram. Instagram asks for the gil1906 password, then for permission, and sends you back to Results. For Threads, sign in to threads.com as gil1906 in the same browser first, then choose Connect Threads. The first sync takes a minute or two.

Day to day:

- **Needs attention:** a connection that has to be signed in again, for example after a password change or once its sign-in has run out, shows Needs attention and a Reconnect button.
- **Not updating:** when a sync saves nothing, the account's card shows Not updating, the day its numbers were last updated, when the last try was, and the reason. Once the numbers are two days old the tab says so across the top. See When the numbers stop updating, below.
- **The email:** every morning at 9:10 UTC, pg_cron runs `cal_private.social_health_check()`. Once a connected account has gone two days without a sync that saved, everyone with a media team login gets one email listing each stuck account: when it last updated, the latest note, what Instagram or Threads sent with the error, and when its sign-in runs out. It comes again each week while it lasts. It uses the same Resend setup as request emails, and stays off until that is set. If the email can't be handed over for sending, the run shows as failed in `cron.job_run_details` (Integrations, then Cron, in the dashboard), and the next morning tries again. Once it is handed over the account counts as told for the week, whatever Resend then does with it, so if no email arrives, check Resend's dashboard or the `net._http_response` query below within a few hours of 9:10 UTC.
- **A wrong match:** open the post from Top posts or from the calendar post's panel, pick the right calendar post, and choose Save match. Match by date instead undoes a hand match.
- **Disconnect:** Disconnect on the Results tab forgets the token. The numbers saved so far stay.
- **Check the nightly sync:** each account's card on the Results tab shows its last sync and any note. In SQL Editor, `select platform, last_sync_at, last_error, last_error_at, last_error_detail from public.cal_social_accounts;` shows the same, with what Instagram or Threads sent with the latest error. `last_sync_at` only moves when a sync saves. pg_cron's "succeeded" only means the request was sent. For a few hours afterwards, `select status_code, content from net._http_response order by created desc limit 3;` shows how the function answered: 202 means the request arrived and the sync started, not that it saved; 401 means the function was deployed with JWT verification on, so no sync runs at all. The function's logs are under Edge Functions, then calendar-social, then Logs; they keep one day. A failed sync, a failed renewal, a sync that stopped partway, and numbers a post couldn't report are each logged with the request, HTTP status, code, subcode, and trace.
- **Pause the nightly sync:** run `select cron.unschedule('gil-calendar-social-sync');`. The `cron.schedule` line at the end of the migration turns it back on.
- **Pause the email:** run `select cron.unschedule('gil-calendar-social-health');`. To turn it back on, run `select cron.schedule('gil-calendar-social-health', '10 9 * * *', 'select cal_private.social_health_check()');`.

### When the numbers stop updating

The account's card gives the reason. Whatever it is, leave the connection in place. Disconnect forgets the saved sign-in, a new one can be refused for the same reason, and the saved one picks up by itself once the problem clears. The numbers saved so far stay.

- **"... is refusing the calendar's requests (Meta says: API access blocked)".** Meta is turning away every request, whatever the sign-in, so Reconnect doesn't help. It did this from Oct. 20, 2026, the day after the accounts were first connected. Meta doesn't document the message. Going by other developers' reports, it lifts once one of these is cleared, most often the first:
  1. **The Facebook account that created the two Meta apps.** Sign in at facebook.com and clear any security check. Then open developers.facebook.com/apps and complete any "Account confirmation needed" step.
  2. **Each app** at developers.facebook.com/apps. Look for a banner, an alert, or a required action. Check that the app isn't archived or restricted, and that gil1906 is still a tester under App roles.
  3. **The gil1906 account.** In the Instagram app, open Settings, then Account Status, and clear any "confirm it's you" notice. Under Apps and websites, both apps should still be listed.

  Then choose Refresh now. The next sync renews the sign-in and brings in current numbers for posts from the last 60 days and for any published in the gap; older posts catch up on Sunday's sync. Daily follower counts for the missed days don't come back.
- **"... didn't answer" or "... asked the calendar to slow down".** The next night's sync tries again.
- **"Choose Reconnect".** The sign-in stopped working or ran out. Choose Reconnect and sign in as gil1906.
- **"The nightly sync hasn't brought in new numbers, and no error was recorded", or "Nothing has been tried since".** The nightly request isn't reaching the Edge Function, or the function isn't running, so Refresh now won't change anything either. Whatever older note is on the card, this comes first. Check the function's logs, the `net._http_response` query above, and that the function is deployed with JWT verification off. The email says "No note" or "Nothing has reported in since that note" for the same thing.
- **The sign-in's end date.** Each sign-in lasts 60 days and renews every week, but can't renew while Meta refuses requests. The card shows the date once it is under a month away, and the email does too. After that date the card shows Needs attention and a Reconnect button. Reconnect works once Meta takes requests again; until then it comes back with the same reason.
- **Asking Meta for help.** `last_error_detail` and the email carry the request, HTTP status, code, subcode, and trace Meta sent. Meta support asks for the trace.

## Brother directory

`directory.html` (www.gil1906.org/directory) is the chapter directory. It shares the calendar's Supabase project and sign-in: brothers use the chapter code, their name, and their PIN; the media team uses its email login. The fifth migration adds it.

**Getting there.** Brother Directory sits under Chapter in the site's menu on every page, phone menu included. Anyone can follow it; a visitor gets the sign-in prompt and the visiting-brother form, and nothing else. Once signed in, the calendar's top row has a Brother directory button and the directory's has Content calendar, since one sign-in covers both.

- **Who sees what.** Visitors see nothing. Brothers see every brother's name, standing, crossing date, birthday (month and day), chapter of initiation, and the phone, email, and city each brother chooses to share. Street addresses, birth years, emergency contacts, and notes are for the brother himself and the media team. The database enforces it; the page only shows what it is allowed to read.
- **Self-service.** Under My record, a brother picks his name and confirms it with the last four digits of the phone on file, then edits his own record. A brother with no record adds himself, marked for the media team to confirm. When a number changed or none is on file, the media team links the record to his sign-in under Manage.
- **Visiting brothers.** A brother from another chapter, or not yet affiliated, adds himself at `gil1906.org/directory#guest` with no sign-in: name, how to reach him, his chapters, dates, and a note. He arrives with the Visiting standing, marked Needs review, with his contact details unshared until the media team confirms him, and the media team gets an email. Visiting brothers get the greeting emails too, for reclamation. A second submission with the same email updates the first; one session can add three a day; a hidden field catches bots. Put the link or its QR code on the sign-in sheet at meetings.
- **Media team.** Add, edit, and remove records, import a CSV (the old chapter database's columns work as they are), download the directory as CSV, confirm brothers who added themselves, and manage the greetings.
- **Greetings.** Every day at 12:35 UTC (8:35 a.m. New York in summer, 7:35 in winter), pg_cron runs `cal_private.dir_run_greetings()`. Each brother with an email on file and greetings turned on gets a short branded email on his birthday and on the anniversary of his crossing. The media team gets an email the day before listing tomorrow's celebrations, including brothers with no email on file, so a post or a call can go out. Deceased brothers are never listed. `dir_messages` logs each send, one per brother, kind, and day, so a rerun never repeats one. The Messages tab holds the switches, the sender, the wording with placeholders, a preview, a test to yourself, and the log.

Setup, once:

1. **Run the SQL.** In SQL Editor, run the four directory migrations in order, starting with `migrations/20261030000100_brother_directory.sql`. They need the calendar's four migrations first.
2. **Load the roll.** Either import the cleaned spreadsheet as CSV under Manage on the page (signed in as the media team), or run the private import SQL in SQL Editor. Neither file lives in this repository: they hold brothers' phone numbers and addresses.
3. **Email.** Greetings use the Resend key the calendar already keeps in Vault (`setup/2-request-emails.sql`). The sender defaults to the calendar's; set a directory sender under Messages, for example `Gamma Iota Lambda <brothers@mail.gil1906.org>`. Any address at `mail.gil1906.org` works, since Resend verified the domain.
4. **Check it.** Run `setup/3-directory-greetings.sql` to see the schedule, the email setup, and the next 30 days of celebrations, and to run today's greetings by hand if you want to.

Day to day:

- **Ask brothers to claim their records.** The old spreadsheet had no emails and only a handful of real birthdates, so the greetings reach brothers only after they claim a record and add both.
- **Pause the greetings:** turn off Send greetings to brothers under Messages. `select cron.unschedule('gil-directory-greetings');` stops the job entirely; `select cron.schedule('gil-directory-greetings', '35 12 * * *', 'select cal_private.dir_run_greetings()');` turns it back on.
- **See what went out:** the Sent panel under Messages, or `select * from public.dir_messages order by sent_at desc limit 20;`. Resend's answers for the last few hours are in `select status_code, content from net._http_response order by created desc limit 5;`.
- **Remove a brother's data:** Remove on his record deletes it, his message log included.

## Photo drop

The three pages in `school-daze/` collect photos for School Daze, the chapter's party on Saturday, Nov. 21, 2026. Ticket buyers send photos from their college days on `photos.html`, the organizers approve them on `review.html`, and `screen.html` plays the approved ones on the venue's big screens. The pages share the calendar's Supabase project but not its sign-in: each page has a code of its own. The tenth and eleventh migrations add it. What each page does is under School Daze Photo Drop in the main [README](../README.md).

- **What it stores.** One row for each photo in `public.drop_photos`: the sender's name and email, the caption, the photo's size, what the page said about the file the person picked, where its files are, whether it is waiting, approved, or rejected, and who reviewed it and when. It also keeps a fingerprint of the photo (the SHA-256 of its bytes), which is how the same photo sent twice is noticed. The sender's internet address is kept only as a hash.
- **Where the files go.** The private `photo-drop` bucket, which the first of the two migrations creates: JPEG only, 8 MB a file. Each photo is at `photos/<id>.jpg`, with a small copy at `thumbs/<id>.jpg` for the review page and the slideshow's blurred background.
- **Settings.** Rows in `cal_private.config`, all starting `drop_`: the three codes, kept as bcrypt hashes (`drop_upload_code_hash`, `drop_review_code_hash`, `drop_screen_code_hash`); the open switch (`drop_open`); the deadline (`drop_closes_at`); the limits (`drop_per_person`, `drop_max_photos`, `drop_max_bytes`, `drop_per_ip_day`); and `drop_ip_salt`, a random value mixed into each address before it is hashed.
- **Who reaches it.** The pages talk only to the `photo-drop` Edge Function. The function connects as the database owner, the way `calendar-social` does, and the database checks the page's code on every request. The table has row level security and no policies, the bucket has no storage policies, and no API role can run the `cal_private.drop_` functions. The pages see photos through signed links that last 14 days. Opening the review page renews any that run out within 3 days. The slideshow gets approved photos and their captions, with no names or emails.
- **How a photo arrives.** The function reads the JPEG's real size from the file and works out its fingerprint. The database checks the code, whether this email has already sent this photo, whether uploads are open, what was typed, and every limit, and saves the row as `sending`. The function puts the files in the bucket, and the row becomes `waiting`. If Storage fails partway, the function takes the files back out and forgets the row, so the sender can try again. A send that never finished stops counting toward the limits after 15 minutes, and is removed the next time an organizer opens the review page.
- **A photo sent twice.** A phone can lose the answer to a photo that did arrive, and the guest then taps Try again. The same photo from the same email is answered as received, stored once, and counted once. If the first copy is still on its way in, the answer is "That photo is still on its way in. Give it a minute, then try again."

Setup, once:

1. **Run the SQL.** In SQL Editor, run `migrations/20261118000100_photo_drop.sql`, then `migrations/20261118000200_photo_drop_repeats.sql`, then `migrations/20261118000300_photo_drop_review_order.sql`. They run after the nine migrations before them. The first creates the table, the bucket, and the settings, with uploads open until noon New York time on Saturday, Nov. 21. The second adds the fingerprint, makes the slideshow take the screen code only, and turns the per-connection limit off. Run both before deploying the Edge Function.
2. **Set the three codes.** In `setup/4-photo-drop.sql`, replace the three placeholder phrases and run the three `drop_set_code` lines. Each code must be different, and 72 characters at most. Case and extra spaces don't matter when a code is typed. Make the review and screen codes random, not a phrase someone could guess from the event's name: nothing counts wrong guesses.
   - **Upload code:** at least 8 characters. Letters, numbers, and dashes only, because it travels inside a link. Everyone with a ticket has it.
   - **Review code:** at least 12 characters. It shows every photo with its sender's name and email, and it deletes. Keep it to the organizers.
   - **Screen code:** at least 12 characters. Letters, numbers, and dashes only if it will go in the link. It shows approved photos and nothing else, and it is the only code the slideshow takes. Never type the review code on the venue's computer, which keeps the code it is given.
3. **Deploy the Edge Function** `functions/photo-drop` with JWT verification off: `supabase functions deploy photo-drop --no-verify-jwt`. The three pages have no Supabase session. Each sends its own code, and the database checks it on every request.
4. **No secrets to add.** The function reads `SUPABASE_URL`, `SUPABASE_DB_URL`, and the project's secret key for Storage (`SUPABASE_SECRET_KEYS`, or `SUPABASE_SERVICE_ROLE_KEY` on an older project). Every project already has them.
5. **Check it.** Run `select cal_private.drop_state();`. Its `state` should be `open`. Open the upload link below with your code and send a test photo. On the review page, choose Review on its card and Approve in the full view. Open the slideshow with the screen code and watch the photo come up. To remove the test photo, choose Back to waiting, then Reject, then Delete on the Rejected tab.

The pages find the project through `assets/calendar/config.js`, which the calendar's go-live filled in. While that file is empty, each page says "This page isn't set up yet."

The links to hand out, with `CODE` replaced by the code:

| Link | Who gets it |
|---|---|
| `https://www.gil1906.org/school-daze/photos.html?k=CODE` | Ticket buyers, in the ticket email. `CODE` is the upload code. |
| `https://www.gil1906.org/school-daze/review.html` | The organizers. Tell them the review code privately. Each types it once, with their name, on each phone or laptop. |
| `https://www.gil1906.org/school-daze/screen.html#c=CODE` | The venue's computer. `CODE` is the screen code, the only code the slideshow takes. The computer keeps it after the first time. |

Before the party, open `https://www.gil1906.org/school-daze/screen.html?demo=1` on the venue's computer. It plays six test pictures with no code, so the screens can be checked before any photo is approved.

Day to day:

- **Close or reopen uploads:** the switch under Uploads on the review page. In SQL Editor, `update cal_private.config set value = 'false' where key = 'drop_open';` closes them, and `'true'` opens them again.
- **Change the deadline:** under Uploads on the review page, choose a date and time and Save, or choose No deadline. The field is in the organizer's own time zone, which the page names. In SQL Editor, step 5 of `setup/4-photo-drop.sql` sets a new time. Keep the `-05:00` on the end: it says the time is New York's. `delete from cal_private.config where key = 'drop_closes_at';` removes the deadline, and the switch still works.
- **Change the per-person limit:** `update cal_private.config set value = '8' where key = 'drop_per_person';`. It starts at 5. Every photo an email has sent counts, whatever became of it, until the photo is deleted.
- **Change the totals:** the same line with `drop_max_photos` (600 to start) or `drop_max_bytes` (750000000 to start, which is 750 MB). Read Storage, below, first.
- **The per-connection limit:** `drop_per_ip_day` is how many photos one internet connection may send in a day. It starts at `0`, which is off. Step 7 of `setup/4-photo-drop.sql` shows how many connections the last day's photos came from. Turn the limit on only when photos sent from different places show different connections there, for example one from a phone on mobile data and one from a computer on Wi-Fi: `update cal_private.config set value = '60' where key = 'drop_per_ip_day';`. If nearly all of them show one connection, Supabase is reporting a shared address and the limit would count everyone together, so leave it off. People on the same Wi-Fi share a connection, so set it back to `0` if guests see "Too many photos have come from this connection today."
- **Whole numbers only:** a limit set to anything else counts as its starting value.
- **A new code:** run its `drop_set_code` line in `setup/4-photo-drop.sql` again. The old code stops working at once, so a new upload code means a new link for ticket buyers.
- **Storage:** the Free plan includes 1 GB of file storage for the whole project, and the calendar's request files in `calendar-files` count toward the same 1 GB. The 750 MB limit keeps the photos and their small copies from filling it. It leaves about 250 MB for request files and keeps the project inside its plan. Supabase can restrict a project that stays over its plan, and that would reach the calendar and the directory too. The 600-photo limit caps the count however small the files are, which also caps how much there is to review. Whichever limit comes first, the upload page says "We have all the photos we can take" and the review page shows Full. Rejected photos count until they are deleted, so Delete on the Rejected tab makes room. Before raising `drop_max_bytes`, check under Storage in the Supabase dashboard how much `calendar-files` holds.
- **Check on it:** `select cal_private.drop_state();` shows whether uploads are open, closed (switched off, or past the deadline), or full, with the deadline, the limits, and the photos and bytes so far. `select status, count(*) as photos, count(distinct email) as people, pg_size_pretty(sum(bytes)) as size from public.drop_photos group by status order by status;` shows how many photos are waiting, approved, and rejected, and how many people sent them. The top line of the review page shows the same totals. The function's logs are under Edge Functions, then photo-drop, then Logs. Each line starts `photo-drop:` and names a photo by its id, never by a code, a name, an email, a caption, or a signed link.
- **A photo that is too large is refused slowly, on purpose:** the function reads every upload to its end before it answers, even one too large to use. On Supabase, an answer sent while an upload is still arriving can hang or be lost on the sender's side. It showed up with anything past about 100 KB. So an upload over 7.5 MB is read through and then refused, and the upload page sends a smaller copy once by itself. Past 40 MB the function stops reading. Keep this when changing `drop.js`: `readBody` does it, and a test covers it.

### After the party

Once the party is over, delete everything. Guests sent these photos, with their names and emails, for one night, and they should not sit in the chapter's storage after it. Deleting also gives the storage back to the calendar's request files.

1. **Check that uploads are closed.** They close by themselves at the deadline. If the deadline was removed, turn the switch off under Uploads, so nothing new arrives afterwards.
2. **Keep the approved photos, if the chapter wants them.** On the review page, open Tools and choose Download approved photos. It saves them to that device as ZIP files, a new one past 250 MB, with each photo named by its number and its sender's name. Guests agreed to their photos being shown on screen at School Daze, so ask before using one anywhere else.
3. **Delete everything.** In Tools, choose Delete everything and type DELETE. It removes every photo's files from the bucket, then the rows, with the names, emails, and captions in them. Then it clears any file left in the bucket that no row points to, apart from one under 10 minutes old, which could belong to a photo still arriving. The slideshow goes back to its title card. It can't be undone. If it stops partway, run it again: a row goes only after its files have. When the page says some leftover files couldn't be checked yet, choose Delete everything again in 10 minutes; it says "The drop is empty" once nothing is left.
4. **Check.** `select cal_private.drop_state();` should show `photos` at 0, and Storage, then `photo-drop`, in the Supabase dashboard should hold no files.

Don't delete the rows in SQL Editor instead: that leaves the files behind in Storage. To retire the links as well, set three new codes with `setup/4-photo-drop.sql`.

## Go live

Plan on about 30 minutes.

1. **Create a Supabase project.** At [supabase.com](https://supabase.com), choose New project. The Free plan works. Pick the East US region and save the database password somewhere safe. Use a project of its own for the calendar; it's the simplest setup. (To share the Alpha Academy Trading Floor's project instead, run the Trading Floor's migrations first, then the calendar's. Its first migration resets table permissions across the project and would undo the calendar's if it ran later.)
2. **Run the SQL.** In the project, open SQL Editor and run these files in order, pasting each into a new query:
   1. `migrations/20261013000100_content_calendar.sql`
   2. `migrations/20261013000200_chairs_and_request_files.sql`, which also creates the `calendar-files` bucket
   3. `migrations/20261014000100_request_emails.sql`
   4. `migrations/20261018000100_social_results.sql`
   5. `migrations/20261030000100_brother_directory.sql`
   6. `migrations/20261114000100_social_sync_health.sql`
   7. `seed.sql`
   8. `setup/1-codes.sql`, after replacing both placeholder phrases with your own. The chapter code is for every brother, so make it easy to say out loud. The media code is for the media team only, so make it a long phrase.

   A project that already ran some of these runs only the migrations it hasn't, in order. Posts, requests, brothers, and codes all stay. After the second migration, brothers start as viewers, so mark the chairs in Manage access. Request emails also need `setup/2-request-emails.sql`; see Request emails above. Results also need the Edge Function and its secrets; see Instagram and Threads results above. The School Daze photo drop has its own two migrations, setup file, and Edge Function; see Photo drop above.
3. **Turn on brother sign-in.** Under Authentication, open Sign In / Providers and turn on **Allow anonymous sign-ins**. Brothers don't create accounts; the chapter code and their PIN are their sign-in. Supabase allows 30 of these sign-ins per hour from one internet connection. Before a chapter meeting where many brothers sign in on the same Wi-Fi, raise that under Authentication, then Rate Limits.
4. **Make media team logins simple.** In the same Sign In / Providers section, open Email and turn off **Confirm email**. The media code already decides who joins the media team. (If you keep confirmation on, set the Site URL under Authentication, then URL Configuration, to `https://www.gil1906.org/calendar.html`, so the confirmation link brings people back to the calendar.)
5. **Connect the page.** Open the Connect button at the top of the project, or Project Settings, then API Keys. Copy the **Project URL** and the **publishable key** (it starts with `sb_publishable_`; the legacy `anon` key also works) into `assets/calendar/config.js`. Both are meant to be public. Never put a secret or `service_role` key in the page. Commit the change on a branch, open a pull request, and merge it; Vercel deploys in a minute or two.
6. **Sign in as the media team.** Open www.gil1906.org/calendar, choose Sign in, then Media team. Enter your email and a password of at least 8 characters, choose Create login, then enter your name and the media code. Each media team member does the same.
7. **Set up one chair and test.** Give a committee chair the chapter code. He chooses Sign in, then First time here, and sees the calendar. In Manage access, choose Make chair beside his name and pick his committee. Request a post appears for him the next time he opens the page, or within two minutes. Have him send a test request with a photo attached. Open it from Requests, check that the photo opens, and approve it. Check that the post shows on the calendar, then delete the test post, and the test photo under Storage.

Then share the link and the chapter code with the chapter. As each committee chair signs in, mark him as a chair in Manage access.

## Day to day

- **New chair:** Manage access, then Make chair beside his name, and pick the committee he chairs. He signs in once first, so his name is on the list.
- **A chair steps down:** Manage access, then Make viewer. He keeps viewing the calendar, and his past requests stay.
- **Forgotten PIN:** Manage access, then Reset PIN beside his name. Tell him the new PIN privately.
- **Five wrong PINs** lock a name for 10 minutes. A PIN reset unlocks it right away.
- **New chapter code:** Manage access, then Change code. Brothers already signed in stay signed in.
- **New media code:** run `setup/1-codes.sql` again with just the media line and a new phrase.
- **Removing a brother:** Manage access, then Remove. His requests and their files stay, with his name on them.
- **Removing someone from the media team:** in SQL Editor, run `delete from public.cal_staff where display_name = 'Their Name';`
- **A simple backup:** in Agenda, turn on Show earlier posts and download the spreadsheet. Request files stay in Storage, where you can download any you want to keep.
- **Free plan pauses:** Supabase pauses a free project after a week with no activity, which can happen over the summer. Restore it from the Supabase dashboard; nothing is lost. The Pro plan never pauses.
- **Facebook:** the platform list leaves Facebook out while the chapter has no access to it. To bring it back, add `{ key: 'facebook', label: 'Facebook' }` to `PLATFORMS` in `assets/calendar/data.js`. The database already accepts it.

## Changing the database later

Once a migration has run on the live project, leave that file alone. Put any change in a new file in `migrations/` with a later timestamp, run it in SQL Editor, and add tests for it. The page's lists of categories, formats, platforms, and statuses live in `assets/calendar/data.js`, and the database checks the same keys, so change both together. The same goes for the upload limits: `FILES` in `data.js` and the bucket settings at the end of the second migration.

## Tests

From the repository root:

```bash
npm install --no-save @electric-sql/pglite@0.5.8 playwright@1.56.0
npx playwright install chromium        # once
node --test "tests/calendar/*.test.mjs"  # 92 tests: access rules, sign-in, chairs, requests, files, review, upgrading, emails, results, the Edge Functions, the Results account states, the directory, the photo drop, and the site's menus
node tests/calendar/demo-smoke.mjs     # the demo in a real browser, at desktop and phone widths
node tests/calendar/live-smoke.mjs     # live mode against a local stand-in for Supabase
```

The database tests run the real migrations and seed in PGlite, Postgres compiled to WebAssembly, with a small stand-in for Supabase's sign-in, storage, Vault, pg_net, and pg_cron. The pg_net stand-in records each request instead of sending it. The Edge Function tests run `functions/calendar-social/social.js` in Node against the same database, with Instagram and Threads simulated by `tests/calendar/meta-sim.mjs`: sign-in, token renewal, the nightly sync, expired and rate-limited tokens, Meta refusing every request, and what the media team sees when something goes wrong. The live browser test runs the same database behind a local imitation of Supabase's Data API, sign-in, and file storage. It walks through a visitor, the media team, a brother who becomes a chair and sends files, and a brother on two devices. Then the media team connects Instagram and Threads through the real Edge Function, matches a post by hand, refreshes, sees Not updating while Meta refuses requests and Connected again once it stops, and disconnects. Add `SCREENSHOTS=some-folder` to either browser test to save screenshots.

The photo drop's tests work the same way. `photo-drop.test.mjs` runs its two migrations in PGlite: the three codes, every reason a photo is refused and the order they come in, a photo sent twice, the limits, closing by the switch and by the clock, review, the slideshow's list, and that no API role gets near any of it. `photo-drop-function.test.mjs` runs `functions/photo-drop/drop.js` in Node against the same database, with Storage simulated by `tests/calendar/storage-sim.mjs`: a full send, each refusal, a repeat, a Storage failure partway, the review actions, deleting and the sweep for leftover files, the slideshow's list, reading every upload to its end, and what never reaches the log. The three School Daze pages have no browser test here.
