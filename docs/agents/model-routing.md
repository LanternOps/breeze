# Model routing and Codex delegation

Moved verbatim from `CLAUDE.md` (2026-10-07).

## Model Routing (cost/speed strategy — benchmarked 2026-09-01)

**Expensive models write contracts and verify claims; cheap models do everything in between; mechanical checks replace expensive review wherever the work is gradeable.** Basis: two head-to-head benchmarks (blind bug-hunt + blind spec→codegen) across Laguna, Codex gpt-5.6-sol med/high, Haiku, Sonnet, Opus — see memory `model-benchmark-codex-claude-laguna-2026-09-01`.

1. **Spec-down (Fable/Opus in-session).** Spend top-tier tokens only on: resolving spec ambiguity, choosing contracts (tenancy shape, cascade lists, API surface), and cross-file reachability judgment. All six models aced a fully-resolved spec (39/39 each); 2 of 3 Claude PRIMARY bug claims died on a file the blind reviewer couldn't see. The orchestrator's value is the contract, not the typing.
2. **Generate cheap — route by access needs, not quality.** Laguna (free, local, ~10× faster): any paste-in-shaped work — spec'd modules, co-located tests, migration drafts from a stated contract. Codex `medium` (flat sub, ~0 marginal): well-scoped repo-touching edits and single-file bug-hunts. Haiku subagents: mechanical repo chores needing tools, with explicit file lists.
3. **Verify mechanically first.** tsc/tests/grep-the-contract before any model review — the cascade-list history is contract tests 5/5 vs human review 0/5. A hidden acceptance suite converts "needs expensive review" into "needs a script."
4. **Review sized by blast radius.** Default: Laguna + Codex `medium` in parallel (~free, ~1 min), orchestrator arbitrates — disagreement is signal; Laguna's hallucinations die at verification (it misread code 2× in the bench — never trust its line-level claims unre-read). Reserve Sonnet (precision: 4/4 real findings, 0 hallucinations) or Opus (depth: found the billing bug nobody else saw) for tenancy/auth/billing/agent-shipped code.
5. **Advisor quorum unchanged** — Fable + codex `xhigh` only for consequential, hard-to-reverse design (see Working Style).

## Codex Delegation

This project uses OpenAI Codex CLI for **read-only analysis (bug-hunting, security review, design-from-plan — its strongest uses) and well-scoped single-file edits** (utilities, co-located tests, CRUD endpoints, mechanical renames). Keep with Claude: repo-wide sweeps/enumeration, cross-module refactors (codex misses existing canonical code), UI work, and the *architecture* of multi-tenant/auth changes — though codex may *execute* an RLS migration once Claude hands it the tenancy contract. Default to `medium` (2026-09-01 bench: `medium` beat `high` on bug-hunts and tied on codegen); escalate to `high` only when medium comes back thin; reserve `xhigh` for open-ended design. Model is `gpt-6-astra` (GPT-6, switched 2026-09-06; `gpt-5.6-sol` is the fallback). For commands, reasoning levels, and the benchmarked delegation matrix, use the **`delegating-to-codex`** skill.

---

