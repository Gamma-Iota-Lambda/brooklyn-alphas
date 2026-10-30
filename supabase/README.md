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
| `seed.sql` | The 128 planned posts for October 2026 to August 2027 |
| `setup/1-codes.sql` | Sets the chapter code and the media code |
| `setup/2-request-emails.sql` | Saves the Resend API key that request emails and directory greetings use |
| `setup/3-directory-greetings.sql` | Checks the directory's greetings setup and runs today's by hand |
| `functions/calendar-social/` | The Edge Function that connects Instagram and Threads and brings in their numbers each night |

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
- The Free plan includes 1 GB of file storage, enough for a few hundred photos or a few dozen short videos. To make room, open Storage in the Supabase dashboard, then `calendar-files`, and delete files from posts that have already gone out. The dashboard shows when each file was added. A request whose files are gone lists them as no longer available.

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
2. **Run the SQL.** In SQL Editor, run `migrations/20261018000100_social_results.sql`. It turns on pg_cron and schedules the nightly sync. On a project that already sends request emails, it also moves pg_net into the extensions schema, which clears a Security Advisor warning; SQL Editor asks you to confirm that step, so choose Run this query.
3. **Deploy the Edge Function** `functions/calendar-social` with JWT verification off. Browsers reach its sign-in steps and pg_cron reaches its sync without a Supabase session; a one-time Connect code and a shared key in Vault protect them. With the Supabase CLI: `supabase functions deploy calendar-social --no-verify-jwt`.
4. **Add its secrets** in the Supabase dashboard under Edge Functions, then Secrets: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `THREADS_APP_ID`, and `THREADS_APP_SECRET`. The function also reads `SUPABASE_URL` and `SUPABASE_DB_URL`, which every project has.
5. **Connect.** On the calendar, open Results and choose Connect Instagram. Instagram asks for the gil1906 password, then for permission, and sends you back to Results. For Threads, sign in to threads.com as gil1906 in the same browser first, then choose Connect Threads. The first sync takes a minute or two.

Day to day:

- **Needs attention:** a connection that stops working, for example after a password change, shows Needs attention and a Reconnect button.
- **A wrong match:** open the post from Top posts or from the calendar post's panel, pick the right calendar post, and choose Save match. Match by date instead undoes a hand match.
- **Disconnect:** Disconnect on the Results tab forgets the token. The numbers saved so far stay.
- **Check the nightly sync:** each account's last sync and any note show on the Results tab. In SQL Editor, `select status_code, content from net._http_response order by created desc limit 3;` shows the function's latest answers (202 means it started), and the function's logs are under Edge Functions, then calendar-social, then Logs.
- **Pause the nightly sync:** run `select cron.unschedule('gil-calendar-social-sync');`. The `cron.schedule` line at the end of the migration turns it back on.

## Brother directory

`directory.html` (www.gil1906.org/directory) is the chapter directory. It shares the calendar's Supabase project and sign-in: brothers use the chapter code, their name, and their PIN; the media team uses its email login. The fifth migration adds it.

