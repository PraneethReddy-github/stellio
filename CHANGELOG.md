# Changelog

## Unreleased

## 1.2.3 — 2026-11-28

- Side-job check: a side job's Fit tab checks pay, hours, place, language and what the job asks for against your side-job limits, each with the posting's own words, and gives Take it / Maybe / Skip. Its score shows in the Inbox.
- Re-scoring side jobs while their search profile is switched off keeps that profile's hours and pay limits.

## 1.2.2 — 2026-11-28

- Full posting text: when a job board sent only part of a posting (it ends in "…"), Fetch full text reads the posting page again, or Paste full text takes the text you copy from it. Stellio reads it again and re-scores the job; a fit analysis made before says the posting changed. The Inbox panel can show the whole saved text, not only the summary.

## 1.2.1 — 2026-11-28

- Re-score in the Inbox: score again the unscored jobs, every job in the list, or those scored before you changed your profile, with progress and Cancel. One job: Re-score (or Score now) in its Score section.

## 1.2.0 — 2026-11-28

- Side jobs: a search profile can be a side job (part-time work for money). Stellio asks the Arbeitsagentur and Adzuna for part-time and minijob listings, drops full-time posts and posts with too many hours or too little pay an hour, and scores them on pay, hours, distance and language instead of your skills. They show under Side jobs in the Inbox and never use up the daily full analyses.

## 1.1.1 — 2026-11-28

- The PDF preview shows every page. A two-page resume used to preview as page 1 only.
- Lists open the row you click. In a long list (Inbox, Workspace, Applications and others), the first click on a lower row used to open the first job instead.

## 1.1.0 — 2026-11-26

- New default resume template: photo and contact block, Summary, Education as a table, Experience, Projects with a link symbol, Publications, Patents, Technical Skills, Certifications, Miscellaneous (positions, achievements, languages) and "Last updated". Resumes may run to two pages.
- Resume photo: Profile, Resume photo. Pick a PNG or JPEG; Stellio keeps a small copy and shows it on your resumes.
- German version: one button on a drafted resume or cover letter makes a German translation as a new version, with German headings and dates. It keeps every fact; Stellio checks that no number, technical term or company name was added.
- Cover letters are laid out like a German business letter: your postal address (new Profile field, letters only), "Place, DD.MM.YYYY", "Application for the position of …" and a signature line. The letter says how you found the job when Stellio knows it.
- New profile section `## Patents`; projects show their link, education its grade.
- Letters such as ß, ł, ř and ō now print correctly in PDFs (ß used to print as "SS").
- If you never changed the old default rules and templates, they are replaced by the new ones at start (the old text stays in History). Edited files stay as they are; Rules, Default shows the difference. Templates you made yourself keep working.
- LaTeX: the new template needs a few more packages, so Settings, LaTeX may ask for one more warm-up.

## 1.0.4 — 2026-11-25

- Update from inside Stellio: the banner opens a "what is new" window with the changes of every version you missed. Download and install fetches the update, checks its SHA-256 and installs it (a .deb asks for your password, an AppImage is replaced in place); then restart with one click.

## 1.0.3 — 2026-11-25

- Delete several at once: press Select above the Workspace job list, the Applications table or Referrals, pick rows, then Delete (one confirmation). Checkboxes show only while selecting.

## 1.0.2 — 2026-11-25

- Update check: a banner tells you when a new version is out and links to its download page. It asks GitHub at start and once a day; switch it off in Settings, General, or use Check now there.

## 1.0.1 — 2026-11-25

- Claude CLI is found when Stellio is started from a desktop menu: the per-user install folders (such as `~/.local/bin`) are now searched too.
- The Adzuna key can be saved on KDE when KWallet is switched off and GNOME Keyring is running.
- The sidebar collapses when the mouse leaves it after a click.
- Settings: jumping to Backups (or any section) no longer pushes the window out of place.
- "Set up in Settings" for LaTeX opens the LaTeX section, and section links stay in place while the page loads.
- The focus ring of inputs is no longer cut off on some sides.
- Full-screen and maximised windows: every screen uses the full width instead of staying on the left.

## 1.0.0 — 2026-11-22

First release.

- **Profile:** one Markdown file is the single source of truth about you. It has a form view and a raw editor with live checks, can import an old resume (PDF, TeX or text) as a draft you review, and keeps its history in git with restore.
- **Rules and templates:** editable resume, cover letter, skills-policy and referral-message rules, plus Overleaf-compatible LaTeX templates. They have live checks, history, reset to default, and a test compile with a PDF preview.
- **Job discovery:** daily scans of Arbeitnow, Bundesagentur für Arbeit, Remotive, RemoteOK, Himalayas, Adzuna (optional key), a company watchlist (Greenhouse, Lever, Ashby, SmartRecruiters, Workable) and an optional web-search agent.
  - Pipeline: hard filters, deduplication across sources, triage, then full analysis for strong matches. Results land in a ranked Inbox.
  - The scan can also run with the app closed, through a systemd user timer.
- **Job intake and fit:** paste a link or text. The fit score comes with reasons, evidence linked to your profile, missing skills, red flags and a verdict.
- **Resumes and cover letters:**
  - The model returns structured content. Code renders the LaTeX and takes facts from your profile.
  - Truth, ATS and rules checks run on every version, with one automatic repair round.
  - You also get versions, revise-by-instruction, manual edits, export, and Open in Overleaf.
- **Skill audit:** keep, remove, learn, or add to profile for every skill on a resume. Your choices are remembered when you regenerate. There is also a skill ledger, gaps, and a learning roadmap with what-if.
- **Applications:** board, table and timeline, with interviews, contacts, notes and follow-up reminders. Applying freezes the exact files you sent into their own folder.
- **Referrals:** public-source contacts for a job, ranked by shared background, with drafted connection notes and messages. Delete and retention controls included.
- **Today and Insights:** a dashboard of what needs you, the funnel, weekly activity, response rates by segment, and questions answered from your own numbers.
- **Security and safety:** sandboxed renderer, strict CSP, SSRF-guarded fetching, sandboxed LaTeX, encrypted API keys, a backup before every risky write, guarded backup restore, and hardened release builds.
