---
version: 1
min_level_to_list: 2           # 1 aware · 2 basic · 3 working · 4 strong · 5 expert
allow_learning_skills: false   # if true, learning skills may appear, suffixed per label below
learning_label: "(learning)"
recency_cutoff_years: 5        # skills unused longer than this are not listed unless JD-required
max_skills_listed: 24
always_pin: []                 # skills that always appear, e.g. [Python, SQL]
never_show: []                 # skills that never appear on resumes
adjacent_skill_prompt: true    # ask "do you have X?" when JD wants a close relative of a profile skill
ghost_skill_policy: block      # block | warn — skills on the page with no profile backing
---

# Skills policy

How Stellio judges skills when tailoring a resume and auditing it.

1. A skill may appear on a resume only if it is in the profile with status `have` and level ≥ `min_level_to_list`, or you approved it for that job in the skill audit.
2. A skill must have evidence (an experience or project id) to be emphasized in bullets. Skills without evidence may appear only in the skills section.
3. JD-required skills you lack are never added. They go to the skill audit as **learn** or **do you have this?**.
4. "Learn" recommendations are ranked by how often the skill is required across your target jobs, not by one job.
5. Learning-time estimates are estimates and are always labelled as such.