- **Who sees what.** Visitors see nothing. Brothers see every brother's name, standing, crossing date, birthday (month and day), chapter of initiation, and the phone, email, and city each brother chooses to share. Street addresses, birth years, emergency contacts, and notes are for the brother himself and the media team. The database enforces it; the page only shows what it is allowed to read.
- **Self-service.** Under My record, a brother picks his name and confirms it with the last four digits of the phone on file, then edits his own record. A brother with no record adds himself, marked for the media team to confirm. When a number changed or none is on file, the media team links the record to his sign-in under Manage.
- **Media team.** Add, edit, and remove records, import a CSV (the old chapter database's columns work as they are), download the directory as CSV, confirm brothers who added themselves, and manage the greetings.
- **Greetings.** Every day at 12:35 UTC (8:35 a.m. New York in summer, 7:35 in winter), pg_cron runs `cal_private.dir_run_greetings()`. Each brother with an email on file and greetings turned on gets a short branded email on his birthday and on the anniversary of his crossing. The media team gets an email the day before listing tomorrow's celebrations, including brothers with no email on file, so a post or a call can go out. Deceased brothers are never listed. `dir_messages` logs each send, one per brother, kind, and day, so a rerun never repeats one. The Messages tab holds the switches, the sender, the wording with placeholders, a preview, a test to yourself, and the log.

Setup, once:

1. **Run the SQL.** In SQL Editor, run `migrations/20261030000100_brother_directory.sql`. It needs the calendar's four migrations first.
2. **Load the roll.** Either import the cleaned spreadsheet as CSV under Manage on the page (signed in as the media team), or run the private import SQL in SQL Editor. Neither file lives in this repository: they hold brothers' phone numbers and addresses.
3. **Email.** Greetings use the Resend key the calendar already keeps in Vault (`setup/2-request-emails.sql`). The sender defaults to the calendar's; set a directory sender under Messages, for example `Gamma Iota Lambda <brothers@mail.gil1906.org>`. Any address at `mail.gil1906.org` works, since Resend verified the domain.
4. **Check it.** Run `setup/3-directory-greetings.sql` to see the schedule, the email setup, and the next 30 days of celebrations, and to run today's greetings by hand if you want to.

Day to day:

- **Ask brothers to claim their records.** The old spreadsheet had no emails and only a handful of real birthdates, so the greetings reach brothers only after they claim a record and add both.
- **Pause the greetings:** turn off Send greetings to brothers under Messages. `select cron.unschedule('gil-directory-greetings');` stops the job entirely; the `cron.schedule` line at the end of the migration turns it back on.
- **See what went out:** the Sent panel under Messages, or `select * from public.dir_messages order by sent_at desc limit 20;`. Resend's answers for the last few hours are in `select status_code, content from net._http_response order by created desc limit 5;`.
- **Remove a brother's data:** Remove on his record deletes it, his message log included.

## Go live

Plan on about 30 minutes.

1. **Create a Supabase project.** At [supabase.com](https://supabase.com), choose New project. The Free plan works. Pick the East US region and save the database password somewhere safe. Use a project of its own for the calendar; it's the simplest setup. (To share the Alpha Academy Trading Floor's project instead, run the Trading Floor's migrations first, then the calendar's. Its first migration resets table permissions across the project and would undo the calendar's if it ran later.)
2. **Run the SQL.** In the project, open SQL Editor and run these files in order, pasting each into a new query:
   1. `migrations/20261013000100_content_calendar.sql`
   2. `migrations/20261013000200_chairs_and_request_files.sql`, which also creates the `calendar-files` bucket
   3. `migrations/20261014000100_request_emails.sql`
   4. `migrations/20261018000100_social_results.sql`
   5. `migrations/20261030000100_brother_directory.sql`
   6. `seed.sql`
   7. `setup/1-codes.sql`, after replacing both placeholder phrases with your own. The chapter code is for every brother, so make it easy to say out loud. The media code is for the media team only, so make it a long phrase.

   A project that already ran some of these runs only the migrations it hasn't, in order. Posts, requests, brothers, and codes all stay. After the second migration, brothers start as viewers, so mark the chairs in Manage access. Request emails also need `setup/2-request-emails.sql`; see Request emails above. Results also need the Edge Function and its secrets; see Instagram and Threads results above.
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
node --test "tests/calendar/*.test.mjs"  # 28 tests: access rules, sign-in, chairs, requests, files, review, upgrading, emails, results, and the Edge Function
node tests/calendar/demo-smoke.mjs     # the demo in a real browser, at desktop and phone widths
node tests/calendar/live-smoke.mjs     # live mode against a local stand-in for Supabase
```

The database tests run the real migrations and seed in PGlite, Postgres compiled to WebAssembly, with a small stand-in for Supabase's sign-in, storage, Vault, pg_net, and pg_cron. The pg_net stand-in records each request instead of sending it. The Edge Function tests run `functions/calendar-social/social.js` in Node against the same database, with Instagram and Threads simulated by `tests/calendar/meta-sim.mjs`: sign-in, token renewal, the nightly sync, expired and rate-limited tokens, and what the media team sees when something goes wrong. The live browser test runs the same database behind a local imitation of Supabase's Data API, sign-in, and file storage. It walks through a visitor, the media team, a brother who becomes a chair and sends files, and a brother on two devices. Then the media team connects Instagram and Threads through the real Edge Function, matches a post by hand, refreshes, and disconnects. Add `SCREENSHOTS=some-folder` to either browser test to save screenshots.
