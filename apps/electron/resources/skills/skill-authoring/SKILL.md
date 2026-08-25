---
name: skill-authoring
description: Create reusable SKILL.md instruction sets that activate for a focused class of work.
---

# Skill authoring

Use this skill when creating or editing a workspace Skill. Read `~/.craft-agent/docs/skills.md` first.

Create `skills/<slug>/SKILL.md` with YAML frontmatter containing a concise `name` and a discriminating `description`. Use a lowercase-hyphenated folder name. The description should say what the skill does and when it applies, not list every possible task.

Keep the body focused on decisions the model would not otherwise know: workspace conventions, required inputs, safety constraints, output expectations, and any relevant local paths. Do not copy generic agent advice. Add supporting files only when the workflow genuinely needs reusable templates, scripts, or reference material.

Skills are invoked with `@` mention and may be overridden by project or workspace skills with the same slug. Validate the resulting skill after writing it, then summarize its trigger and intended outcome.
