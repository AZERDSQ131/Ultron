# ULTRON skills

Each subdirectory here is one skill: a `SKILL.md` with a short frontmatter
plus whatever instructions ULTRON needs for that kind of task. Only the
catalog (name + description of every skill) is injected into the system
prompt on every turn; the full body is loaded on demand via the `skill_read`
tool, so an unrelated skill costs no context until it's actually needed.

## Format

```
skills/<skill-name>/SKILL.md
```

```markdown
---
name: skill-name
description: One short sentence — this is what ULTRON sees on every turn to decide whether to read the rest.
---

Full instructions, steps, conventions, tool-usage notes...
```

`name` should match the directory name. `description` is the only thing
that's always "on" — keep it short and specific enough that ULTRON can tell
from it alone whether the skill applies to the current task.
