## Codex and Other Agents

Everything above is shared with Claude Code (`CLAUDE.md`). This section applies to Codex and other agents that read `AGENTS.md`.

- **Skills.** Where a rule points at `.claude/skills/<name>/SKILL.md`, read that file; it is plain Markdown and applies to you too.
- **Advisor quorum.** When a Claude session runs you with `codex exec` for a second opinion, stay read-only: no edits, commits, or GitHub writes. Report your position and the reasons.
- **Branch names.** Never use a `codex/` (or any agent/vendor) prefix. Use `fix/<issue>-<slug>`, `feat/<issue>-<slug>`, `docs/<slug>`, `chore/<slug>`, `ops/<slug>`, `hotfix/<slug>`; lowercase kebab-case. `pr-<N>` / `pr-<N>-review` only for inspecting an existing PR.
- **PR titles** follow `fix(scope): summary` / `feat(scope): summary` / `docs(scope): summary` / `chore(scope): summary`, with `(#1234)` when tied to an issue.
- **Linking issues.** `Closes #1234` when the PR fully resolves the issue (the default). `Refs #1234` only for a partial fix or a community report the reporter must verify, and then say in the body which half shipped. Repeat the keyword per issue: `Closes #X, closes #Y`.
