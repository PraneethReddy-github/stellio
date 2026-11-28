# Stellio user guide

Stellio is a desktop app for one person on Linux. It finds jobs, tells you how well you fit, writes a tailored LaTeX resume and cover letter under rules you control, audits the skills on the page, and tracks every application. Your data stays on your machine.

## 1. Install

You need the Claude CLI (the `claude` command) logged in to your subscription, and `git`. Both are checked in Settings, AI.

**AppImage** (any distribution):

```sh
chmod +x Stellio-1.0.0-x86_64.AppImage
./Stellio-1.0.0-x86_64.AppImage
```

**Debian and Ubuntu**:

```sh
sudo apt install ./Stellio-1.0.0-amd64.deb
```

Stellio then appears in your application menu under Office. For PDF previews of your resume you also need a LaTeX engine and `bubblewrap` (see Troubleshooting).

## 2. First run

On first start Stellio creates your data folder and opens on Today, which is empty until you add things. At the top, a **Setup** checklist shows what is still missing (Claude CLI, profile, rules, a search profile, LaTeX, and an optional daily scan), each with its real state and one button. It goes away when the required steps are done or when you press Dismiss. Do these in order:

1. **Profile** (`G P`). This is the one truthful source for everything Stellio writes. Import an existing resume (PDF, `.tex`, `.txt`) or fill the template. Check the validation messages, then save. Nothing is generated from facts that are not in the profile. The seed profile ships with example entries (`Job Title — Company`, `Project Name`, `Degree, Field — University`) and no email: until you replace them and add your email, Stellio refuses to write a resume, cover letter or referral message and tells you what to fix.
2. **Settings, AI.** Confirm the Claude CLI shows as installed and logged in. Pick a model and effort per task, or leave the defaults.
3. **Settings, Search profiles.** Add at least one: roles, locations, remote, seniority, salary floor, words to exclude.
4. **Settings, Sources.** Choose which job sources to scan. Adzuna needs your own free key (Stellio stores it encrypted with your system keyring and never shows it again).
5. **Settings, LaTeX.** If no engine is found, install Tectonic from there (a 10 MB download, checked against a pinned checksum).

Ctrl+K opens the command palette. `G` then a letter jumps between screens.

## 3. The data folder

Default `~/Stellio` (shown in Settings, General). You can open every file in any editor; Stellio notices outside edits.

```
~/Stellio/
  profile/praneethreddy.md   your master profile
  rules/                     resume.md, cover-letter.md, skills-policy.md, referral-message.md
  templates/                 resume.tex, cover-letter.tex, photo.jpg (your resume photo, if set)
  applications/              one folder per application, with the exact files you used
  .stellio/                  database, backups, logs (do not edit)
```

`profile`, `rules`, `templates` and `applications` are versioned with git, so every change has a history and can be reverted from the app. Without git the app still works, but without history; Settings, General says so.

## 4. A job you found

Paste a link or the text of a posting (Workspace). Stellio structures it and scores your fit with evidence from your profile and a list of red flags. Then:

- **Resume.** Generate a tailored resume. Employers, titles and dates always come from the profile. Every number and skill is checked against the profile (the truth check), plus an ATS keyword check and the lint rules from `rules/resume.md`. Revise by instruction or edit the LaTeX yourself; versions are kept and can be compared.
- **Cover letter.** Same pipeline, with `rules/cover-letter.md`. Laid out as a German business letter: sender block with your postal address (Profile), the company, "Place, DD.MM.YYYY", "Application for the position of …", the letter, closing and signature line.
- **German version.** On a drafted resume or letter, German version makes a German translation as a new version. Only the wording changes; Stellio checks that no number or technical term was added.
- **Photo.** Profile, Resume photo: pick a PNG or JPEG. It is shown on resumes while `rules/resume.md` has `photo: true`.
- **Skill audit.** Every skill on the page is labelled with where it comes from and a recommendation: keep, remove, learn, or add to the profile.
- **Use it.** Copy the LaTeX, export a PDF, or Open in Overleaf. Mark the version final when you apply; it is frozen with the application.

## 5. Daily scan and the timer

Inbox (`G I`) shows new jobs ranked for you, each with a one-line reason. `S` shortlists a job, `D` dismisses it with a reason.

- **In the app.** Settings, Schedule: turn on the daily scan and set the time. It is off by default because a scan uses Claude usage. If the app was closed at that time it scans at the next start when the last scan is over a day old.
- **While the app is closed.** Settings, Schedule, Run when the app is closed: Install shows the exact two systemd user unit files (`stellio-scan.service` and `.timer` under `~/.config/systemd/user`) before anything is written. The timer runs `stellio --scan`, which scans, posts a notification and exits. Remove deletes the unit files.
- **Re-score.** Inbox, Re-score: score again the jobs that have no score yet, every job in the list you are looking at, or the ones scored before you last changed your profile. One job: Re-score in its Score section. Jobs with a full fit analysis keep that score; re-analyze them in Workspace. The triage score reads your whole profile but only the first 1,200 characters of a posting.
- **Side jobs.** For part-time work you want only for the money, add a search profile in Settings, Search profiles, and switch on **Side job**. Set the most hours a week you can work (20 by default) and the least pay an hour you accept (the minimum wage by default); the roles start as Werkstudent, Aushilfe, Minijob, Teilzeit. Those jobs are scored on pay, hours, distance and language rather than your skills, never get the automatic full analysis, and show under **Side jobs** in the Inbox, apart from your career jobs.
- **Limits.** Settings, Discovery sets how many jobs get a full analysis per day, the score threshold for it, and the source weights. Web search is a separate switch, off by default.

