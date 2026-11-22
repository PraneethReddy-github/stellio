# Changelog

## 1.0.0

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
