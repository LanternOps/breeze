/**
 * apps/api/src/worker.ts — `BREEZE_ROLE=worker` entrypoint (wave 3.5d-b, #4086).
 *
 * Deliberately imports NO route modules: the import-closure contract test
 * (`services/workerEntrypointClosure.contract.test.ts`, #4086 Task 5)
 * enforces this statically. `workerRegistry.ts`'s 104 entries are all behind
 * `load: () => import(...)` thunks specifically so this file's own STATIC
 * import graph never force-loads the route graph or `routes/agentWs.ts` —
 * only the entries actually selected for `role: 'worker'` (the `global`-
 * placement subset) get their modules loaded, and only at runtime.
 *
 * THIS FILE IS A PLACEHOLDER SHELL for Task 6 of the wave 3.5d-b plan
 * (docs/superpowers/plans/ai-mcp/2026-08-27-ai-agents-wave3.5d-b-role-split.md).
 * Task 5 (this commit) only needs the file to exist, with the role guard and
 * no forbidden imports, so the closure contract test has a real static
 * import graph to walk instead of asserting against a file that doesn't
 * exist yet. Task 6 fills in the full boot pipeline described in the plan:
 * config validation, Sentry, DB + migration parity wait (never `autoMigrate`),
 * mandatory Redis check, extension tenancy registration, event subscribers,
 * `startRegisteredWorkers('worker', ...)`, a slim raw-`node:http` health
 * server, and phased shutdown. Task 6 MODIFIES this file's body — it does
 * not recreate it — and must preserve this header's "no route imports"
 * contract.
 */
import 'dotenv/config';
import { breezeRole } from './config/env';

if (breezeRole() !== 'worker') {
  // This binary runs ONLY as the worker role — mirrors index.ts's inverse
  // guard (BREEZE_ROLE=worker refuses to boot dist/index.cjs).
  console.error('[boot] dist/worker.cjs requires BREEZE_ROLE=worker — got a different role, refusing to start.');
  process.exit(78); // EX_CONFIG
}

// TODO(#4086 Task 6): full boot pipeline — see the header comment above.
