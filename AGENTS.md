# Repository Agent Rules

## Working Style

- Make changes in small, sequential steps.
- Do not batch risky or unrelated edits into one large patch.
- Do not say or attempt "I will apply everything in one patch" for multi-step fixes.
- Never try to fix a multi-file problem with one large patch. Edit one file at a time, validate it, then move to the next file.
- Prefer editing one file at a time, then validate that file before moving to the next.
- If a task spans multiple files, finish and verify each file slice separately.

## Communication

- Communicate with the user in Turkish.
- Keep UI text, code comments, and developer-facing strings in English unless the repository already requires another language.

## UI / Product Work

- Match existing product layouts closely when the user provides screenshots or a reference implementation.
- Do not improvise major layout changes when the target structure is already specified by the user.