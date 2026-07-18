# RevTrack — Revision Tracker

A fast, private, single-page revision tracker that runs entirely in your
browser. Pure HTML, CSS and vanilla JavaScript — no frameworks, no build
step, no backend, no accounts. All of your data stays on your device in
LocalStorage.

Built to be dropped straight onto **GitHub Pages** and used from day one.

---

## Deploying to GitHub Pages

The whole app is static files, so hosting it takes about two minutes:

1. **Create a GitHub repository.** Sign in to GitHub, click **New
   repository**, give it a name (for example `revision-tracker`), and create
   it. Public is fine — the app holds no data of yours; everything you log
   lives only in your own browser.

2. **Upload every file in this folder.** On the repository page choose
   **Add file → Upload files**, then drag in `index.html`, `style.css`,
   `script.js`, `README.md` and the whole `assets` folder (keep the folder
   structure exactly as it is). Commit the upload.

3. **Turn on GitHub Pages.** Go to **Settings → Pages**, and under
   *Build and deployment* set **Source** to *Deploy from a branch*, pick the
   `main` branch and the `/ (root)` folder, then **Save**.

4. **Open your site.** After a minute or so GitHub shows your URL
   (`https://<your-username>.github.io/<repository-name>/`). Open it and the
   app is fully functional — there is no further setup of any kind.

The only things fetched from the internet are the Chart.js library and the
two Google Fonts (both from CDNs). Everything else — including every scrap
of your revision data — is local.

---

## What it does

**Dashboard.** A greeting, today's date and a live London clock. Today's
total revision time sits next to a session timer with start, pause, resume,
finish and discard, plus one-click manual time entry. A weekly card shows
each day's hours, your weekly target and progress towards it; a monthly card
shows the month's total, daily average, session count and best day. An
interactive graph switches between daily, weekly and monthly views, a pie
chart breaks the last while down by subject with a percentage legend, and a
recent-sessions list gives one-click access to your latest entries.

**Timer.** Timestamp-based, so it never drifts: it keeps perfect time in
background tabs and even survives closing and reopening the page
mid-session. Pick a subject, add an optional title and notes, and go. It
chimes (your choice of sound) when you hit your default session length, and
sessions shorter than a few seconds are quietly discarded.

**Calendar.** A week at a time, always in Europe/London regardless of where
you are. Days run vertically with blocks sized by duration and coloured by
subject. Click any block to see subject, title, start, finish, duration and
notes, then edit, delete or duplicate it. Drag blocks with a mouse to move
them (15-minute snapping), click empty space to plan a future block, and
give any block a one-off colour override. Overnight sessions and clock
changes (GMT/BST) are handled correctly.

**Statistics.** Total hours, current and longest streaks, daily and weekly
averages, most and least revised subjects, longest, shortest and average
sessions, hours by weekday, month and year, a 7-day trend line, a
this-month doughnut, a GitHub-style consistency heatmap for the last year,
and a per-subject breakdown table.

**Setup.** Add, rename, recolour, reorder (drag or arrow buttons) and
delete subjects — deleting warns you and is undoable. Set weekly and daily
targets, default session length, notification sound, light/dark/system
theme, five graph colour palettes, and whether weeks start on Monday or
Sunday.

**Search.** The search box in the header matches subjects, titles, notes
and dates as you type; click a result to open that session.

**Data.** Export your sessions as CSV or a full JSON backup, import either
(imports are additive for CSV, and restore-from-backup for JSON), or erase
everything behind a double confirmation. Every change is saved instantly.

**Comfort.** Undo toasts for deletions, confirmation dialogs for anything
destructive, keyboard shortcuts throughout, an animated loading screen,
friendly empty states, full keyboard accessibility with ARIA labelling, and
a responsive layout from phone to desktop.

---

## Keyboard shortcuts

| Key       | Action                                    |
|-----------|-------------------------------------------|
| `/`       | Focus search                              |
| `1`–`4`   | Dashboard · Calendar · Stats · Setup      |
| `S`       | Start, pause or resume the timer          |
| `F`       | Finish the running session                |
| `M`       | Add time manually                         |
| `T`       | Toggle light / dark                       |
| `P` / `N` | Previous / next week (calendar view)      |
| `?`       | Show the shortcuts cheatsheet             |
| `Esc`     | Close dialogs                             |

---

## Files

```
/
├── index.html          The app shell — all four views and dialogs
├── style.css           All styling: themes, palettes, layout, animation
├── script.js           All behaviour, organised into commented modules
├── README.md           This file
└── assets/
    ├── icons/          favicon.svg
    ├── images/         logo.svg
    └── fonts/          Empty — fonts load from Google Fonts (see note inside)
```

## Privacy & storage

Nothing ever leaves your browser. Data is kept under a single LocalStorage
key (`revtrack.v1`) in whatever browser and profile you use the app from —
which also means it does not sync between devices by itself. Use
**Setup → Download backup** to move your data anywhere, and **Restore
backup** to load it again. Clearing the browser's site data erases the app's
data too, so back up occasionally.

## Browser support

Any current version of Chrome, Edge, Firefox or Safari, on desktop or
mobile. The first visit needs an internet connection for Chart.js and the
fonts; after that the app itself works offline (graphs politely explain
themselves if the CDN is unreachable).
