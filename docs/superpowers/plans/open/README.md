# Open plans — up for grabs

> 📖 **New here? Read the guide first:**
> [Contributing → Coding with Claude Code](https://docs.breezermm.com/contributing/coding-with-claude-code/)
> (source: `apps/docs/src/content/docs/contributing/coding-with-claude-code.mdx`).
> It explains the plan-driven workflow end to end — how to pick up work here,
> propose your own, and hand it back ready to merge.

This folder is the **work queue** for contributors. Every plan document here is a
ready-to-implement work order whose approach is already agreed — picking one up
means the *what* and the *how* are signed off, so you can start building.

Everything in the parent `../` folder is **completed, shipped work** kept for
history. Don't mine it for things to do — only this `open/` folder is live.

## Current inbox

Seeded 2026-07-21 from a completion audit (269 plans, code-graph + memory
cross-check) followed by a merit review of the survivors. The audit's 15
not-done candidates were narrowed: 4 turned out already-shipped on `main` (moved
back to the archive), 2 cross-repo Weavestream plans left in place. These 9 are
the real open work, each merit-reviewed:

| Plan | Verdict | Note |
|---|---|---|
| `2026-07-18-action-intents-mcp-cutover.md` | ✅ do | Live gap: MCP API-key callers still auto-execute Tier-3 w/o approval (unlike UI). Wiring only — reuses shipped Plan-1 primitives. |
| `2026-06-16-1105-dbcontext-txn-architecture.md` | ✅ do | High-value reliability (#1697 reopened, prod conn-pool outages). Go straight to the Phase-1 tripwire; skip the re-audit. |
| `2026-07-01-partner-level-reports-design.md` | ✅ do | Strong MSP sales artifact. Dual-owner pattern now proven on 6 tables — easier than the plan assumed. |
| `2026-07-10-web-i18n-phase3-ssr-and-api-messages.md` | ✅ do ⚠️ | Fix first: plan hardcodes `['en','pt-BR']`, but 5 locales now ship — else 3 get English shells. |
| `2026-07-10-web-i18n-phase4-emails-pdfs-notifications.md` | ✅ do ⚠️ | Live FR-CA prospect gets English-only invoices today. Front-load billing PDFs; fix the locale list. |
| `2026-05-13-backup-cert-plan-1-foundation.md` | ✅ do ⚠️ | Add `backupRetention.ts` + `backupWorker.ts` to critical paths. Inert until Plan 2 produces manifests. |
| `2026-06-23-ml-device-instability-shadow-phase-a.md` | 🟨 revisit | Phase A plumbing is cheap; **hold Phase B** — competes with `reliabilityScoring` (still being tuned, #1908). |
| `2026-06-15-authenticator-registration-redesign.md` | 🔴 bug / ⛔ don't run as-written | Two live bugs: mobile approver reg 400s (#1890 re-added `currentPassword`, client not updated); browser approver reg **never worked** (`stores/authenticator.ts` never sent it, since #1369). Enforcing partners hard-blocked (403 ≥L2); others silently downgraded to L1. Mobile silent-fail already fixed (#2683). Fix: short-lived `authenticator:register` re-auth token + browser password field — do NOT drop `currentPassword`. Filed: **#2707**. |
| `2026-06-22-be16-vuln-mgmt-phase5-network-devices.md` | ❌ drop-candidate | Blocked on BE-30, which is an abandoned 5-month-stale branch. Plan admits "roadmap completeness." |

✅ do = greenlight (⚠️ = one tweak first). 🟨 revisit = do part, hold part.
🔴 = live bug, but not fixable by running this plan. ❌ = recommend dropping.

> Cross-repo Weavestream sync plans (`integrations/…weavestream-*`) are unfinished
> too but left in place — they execute in the separate Weavestream repo and can't
> be verified or worked from here.

## For contributors

1. Browse the `.md` files here. Each has a goal, architecture, tech stack, a
   linked design spec, and `- [ ]` task checkboxes.
2. Tell Todd you're taking one (so two people don't grab the same plan).
3. Build it — follow the full workflow in the
   [Coding with Claude Code](https://docs.breezermm.com/contributing/coding-with-claude-code/)
   guide.

Want to build something with no plan yet? Write the plan first (`brainstorming`
→ `writing-plans` skills), drop it here, and get a 👍 before you code.

## For maintainers

- Drop a plan here when it's ready to be handed off.
- When its PR merges, **move the plan out of `open/` into the parent `../`
  archive** so this folder only ever lists what's still available.
