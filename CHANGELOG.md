# Changelog

## Unreleased

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