## 6. Editing the rules

Rules decide how Stellio writes for you. Open Rules (`G R`) to edit `resume.md`, `cover-letter.md`, `skills-policy.md`, `referral-message.md` and the two LaTeX templates, with live lint and a test compile. Every save is a git commit; Reset to default and history are one click. If a file changes on disk while you edit, you choose between reloading and overwriting; nothing is lost silently.

## 7. Overleaf

Open in Overleaf creates a new Overleaf project from the LaTeX source in your browser (Stellio posts the source to `overleaf.com/docs` through a short-lived local form). The photo cannot travel with it: the project gets the resume without the photo; upload `photo.jpg` to the project and change `\resumephotofalse` to `\resumephototrue` to add it. Overleaf compiles with pdfLaTeX while the local preview uses Tectonic, so line breaks can differ slightly; Stellio warns when a one-page resume may spill over on Overleaf.

## 8. Referrals and their boundaries

For a job you care about, Stellio can find a few people who work at that company in a relevant role and draft a short message to each.

- It uses **public sources only**: web search results, company pages, public GitHub profiles, talks and personal sites. LinkedIn appears only as a public profile link found in search results. Stellio never logs in anywhere, never scrapes LinkedIn, and never uses data brokers.
- It records a contact (an email, a contact link) **only if the person published it** for professional contact. It never guesses an email address, and never collects phone numbers or home addresses.
- Every fact shows its source and the date it was seen.
- **Stellio never sends anything.** You copy the note or message and send it yourself.
- At most 25 people per search, for one company and role. Delete one person or all of them with one click; this also deletes the AI run logs that mention them. Database backups made earlier keep a copy until they are pruned (the 14 newest daily backups are kept). People you never contacted are deleted automatically after 90 days. The search run sees your schools, past employers and spoken languages (it is a web-search run); your city and project titles stay local.

## 9. Backups and restore

Settings, Backups lists the files in `~/Stellio/.stellio/backups`: database snapshots (a daily one, one before every upgrade that changes the database, and each Back up now; the 14 newest dailies and the 10 newest of each other kind are kept), and copies of profile or rules files made when git is missing. Open folder shows them in your file manager.

**Restore** replaces the database with a snapshot:

1. Choose Restore on a database snapshot and confirm. Restore is refused while a scan is running.
2. Stellio copies the snapshot aside and checks it (integrity, that it is a Stellio database, and that it was not made by a newer Stellio). If it fails any check, you get a message and nothing changes.
3. Stellio saves your current database as a `pre-restore` snapshot, swaps the files and restarts.

So a restore can itself be undone by restoring the `pre-restore` snapshot. Restore covers the database (jobs, applications, runs, settings). Your profile, rules and application files are plain files with git history; revert them from their own screens.

## 10. Privacy

- Everything is stored in your data folder and `~/.config/Stellio`. There is no telemetry and no account.
- Network traffic is limited to: the job sources you enabled, job pages you open or paste, the Claude CLI (which sends the prompt, your profile excerpt and the posting to Anthropic under your own subscription), the Tectonic download and LaTeX package fetches you start, Overleaf when you press Open in Overleaf, and the update check: at start and once a day Stellio asks GitHub for the newest release (nothing about you is sent) and downloads the update from there only when you press Download and install. Switch it off in Settings, General.
- Stellio never applies for you and never logs in to a job site or social network for you.
- The Adzuna key is encrypted with your system keyring.
- LaTeX compiles run in a sandbox with no network and no access to your files.

## 11. Troubleshooting

**How do I delete several jobs or people?** Press Select above the list (Workspace, Applications table, Referrals), pick rows, then Delete. Esc leaves the mode. A single job is deleted from its Status menu.

**How do I update?** A banner tells you when a new version is out. See what is new shows the changes; Download and install fetches the file from GitHub, checks its SHA-256 and installs it (a .deb asks for your password through the system prompt, an AppImage is replaced in place). Then press Restart Stellio. Your data folder is not touched. A copy installed any other way gets a link to the release page instead.

**The Claude CLI is not found or not logged in.** Settings, AI shows the state. Install the CLI, run `claude` in a terminal once and log in, then reopen Settings (the check is cached for up to 5 minutes). Stellio runs it from an empty folder with your user settings turned off, so your own hooks and plugins do not affect results.

**"Claude usage limit reached".** A banner appears at the top and background tasks pause. Your subscription's limit resets on its own; nothing is lost; run the task again after the reset (Activity, from the command palette, lists the failed run).

**"Secure LaTeX compile needs bubblewrap".** Install it: `sudo apt install bubblewrap`. Compiles are refused without it, by design. Some systems also block the sandbox with AppArmor; the Settings message says when the self-test fails.

**No PDF preview.** Settings, LaTeX: install Tectonic, then Download LaTeX packages once (compiles run offline afterwards). Without an engine you can still copy the LaTeX or open it in Overleaf.

**A scan found nothing or a source shows an error.** Settings, Sources shows the last success and the last error for each source. A single failing source does not stop the others.

**The timer does not run.** Settings, Schedule shows whether systemd is available in this session and when the timer runs next. A headless scan needs a graphical session for notifications and the system keyring.

**Where are the logs?** `~/.config/Stellio/logs/main.log` (rotated). AI runs have their own logs under the data folder and are listed in Activity. Logs never contain your API key.

**Start over.** Close Stellio and move `~/Stellio` aside; the next start seeds a fresh folder. Your old folder is not touched.
