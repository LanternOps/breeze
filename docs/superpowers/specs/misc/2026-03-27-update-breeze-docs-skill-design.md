# Update Breeze Docs Skill — Design Spec

**Date**: 2026-03-27
**Status**: Approved

## Overview

A Claude Code skill (`update-breeze-docs`) that updates the Breeze RMM Starlight technical documentation (`apps/docs/`) after code changes. Supports two entry modes: diff-driven (specific PR, version range) and manual targeting (specific doc by topic name). Uses `scripts/docs-review/mapping.json` for code-to-doc relationships and keeps it current.

## Skill Identity

- **Name**: `update-breeze-docs`
- **Location**: `~/.claude/skills/update-breeze-docs/skill.md`
- **Trigger phrases**: "update docs", "docs are stale", "update the [X] docs", "update docs for PR #N", "update docs since vX.Y.Z", "sync docs", "docs need updating"
- **Not this skill**: Release notes for the marketing site (`breezermm.com`) — use `update-breeze-release-notes` instead

## Entry Modes

### Diff Mode

Triggered by: "update docs for PR #285", "update docs since v0.14.0", "what docs need updating after the last 5 commits"

1. Get the diff (`gh pr diff N`, `git diff vA..vB`, or `git diff HEAD~N..HEAD`)
2. Extract changed files from the diff
3. Look up affected docs via `mapping.json` (forward lookup: code file → doc files)
4. For each affected doc: read the doc, read the relevant code diff, identify what's wrong/missing
5. Present a change plan (table format — see below)
6. After user approval, make the edits
7. Check for unmapped code files → update `mapping.json` if new relationships found

### Manual Mode

Triggered by: "update the patching docs", "the discovery docs are stale", "review the deployment docs"

1. Identify the target doc file(s) from the topic name (e.g., "patching" → `features/patch-management.mdx`)
2. Read the doc file
3. Use `mapping.json` in reverse to find the source files this doc covers (doc → code file patterns)
4. Read the current source code (route files, service files, agent code)
5. Compare what the doc says vs what the code does — identify gaps, inaccuracies, missing features
6. Present a change plan
7. After user approval, make the edits
8. Update `mapping.json` if new relationships discovered

## Change Plan Format

Before writing anything, present:

```
## Proposed Doc Updates

| File | Action | Details |
|------|--------|---------|
| features/patch-management.mdx | Update | Line 45: `installPatch` param renamed to `patchIds` |
| features/patch-management.mdx | Add | New section: "Auto-download before install" behavior |
| reference/api.mdx | Update | PATCH /patches endpoint — new `source` field |

New mapping: apps/api/src/routes/patchJobs.ts → features/patch-management.mdx
```

Wait for user approval before making edits.

## Edit Rules

- Fix factually wrong content (renamed params, changed behavior, new required fields)
- Add new sections for shipped features not yet documented
- Never delete or rewrite existing prose that is still correct
- Preserve frontmatter, Astro component imports, Starlight component usage
- Match the existing writing style of the doc file

## Mapping Management

### File Location

`scripts/docs-review/mapping.json`

### Forward Lookup (Diff Mode)

Code file changed → which docs cover it?

```
apps/api/src/routes/scripts.ts → features/scripts.mdx
```

### Reverse Lookup (Manual Mode)

Doc file targeted → which source files does it document?

```
features/patch-management.mdx → agent/internal/patching/**, apps/api/src/routes/patches.ts
```

### Auto-Update Rules

When the skill discovers a code file that affects a doc but has no mapping:
1. Add the mapping to `mapping.json`
2. Include it in the change plan output so the user sees it
3. Use the existing glob pattern style

When the skill discovers a mapping that points to a doc file that no longer exists:
1. Flag it in the output
2. Remove the stale mapping after confirmation

### Pattern Convention

Follow the existing style in `mapping.json`:
- Agent code: `agent/internal/<package>/**`
- API routes: `apps/api/src/routes/<file>.ts`
- API services: `apps/api/src/services/<file>.ts`
- API middleware: `apps/api/src/middleware/<file>.ts`
- DB schema: `apps/api/src/db/schema/**`
- Config files: exact filename (e.g., `.env.example`, `docker-compose*.yml`)

## Cross-Skill Reference

When the skill detects a post-release context (version range diff, multiple PRs, or user mentions "after the release"), append:

```
---
Docs updated. You may also want to run:
  /update-breeze-release-notes — to update the marketing site release notes
```

No shared logic or delegation — just a reminder.

## File Locations

| Purpose | Path |
|---------|------|
| Documentation files | `apps/docs/src/content/docs/**/*.mdx` |
| Doc sections | `agents/`, `deploy/`, `features/`, `getting-started/`, `monitoring/`, `reference/`, `security/` |
| Code-to-doc mapping | `scripts/docs-review/mapping.json` |
| Skill file | `~/.claude/skills/update-breeze-docs/skill.md` |

## Build Verification

After making edits, verify the docs site still builds:

```bash
cd apps/docs && npx astro build 2>&1 | tail -10
```

If the build fails (broken Astro component import, frontmatter error, etc.), fix the issue before finishing.

## Key Decisions

1. **Two entry modes**: diff-driven (PR/version range) and manual (topic name)
2. **Always show a change plan** before writing — no silent edits
3. **Moderate scope**: fix wrong facts + add missing content, never delete correct prose
4. **Keeps `mapping.json` current** as a side effect
5. **Cross-references** the release notes skill after release-context runs
6. **Build verification** after edits
