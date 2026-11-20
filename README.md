# Gamma Iota Lambda Chapter — Official Website
**The Brooklyn Alphas · Alpha Phi Alpha Fraternity, Inc.**
Live site: [www.gil1906.org](https://www.gil1906.org)

---

## Overview

This is the official website for Gamma Iota Lambda Chapter of Alpha Phi Alpha Fraternity, Inc., chartered May 5, 1945 in Brooklyn, NY. The site is a static HTML/CSS/JS website — no build tools, no frameworks, no dependencies. Every page is a plain `.html` file that links to a shared `style.css`.

---

## Site Structure

```
/
├── index.html                  # Homepage (hero, about, programs, history, meetings, contact)
├── alpha-academy.html          # Alpha Academy program page
├── chapter-history.html        # Full chapter history
├── executive-board.html        # 2026–2027 Executive Board, with bios
├── fraternity-history.html     # Alpha Phi Alpha fraternity history
├── impact-20.html              # Impact $20 donation campaign
├── recommended-readings.html   # Curated reading list
├── scholarship.html            # Judge Myles A. Paige Scholarship
├── press.html                  # Press kit for journalists: facts, media contact, and downloads
├── calendar.html               # Content calendar for the media team and brothers (behind the home page's Sign in button)
├── 404.html                    # Custom not-found page
├── style.css                   # All shared styles (single stylesheet)
├── sitemap.xml                 # XML sitemap for Google indexing
├── robots.txt                  # Search crawler instructions
├── vercel.json                 # Vercel hosting settings and URL redirects
├── favicon.png                 # Browser tab icon (32×32px)
├── apple-touch-icon.png        # iOS home screen icon (180×180px)
├── og-image.jpg                # Social sharing preview image (1200×630px)
├── gil-crest.png               # Chapter crest — used in nav and as headshot placeholder
├── zelle-qr.png                # Zelle QR code (Impact $20 page)
├── chapter-photo1.png          # Chapter group photo
├── school-daze/                # School Daze photo drop (no site nav, not in the sitemap)
│   ├── photos.html             # Ticket buyers send photos from their college days
│   ├── review.html             # The organizers approve photos for the big screens
│   └── screen.html             # The slideshow for the venue's computer
├── assets/calendar/            # The calendar's script, styles, demo data, and Supabase client
├── assets/press/               # Downloads for the Press page (the press kit PDF)
├── assets/photo-drop/          # The photo drop's scripts, styles, and the event flyer
├── supabase/                   # The calendar's and the photo drop's database (migrations, seed, setup, go-live steps) and their Edge Functions
├── tests/calendar/             # The calendar's database and browser tests, and the photo drop's database and Edge Function tests
└── headshots/                 # Current board first, then photos of past officers
    ├── robert-brissett.jpeg
    ├── lucien-allen.jpg
    ├── sadiqq-elcock.jpg
    ├── dwane-omar-jones.jpg
    ├── sherron-cloyd.jpg
    ├── andre-mckenzie.jpg
    ├── eugene-aiken.jpg
    ├── christopher-gooding.jpg
    ├── remington-allen.jpg
    ├── jean-louis.jpg
    ├── jessy-dwyer.jpg
    ├── farid-adenuga.jpg
    ├── musa-abdullah.jpg
    ├── tommy-atkins.jpg
    ├── christevane-francois.jpg
    └── (past officers: david-williams.jpg, david-brown.jpg, eric-davis.jpeg, bryce-tarrant.jpeg)
```

---

## Making Updates

### Editing content
All content is written directly in the HTML files. There is no CMS. Open the relevant `.html` file in any text editor, make your changes, and push to the repo.

### Shared styles
All visual styling lives in `style.css`. Page-specific styles are written in `<style>` blocks inside each HTML file's `<head>`. If a style change should affect every page (nav, footer, buttons, typography), edit `style.css`. If it's specific to one page, edit that page's `<style>` block.

### Adding a new page
1. Copy the structure of an existing inner page (e.g. `chapter-history.html`)
2. Update the `<title>`, `<meta name="description">`, and `<link rel="canonical">` tags
3. Update the Open Graph and Twitter Card meta tags
4. Add a `<url>` entry to `sitemap.xml`
5. Add a link to it in the nav dropdown on every page (both desktop `nav-links` and mobile `nav-mobile-menu`). In the phone menu, links go inside `mobile-menu-links`: a page that sits under a section gets `class="mobile-nav-link mobile-nav-sub"` and goes right after that section's link, and the sections number themselves. `tests/calendar/site-nav.test.mjs` checks that the Chapter menu is the same on every page; a new link under Chapter goes in its list too.

---

## Third-Party Services

### Google Analytics
- **Property:** Gamma Iota Lambda Chapter
- **Measurement ID:** `G-4YESGMG3TC`
- The tracking snippet is in the `<head>` of every page
- To view data: [analytics.google.com](https://analytics.google.com)

### Formspree (Contact Form)
- The contact form on `index.html` submits to Formspree
- **Form action URL:** `https://formspree.io/f/YOUR_FORM_ID`
- Replace `YOUR_FORM_ID` with the actual ID from your Formspree dashboard
- To manage submissions, set notification email, or change the form: [formspree.io](https://formspree.io)
- The form field names (`name`, `email`, `subject`, `message`) map directly to what Formspree displays in its dashboard

### Google Search Console
- Sitemap submitted at: `https://www.gil1906.org/sitemap.xml`
- To verify ownership or check indexing status: [search.google.com/search-console](https://search.google.com/search-console)

### Substack (Newsletter embed)
- Embedded on `index.html` via iframe
- Publication: [gil1906.substack.com](https://gil1906.substack.com)
- To manage subscribers and posts: [substack.com](https://substack.com)

---

## Headshots

Headshots live in the `headshots/` folder. File naming convention is `firstname-lastname.jpg` (lowercase, hyphenated). Some files use `.jpeg` instead of `.jpg` — preserve the extension exactly as it exists when adding new photos.

**Current status (2026–2027 board):**
| Member | File | Status |
|---|---|---|
| Robert Brissett | `robert-brissett.jpeg` | ✓ |
| Lucien Allen | `lucien-allen.jpg` | ✓ |
| Sadiqq Elcock | `sadiqq-elcock.jpg` | ✓ |
| Dwane Omar Jones, Esq. | `dwane-omar-jones.jpg` | ✓ |
| Sherron Cloyd | `sherron-cloyd.jpg` | ✓ |
| Dr. Andre McKenzie | `andre-mckenzie.jpg` | ✓ |
| Eugene Aiken | `eugene-aiken.jpg` | ✓ |
| Christopher Gooding | `christopher-gooding.jpg` | ✓ |
| Remington Allen | `remington-allen.jpg` | ✓ |
| Jean Louis | `jean-louis.jpg` | ✓ |
| Jessy Dwyer | `jessy-dwyer.jpg` | ✓ |
| Farid Adenuga | `farid-adenuga.jpg` | ✓ |
| Dr. Musa Abdullah | `musa-abdullah.jpg` | ✓ |
| Tommy Atkins | `tommy-atkins.jpg` | ✓ |
| Christevane Francois | `christevane-francois.jpg` | ✓ |

**To add a new headshot:**
1. Crop to a square (1:1 ratio), ideally at least 400×400px
2. Name the file `firstname-lastname.jpg`
3. Compress it at [squoosh.app](https://squoosh.app) before adding (target under 100KB)
4. Drop it in `headshots/`
5. Update `executive-board.html` — find the card, remove the `placeholder` class from `.eb-card-img-wrap`, update the `src` and `alt` attributes

---

## Updating the Executive Board

Each board term, update `executive-board.html`:

1. Update the hero subtitle (`2026–2027 · Servants of All`) and the large year behind it (`eb-hero-year`) to the new term
2. Update the `<title>` and meta description year
3. Update the JSON-LD structured data block (`<script type="application/ld+json">`) with the new member list
4. Update `sitemap.xml` — change the `<lastmod>` date for `executive-board.html`

For each member card, the pattern is:
```html
<div class="eb-card reveal">
  <div class="eb-card-img-wrap">
    <img src="headshots/firstname-lastname.jpg" alt="Full Name, Role" loading="lazy" />
  </div>
  <div class="eb-card-name">Full Name</div>
  <div class="eb-card-role">Role Title</div>
  <details class="eb-bio">
    <summary>Read bio<span class="eb-sr">: Full Name</span></summary>
    <p>A short, conversational bio in the third person.</p>
  </details>
</div>
```

The bio stays hidden until a visitor presses **Read bio**, which works with a mouse, a finger, or the keyboard. The hidden `eb-sr` text tells screen reader users whose bio the button opens, so keep it matched to the name. If a member has no bio yet, leave out the whole `<details>` block.

For a member with no photo, add the `placeholder` class and use `gil-crest.png`:
```html
<div class="eb-card-img-wrap placeholder">
  <img src="gil-crest.png" alt="" aria-hidden="true" />
</div>
```

---

## Updating the Alpha Academy Page

Each program cycle, update `alpha-academy.html`:

1. Update the school-year references (`2026–2027`) in the status banner, the prose paragraph on the schedule, the apply block heading, and the sidebar **School Year** row
2. Update the application link `href` if the Google Form URL changes — it appears in **four** places: the apply block button, the sidebar `.aa-apply-card` CTA, the bottom `.aa-contact` CTA, and the JSON-LD `potentialAction.target`
3. Update the deadline in the apply block (`.aa-apply-deadline-date`), the sidebar card (`.aa-apply-card-date` / `.aa-apply-card-label`), the status banner text, the bottom CTA copy, and the JSON-LD `potentialAction.endTime` (ISO format: `YYYY-MM-DD`)
4. Update the `<meta name="description">`, `og:description`, and `twitter:description` tags, which mention the open application and deadline
5. Update `sitemap.xml` — change the `<lastmod>` date for `alpha-academy.html`

**Current status:** applications closed, reopening at the beginning of the next school year. The 2026–2027 cycle used [this Google Form](https://docs.google.com/forms/d/e/1FAIpQLSfI5-bOwPjGmGAE5XhluFAdQ_M-nwJ2laGlwIc04GHZqt-5Kg/viewform) with a September 25, 2026 deadline. The promo flyer for that cycle is kept at `assets/alpha-academy/alpha-academy-application2627.jpg` — it is not referenced by any page while applications are closed, since it advertises a passed deadline.

### When applications close

Swap the banner back to the closed state — drop the `open` class from `.aa-status`, change it from an `<a href="#apply">` back to a `<div>`, and remove the `.aa-status-arrow` span. Then remove the `.aa-apply` block, the sidebar `.aa-apply-card`, and the apply button in the bottom CTA, and set the sidebar **Applications** row to the closed message. Also:

- Drop the `potentialAction` block from the page's JSON-LD
- Point `og:image` and `twitter:image` back at `og-image.jpg` and remove the `og:image:width` / `og:image:height` / `og:image:alt` tags, so shares stop previewing a flyer with a passed deadline
- Take the open-application wording back out of `<meta name="description">`, `og:description`, and `twitter:description`

The CSS for both states stays in the page's `<style>` block, so reopening next cycle is just markup. When reopening, add a fresh flyer rather than reusing the previous cycle's.

---

## Updating the Scholarship Page

Each year, update `scholarship.html`:

1. Update the year references (`2025` → new year) in the `<title>`, meta description, hero heading, and body text
2. Update the application deadline date in both the body copy and the sidebar card
3. Update the JSON-LD `applicationDeadline` field (ISO format: `YYYY-MM-DD`)
4. Update the essay prompt if it changes
5. Update the application link `href` if the Google Form URL changes

---

## Content Calendar

`calendar.html` is the media team's content calendar for the fraternal year: holidays, Divine Nine Founders' Days, national program posts, notable Alpha men, monthly series, and chapter events, with a way for committee chairs to request posts. Bro. Eugene Aiken, Associate Editor of the Sphinx, runs it for the media team.

- **Address:** www.gil1906.org/calendar. The **Sign in** button in the home page's top menu and phone menu opens it at the sign-in panel. It isn't in the sitemap, and it asks search engines not to index it.
- **Who sees what:** visitors see only a sign-in prompt. Brothers sign in with the chapter code, their name, and a PIN, and view every post. Committee chairs are brothers the media team marks as chairs in Manage access; they also send and follow requests. The media team signs in with an email and password and edits everything.
- **Requests:** only committee chairs send them, at least three weeks ahead. They attach photos, videos, or PDFs in the form (up to 10 files, 50 MB each) or share a Google Drive link. Each new request emails the media team through Resend. The media team asks questions, declines, or adds them to the calendar, and the chair follows the status on the same page. It's built to take over from the Google Form the chapter has used for content requests.
- **Platforms:** Instagram, Threads, X, gil1906.org, Substack, and WhatsApp. Facebook is off while the chapter has no access to it.
- **Exports:** the Agenda view downloads a spreadsheet (CSV) or a calendar file (.ics) for Google Calendar, Outlook, or Apple Calendar.
- **Results:** the media team's Results tab shows how posts do on Instagram and Threads: followers over time, planned posts against what went out each month, average views by category, format, and national program, and top posts. A Supabase Edge Function signs in to @gil1906, keeps its access in Supabase Vault, and brings in every post's numbers each night, matching posts to the calendar by date. Setup is under Instagram and Threads results in [`supabase/README.md`](supabase/README.md).

**Demo and live.** With `assets/calendar/config.js` empty, the page runs a demo on sample data saved in each visitor's browser. To go live, follow [`supabase/README.md`](supabase/README.md): create a Supabase project, run the SQL files in order, change two sign-in settings, and paste the project's address and publishable key into `config.js`.

**Files:**
- `calendar.html` holds the site's nav and footer around the calendar.
- `assets/calendar/app.js` draws the page; `api-live.js` talks to Supabase and `api-demo.js` runs the demo. Both expose the same methods.
- `assets/calendar/charts.js` draws the Results charts: SVG line and column charts and bar lists, each with a hover and keyboard readout and a table view. Their colors are the `--viz-*` values in `calendar.css`, checked for color blindness and contrast.
- `assets/calendar/sync-health.js` decides what each connected account's card on Results says: fine, needs a new sign-in, or not updating. It is on its own so the tests can check each case.
- `supabase/functions/calendar-social/` is the Edge Function behind Results: `social.js` holds the sign-in and the nightly sync, and `index.ts` connects it to the database on Supabase.
- `assets/calendar/data.js` lists the categories, programs, formats, platforms, statuses, committees, and upload limits. The database checks the same keys, so change both together. A comment above the platforms says how to bring Facebook back.
- `assets/calendar/calendar.css` gives the calendar the look of the original version the media team approved: a light palette with old gold, Cormorant Garamond for headings, and Outfit for everything else. The site's nav and footer keep their own look. It loads after `style.css`, styles only elements inside `.gc`, and turns off the site's page-in animation on this page so the side panel stays fixed to the screen.
- `assets/calendar/vendor/supabase.js` is the Supabase client (supabase-js 2.117.2), kept in the repository so the page needs no build step.
- `index.html` carries the Sign in button: `nav-signin` in the top menu and `mobile-signin` in the phone menu, both linking to `calendar.html#signin`. To make room, the `#main-nav.has-signin` rules in `style.css` hide the home page's social icons in the top menu below 1600px wide and tighten the link spacing on smaller laptops. The icons stay in the phone menu and the Contact section.

**Tests:** see the Tests section of [`supabase/README.md`](supabase/README.md). Run them after any change to the calendar.

---

## School Daze Photo Drop

The three pages in `school-daze/` collect photos for School Daze, the chapter's party on Saturday, Nov. 21, 2026, 8 PM to 2 AM at The Ivory on Park. Ticket buyers send photos from their college days, the organizers approve them, and the approved photos play on the venue's big screens. The party committee can add videos of its own, which play in between the photos. Each page has its own code:

| Page | Who uses it | Code |
|---|---|---|
| `school-daze/photos.html` | Ticket buyers, mostly on phones | The upload code, carried in the emailed link as `?k=CODE` |
| `school-daze/review.html` | The organizers, on a phone or a laptop | The review code, typed once with their name |
| `school-daze/screen.html` | The venue's computer | The screen code, in the link as `#c=CODE` or typed once |

- **Addresses:** www.gil1906.org/school-daze/photos.html, /school-daze/review.html, and /school-daze/screen.html. The short address www.gil1906.org/school-daze goes to the upload page, and /school-daze/review and /school-daze/screen find their pages. The pages have no site nav and no analytics, stay out of the sitemap, and ask search engines not to index them. They send no referrer, so a code in a link isn't passed to another site.
- **What guests see:** the link in the ticket email opens the upload page, with the flyer and the ask. To guests the photos are for a special throwback tribute at the party: the page never mentions a screen, so nobody is put off sending one. The box they check before sending still says the chapter may show their photos at School Daze as part of it. A guest enters a name and the email the ticket was bought with, chooses up to 5 photos, adds a caption to any of them (optional, 80 characters), checks one box saying the photos are theirs to share, and sends. Tips on the page ask for the original file and warn against screenshots and copies saved from Instagram, Facebook, or a text message. With no code in the link, the page asks for the code from the email. After the deadline, or once the drop is full, it says so and shows the party details.
- **Photo quality:** the page labels each chosen photo by the long side of the file the guest picked: Sharp (1600 pixels or more), Good (1000 or more), Small (500 or more; it is taken, with a note that it will look soft), or Too small (under 500; refused). Before sending, the page redraws each photo as a JPEG no longer than 2560 pixels on its long side and 6 MB at most. It never makes a photo larger than it came. Redrawing also drops what a camera writes into the file, such as where the photo was taken. A file the browser can't open, such as an iPhone HEIC photo outside Safari, gets a message saying to open the page on the iPhone or send a JPEG or PNG copy.
- **Sending:** photos go one at a time, with a line such as "Sending 2 of 3". One that fails gets a Try again and doesn't hold up the rest. A photo sent twice from the same email is kept once and counts once, so Try again is safe after a lost connection. The page remembers the guest's name and email on that device for next time. The thank-you offers Send more while the guest has photos left.
- **Review:** on `review.html`, an organizer signs in with the review code and a name. Both stay on that device until Sign out. Photos sit under three tabs, Waiting, Approved, and Rejected, oldest first. Each card shows the photo, the sender's name and email, when it came in, the same size label the guest saw, and the caption, which the organizer can edit. A waiting photo is approved from the full view only, with the real file loaded on screen: the small picture on a card is one the sender's phone made. So Waiting cards get Review, which opens the full view, and Reject. The full view has Approve, Reject, and arrows to the previous and next. Review them in order opens the oldest waiting photo, and each one approved or rejected brings up the next. The other tabs get Back to waiting. Rejected photos also get Delete, which is permanent and asks first. The organizer's name is saved with each approval or rejection, so the team sees who did what. Approve and Reject apply only to a photo that is still waiting, so two organizers working at once can't overturn each other: the one who was second is told, and sees where the photo stands. A tap counts only once the photo has been on screen for a moment. The page checks for new photos every minute. Only approved photos reach the slideshow, with their captions and nothing about who sent them.
- **Videos from the committee:** guests send photos only. An organizer adds a video on the review page, under Tools, then Add a video. It takes an MP4 or MOV file of 1000 MB at most. The page opens the file in the organizer's browser first and refuses one it can't open, since the slideshow may not be able to play it either. It shows the video's length, its size, and a picture of it, takes an optional caption, and sends the file straight to the chapter's storage, with a bar showing how far along it is and a Cancel button. The box stays open until the upload ends, and that phone or laptop can't review photos meanwhile. The file goes up in pieces, so a connection that drops costs one piece and not the upload: the page says the connection dropped, keeps trying, and carries on from where it was once the connection is back. It gives up only when nothing has got through for ten minutes, and it is just as patient with the server's last check once the file is in. The page keeps the screen awake while a video goes up, where the browser allows it, and a computer that slept anyway carries on when it wakes. An upload has two hours to finish, which a 1000 MB video manages on any connection faster than about 1.2 megabits a second. A large video can still take many minutes, so add videos before the party, from a computer on good Wi-Fi. A video needs no approval: it goes straight into the show, under Approved, with the name of the organizer who added it. Its card shows its length and size, and the full view plays it. Back to waiting or Reject takes it out of the show, and Delete on the Rejected tab removes it for good. Videos have room of their own (40 videos, 10000 MB together) and never take a guest's place.
- **Uploads and tools:** on the same page, the Uploads panel has the open or closed switch and the deadline, shown in the organizer's own time zone. Tools has Open the slideshow, Add a video, Download approved photos (it saves them to that device as ZIP files, without the videos), and Delete everything, for after the party, which asks the organizer to type DELETE.
- **The slideshow:** `screen.html` runs on the venue's computer for the whole party with nobody watching over it.
  - **Setup:** open the link with the screen code (`screen.html#c=CODE`), or type the code. The slideshow takes the screen code only. Never type the review code on the venue's computer, which remembers what it is given. Choose the seconds per photo (5, 8, 12, or 20; it starts at 8), the order (shuffle, or oldest first), captions on or off, and the School Daze logo in the corner on or off. For the committee's videos, choose how many photos go by between two of them (5, 10, or 20; it starts at 10) and whether they play with their sound (they start silent). The computer remembers the code and the choices. Start the slideshow checks the code, goes full screen, and keeps the screen awake where the browser allows.
  - **On screen:** each photo shows whole over a blurred, darkened copy of itself, with a slow cross-fade and a gentle zoom. A photo is never stretched past one and a half times its own pixels. A small one shows as a framed print instead. Captions sit at the bottom left, two lines at most.
  - **Staying current:** the page asks for the approved photos every minute. A newly approved photo joins at the front of the line. One that is no longer approved leaves the screen at that check, even when the next photo hasn't loaded yet. If the connection drops, a photo won't load, or the code stops working, the show plays on with what it has and keeps trying. On a slow connection it keeps its pace too: it tries the photos it doesn't have behind the scenes, one at a time, and brings each one in as it arrives. While it waits, the photo the room saw longest ago fills in, and the line keeps its place: a stall doesn't send the show back to the start, and the photo that was loading when it began is next once photos come again. With no second photo to show yet, it waits for one download instead of starting others beside it, so a slow connection isn't split between several. A photo gets 90 seconds to come down; on a connection too slow for that (under about 150 kilobits a second for a typical photo) nothing new arrives, and the show plays what it has. It goes back to loading each next photo directly once a photo comes down quickly again. With no approved photos, the screens show a School Daze title card. The browser remembers which photos it has shown, so reloading the page, or starting the show again on the same computer, opens with those straight away. A reload still needs a connection to bring the page itself back: if the connection is down, leave the page open.
  - **Videos:** a video from the committee plays after every so many photos, the videos taking turns, each for its own length. It fills the screen as far as its shape allows, over a blurred copy of its poster picture, with its caption. A video goes on screen only once the whole file is on the venue's computer, so it never stops to load in front of the room. The page brings each one down in pieces, in the gaps when no photo is on its way, and keeps the pieces in the browser's own storage, on disk, so a video of hundreds of megabytes is never held in memory. A piece that fails is asked for again, a reload doesn't download anything twice, a download that was cut off carries on from the piece it had reached, and a video taken out of the show is deleted from the computer. Large videos take a while to come down: open the slideshow on the venue's computer ahead of time, in the same browser it will use at the party, and leave it running until the controls say every video is ready. The download carries on while the slideshow's tab is behind another one. A browser won't load a video in a tab that is behind another, so a video that arrives then is checked, and one whose turn comes then is played, once the tab is in front again. A private window gives the page almost no storage, so use an ordinary one; a video there is no room to keep is named as such in the controls. With photos slow to arrive, the photos come first and the videos wait. A file the browser can't play is left out, and the photos carry on. With no photos at all, the videos play one after another, and one video alone goes round and round. The controls show a line such as "Videos: 2 of 3 ready, the next one 40% here". Pause holds a video where it is, and Next and Previous step past it.
  - **Controls and keys:** the controls and the cursor stay hidden. Moving the mouse or tapping shows Pause, Previous, Next, Captions, Full screen, and Setup for 3 seconds. Space pauses. The arrow keys go back and forward, and so do Page Up and Page Down, which a presenter's clicker sends. C turns captions on or off. F is full screen. Esc leaves full screen.
  - **Testing the screens:** `screen.html?demo=1` plays six test pictures made in the browser, with no code and no call to the server, so the venue can check its screens before any photo is approved. One of the six is small, to show the framed print. The setup card links to it.
- **Limits:** 5 photos per email. 600 photos and 750 MB in all. Uploads close at noon New York time on Saturday, Nov. 21. A photo is 6 MB at most after the page shrinks it, and at least 500 pixels on its long side. A caption is 80 characters at most. A limit on photos from one internet connection exists and starts turned off. The committee's videos are 1000 MB each at most, 40 videos and 10000 MB together. Those two sizes are what the live project is set to on Supabase's Pro plan; the migration starts them at 50 MB and 200 MB, which is what the free plan can hold. The organizers change the deadline on the review page. The rest are settings in the database; see Photo drop in [`supabase/README.md`](supabase/README.md).

**Setup.** The pages talk only to the `photo-drop` Edge Function in the calendar's Supabase project, and the function checks each page's code. The photos sit in a private storage bucket, and the pages see them through signed links. The pages find the project through `assets/calendar/config.js`; while that file is empty, each page says "This page isn't set up yet." Setting the codes, the links to hand out, and what to do after the party are under Photo drop in [`supabase/README.md`](supabase/README.md).

**Files:**
- `school-daze/photos.html`, `review.html`, and `screen.html` are the three pages. They load the shared files below and not the site's `style.css`.
- `assets/photo-drop/api.js` is the pages' link to the Edge Function. `drop.css` is the look the three share: black and gold with block lettering, after the event flyer. Every class in it starts with `pd-`.
- `assets/photo-drop/photos.js` and `photos.css` run the upload page. `image.js` gets each photo ready in the browser: the size label, the redrawn JPEG, and a small copy for the review page and the slideshow's blurred background.
- `assets/photo-drop/review.js` and `review.css` run the review page. `zip.js` writes the ZIP files for Download approved photos. `video.js` is Add a video: it opens the chosen file, makes its poster picture, and sends both to storage, the video in pieces (a resumable upload).
- `assets/photo-drop/screen.js` and `screen.css` run the slideshow. `clips.js` brings the committee's videos down to the venue's computer and keeps them there.
- `assets/photo-drop/school-daze-logo.png` is the event's logo, the chapter's crest over the School Daze lettering on a clear background. The slideshow shows it in the top right corner.
- `assets/photo-drop/school-daze-flyer.jpg` is the event flyer, used on the slideshow's title card and in link previews. `school-daze-flyer-small.jpg` is a smaller copy for the upload page and the slideshow's setup card.
- `supabase/functions/photo-drop/` is the Edge Function: `drop.js` holds everything it does, and `index.ts` connects it to the database on Supabase.
- `supabase/migrations/20261118000100_photo_drop.sql` adds the table, the bucket, the settings, and the database functions. `20261118000200_photo_drop_repeats.sql` keeps one copy of a photo sent twice, makes the slideshow take the screen code only, and turns the per-connection limit off. `20261118000300_photo_drop_review_order.sql` makes Approve and Reject apply to waiting photos only, so two organizers reviewing at once can't overturn each other, and Delete take only rejected ones. `20261118000400_photo_drop_video.sql` adds the committee's videos: what kind each row is, the videos' own limits, and a bucket that takes MP4 and MOV files. `supabase/setup/4-photo-drop.sql` sets the three codes.
- `vercel.json` holds the two redirects for the short addresses.

**Tests:** `tests/calendar/photo-drop.test.mjs` covers the database and `tests/calendar/photo-drop-function.test.mjs` covers the Edge Function, with Storage simulated by `tests/calendar/storage-sim.mjs`. They run with the calendar's tests; see the Tests section of [`supabase/README.md`](supabase/README.md). `tests/calendar/photo-drop-smoke.mjs` walks the three pages in a real browser: a guest sends photos, an organizer reviews them, the slideshow plays the approved one, and an organizer adds a video (`tests/calendar/fixtures/clip.mp4`, three seconds long) that the slideshow then plays. It doesn't cover the slideshow on a slow or failing connection, so after a change to `screen.js` try that by hand as well (the browser's developer tools can slow the network down). `screen.html?demo=1` plays the slideshow without the server.

---

## SEO Notes

Every page has:
- A unique `<title>` and `<meta name="description">`
- A `<link rel="canonical">` pointing to `https://www.gil1906.org/PAGE.html`
- Open Graph tags (`og:title`, `og:description`, `og:image`, `og:url`)
- Twitter Card tags
- JSON-LD structured data appropriate to the page type

`calendar.html` is the exception: it's a working page for brothers, so it carries `noindex` and stays out of the sitemap. The three School Daze pages in `school-daze/` do the same.

The canonical domain is `https://www.gil1906.org` (www, HTTPS). Every canonical tag, `og:url`, and sitemap entry uses it. Vercel is set up to:
- Serve every page over HTTPS (automatic)
- Redirect `gil1906.org` to `www.gil1906.org` (set under Settings, then Domains, in the Vercel project)
- Redirect extensionless page addresses (`/events`) to the `.html` pages, as GitHub Pages did. This rule is in `vercel.json`.

---

## Deployment

The site is hosted on **Vercel**, connected to this repository. There is no build step: Vercel publishes the files in the repository as they are.

- **Production:** every merge to `main` deploys to www.gil1906.org within a minute or two.
- **Previews:** every pull request gets its own preview address from Vercel, posted on the pull request. Check your change there before merging.
- **Settings:** `vercel.json` holds the redirect for extensionless addresses and the short addresses for the School Daze pages. Domains are set in the Vercel project under Settings, then Domains.
- **DNS:** the domain is registered at Namecheap, and its DNS records live there (Domain List, then Manage, then Advanced DNS). The apex `gil1906.org` has an A record and `www` has a CNAME record, both with the values Vercel shows on its Domains page. Leave the email records (MX and TXT) alone when editing DNS.
- **404 page:** Vercel serves `404.html` for any address that doesn't exist.
- **Usage limit:** on Vercel's free Hobby plan, the account gets 100 GB of data transfer a month. If it goes over, Vercel pauses every project on the account, and visitors see an error page instead of the site. The Events and Alpha Academy pages load many full-size photos and videos, so a busy month after an event can get there. Vercel emails a warning as usage nears the limit; you can also watch it under Usage in the Vercel dashboard. On the Pro plan, going over is billed instead of paused.

**Keep GitHub Pages turned on.** Before the custom domain was added in April 2026, the site lived at `gamma-iota-lambda.github.io/brooklyn-alphas/`, and links from that time may still be shared or in search results. GitHub forwards them to gil1906.org only while GitHub Pages stays on for this repository with `gil1906.org` as its custom domain. So leave Pages on (Settings, then Pages) and keep the `CNAME` file. GitHub may show a DNS warning there because the domain now points to Vercel; that's expected.

The site is plain files, so it can move to any static host. Carry the redirect in `vercel.json` over to that host's format.

---

## Browser & Accessibility

- Tested in Chrome, Firefox, Safari, and mobile (iOS Safari, Android Chrome)
- Skip-to-content link on every page for keyboard navigation
- ARIA labels on nav, mobile menu dialog, and interactive elements
- `prefers-reduced-motion` respected via CSS (animations disabled for users who opt out)
- Color contrast meets WCAG AA for primary text

---

## Contacts

| Role | Contact |
|---|---|
| General inquiries | info@gil1906.org |
| Membership | membership@gil1906.org |
| Alpha Academy | education@gil1906.org |
| Scholarship | education@gil1906.org (subject: GIL Scholarship 2025) |

---

*Gamma Iota Lambda Chapter · Alpha Phi Alpha Fraternity, Inc. · Chartered May 5, 1945 · Brooklyn, New York*
