---
# Machine-checked rules (linted in code after every generation). Edit freely.
version: 1
page_limit: 1
sections_order: [header, summary, experience, projects, skills, education, certifications]
sections_required: [header, experience, skills, education]
summary:
  enabled: true
  max_words: 50
experience:
  max_roles: 4
  bullets_per_role: { min: 2, max: 5 }
  most_recent_role_bullets_max: 6
projects:
  max: 3
  bullets_per_project: { min: 1, max: 3 }
bullet:
  min_chars: 60
  max_chars: 190
  must_start_with_verb: true
  tense: past_for_past_roles_present_for_current
skills_section:
  max_lines: 4
  max_skills: 24
date_format: "MMM YYYY"     # Jan 2025 – Present
photo: false
banned_words:
  - spearheaded
  - synergy
  - leveraged
  - utilized
  - passionate
  - results-driven
  - dynamic
  - go-getter
  - team player
  - hardworking
  - detail-oriented
  - cutting-edge
  - seamless
  - robust
  - delve
  - tapestry
  - showcase
  - pivotal
  - innovative
  - responsible for
  - various
first_person: false          # no "I", "my"
---

# Resume rules

These rules are given to the AI on every resume generation and override its style defaults. They never override the truth rules (everything must come from the profile).

## Goal

A one-page resume a recruiter can scan in 10 seconds and an ATS can parse cleanly, tailored to one job.

## Content selection

1. Lead with what the job asks for. Order experience bullets by relevance to the JD's required qualifications, not by chronology within a role.
2. Keep roles in reverse-chronological order. Never reorder roles.
3. Include a project only if it shows a required or preferred skill that experience doesn't already show.
4. Drop content that is irrelevant to this job before shortening relevant content.
5. Never leave an unexplained gap: if a role is dropped for space, keep it as a one-line entry (title, company, dates) with no bullets.

## Bullet writing

1. Pattern: **action verb + what you did + how/with what + measurable result**. Result first when it is strong.
2. Use only numbers present in the profile. If a fact has no number, do not invent one; describe scope instead (team size, users, data volume — only if in profile).
3. Use the JD's exact terminology when it is true for you (JD says "PostgreSQL", profile says "Postgres" → write "PostgreSQL").
4. One idea per bullet. No semicolon chains.
5. No filler adjectives. No banned words (front matter).
6. Each bullet should fit on at most two lines of the template.

## Summary

Two sentences, max 50 words: who you are (role + years + domain) and the 2–3 strongest matches with this job. No objective statements ("seeking a role…").

## Skills section

1. Grouped lines by category, e.g. `Languages: Python, SQL` · `Data: Airflow, dbt, Spark` · `Cloud & Tools: AWS, Docker, Git`.
2. JD-required skills you have come first in each line.
3. Only skills with status `have` and level ≥ 2 (see skills-policy.md). No soft skills in this section.
4. No proficiency bars, stars, or percentages.

## Formatting (enforced by template; listed so you can change it)

- Single column, no tables for layout, no icons, no photo, no colours other than the template accent for name and links.
- Standard headings: Summary, Experience, Projects, Skills, Education, Certifications.
- Header: name, location (city, country), email, phone, LinkedIn, GitHub/portfolio. No full address, no date of birth, no marital status.
- Dates right-aligned, format `Jan 2025 – Present`.
- File name: `Firstname_Lastname_Resume_<Company>.pdf`.

## Things never to do

- Never invent employers, titles, dates, degrees, certifications, numbers, or skills.
- Never copy whole sentences from the job description.
- Never use first person.
- Never include references or "references available on request".
