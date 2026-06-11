# MCP Bootstrap UX: Signup-First Flow + Email Verification

**Status:** Plan superseded by 2026-04-28 — see `docs/superpowers/plans/2026-04-28-bootstrap-signup-flow.md` for the working document.

**Why this doc was kept:** It captured the architect's blueprint for the original `/activate/<token>` set-password refactor. That refactor is now a *subset* of the larger signup-first design — same set-password component, same auto-login pipeline, same audit pattern. Reference for code patterns; do not execute from this doc directly.

**Original gap:** `create_tenant` provisioned partner-admins with `passwordHash: null` and never set one. Activation email click marked email-verified but didn't take a password.

**Discarded approach:** Make `/activate/<token>` a set-password form (mirror `auth/invite.ts`). Still valid for the agent-provisioned-tenant case (a partner creates a tenant for one of their customers; that customer clicks the email link). But it's no longer the *primary* first-contact flow.

**New approach:** Self-service `/signup` page driven by Claude.ai's OAuth-forcing behavior. See the 2026-04-28 plan.
