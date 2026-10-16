---
description: "Open the Breeze GH queue (PRs · Discussions · Issues · Advisories)"
---

Invoke the `gh-queue` skill via the Skill tool, then follow its workflow: read `queue.md` for current state, cross-check live state for all four types (`gh pr list`, the discussions GraphQL query, `gh issue list`, and security advisories per §1a — API for state, the logged-in advisory page for comments — all on `LanternOps/breeze`), and report what's waiting on me. Advisory comments are not in the API and `updated_at` does not move on a comment, so read each page. Ask what to do next (triage round, deep-review a specific PR/discussion/issue/advisory, or close out resolved ones).
