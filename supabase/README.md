# Content calendar: Supabase setup

`calendar.html` (www.gil1906.org/calendar) is the media team's content calendar for the 2026-2027 fraternal year. Brothers see what's coming up and committee chairs request posts there. It runs in one of two modes:

- **Demo**, while `assets/calendar/config.js` is empty. The page uses sample data saved only in each visitor's browser, with a switch to view it as the media team, a brother, or a visitor. Safe to merge and preview.
- **Live**, once `config.js` has a Supabase project's address and key. Posts and requests live in that project's database, and everyone sees the same calendar.

This folder holds everything the live mode needs:

| File | What it does |
|---|---|
| `migrations/20261013000100_content_calendar.sql` | Tables, access rules, and the functions brothers write through |
| `seed.sql` | The 128 planned posts for October 2026 to August 2027 |
| `setup/1-codes.sql` | Sets the chapter code and the media code |

## Who can do what

- **Visitors** see nothing until the media team turns on the public calendar. Then they see dates, titles, categories, and post ideas. Captions, notes, creative links, and requests stay private.
- **Brothers** sign in once with the chapter code, their name, and a PIN of 4 to 6 digits. They see the whole calendar and the request queue, send requests, and edit their own requests until the media team reviews them. On another phone or computer they sign in with their name and PIN. A name stays signed in on one device at a time.
- **The media team** signs in with an email and password, then enters the media code once. They add and edit posts, review requests, reset PINs, and choose whether the calendar is public.

The database enforces all of this. The page only shows what the database allows.

## Go live

Plan on about 30 minutes.

1. **Create a Supabase project.** At [supabase.com](https://supabase.com), choose New project. The Free plan works. Pick the East US region and save the database password somewhere safe. Use a project of its own for the calendar; it's the simplest setup. (To share the Alpha Academy Trading Floor's project instead, run the Trading Floor's migrations first, then this one. Its first migration resets table permissions across the project and would undo the calendar's if it ran later.)
2. **Run the SQL.** In the project, open SQL Editor and run these three files in order, pasting each into a new query:
   1. `migrations/20261013000100_content_calendar.sql`
   2. `seed.sql`
   3. `setup/1-codes.sql`, after replacing both placeholder phrases with your own. The chapter code is for every brother, so make it easy to say out loud. The media code is for the media team only, so make it a long phrase.
3. **Turn on brother sign-in.** Under Authentication, open Sign In / Providers and turn on **Allow anonymous sign-ins**. Brothers don't create accounts; the chapter code and their PIN are their sign-in. Supabase allows 30 of these sign-ins per hour from one internet connection. Before a chapter meeting where many brothers sign in on the same Wi-Fi, raise that under Authentication, then Rate Limits.
4. **Make media team logins simple.** In the same Sign In / Providers section, open Email and turn off **Confirm email**. The media code already decides who joins the media team. (If you keep confirmation on, set the Site URL under Authentication, then URL Configuration, to `https://www.gil1906.org/calendar.html`, so the confirmation link brings people back to the calendar.)
5. **Connect the page.** Open the Connect button at the top of the project, or Project Settings, then API Keys. Copy the **Project URL** and the **publishable key** (it starts with `sb_publishable_`; the legacy `anon` key also works) into `assets/calendar/config.js`. Both are meant to be public. Never put a secret or `service_role` key in the page. Commit the change on a branch, open a pull request, and merge it; Vercel deploys in a minute or two.
6. **Sign in as the media team.** Open www.gil1906.org/calendar, choose Sign in, then Media team. Enter your email and a password of at least 8 characters, choose Create login, then enter your name and the media code. Each media team member does the same.
7. **Test with one brother.** Give him the chapter code. He chooses Sign in, then First time here, and sends a test request. Approve it from Requests, check that it shows on the calendar, then delete the test post.
8. **Decide on the public calendar.** Under Manage access, choose whether anyone who opens the page can see it. It starts private.

Then share the link and the chapter code with the chapter.

## Day to day

- **Forgotten PIN:** Manage access, then Reset PIN beside his name. Tell him the new PIN privately.
- **Five wrong PINs** lock a name for 10 minutes. A PIN reset unlocks it right away.
- **New chapter code:** Manage access, then Change code. Brothers already signed in stay signed in.
- **New media code:** run `setup/1-codes.sql` again with just the media line and a new phrase.
- **Removing a brother:** Manage access, then Remove. His requests stay, with his name on them.
- **Removing someone from the media team:** in SQL Editor, run `delete from public.cal_staff where display_name = 'Their Name';`
- **A simple backup:** in Agenda, turn on Show earlier posts and download the spreadsheet.
- **Free plan pauses:** Supabase pauses a free project after a week with no activity, which can happen over the summer. Restore it from the Supabase dashboard; nothing is lost. The Pro plan never pauses.

## Changing the database later

Once the migration has run on the live project, leave that file alone. Put any change in a new file in `migrations/` with a later timestamp, run it in SQL Editor, and add tests for it. The page's lists of categories, formats, platforms, and statuses live in `assets/calendar/data.js`, and the database checks the same keys, so change both together.

## Tests

From the repository root:

```bash
npm install --no-save @electric-sql/pglite@0.5.8 playwright@1.56.0
npx playwright install chromium        # once
node --test "tests/calendar/*.test.mjs"  # 11 database tests: access rules, sign-in, requests, review
node tests/calendar/demo-smoke.mjs     # the demo in a real browser, at desktop and phone widths
node tests/calendar/live-smoke.mjs     # live mode against a local stand-in for Supabase
```

The database tests run the real migration and seed in PGlite, Postgres compiled to WebAssembly, with a small stand-in for Supabase's sign-in tables and roles. The live browser test runs the same database behind a local imitation of Supabase's Data API and sign-in, and walks through the media team, a visitor, and a brother on two devices. Add `SCREENSHOTS=some-folder` to either browser test to save screenshots.
