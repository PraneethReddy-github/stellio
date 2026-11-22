---
# Machine-checked rules (linted after every draft). Edit freely.
version: 1
connection_note:
  max_chars: 300          # LinkedIn connection note limit
message:
  words: { min: 60, max: 140 }
  subject_max_chars: 70
match_language: true      # write in German if the person's public profile is in German
must_include:
  - role_title            # the exact job title
  - job_reference         # link or job ID
  - shared_ground         # one specific, true connection (same university, ex-employer, city, project, talk)
  - small_ask             # "would you be open to referring me / sharing a quick view of the team?"
banned_phrases:
  - I hope this message finds you well
  - I came across your profile
  - I'm reaching out because
  - dear sir or madam
  - pick your brain
  - quick question
  - huge fan
  - dream job
  - passionate
  - synergy
  - circle back
  - just checking in
first_person: true
---

# Referral message rules

Stellio gives these rules to the AI each time it drafts a referral request. The truth rules still apply:
- Everything about you comes from your profile.
- Everything about them comes from their public, cited sources.

## Connection note (LinkedIn, at most 300 characters)

1. One line on who you are and what you want: the role and the company.
2. One specific shared-ground point, if one exists. Never invent one.
3. Ask whether you can message them about the role. Do not ask for the referral yet.

## Message (after they accept, or by email)

1. **First line:** the role (exact title plus link or ID) and why you're writing to *them*, using their team, project, talk, or a shared background.
2. **Second:** two short, concrete proof points from your profile that match the role.
3. **Third:** a small, easy ask: "Would you be open to referring me, or telling me whether my background fits the team?" Offer to send your resume. Make saying no easy.
4. **Close** with thanks. Mention no attachments in the first message.

## Style

- Plain, warm, brief. It should read like a person wrote it for this one reader.
- Use their first name. No titles, unless the profile is in German and formal language fits. When writing in German, use "Sie" unless their public writing uses "du".
- No flattery that you can't back with a source. No pressure or guilt. No follow-up sooner than 7 days.
