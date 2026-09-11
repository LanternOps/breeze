# W01b — Proposals, execution source, scanner, and tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an AI chat session or headless agent can author a script as an immutable, content-addressed `script_proposals` row, and `run_script { proposalId }` validates it, resolves a non-null effect digest, is guarded at the right approval scope, and dispatches a first-class proposal-backed `script_executions` row — all behind `BREEZE_AI_SCRIPT_AUTHORING_ENABLED`, with no reviewer yet (W02), so nothing is actually runnable until a proposal can reach `reviewed`.

**Architecture:** two new org-scoped (RLS shape 1) tables; `script_executions` gains a `source_kind` discriminator plus snapshot and provenance columns so readers stop joining `scripts`; `scripts` gains birth provenance; the existing shared script-security mirror grows a BASIC list and a deterministic touch classifier; a new `services/scriptProposals/` module owns creation, runnability, guardrail context, dispatch snapshot and the (W02-implemented) review queue; `aiGuardrails.checkGuardrails` gains an optional, DB-free third parameter so the proposal's persisted risk tier can pick `supervised` vs `four_eyes` without the guardrail module importing schema.

**Tech Stack:** Hono + TypeScript, Drizzle ORM, PostgreSQL with forced RLS, BullMQ + Redis, Vitest, Zod, `@breeze/shared`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md`
**Roadmap / cross-wave contracts:** `docs/superpowers/plans/ai-mcp/2026-09-11-ai-script-authoring-roadmap.md`

---

## Global Constraints

Every task inherits all of these.

- **Feature flag** `BREEZE_AI_SCRIPT_AUTHORING_ENABLED`, env-read, default `false`. When off: `propose_script` / `get_script_proposal` are not offered to any model, and `run_script { proposalId }` returns a tool error `feature_disabled`.
- **Migration slots are fixed** (roadmap §2): `2026-10-16-100100-script-proposals.sql`, `2026-10-16-100200-script-executions-source.sql`, `2026-10-16-100300-scripts-origin.sql`. They must sort after the newest shipped migration, verified at `apps/api/migrations/` — currently `2026-10-15-170200-organization-key-dates.sql`. Re-verify at push with `scripts/check-migration-naming.sh --against-ref origin/main`.
- **Migrations are idempotent** (`CREATE TABLE IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `pg_policies` existence checks) and contain **no inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file in a transaction.
- **Any migration that writes rows elects system scope first**: `SELECT set_config('breeze.scope', 'system', true);` before the first `UPDATE`/`DELETE`/`INSERT`, and reports counts via `GET DIAGNOSTICS` + `RAISE WARNING`. Enforced by `apps/api/src/db/migrationRlsScope.test.ts`.
- **Tenancy shape 1** for both new tables: `org_id uuid NOT NULL REFERENCES organizations(id)`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, four `breeze_has_org_access(org_id)` policies, `GRANT … TO breeze_app`. `breeze_has_org_access` already returns TRUE under system scope (`apps/api/migrations/0001-baseline.sql:1663-1671`), so no separate system branch is written. Shape-1 tables are **auto-discovered** by `rls-coverage.integration.test.ts:1127-1137` — no allowlist entry.
- **Composite FKs that reference an `org_id` column are `DEFERRABLE INITIALLY IMMEDIATE`** (org merge runs `SET CONSTRAINTS ALL DEFERRED`).
- **Cascade registration is a separate contract from RLS.** Every new `org_id` table joins `CORE_ORG_CASCADE_DELETE_ORDER`; every new **column** on an already-registered org-cascade table (`scripts`, `script_executions`) must be classified in `CORE_TENANT_EXPORT_POLICY`.
- **Export buckets** (`apps/api/src/services/tenantExportPolicyRegistry.ts:4-39`): `included`, `reviewedIncluded` (name matches `SUSPICIOUS_NAME_PARTS`, reviewed non-secret), `excludedSensitive`, `excludedOpen` (**every** `json`/`jsonb`/`bytea` column). You never hand-write `reviewedSensitiveName: true` — the bucket supplies it.
- **`aiGuardrails.ts` must not import the tool registry or DB schema** — `aiGuardrails.imports.contract.test.ts` greps for `from './aiToolSchemas'` and `getToolDefinitions`.
- **No new agent-facing payload fields.** A proposal dispatches through the existing script payload shape; `agent/` is untouched in this wave.
- **Tests sit beside source.** Run one API file with `cd apps/api && npx vitest run <path>` (never `pnpm --filter … test -- --run`). Integration suites need `pnpm test-stack up` and are run explicitly before PR.
- **`packages/shared` has no `./utils` subpath export** (`packages/shared/package.json` exports map) — utils are reachable only through the root barrel `@breeze/shared`. Types and validators also have `./types` and `./validators` subpaths.
- **W01a is assumed merged.** This wave consumes `cutScriptVersion`, `headScriptVersion`, `sha256Content` from `apps/api/src/services/scriptVersions.ts` exactly as roadmap §3.2 declares them, and the `script_origin` enum + `script_versions` provenance columns created by `2026-10-16-100000-script-versions-immutable.sql`.
- **Every task ends with a commit.**

### Shared-type ordering note (roadmap §3.1 vs §3.2)

Roadmap §3.2 has W01a's `ScriptVersionProvenance` consume `ScriptOrigin` and `ScriptApprovalMethod`, but §3.1 assigns `packages/shared/src/types/scriptProposals.ts` to W01b. That is circular. **Resolution used here:** Task 4 writes the complete file including `ScriptOrigin` and `ScriptApprovalMethod`. If W01a already created the file with those two types, keep them byte-identical and append the rest; the Task 4 code block is the full intended end state either way.

---

## File Structure

**Created**
- `packages/shared/src/types/scriptProposals.ts` — DTO shapes read by API/web/mobile/helper.
- `packages/shared/src/validators/scriptProposals.ts` — Zod: verification claim union, `propose_script` input, status/tier vocabularies.
- `apps/api/migrations/2026-10-16-100100-script-proposals.sql`
- `apps/api/migrations/2026-10-16-100200-script-executions-source.sql`
- `apps/api/migrations/2026-10-16-100300-scripts-origin.sql`
- `apps/api/src/db/schema/scriptProposals.ts`
- `apps/api/src/services/scriptProposals/{index,proposals,runnable,guardrailContext,dispatchSnapshot,reviewQueue}.ts`
- `apps/api/src/services/aiToolsScriptProposals.ts`
- integration suites under `apps/api/src/__tests__/integration/`

**Modified**
- `packages/shared/src/utils/scriptSecurityPatterns.ts` (+ its test) — BASIC mirror, touch classifier, `scanScriptContent`, `SCANNER_VERSION`.
- `packages/shared/src/{types,validators}/index.ts`, `packages/shared/src/utils/index.ts` — barrels.
- `apps/api/src/config/{env.ts,validate.ts}` — the flag.
- `apps/api/src/db/schema/{scripts.ts,index.ts}`.
- `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `orgMergeCustomExecutors.ts`.
- `apps/api/src/services/aiGuardrails.ts` (+ `GuardrailContext`, `checkAgentGuardrails` passthrough).
- `apps/api/src/services/actionIntents/{intentService.ts,effectDigest.ts}`.
- `apps/api/src/services/{aiAgentSdk.ts,aiAgentSdkTools.ts,aiTools.ts,aiToolSchemas.ts,aiToolsScripts.ts,scriptDispatch.ts}`.
- `apps/api/src/services/aiAgents/{runLoop.ts,agentToolCatalog.ts}`.
- `apps/api/src/jobs/staleCommandReaper.ts`, `apps/api/src/routes/scripts.ts`.
- `apps/web/src/locales/*/settings.json` (8 locales) — new capability group copy.

---

### Task 1: Feature flag `BREEZE_AI_SCRIPT_AUTHORING_ENABLED`

**Files:**
- Modify: `apps/api/src/config/env.ts:111-113` (pattern), `apps/api/src/config/validate.ts:623-626` and `:1814-1823`
- Modify: `.env.example`, `docker-compose.yml`
- Test: `apps/api/src/config/env.aiScriptAuthoringEnabled.test.ts` (new)

**Interfaces:**
- Produces: `aiScriptAuthoringEnabled(): boolean` from `apps/api/src/config/env.ts`. Call-time (not module-const) so tests can flip `process.env` without `vi.resetModules()`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/config/env.aiScriptAuthoringEnabled.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { aiScriptAuthoringEnabled } from './env';

const KEY = 'BREEZE_AI_SCRIPT_AUTHORING_ENABLED';
afterEach(() => { delete process.env[KEY]; });

describe('aiScriptAuthoringEnabled()', () => {
  it.each([undefined, '', 'false', '0', 'no', 'off', 'garbage'])('is false for %s', (value) => {
    if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value;
    expect(aiScriptAuthoringEnabled()).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE', '  true  '])('is true for %s', (value) => {
    process.env[KEY] = value;
    expect(aiScriptAuthoringEnabled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/config/env.aiScriptAuthoringEnabled.test.ts`
Expected: FAIL — `aiScriptAuthoringEnabled` is not exported from `./env`.

- [ ] **Step 3: Add the flag reader**

In `apps/api/src/config/env.ts`, beside `policyDecideEnabled()` (`:111-113`):

```ts
/**
 * AI script authoring, review, and reviewer-gated execution (spec
 * 2026-09-11-ai-script-authoring-and-review-design.md). Default OFF until W03.
 * Call-time, not a module const: the flag is read per tool-registration and per
 * run_script call, and tests flip it without vi.resetModules().
 */
export function aiScriptAuthoringEnabled(): boolean {
  return envFlag('BREEZE_AI_SCRIPT_AUTHORING_ENABLED', false);
}
```

- [ ] **Step 4: Declare it in the config schema and the typo guard**

In `apps/api/src/config/validate.ts`, in `envObjectSchema.shape` beside `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` (`:623-626`):

```ts
    // AI script authoring (W01b). Read at runtime by aiScriptAuthoringEnabled()
    // in env.ts. Validated here for boolean format only.
    BREEZE_AI_SCRIPT_AUTHORING_ENABLED: z.string().optional(),
```

and in the `superRefine` block beside the policy-decide guard (`:1814-1823`):

```ts
    const scriptAuthoringRaw = (data.BREEZE_AI_SCRIPT_AUTHORING_ENABLED ?? '').trim().toLowerCase();
    if (scriptAuthoringRaw && !boolValues.has(scriptAuthoringRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BREEZE_AI_SCRIPT_AUTHORING_ENABLED'],
        message:
          'BREEZE_AI_SCRIPT_AUTHORING_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to false (AI script authoring is dark).',
      });
    }
```

- [ ] **Step 5: Add the env/compose parity entries**

`.env.example` (near the other `BREEZE_AI_*` lines):

```
# AI script authoring, independent review and reviewer-gated execution. Default off.
BREEZE_AI_SCRIPT_AUTHORING_ENABLED=false
```

`docker-compose.yml`, in the `api` service `environment:` block (compose interpolation only happens for vars listed there):

```yaml
      BREEZE_AI_SCRIPT_AUTHORING_ENABLED: ${BREEZE_AI_SCRIPT_AUTHORING_ENABLED:-false}
```

- [ ] **Step 6: Run the flag test plus the two drift contracts**

Run: `cd apps/api && npx vitest run src/config/env.aiScriptAuthoringEnabled.test.ts src/config/validate.test.ts src/config/envComposeParity.test.ts`
Expected: PASS. `validate.test.ts:2492` asserts every `ENV_SCHEMA_KEYS` entry is actually read; `envComposeParity.test.ts` asserts schema/`.env.example`/compose agree.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/config/env.ts apps/api/src/config/validate.ts \
  apps/api/src/config/env.aiScriptAuthoringEnabled.test.ts .env.example docker-compose.yml
git commit -m "feat(ai): add BREEZE_AI_SCRIPT_AUTHORING_ENABLED feature flag (default off)"
```

---

### Task 2: Mirror the agent's BASIC patterns in the shared scanner

**Files:**
- Modify: `packages/shared/src/utils/scriptSecurityPatterns.ts` (317 lines today; STRICT list `:84-261`, `decodeObfuscated` `:56-60`, `detectStrictScriptPatterns` `:305-317`)
- Modify: `packages/shared/src/utils/scriptSecurityPatterns.test.ts` (parser `:28-67`, parity suite `:69-117`)
- Reads: `agent/internal/executor/security.go:47-78` (the 21 BASIC entries, fields `pattern` / `desc`)

**Interfaces:**
- Produces: `BASIC_SCRIPT_PATTERNS`, `BASIC_SCRIPT_PATTERN_DESCRIPTIONS`, `detectBasicScriptPatterns(content: string): string[]`.

- [ ] **Step 1: Generalise the Go parser in the test, then write the failing BASIC parity test**

Replace `parseGoStrictPatterns()` (`scriptSecurityPatterns.test.ts:28-67`) with a list-name parameter, keeping the body identical otherwise, and add the BASIC suite:

```ts
function parseGoPatterns(listName: 'basicPatterns' | 'strictPatterns'): GoPattern[] {
  const source = readFileSync(GO_SECURITY_SOURCE, 'utf8');
  const start = source.indexOf(`${listName} := []struct {`);
  if (start === -1) throw new Error(`${listName} literal not found in security.go`);
  const bodyStart = source.indexOf('}{', start);
  if (bodyStart === -1) throw new Error(`${listName} literal body not found`);
  const bodyEnd = source.indexOf('\n\t}\n', bodyStart);
  if (bodyEnd === -1) throw new Error(`${listName} literal terminator not found`);
  const body = source.slice(bodyStart + 2, bodyEnd);
  // …unchanged rawEntry / obfuscatedEntry loop from the existing parser…
  return patterns;
}
function parseGoStrictPatterns(): GoPattern[] { return parseGoPatterns('strictPatterns'); }

describe('basic script pattern mirror matches the Go validator', () => {
  const goBasic = parseGoPatterns('basicPatterns');

  it('parses a non-trivial number of BASIC patterns out of security.go', () => {
    expect(goBasic.length).toBeGreaterThan(15);
  });

  it('mirrors every Go basic pattern source in order', () => {
    expect(BASIC_SCRIPT_PATTERNS.map((p) => p.source)).toEqual(goBasic.map((p) => p.source));
  });

  it('mirrors every Go basic pattern description byte-for-byte', () => {
    expect(BASIC_SCRIPT_PATTERNS.map((p) => p.description)).toEqual(goBasic.map((p) => p.description));
  });

  it('shares no description with the STRICT list — basic is never acknowledgeable', () => {
    const strict = new Set(STRICT_SCRIPT_PATTERN_DESCRIPTIONS);
    expect(BASIC_SCRIPT_PATTERN_DESCRIPTIONS.filter((d) => strict.has(d))).toEqual([]);
  });

  it('matches a fork bomb and does not match an ordinary cleanup script', () => {
    expect(detectBasicScriptPatterns(':(){ :|:& };:')).toEqual(['fork bomb pattern']);
    expect(detectBasicScriptPatterns('Remove-Item -Recurse -Force C:\\Temp\\cache')).toEqual([]);
  });
});
```

Import `BASIC_SCRIPT_PATTERNS`, `BASIC_SCRIPT_PATTERN_DESCRIPTIONS`, `detectBasicScriptPatterns` at the top of the test file.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/utils/scriptSecurityPatterns.test.ts`
Expected: FAIL — `BASIC_SCRIPT_PATTERNS` is not exported.

- [ ] **Step 3: Add the BASIC list, verbatim from the Go source**

In `packages/shared/src/utils/scriptSecurityPatterns.ts`, above the STRICT list:

```ts
/**
 * Web/API mirror of the agent's BASIC-level patterns
 * (`agent/internal/executor/security.go`, `basicPatterns`).
 *
 * BASIC patterns are UNCONDITIONAL on the device: unlike STRICT they can never
 * be acknowledged, so this mirror carries no `explanation` — there is no
 * acknowledgement UI for it. Its only consumer is the proposal scanner, which
 * rejects a proposal outright on a hit (spec §4.4) rather than sending it to a
 * reviewer or a human.
 *
 * The same fail-safe argument as the STRICT mirror holds in both directions: a
 * BASIC pattern this file misses is still blocked by the agent at execution
 * (the proposal simply fails on the device instead of at authoring time), and a
 * pattern only this file matches rejects a harmless proposal early. Neither
 * direction can loosen the agent.
 */
export type BasicScriptPattern = {
  /** The regex source, mirroring the Go pattern verbatim, matched with `(?i)`. */
  readonly source: string;
  /** The agent's description string, byte-for-byte. */
  readonly description: string;
};

export const BASIC_SCRIPT_PATTERNS: readonly BasicScriptPattern[] = [
  // Unix dangerous patterns
  { source: String.raw`rm\s+-[rR]f?\s+/\s*$`, description: 'recursive delete on root directory' },
  { source: String.raw`rm\s+-[rR]f?\s+/\*`, description: 'recursive delete on root wildcard' },
  { source: String.raw`rm\s+-[rR]f?\s+/[a-z]+\s*$`, description: 'recursive delete on system directory' },
  { source: String.raw`mkfs\s+`, description: 'filesystem format command' },
  { source: String.raw`dd\s+.*of=/dev/[hs]d`, description: 'direct disk write to block device' },
  { source: String.raw`>\s*/dev/[hs]d`, description: 'redirect to block device' },
  { source: String.raw`chmod\s+-[rR]\s+[0-7]*777\s+/`, description: 'dangerous recursive chmod on root' },
  { source: String.raw`chown\s+-[rR]\s+.*\s+/\s*$`, description: 'dangerous recursive chown on root' },
  { source: String.raw`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, description: 'fork bomb pattern' },
  { source: String.raw`/dev/null\s*>\s*/etc/passwd`, description: 'attempt to destroy passwd file' },
  { source: String.raw`echo\s+.*>\s*/etc/shadow`, description: 'attempt to modify shadow file' },

  // Windows dangerous patterns
  { source: String.raw`format\s+[a-zA-Z]:`, description: 'disk format command' },
  { source: String.raw`del\s+/[fFsS]\s+[a-zA-Z]:\\Windows`, description: 'Windows system file deletion' },
  { source: String.raw`rd\s+/[sS]\s+/[qQ]\s+[a-zA-Z]:\\Windows`, description: 'Windows directory deletion' },
  { source: String.raw`rd\s+/[sS]\s+/[qQ]\s+[a-zA-Z]:\\Program`, description: 'Program Files deletion' },
  { source: String.raw`attrib\s+.*[a-zA-Z]:\\Windows`, description: 'modify Windows file attributes' },

  // PowerShell dangerous patterns
  { source: String.raw`Remove-Item\s+-Recurse\s+-Force\s+[A-Z]:\\Windows`, description: 'PowerShell Windows deletion' },
  { source: String.raw`Remove-Item\s+-Recurse\s+-Force\s+/`, description: 'PowerShell root deletion' },
  { source: String.raw`Format-Volume`, description: 'PowerShell volume format' },
  { source: String.raw`Clear-Disk`, description: 'PowerShell disk clear' },
  { source: String.raw`Initialize-Disk`, description: 'PowerShell disk initialize' },
] as const;

export const BASIC_SCRIPT_PATTERN_DESCRIPTIONS: readonly string[] = [
  ...new Set(BASIC_SCRIPT_PATTERNS.map((pattern) => pattern.description)),
];

const COMPILED_BASIC_PATTERNS: readonly { regex: RegExp; description: string }[] =
  BASIC_SCRIPT_PATTERNS.map((pattern) => ({
    // `i` mirrors the agent's `(?i)` prefix. No `s` flag, same reason as STRICT.
    regex: new RegExp(pattern.source, 'i'),
    description: pattern.description,
  }));

/** The BASIC-level descriptions this content matches, deduped, in the agent's order. */
export function detectBasicScriptPatterns(content: string): string[] {
  if (!content) return [];
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const { regex, description } of COMPILED_BASIC_PATTERNS) {
    if (seen.has(description)) continue;
    if (regex.test(content)) {
      seen.add(description);
      matched.push(description);
    }
  }
  return matched;
}
```

- [ ] **Step 4: Run the suite to green**

Run: `cd packages/shared && npx vitest run src/utils/scriptSecurityPatterns.test.ts`
Expected: PASS, including the pre-existing STRICT parity tests (the generalised parser must not change their results).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/scriptSecurityPatterns.ts packages/shared/src/utils/scriptSecurityPatterns.test.ts
git commit -m "feat(shared): mirror the agent's BASIC script security patterns with Go-source parity"
```

---

### Task 3: Touch classifier, `scanScriptContent`, and `SCANNER_VERSION`

**Files:**
- Modify: `packages/shared/src/utils/scriptSecurityPatterns.ts`
- Test: `packages/shared/src/utils/scriptScanner.test.ts` (new — the classifier has no Go counterpart, so it lives beside the parity suite rather than inside it)

**Interfaces:**
- Consumes: `detectBasicScriptPatterns`, `detectStrictScriptPatterns` (Task 2 / existing `:305`), `ScriptLanguage` (`packages/shared/src/types/index.ts:389`).
- Produces, exactly as roadmap §3.1 declares:
  ```ts
  export const SCANNER_VERSION = '2026-09-11.1';
  export const TOUCH_CLASSES = [...] as const;
  export type TouchClass = (typeof TOUCH_CLASSES)[number];
  export const LANE_HARD_DENIED_CLASSES: ReadonlySet<TouchClass>;
  export interface ScriptScanResult { scannerVersion: string; basicHits: string[]; strictHits: string[]; touchClasses: TouchClass[]; touchedNames: { services: string[]; paths: string[]; registryKeys: string[] } }
  export function scanScriptContent(content: string, language: ScriptLanguage): ScriptScanResult;
  ```

- [ ] **Step 1: Write the failing classifier tests**

```ts
// packages/shared/src/utils/scriptScanner.test.ts
import { describe, expect, it } from 'vitest';
import {
  LANE_HARD_DENIED_CLASSES, SCANNER_VERSION, TOUCH_CLASSES, scanScriptContent,
} from './scriptSecurityPatterns';

describe('scanScriptContent', () => {
  it('stamps the scanner version and returns an empty, sorted, unique class set for inert content', () => {
    const result = scanScriptContent('Write-Output "hello"', 'powershell');
    expect(result.scannerVersion).toBe(SCANNER_VERSION);
    expect(result.basicHits).toEqual([]);
    expect(result.strictHits).toEqual([]);
    expect(result.touchClasses).toEqual([]);
    expect(result.touchedNames).toEqual({ services: [], paths: [], registryKeys: [] });
  });

  it('classifies a service restart and extracts the service name', () => {
    const result = scanScriptContent('Restart-Service -Name Spooler -Force', 'powershell');
    expect(result.touchClasses).toContain('services');
    expect(result.touchedNames.services).toEqual(['Spooler']);
  });

  it('classifies a registry write and extracts the key', () => {
    const result = scanScriptContent(
      'reg add "HKLM\\SOFTWARE\\Breeze\\Agent" /v Mode /d fast /f', 'cmd');
    expect(result.touchClasses).toContain('registry');
    expect(result.touchedNames.registryKeys).toEqual(['HKLM\\SOFTWARE\\Breeze\\Agent']);
  });

  it('classifies an encoded PowerShell command as shell_eval, which is hard-denied for the lane', () => {
    const result = scanScriptContent('powershell -EncodedCommand SQBFAFgA', 'powershell');
    expect(result.touchClasses).toContain('shell_eval');
    expect(LANE_HARD_DENIED_CLASSES.has('shell_eval')).toBe(true);
  });

  it('reports a BASIC hit alongside its classes rather than short-circuiting', () => {
    const result = scanScriptContent('Format-Volume -DriveLetter D', 'powershell');
    expect(result.basicHits).toEqual(['PowerShell volume format']);
    expect(result.touchClasses).toContain('disk');
  });

  it('is insensitive to case, surrounding whitespace and CRLF line endings', () => {
    const crlf = scanScriptContent('  STOP-SERVICE -Name Spooler\r\nnet stop Spooler\r\n', 'powershell');
    const lf = scanScriptContent('stop-service -Name Spooler\nnet stop Spooler\n', 'powershell');
    expect(crlf.touchClasses).toEqual(lf.touchClasses);
    expect(crlf.touchClasses).toContain('services');
  });

  it('returns classes sorted and unique even when several patterns of one class match', () => {
    const result = scanScriptContent(
      'Stop-Service Spooler; Start-Service Spooler; Remove-Item C:\\Windows\\Temp\\x', 'powershell');
    expect(result.touchClasses).toEqual([...new Set(result.touchClasses)].sort());
  });

  it('exposes exactly the 19 spec classes and a hard-denied subset of 7', () => {
    expect(TOUCH_CLASSES).toHaveLength(19);
    expect([...LANE_HARD_DENIED_CLASSES].sort()).toEqual(
      ['boot', 'credentials', 'disk', 'firewall', 'security_tooling', 'shell_eval', 'users_groups'],
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/utils/scriptScanner.test.ts`
Expected: FAIL — `scanScriptContent` is not exported.

- [ ] **Step 3: Implement the classifier and the scan entry point**

Append to `packages/shared/src/utils/scriptSecurityPatterns.ts`:

```ts
/**
 * Version tag stamped on every proposal and carried in the intent evidence.
 * BUMP THIS whenever a pattern or a classifier rule changes: an unattended
 * decision (W04) records the version it was made under, and a proposal scanned
 * by an older scanner must not be treated as if it had been classified by this
 * one.
 */
export const SCANNER_VERSION = '2026-09-11.1';

/** Closed vocabulary of resource classes a script may touch (spec §4.3). */
export const TOUCH_CLASSES = [
  'registry', 'services', 'processes', 'files_system', 'files_user', 'temp_files',
  'network_egress', 'firewall', 'credentials', 'users_groups', 'packages', 'scheduled_tasks',
  'disk', 'boot', 'security_tooling', 'dns_cache', 'printing', 'browser', 'shell_eval',
] as const;
export type TouchClass = (typeof TOUCH_CLASSES)[number];

/**
 * Classes the unattended lane may NEVER run, whatever a policy or a reviewer
 * says (spec §4.6 invariant 6). Exported here, beside the classifier that
 * produces the classes, so the enforcement set cannot drift from the vocabulary.
 */
export const LANE_HARD_DENIED_CLASSES: ReadonlySet<TouchClass> = new Set<TouchClass>([
  'credentials', 'security_tooling', 'boot', 'disk', 'shell_eval', 'users_groups', 'firewall',
]);

type TouchRule = { readonly regex: RegExp; readonly touchClass: TouchClass };

/**
 * Conservative and ADDITIVE: an unknown construct matches nothing. That is the
 * safe direction, because the lane requires a NON-EMPTY class set within an
 * allowlist (spec §4.6 invariant 6) — content the classifier cannot place goes
 * to a human instead of running unattended.
 */
const TOUCH_RULES: readonly TouchRule[] = [
  { regex: /\b(?:reg(?:\.exe)?\s+(?:add|delete|import)|New-ItemProperty|Set-ItemProperty|Remove-ItemProperty|Set-Item\s+-Path\s+HK|HKLM[:\\]|HKCU[:\\]|HKEY_[A-Z_]+)/i, touchClass: 'registry' },
  { regex: /\b(?:(?:Start|Stop|Restart|Set|New|Remove)-Service|sc(?:\.exe)?\s+(?:start|stop|config|create|delete)|net\s+(?:start|stop)|systemctl\s+(?:start|stop|restart|enable|disable|mask)|service\s+\S+\s+(?:start|stop|restart))\b/i, touchClass: 'services' },
  { regex: /\b(?:Stop-Process|Start-Process|taskkill|\bkill\s+-9\b|pkill|Get-Process\s+.*\|\s*Stop-Process)\b/i, touchClass: 'processes' },
  { regex: /\b(?:C:\\Windows|C:\\Program Files|%SystemRoot%|\/etc\/|\/usr\/|\/var\/(?!tmp)|\/opt\/|\/bin\/|\/sbin\/)/i, touchClass: 'files_system' },
  { regex: /(?:C:\\Users\\|%USERPROFILE%|\$env:USERPROFILE|\/home\/|\/Users\/|~\/)/i, touchClass: 'files_user' },
  { regex: /(?:%TEMP%|%TMP%|\$env:TEMP|C:\\Windows\\Temp|\/tmp\/|\/var\/tmp\/|Get-ChildItem\s+.*Temp)/i, touchClass: 'temp_files' },
  { regex: /\b(?:Invoke-WebRequest|Invoke-RestMethod|curl|wget|New-Object\s+Net\.WebClient|System\.Net\.Http|nc\s+-|Test-NetConnection)\b/i, touchClass: 'network_egress' },
  { regex: /\b(?:netsh\s+advfirewall|New-NetFirewallRule|Set-NetFirewallRule|Remove-NetFirewallRule|iptables|nft\s|ufw\s|firewall-cmd)\b/i, touchClass: 'firewall' },
  { regex: /\b(?:ConvertTo-SecureString|Get-Credential|cmdkey|\/etc\/shadow|\/etc\/passwd|Export-PfxCertificate|certutil\s+-exportPFX|vaultcmd|Get-StoredCredential)\b/i, touchClass: 'credentials' },
  { regex: /\b(?:New-LocalUser|Set-LocalUser|Remove-LocalUser|Add-LocalGroupMember|net\s+(?:user|localgroup)|useradd|usermod|userdel|groupadd|gpasswd|Add-ADGroupMember)\b/i, touchClass: 'users_groups' },
  { regex: /\b(?:winget|choco|msiexec|Install-Package|Uninstall-Package|Install-Module|apt-get|apt\s+install|yum\s|dnf\s|zypper|brew\s+install|Start-Process\s+.*\.msi)\b/i, touchClass: 'packages' },
  { regex: /\b(?:schtasks|New-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Set-ScheduledTask|crontab|systemd-run\s+--on)\b/i, touchClass: 'scheduled_tasks' },
  { regex: /\b(?:diskpart|Format-Volume|Clear-Disk|Initialize-Disk|New-Partition|Remove-Partition|Set-Partition|mkfs|fdisk|parted|chkdsk\s+\/[fFrR])\b/i, touchClass: 'disk' },
  { regex: /\b(?:bcdedit|bootrec|Set-BootOrder|grub-install|update-grub|efibootmgr|Restart-Computer|shutdown\s+\/r)\b/i, touchClass: 'boot' },
  { regex: /\b(?:Set-MpPreference|Add-MpPreference|Remove-MpPreference|Set-MpComputerStatus|Stop-Service\s+.*(?:WinDefend|Sense|SentinelAgent)|mpcmdrun|Uninstall-WindowsFeature\s+Windows-Defender|Disable-WindowsOptionalFeature\s+.*Defender)\b/i, touchClass: 'security_tooling' },
  { regex: /\b(?:ipconfig\s+\/flushdns|Clear-DnsClientCache|resolvectl\s+flush-caches|dscacheutil\s+-flushcache|systemd-resolve\s+--flush-caches)\b/i, touchClass: 'dns_cache' },
  { regex: /\b(?:Get-Printer|Add-Printer|Remove-Printer|Restart-Service\s+.*Spooler|net\s+stop\s+spooler|lpadmin|cupsenable|cupsdisable)\b/i, touchClass: 'printing' },
  { regex: /\b(?:chrome\.exe|msedge\.exe|firefox|Google\\Chrome\\User Data|Microsoft\\Edge\\User Data|Mozilla\\Firefox\\Profiles|Library\/Application Support\/Google\/Chrome)\b/i, touchClass: 'browser' },
  { regex: /\b(?:Invoke-Expression|\biex\b|-EncodedCommand|\benc\b\s+[A-Za-z0-9+/=]{16,}|FromBase64String|\beval\s*\(|base64\s+-d|\|\s*(?:bash|sh|powershell)\b|DownloadString)/i, touchClass: 'shell_eval' },
];

/** Service names in the shapes the service rules above recognise. */
const SERVICE_NAME_RULES: readonly RegExp[] = [
  /(?:Start|Stop|Restart|Set|Remove)-Service\s+(?:-Name\s+)?["']?([A-Za-z0-9._$-]+)["']?/gi,
  /\bnet\s+(?:start|stop)\s+["']?([A-Za-z0-9._$-]+)["']?/gi,
  /\bsc(?:\.exe)?\s+(?:start|stop|config|create|delete)\s+["']?([A-Za-z0-9._$-]+)["']?/gi,
  /\bsystemctl\s+(?:start|stop|restart|enable|disable|mask)\s+["']?([A-Za-z0-9._@$-]+)["']?/gi,
];

/** Absolute Windows and POSIX paths, quoted or bare. */
const PATH_RULES: readonly RegExp[] = [
  /(?:^|["'\s=])([A-Za-z]:\\[^"'\s|;,)]+)/g,
  /(?:^|["'\s=])(\/(?:etc|usr|var|opt|bin|sbin|home|Users|tmp|Library)\/[^"'\s|;,)]*)/g,
];

/** Registry keys, hive-rooted, in either `HKLM\…` or `HKLM:\…` notation. */
const REGISTRY_KEY_RULES: readonly RegExp[] = [
  /\b(HK(?:LM|CU|CR|U|CC)|HKEY_[A-Z_]+):?\\([^"'\s|;,)]+)/g,
];

function collect(content: string, rules: readonly RegExp[], join: (m: RegExpExecArray) => string): string[] {
  const found = new Set<string>();
  for (const rule of rules) {
    // Fresh RegExp per call: the module-level literals carry /g and therefore
    // `lastIndex` state, which would make a second call skip early matches.
    const regex = new RegExp(rule.source, rule.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      if (match[0].length === 0) { regex.lastIndex += 1; continue; }
      const value = join(match).trim();
      if (value) found.add(value);
    }
  }
  return [...found].sort();
}

/**
 * The single scan entry point for a proposal: BASIC hits, STRICT hits, touch
 * classes, and the named resources the classes refer to (used by the lane's
 * protected-resource check in W04 — `aiGuardrails` only ever inspects named
 * input fields, never script content, so the names have to come from here).
 *
 * `language` is accepted and stamped through the caller's row rather than used
 * to narrow the rule set: the agent compiles ONE pattern list for every
 * language, and a classifier that ignored, say, Windows rules for a `bash`
 * proposal would miss a bash script that shells out to `reg.exe` under Wine or
 * writes a Windows path over a share.
 */
export function scanScriptContent(content: string, language: ScriptLanguage): ScriptScanResult {
  void language;
  // CRLF is normalised because the agent's own patterns are anchored with `$`
  // under `(?i)` and no `(?s)`: a trailing \r would defeat an end-anchored
  // match here while the device (which receives \n-normalised content through
  // the dispatch payload) would still match it.
  const normalized = (content ?? '').replace(/\r\n/g, '\n');
  const classes = new Set<TouchClass>();
  for (const { regex, touchClass } of TOUCH_RULES) {
    if (regex.test(normalized)) classes.add(touchClass);
  }
  return {
    scannerVersion: SCANNER_VERSION,
    basicHits: detectBasicScriptPatterns(normalized),
    strictHits: detectStrictScriptPatterns(normalized),
    touchClasses: [...classes].sort(),
    touchedNames: {
      services: collect(normalized, SERVICE_NAME_RULES, (m) => m[1] ?? ''),
      paths: collect(normalized, PATH_RULES, (m) => m[1] ?? ''),
      registryKeys: collect(normalized, REGISTRY_KEY_RULES, (m) => `${m[1]}\\${m[2]}`),
    },
  };
}

export interface ScriptScanResult {
  scannerVersion: string;
  basicHits: string[];
  strictHits: string[];
  touchClasses: TouchClass[];
  touchedNames: { services: string[]; paths: string[]; registryKeys: string[] };
}
```

Add `import type { ScriptLanguage } from '../types';` at the top of the module.

- [ ] **Step 4: Run both scanner suites**

Run: `cd packages/shared && npx vitest run src/utils/scriptScanner.test.ts src/utils/scriptSecurityPatterns.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Typecheck the package**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: no errors. `scriptSecurityPatterns` is already re-exported by `packages/shared/src/utils/index.ts:22` (`export * from './scriptSecurityPatterns';`), so no barrel change is needed for this task.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/utils/scriptSecurityPatterns.ts packages/shared/src/utils/scriptScanner.test.ts
git commit -m "feat(shared): add the deterministic touch classifier and scanScriptContent"
```

---

### Task 4: Shared proposal types and validators

**Files:**
- Create: `packages/shared/src/types/scriptProposals.ts`
- Create: `packages/shared/src/validators/scriptProposals.ts`
- Modify: `packages/shared/src/types/index.ts:5-9`, `packages/shared/src/validators/index.ts:17-25`
- Test: `packages/shared/src/validators/scriptProposals.test.ts`

**Interfaces:**
- Produces (roadmap §3.1, exact names): `ScriptProposal`, `ScriptProposalReview`, `ScriptProposalStatus`, `ScriptOrigin`, `ScriptApprovalMethod`; `RISK_TIERS`, `RiskTier`, `riskTierRank`, `scriptVerificationClaimSchema`, `ScriptVerificationClaim`, `proposeScriptInputSchema`, `ProposeScriptInput`, `SCRIPT_PROPOSAL_STATUSES`.

- [ ] **Step 1: Write the failing validator tests**

```ts
// packages/shared/src/validators/scriptProposals.test.ts
import { describe, expect, it } from 'vitest';
import {
  RISK_TIERS, SCRIPT_PROPOSAL_STATUSES, proposeScriptInputSchema, riskTierRank,
  scriptVerificationClaimSchema,
} from './scriptProposals';

const base = {
  language: 'powershell' as const,
  content: 'Restart-Service -Name Spooler',
  goal: 'Print jobs are stuck on this workstation',
  expectedEffect: 'The print spooler service is restarted',
  verification: { kind: 'service_running' as const, name: 'Spooler' },
  deviceIds: ['11111111-1111-4111-8111-111111111111'],
};

describe('scriptVerificationClaimSchema', () => {
  it('accepts each v1 claim kind', () => {
    for (const claim of [
      { kind: 'exit_code', equals: 0 },
      { kind: 'service_running', name: 'Spooler' },
      { kind: 'process_absent', name: 'stuckapp.exe' },
      { kind: 'file_exists', path: 'C:\\ProgramData\\Breeze\\ok.txt' },
      { kind: 'output_matches', regex: 'Running' },
    ]) {
      expect(scriptVerificationClaimSchema.safeParse(claim).success).toBe(true);
    }
  });

  it('rejects an unknown kind and a claim missing its discriminant payload', () => {
    expect(scriptVerificationClaimSchema.safeParse({ kind: 'vibes' }).success).toBe(false);
    expect(scriptVerificationClaimSchema.safeParse({ kind: 'service_running' }).success).toBe(false);
  });

  it('rejects an output_matches regex that does not compile', () => {
    expect(scriptVerificationClaimSchema.safeParse({ kind: 'output_matches', regex: '(' }).success).toBe(false);
  });
});

describe('proposeScriptInputSchema', () => {
  it('accepts a minimal proposal and defaults runAs and timeoutSeconds', () => {
    const parsed = proposeScriptInputSchema.parse(base);
    expect(parsed.runAs).toBe('system');
    expect(parsed.timeoutSeconds).toBe(300);
  });

  it('rejects content over 64 KiB', () => {
    expect(proposeScriptInputSchema.safeParse({ ...base, content: 'a'.repeat(65537) }).success).toBe(false);
  });

  it('rejects 0 and 11 devices, accepts 10', () => {
    const id = (n: number) => `1111111${n}-1111-4111-8111-111111111111`;
    expect(proposeScriptInputSchema.safeParse({ ...base, deviceIds: [] }).success).toBe(false);
    expect(proposeScriptInputSchema.safeParse({
      ...base, deviceIds: Array.from({ length: 10 }, (_, i) => id(i)),
    }).success).toBe(true);
    expect(proposeScriptInputSchema.safeParse({
      ...base, deviceIds: [...Array.from({ length: 10 }, (_, i) => id(i)), id(0)],
    }).success).toBe(false);
  });

  it('rejects runAs elevated — a proposal is never elevated in v1', () => {
    expect(proposeScriptInputSchema.safeParse({ ...base, runAs: 'elevated' }).success).toBe(false);
  });

  it('rejects a timeout above 3600', () => {
    expect(proposeScriptInputSchema.safeParse({ ...base, timeoutSeconds: 3601 }).success).toBe(false);
  });
});

describe('risk tiers and statuses', () => {
  it('ranks low..critical as 0..3', () => {
    expect(RISK_TIERS.map(riskTierRank)).toEqual([0, 1, 2, 3]);
  });

  it('declares the thirteen proposal statuses', () => {
    expect(SCRIPT_PROPOSAL_STATUSES).toHaveLength(13);
    expect(SCRIPT_PROPOSAL_STATUSES).toContain('scan_rejected');
    expect(SCRIPT_PROPOSAL_STATUSES).toContain('promoted');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/validators/scriptProposals.test.ts`
Expected: FAIL — module `./scriptProposals` not found.

- [ ] **Step 3: Write the types file**

```ts
// packages/shared/src/types/scriptProposals.ts
/**
 * DTO shapes for AI-authored script proposals (spec §4.1). The API returns
 * these; web, mobile and helper read them.
 *
 * NOTE: `ScriptOrigin` and `ScriptApprovalMethod` are consumed by W01a's
 * `ScriptVersionProvenance` as well. They live here, with the rest of the
 * proposal vocabulary, so there is exactly one definition.
 */

/** Where a script RECORD was born. `system` is the built-in library. */
export type ScriptOrigin = 'human' | 'ai_proposal' | 'imported' | 'system';

/** How an execution came to be authorised. */
export type ScriptApprovalMethod =
  | 'supervised_self' | 'four_eyes' | 'unattended_reviewer_gated' | 'direct_ui' | 'automation';

export type ScriptProposalStatus =
  | 'proposed' | 'scan_rejected' | 'review_failed' | 'reviewed'
  | 'approved' | 'rejected' | 'changes_requested' | 'expired' | 'superseded'
  | 'executed' | 'verified' | 'verification_failed' | 'promoted';

export type ScriptProposalAuthorKind = 'chat_session' | 'agent_run';
export type ScriptProposalReviewerKind = 'static_scan' | 'model';
export type ScriptProposalReviewStatus = 'completed' | 'failed' | 'timeout';

export interface ScriptProposal {
  id: string;
  orgId: string;
  authorKind: ScriptProposalAuthorKind;
  sessionId: string | null;
  agentRunId: string | null;
  language: string;
  content: string;
  contentDigest: string;
  timeoutSeconds: number;
  runAs: 'system' | 'user';
  goal: string;
  expectedEffect: string;
  verification: unknown;
  rollbackNote: string | null;
  targetDeviceIds: string[];
  scannerVersion: string;
  basicHits: string[];
  strictHits: string[];
  touchClasses: string[];
  status: ScriptProposalStatus;
  revision: number;
  supersedesId: string | null;
  riskTier: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  intentId: string | null;
  verifiedAt: string | null;
  verificationResult: unknown;
  promotedScriptId: string | null;
  promotedVersionId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface ScriptProposalReview {
  id: string;
  orgId: string;
  proposalId: string;
  reviewerKind: ScriptProposalReviewerKind;
  model: string | null;
  reviewerPromptVersion: string | null;
  status: ScriptProposalReviewStatus;
  summary: string | null;
  riskTier: string | null;
  goalMatch: 'yes' | 'partial' | 'no' | null;
  reversible: boolean | null;
  verificationAdequate: boolean | null;
  recommendedAction: 'approve' | 'changes' | 'reject' | null;
  verdict: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  costCents: string | null;
  createdAt: string;
}
```

- [ ] **Step 4: Write the validators file**

```ts
// packages/shared/src/validators/scriptProposals.ts
import { z } from 'zod';
import { SCRIPT_LANGUAGES } from '../constants';

export const RISK_TIERS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** low 0 … critical 3. Comparisons against a ceiling use this, never string order. */
export function riskTierRank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier);
}

export const SCRIPT_PROPOSAL_STATUSES = [
  'proposed', 'scan_rejected', 'review_failed', 'reviewed',
  'approved', 'rejected', 'changes_requested', 'expired', 'superseded',
  'executed', 'verified', 'verification_failed', 'promoted',
] as const;

/**
 * v1 verification claims (spec §4.9). `exit_code` and `output_matches` are
 * EXECUTION evidence, not independent observation — the reviewer must mark
 * `verificationAdequate: false` when one of them is the only claim behind a
 * service, disk or application goal.
 */
export const scriptVerificationClaimSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exit_code'), equals: z.number().int().min(-2147483648).max(2147483647).default(0) }),
  z.object({ kind: z.literal('service_running'), name: z.string().min(1).max(255) }),
  z.object({ kind: z.literal('process_absent'), name: z.string().min(1).max(255) }),
  z.object({ kind: z.literal('file_exists'), path: z.string().min(1).max(1024) }),
  z.object({
    kind: z.literal('output_matches'),
    // Compiled here so an uncompilable claim is rejected at authoring time
    // rather than throwing inside the verification worker three minutes later.
    regex: z.string().min(1).max(512).refine((value) => {
      try { new RegExp(value); return true; } catch { return false; }
    }, { message: 'regex must compile' }),
  }),
]);
export type ScriptVerificationClaim = z.infer<typeof scriptVerificationClaimSchema>;

export const proposeScriptInputSchema = z.object({
  language: z.enum(SCRIPT_LANGUAGES),
  content: z.string().min(1).max(65536),
  goal: z.string().min(1).max(2000),
  expectedEffect: z.string().min(1).max(2000),
  verification: scriptVerificationClaimSchema,
  rollbackNote: z.string().max(2000).optional(),
  deviceIds: z.array(z.string().uuid()).min(1).max(10),
  // 'elevated' is deliberately absent: the elevation ceremony has its own
  // approval path and a proposal must not be able to reach it (spec §4.1).
  runAs: z.enum(['system', 'user']).default('system'),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  supersedesProposalId: z.string().uuid().optional(),
});
export type ProposeScriptInput = z.infer<typeof proposeScriptInputSchema>;
```

- [ ] **Step 5: Export both from the barrels**

`packages/shared/src/types/index.ts`, beside line 9:

```ts
export * from './scriptProposals';
```

`packages/shared/src/validators/index.ts`, beside line 25:

```ts
export * from './scriptProposals';
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd packages/shared && npx vitest run src/validators/scriptProposals.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/scriptProposals.ts packages/shared/src/validators/scriptProposals.ts \
  packages/shared/src/validators/scriptProposals.test.ts \
  packages/shared/src/types/index.ts packages/shared/src/validators/index.ts
git commit -m "feat(shared): add script proposal types and validators"
```

---

### Task 5: Migration — `script_proposals` and `script_proposal_reviews`

**Files:**
- Create: `apps/api/migrations/2026-10-16-100100-script-proposals.sql`
- Test: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`

**Interfaces:**
- Produces: tables `script_proposals`, `script_proposal_reviews`; enum `script_proposal_status`.
- Templates copied: shape-1 RLS from `apps/api/migrations/2026-10-15-170200-organization-key-dates.sql:36-46`; idempotent enum from the same file `:6-8`; immutability trigger from `apps/api/migrations/2026-07-18-action-intents.sql:95-125`; append-only REVOKE/trigger from `apps/api/migrations/2026-09-11-peripheral-effective-policy-v2.sql:148-199`; `GRANT … TO breeze_app` from `apps/api/migrations/2026-10-14-100000-manual-assets.sql:140`.

- [ ] **Step 1: Write the migration file**

```sql
-- script_proposals + script_proposal_reviews (AI script authoring W01b, spec
-- §4.1/§5). Both RLS shape 1 (direct org_id, auto-discovered by
-- rls-coverage.integration.test.ts). DDL only — no row writes, so no
-- breeze.scope elevation is required in this file.
--
-- FK RULES (spec §5): the ONLY hard FK between the two new tables is
-- reviews -> proposals, composite on (proposal_id, org_id) and DEFERRABLE
-- INITIALLY IMMEDIATE because org merge runs SET CONSTRAINTS ALL DEFERRED.
-- proposals.intent_id, .supersedes_id, .promoted_script_id and
-- .promoted_version_id are BARE uuids: the referenced rows change org or die on
-- different schedules, and a self-referencing supersedes_id FK would put a
-- cycle in tenantCascade's topological order.
--
-- Registration (same PR): CORE_ORG_CASCADE_DELETE_ORDER (reviews BEFORE
-- proposals), AUDIT_ADMIN_REQUIRED_TABLES (reviews), CORE_TENANT_EXPORT_POLICY
-- (both), orgMergeRegistry (proposals = custom + fence, reviews =
-- leave-for-erasure).

DO $$ BEGIN
  CREATE TYPE script_proposal_status AS ENUM (
    'proposed','scan_rejected','review_failed','reviewed',
    'approved','rejected','changes_requested','expired','superseded',
    'executed','verified','verification_failed','promoted'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS script_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  author_kind TEXT NOT NULL,
  session_id UUID REFERENCES ai_sessions(id) ON DELETE SET NULL,
  -- Agent runs are left for source-org erasure and never repointed, so this is
  -- a typed reference, not an FK (same rule as action_intents).
  agent_run_id UUID,
  language script_language NOT NULL,
  content TEXT NOT NULL,
  content_digest CHAR(64) NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  run_as TEXT NOT NULL DEFAULT 'system',
  goal TEXT NOT NULL,
  expected_effect TEXT NOT NULL,
  verification JSONB NOT NULL,
  rollback_note TEXT,
  target_device_ids UUID[] NOT NULL,
  scanner_version TEXT NOT NULL,
  basic_hits TEXT[] NOT NULL DEFAULT '{}',
  strict_hits TEXT[] NOT NULL DEFAULT '{}',
  touch_classes TEXT[] NOT NULL DEFAULT '{}',
  status script_proposal_status NOT NULL DEFAULT 'proposed',
  revision INTEGER NOT NULL DEFAULT 1,
  supersedes_id UUID,
  risk_tier TEXT,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  intent_id UUID,
  verified_at TIMESTAMPTZ,
  verification_result JSONB,
  promoted_script_id UUID,
  promoted_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

-- The composite target the reviews FK references.
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_id_org_uk UNIQUE (id, org_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_author_kind_chk
    CHECK (author_kind IN ('chat_session','agent_run'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_run_as_chk
    CHECK (run_as IN ('system','user'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_timeout_chk
    CHECK (timeout_seconds BETWEEN 1 AND 3600);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_targets_chk
    CHECK (array_length(target_device_ids, 1) BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_risk_tier_chk
    CHECK (risk_tier IS NULL OR risk_tier IN ('low','medium','high','critical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposals ADD CONSTRAINT script_proposals_content_size_chk
    CHECK (octet_length(content) <= 65536);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS script_proposals_org_created_idx ON script_proposals (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS script_proposals_org_status_idx ON script_proposals (org_id, status);
-- Partial: the runnability check reads "is this proposal already consumed?".
CREATE INDEX IF NOT EXISTS script_proposals_unconsumed_idx ON script_proposals (org_id, expires_at)
  WHERE intent_id IS NULL;

-- Immutability: everything the reviewer saw and everything the digest pins.
-- Lifecycle columns (status, risk_tier, decided_*, intent_id, verified_*,
-- promoted_*) are deliberately NOT listed — those are exactly what state
-- transitions and the org-merge fence mutate.
CREATE OR REPLACE FUNCTION script_proposals_block_content_update() RETURNS trigger AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.author_kind IS DISTINCT FROM OLD.author_kind
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
     OR NEW.timeout_seconds IS DISTINCT FROM OLD.timeout_seconds
     OR NEW.run_as IS DISTINCT FROM OLD.run_as
     OR NEW.goal IS DISTINCT FROM OLD.goal
     OR NEW.expected_effect IS DISTINCT FROM OLD.expected_effect
     OR NEW.verification IS DISTINCT FROM OLD.verification
     OR NEW.rollback_note IS DISTINCT FROM OLD.rollback_note
     OR NEW.target_device_ids IS DISTINCT FROM OLD.target_device_ids
     OR NEW.scanner_version IS DISTINCT FROM OLD.scanner_version
     OR NEW.basic_hits IS DISTINCT FROM OLD.basic_hits
     OR NEW.strict_hits IS DISTINCT FROM OLD.strict_hits
     OR NEW.touch_classes IS DISTINCT FROM OLD.touch_classes
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'script proposal content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'script_proposals_immutable_trg') THEN
    CREATE TRIGGER script_proposals_immutable_trg BEFORE UPDATE ON script_proposals
      FOR EACH ROW EXECUTE FUNCTION script_proposals_block_content_update();
  END IF;
END $$;

ALTER TABLE script_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON script_proposals;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON script_proposals;
DROP POLICY IF EXISTS breeze_org_isolation_update ON script_proposals;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON script_proposals;
CREATE POLICY breeze_org_isolation_select ON script_proposals FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON script_proposals FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON script_proposals FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON script_proposals FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON script_proposals TO breeze_app;

-- ---------------------------------------------------------------------------
-- script_proposal_reviews — append-only evidence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS script_proposal_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  proposal_id UUID NOT NULL,
  reviewer_kind TEXT NOT NULL,
  model TEXT,
  reviewer_prompt_version TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  risk_tier TEXT,
  goal_match TEXT,
  reversible BOOLEAN,
  verification_adequate BOOLEAN,
  recommended_action TEXT,
  verdict JSONB,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_cents NUMERIC(12,4),
  budget_reservation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_proposal_org_fk
    FOREIGN KEY (proposal_id, org_id) REFERENCES script_proposals(id, org_id)
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_kind_chk
    CHECK (reviewer_kind IN ('static_scan','model'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_status_chk
    CHECK (status IN ('completed','failed','timeout'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_risk_tier_chk
    CHECK (risk_tier IS NULL OR risk_tier IN ('low','medium','high','critical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_goal_match_chk
    CHECK (goal_match IS NULL OR goal_match IN ('yes','partial','no'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_action_chk
    CHECK (recommended_action IS NULL OR recommended_action IN ('approve','changes','reject'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_proposal_reviews ADD CONSTRAINT script_proposal_reviews_summary_len_chk
    CHECK (summary IS NULL OR char_length(summary) <= 600);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Spec §4.1: the LATEST review is derived, not stored as an FK on the proposal
-- (that would be a proposal<->review cycle the cascade order rejects). This is
-- the index that read runs on.
CREATE INDEX IF NOT EXISTS script_proposal_reviews_proposal_created_idx
  ON script_proposal_reviews (proposal_id, created_at DESC);

CREATE OR REPLACE FUNCTION script_proposal_reviews_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Erasure (breeze_audit_admin, retention flag set) and cascading deletes
    -- from the parent are the only permitted removals.
    IF allow_retention = '1' OR pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'script proposal reviews are append-only',
    HINT = 'Review evidence cannot be modified or deleted. Retention uses breeze_audit_admin plus breeze.allow_audit_retention=1.';
END;
$$;

DROP TRIGGER IF EXISTS script_proposal_reviews_block_update ON script_proposal_reviews;
CREATE TRIGGER script_proposal_reviews_block_update
  BEFORE UPDATE ON script_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION script_proposal_reviews_append_only();
DROP TRIGGER IF EXISTS script_proposal_reviews_block_delete ON script_proposal_reviews;
CREATE TRIGGER script_proposal_reviews_block_delete
  BEFORE DELETE ON script_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION script_proposal_reviews_append_only();

ALTER TABLE script_proposal_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_proposal_reviews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON script_proposal_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON script_proposal_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_update ON script_proposal_reviews;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON script_proposal_reviews;
CREATE POLICY breeze_org_isolation_select ON script_proposal_reviews FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON script_proposal_reviews FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON script_proposal_reviews FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON script_proposal_reviews FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, REFERENCES ON script_proposal_reviews TO breeze_app;
REVOKE UPDATE, DELETE, TRUNCATE ON script_proposal_reviews FROM breeze_app;
GRANT SELECT, DELETE ON script_proposal_reviews TO breeze_audit_admin;
REVOKE INSERT, UPDATE, TRUNCATE ON script_proposal_reviews FROM breeze_audit_admin;
```

- [ ] **Step 2: Apply it against a live database**

```bash
pnpm test-stack up
export DATABASE_URL="$(grep '^DATABASE_URL=' .env.test | cut -d= -f2-)"
pnpm db:migrate
```

Expected: the file applies, and re-running `pnpm db:migrate` is a no-op (the ledger keys on the filename).

- [ ] **Step 3: Prove the RLS and the triggers by hand as `breeze_app`**

```bash
docker exec -it "$(docker ps --format '{{.Names}}' | grep -m1 postgres)" \
  psql -U breeze_app -d breeze -c \
  "SET breeze.scope = 'organization'; SET breeze.accessible_org_ids = '{}'; \
   INSERT INTO script_proposals (org_id, author_kind, language, content, content_digest, timeout_seconds, goal, expected_effect, verification, target_device_ids, scanner_version) \
   VALUES (gen_random_uuid(),'chat_session','bash','echo hi',repeat('a',64),60,'g','e','{}'::jsonb,ARRAY[gen_random_uuid()],'x');"
```

Expected: `ERROR: new row violates row-level security policy for table "script_proposals"`.

- [ ] **Step 4: Run the migration guards**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS. `migrationRlsScope.test.ts` must stay green **without** adding this file to its frozen baseline — this migration writes no rows.

Run: `./scripts/check-migration-naming.sh --against-ref origin/main`
Expected: PASS (the file sorts after `2026-10-15-170200-organization-key-dates.sql`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-16-100100-script-proposals.sql
git commit -m "feat(db): add script_proposals and append-only script_proposal_reviews with shape-1 RLS"
```

---

### Task 6: Migration — `script_executions` proposal source, snapshot and provenance

**Files:**
- Create: `apps/api/migrations/2026-10-16-100200-script-executions-source.sql`

**Interfaces:**
- Produces on `script_executions`: `script_id` nullable; `source_kind`, `proposal_id`; snapshot `language`, `timeout_seconds`, `run_as` (already present, unchanged), `content_digest`; provenance `script_version_id`, `review_id`, `approved_by`, `approval_method`, `review_risk_tier`, `review_summary`.

- [ ] **Step 1: Write the migration file**

```sql
-- script_executions gains a first-class proposal source (spec §4.1, D11).
-- No hidden library script is created to satisfy the FK; script_id becomes
-- nullable and a CHECK pins exactly one source per row.
--
-- Snapshot columns are written at dispatch for BOTH sources so readers stop
-- joining `scripts` for language/timeout — the join is why a parentless row
-- was impossible before (staleCommandReaper.ts:584 innerJoins scripts).
--
-- Provenance ids are BARE uuids (no FK): script_executions is device-
-- denormalised and restamped on device move, so a same-org composite FK would
-- abort the move (spec §4.1, schema/scripts.ts:168 + moveOrg.ts:660).
-- review_risk_tier / review_summary are SNAPSHOTS so device activity still
-- renders after the proposal and its review are erased.
--
-- DDL only: every column is added nullable or with a constant default, so no
-- row-writing statement and therefore no breeze.scope elevation is needed.
-- Registration (same PR): every column below is classified in
-- CORE_TENANT_EXPORT_POLICY. script_executions is already in
-- CORE_ORG_CASCADE_DELETE_ORDER, CORE_DEVICE_CASCADE_DELETE_TABLES and
-- CORE_DEVICE_ORG_DENORMALIZED_TABLES — no change there.

ALTER TABLE script_executions ALTER COLUMN script_id DROP NOT NULL;

ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'library';
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS proposal_id UUID;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS language script_language;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS content_digest CHAR(64);
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS script_version_id UUID;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS review_id UUID;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS approval_method TEXT;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS review_risk_tier TEXT;
ALTER TABLE script_executions ADD COLUMN IF NOT EXISTS review_summary VARCHAR(600);

DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_source_kind_chk
    CHECK (source_kind IN ('library','proposal'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Exactly one source. Written as two biconditionals rather than an OR so a row
-- that names BOTH a script and a proposal is rejected too.
DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_library_source_chk
    CHECK ((source_kind = 'library') = (script_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_proposal_source_chk
    CHECK ((source_kind = 'proposal') = (proposal_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_approval_method_chk
    CHECK (approval_method IS NULL OR approval_method IN
      ('supervised_self','four_eyes','unattended_reviewer_gated','direct_ui','automation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE script_executions ADD CONSTRAINT script_executions_review_risk_tier_chk
    CHECK (review_risk_tier IS NULL OR review_risk_tier IN ('low','medium','high','critical'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS script_executions_proposal_idx
  ON script_executions (proposal_id)
  WHERE proposal_id IS NOT NULL;
```

- [ ] **Step 2: Apply and re-apply**

```bash
pnpm db:migrate && pnpm db:migrate
```

Expected: first run applies; second is a no-op. The `DROP NOT NULL` is naturally idempotent.

- [ ] **Step 3: Prove the CHECKs reject a malformed row**

```bash
docker exec -it "$(docker ps --format '{{.Names}}' | grep -m1 postgres)" \
  psql -U postgres -d breeze -c \
  "SET breeze.scope='system'; INSERT INTO script_executions (device_id, org_id, source_kind) \
   SELECT id, org_id, 'proposal' FROM devices LIMIT 1;"
```

Expected: `ERROR: new row for relation "script_executions" violates check constraint "script_executions_proposal_source_chk"`.

- [ ] **Step 4: Run the migration guards**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-16-100200-script-executions-source.sql
git commit -m "feat(db): give script_executions a first-class proposal source with snapshot and provenance columns"
```

---

### Task 7: Migration — `scripts.origin` and `scripts.origin_proposal_id`

**Files:**
- Create: `apps/api/migrations/2026-10-16-100300-scripts-origin.sql`

**Interfaces:**
- Produces: `scripts.origin` (`script_origin` enum, default `human`), `scripts.origin_proposal_id` (bare uuid).
- Note: `script_origin` is created by W01a's `2026-10-16-100000-script-versions-immutable.sql`. It is re-declared here in the same idempotent form so this file also applies on a database where W01a's file has not run (a cherry-picked branch, a partial restore) rather than failing on an undefined type.

- [ ] **Step 1: Write the migration file**

```sql
-- scripts gains birth provenance (spec §4.1). `origin` is the RECORD's birth;
-- a human edit after promotion cuts a new head version with origin = human and
-- empty review fields, which is what makes the library badge honestly drop to
-- "edited since review".
--
-- THIS FILE WRITES ROWS (the is_system backfill), so it elects system scope
-- first: breeze_current_scope() defaults to 'none' and `scripts` is FORCE ROW
-- LEVEL SECURITY, which binds the table owner too — without the elevation the
-- UPDATE matches zero rows silently and the RAISE WARNING prints a truthful-
-- looking 0.

DO $$ BEGIN
  CREATE TYPE script_origin AS ENUM ('human','ai_proposal','imported','system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE scripts ADD COLUMN IF NOT EXISTS origin script_origin NOT NULL DEFAULT 'human';
-- Bare uuid: the proposal is org-scoped incident data that may be erased long
-- before the promoted script is, and the UI renders "review evidence erased"
-- rather than following a broken link (spec §4.8).
ALTER TABLE scripts ADD COLUMN IF NOT EXISTS origin_proposal_id UUID;

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE scripts SET origin = 'system' WHERE is_system IS TRUE AND origin <> 'system';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled origin=system on % built-in script(s)', n;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS scripts_origin_idx ON scripts (org_id, origin);
```

- [ ] **Step 2: Apply, re-apply, and read the warning back**

```bash
pnpm db:migrate 2>&1 | grep -i 'backfilled origin=system'
pnpm db:migrate
```

Expected: the first run prints the count (0 is a legitimate count on an empty dev DB — the point is that it is a *recorded* count, not silence); the second is a no-op because the `UPDATE` predicate excludes already-backfilled rows.

- [ ] **Step 3: Run the migration guards**

Run: `cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts`
Expected: PASS. The `set_config('breeze.scope', …)` form is what the guard recognises — a `SET LOCAL` inside the `DO` block works at runtime but reds this suite.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-16-100300-scripts-origin.sql
git commit -m "feat(db): record script origin provenance on the scripts table"
```

---

### Task 8: Drizzle schema for proposals, and the `scripts.ts` column additions

**Files:**
- Create: `apps/api/src/db/schema/scriptProposals.ts`
- Modify: `apps/api/src/db/schema/scripts.ts:26-78` (scripts), `:165-232` (scriptExecutions)
- Modify: `apps/api/src/db/schema/index.ts`
- Test: `apps/api/src/db/schema/scriptProposals.test.ts`

**Interfaces:**
- Produces: `scriptProposals`, `scriptProposalReviews`, `scriptProposalStatusEnum`, `scriptOriginEnum`; types `ScriptProposalRow = typeof scriptProposals.$inferSelect`, `ScriptProposalReviewRow = typeof scriptProposalReviews.$inferSelect`. Every later task refers to these two row types by exactly those names.

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/api/src/db/schema/scriptProposals.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { scriptProposalReviews, scriptProposals } from './scriptProposals';
import { scriptExecutions, scripts } from './scripts';

describe('script proposal schema', () => {
  it('declares script_proposals with the spec §4.1 columns', () => {
    expect(getTableName(scriptProposals)).toBe('script_proposals');
    expect(Object.keys(getTableColumns(scriptProposals))).toEqual(expect.arrayContaining([
      'id', 'orgId', 'authorKind', 'sessionId', 'agentRunId', 'language', 'content',
      'contentDigest', 'timeoutSeconds', 'runAs', 'goal', 'expectedEffect', 'verification',
      'rollbackNote', 'targetDeviceIds', 'scannerVersion', 'basicHits', 'strictHits',
      'touchClasses', 'status', 'revision', 'supersedesId', 'riskTier', 'decidedBy',
      'decidedAt', 'decisionNote', 'intentId', 'verifiedAt', 'verificationResult',
      'promotedScriptId', 'promotedVersionId', 'createdAt', 'expiresAt',
    ]));
  });

  it('declares script_proposal_reviews with the review columns', () => {
    expect(getTableName(scriptProposalReviews)).toBe('script_proposal_reviews');
    expect(Object.keys(getTableColumns(scriptProposalReviews))).toEqual(expect.arrayContaining([
      'id', 'orgId', 'proposalId', 'reviewerKind', 'model', 'reviewerPromptVersion', 'status',
      'summary', 'riskTier', 'goalMatch', 'reversible', 'verificationAdequate',
      'recommendedAction', 'verdict', 'inputTokens', 'outputTokens', 'costCents',
      'budgetReservationId', 'createdAt',
    ]));
  });

  it('makes script_executions.script_id optional and adds the source + provenance columns', () => {
    const cols = getTableColumns(scriptExecutions);
    expect(cols.scriptId.notNull).toBe(false);
    for (const name of [
      'sourceKind', 'proposalId', 'language', 'timeoutSeconds', 'contentDigest',
      'scriptVersionId', 'reviewId', 'approvedBy', 'approvalMethod',
      'reviewRiskTier', 'reviewSummary',
    ]) {
      expect(cols[name as keyof typeof cols], name).toBeDefined();
    }
  });

  it('adds origin provenance to scripts', () => {
    const cols = getTableColumns(scripts);
    expect(cols.origin).toBeDefined();
    expect(cols.originProposalId).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/scriptProposals.test.ts`
Expected: FAIL — `./scriptProposals` does not exist.

- [ ] **Step 3: Write the schema module**

```ts
// apps/api/src/db/schema/scriptProposals.ts
import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, char, integer, boolean, jsonb, timestamp, numeric, pgEnum, index, varchar,
} from 'drizzle-orm/pg-core';
import type { ScriptVerificationClaim } from '@breeze/shared';
import { organizations } from './orgs';
import { users } from './users';
import { aiSessions } from './ai';
import { scriptLanguageEnum } from './scripts';

export const scriptProposalStatusEnum = pgEnum('script_proposal_status', [
  'proposed', 'scan_rejected', 'review_failed', 'reviewed',
  'approved', 'rejected', 'changes_requested', 'expired', 'superseded',
  'executed', 'verified', 'verification_failed', 'promoted',
]);

/**
 * An AI-authored script proposal: immutable, content-addressed, incident-bound.
 *
 * org_id NOT NULL is justified (and is NOT a partner-wide config table, spec
 * §4.1): a proposal targets specific devices in one org and dies with the
 * incident. org_id is trigger-immutable, like action_intents.
 *
 * `intentId`, `supersedesId`, `promotedScriptId` and `promotedVersionId` are
 * bare uuids on purpose — the rows they name change org or die on different
 * schedules, and a self-referencing supersedes FK would put a cycle in the
 * cascade order (tenantCascade.ts:1004-1046 rejects cycles).
 */
export const scriptProposals = pgTable('script_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  authorKind: text('author_kind').$type<'chat_session' | 'agent_run'>().notNull(),
  sessionId: uuid('session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
  agentRunId: uuid('agent_run_id'),
  language: scriptLanguageEnum('language').notNull(),
  content: text('content').notNull(),
  contentDigest: char('content_digest', { length: 64 }).notNull(),
  timeoutSeconds: integer('timeout_seconds').notNull(),
  runAs: text('run_as').$type<'system' | 'user'>().notNull().default('system'),
  goal: text('goal').notNull(),
  expectedEffect: text('expected_effect').notNull(),
  verification: jsonb('verification').$type<ScriptVerificationClaim>().notNull(),
  rollbackNote: text('rollback_note'),
  targetDeviceIds: uuid('target_device_ids').array().notNull(),
  scannerVersion: text('scanner_version').notNull(),
  basicHits: text('basic_hits').array().notNull().default(sql`'{}'::text[]`),
  strictHits: text('strict_hits').array().notNull().default(sql`'{}'::text[]`),
  touchClasses: text('touch_classes').array().notNull().default(sql`'{}'::text[]`),
  status: scriptProposalStatusEnum('status').notNull().default('proposed'),
  revision: integer('revision').notNull().default(1),
  supersedesId: uuid('supersedes_id'),
  riskTier: text('risk_tier').$type<'low' | 'medium' | 'high' | 'critical'>(),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  intentId: uuid('intent_id'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationResult: jsonb('verification_result'),
  promotedScriptId: uuid('promoted_script_id'),
  promotedVersionId: uuid('promoted_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => ({
  orgCreatedIdx: index('script_proposals_org_created_idx').on(table.orgId, table.createdAt),
  orgStatusIdx: index('script_proposals_org_status_idx').on(table.orgId, table.status),
}));

/** Append-only: REVOKE UPDATE/DELETE from breeze_app + an immutability trigger. */
export const scriptProposalReviews = pgTable('script_proposal_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // Composite (proposal_id, org_id) FK, DEFERRABLE INITIALLY IMMEDIATE, lives
  // in the migration — Drizzle does not model composite FKs on a single column.
  proposalId: uuid('proposal_id').notNull(),
  reviewerKind: text('reviewer_kind').$type<'static_scan' | 'model'>().notNull(),
  model: text('model'),
  reviewerPromptVersion: text('reviewer_prompt_version'),
  status: text('status').$type<'completed' | 'failed' | 'timeout'>().notNull(),
  summary: text('summary'),
  riskTier: text('risk_tier').$type<'low' | 'medium' | 'high' | 'critical'>(),
  goalMatch: text('goal_match').$type<'yes' | 'partial' | 'no'>(),
  reversible: boolean('reversible'),
  verificationAdequate: boolean('verification_adequate'),
  recommendedAction: text('recommended_action').$type<'approve' | 'changes' | 'reject'>(),
  verdict: jsonb('verdict'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costCents: numeric('cost_cents', { precision: 12, scale: 4 }),
  budgetReservationId: text('budget_reservation_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  proposalCreatedIdx: index('script_proposal_reviews_proposal_created_idx')
    .on(table.proposalId, table.createdAt),
}));

export type ScriptProposalRow = typeof scriptProposals.$inferSelect;
export type ScriptProposalReviewRow = typeof scriptProposalReviews.$inferSelect;

void varchar; // keep the import list aligned with scripts.ts conventions
```

Delete the trailing `void varchar;` line and the `varchar` import if it is unused after writing the file — it is listed only because `scripts.ts` imports the same set.

- [ ] **Step 4: Add the new columns to `scripts.ts`**

In `apps/api/src/db/schema/scripts.ts`, add the origin enum beside `scriptRunAsEnum` (`:9`):

```ts
export const scriptOriginEnum = pgEnum('script_origin', ['human', 'ai_proposal', 'imported', 'system']);
```

In the `scripts` table, after `version` (`:45`):

```ts
  // Spec §4.1: the RECORD's birth. A human edit after promotion cuts a new head
  // version with origin = human and empty review fields, so the library badge
  // honestly drops to "edited since review".
  origin: scriptOriginEnum('origin').notNull().default('human'),
  // Bare uuid: the proposal is org-scoped incident data that may be erased long
  // before this script is. The provenance panel renders "review evidence
  // erased" rather than following a broken link.
  originProposalId: uuid('origin_proposal_id'),
```

In the `scriptExecutions` table, change `:167` and add the new columns after `targetSessionId` (`:218`):

```ts
  // NULLABLE since 2026-10-16-100200: a proposal-backed execution has no
  // library script (spec D11). `script_executions_library_source_chk` pins
  // (source_kind = 'library') = (script_id IS NOT NULL).
  scriptId: uuid('script_id').references(() => scripts.id),
```

```ts
  // --- execution source + snapshot (2026-10-16-100200) -------------------
  sourceKind: text('source_kind').$type<'library' | 'proposal'>().notNull().default('library'),
  proposalId: uuid('proposal_id'),
  // Written at dispatch for BOTH sources so readers stop joining `scripts`
  // for the fields they need (staleCommandReaper, execution history, the
  // get_script_execution tool). Nullable because rows created before this
  // migration have no snapshot — every reader falls back to the join.
  language: scriptLanguageEnum('language'),
  timeoutSeconds: integer('timeout_seconds'),
  contentDigest: char('content_digest', { length: 64 }),
  // --- provenance (2026-10-16-100200) ------------------------------------
  // All bare uuids: this table is device-denormalised and restamped on device
  // move, so a same-org composite FK would abort the move.
  scriptVersionId: uuid('script_version_id'),
  reviewId: uuid('review_id'),
  approvedBy: uuid('approved_by'),
  approvalMethod: text('approval_method').$type<ScriptApprovalMethod>(),
  // Snapshots, not links: device activity must still render after the proposal
  // and its review are erased.
  reviewRiskTier: text('review_risk_tier').$type<'low' | 'medium' | 'high' | 'critical'>(),
  reviewSummary: varchar('review_summary', { length: 600 }),
```

Add `char` to the `drizzle-orm/pg-core` import list at `:2` and `import type { ScriptApprovalMethod } from '@breeze/shared';` beside the existing shared import at `:3`.

- [ ] **Step 5: Export the new module from the schema barrel**

`apps/api/src/db/schema/index.ts`, beside `export * from './scripts';`:

```ts
export * from './scriptProposals';
```

- [ ] **Step 6: Run the schema test and the drift check**

Run: `cd apps/api && npx vitest run src/db/schema/scriptProposals.test.ts`
Expected: PASS.

Run: `pnpm db:check-drift`
Expected: no drift — the Drizzle definitions match the three migrations.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/scriptProposals.ts apps/api/src/db/schema/scriptProposals.test.ts \
  apps/api/src/db/schema/scripts.ts apps/api/src/db/schema/index.ts
git commit -m "feat(db): drizzle schema for script proposals, reviews, execution source and script origin"
```

---

### Task 9: Register both tables in the org cascade and the audit-admin set

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:228` (`CORE_ORG_CASCADE_DELETE_ORDER`), `:586-590` (the `sc…` neighbourhood), `:973-981` (`AUDIT_ADMIN_REQUIRED_TABLES`)
- Test: `apps/api/src/db/schema/scriptProposals.registration.test.ts` (new; pattern copied from `apps/api/src/db/schema/aiAgentSchedules.test.ts:31-41`)

**Interfaces:**
- Consumes: the exported alias `ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:714`) — there is **no** exported `CORE_ORG_CASCADE_DELETE_ORDER`; tests must import the alias.

- [ ] **Step 1: Write the failing registration test**

```ts
// apps/api/src/db/schema/scriptProposals.registration.test.ts
import { describe, expect, it } from 'vitest';
import { ORG_CASCADE_DELETE_ORDER, __testOnly } from '../../services/tenantCascade';

describe('script proposal cascade registration', () => {
  it('registers both tables in the org cascade order', () => {
    expect(ORG_CASCADE_DELETE_ORDER).toContain('script_proposals');
    expect(ORG_CASCADE_DELETE_ORDER).toContain('script_proposal_reviews');
  });

  it('deletes reviews before proposals — reviews are the FK child', () => {
    // An FK declared without ON DELETE defaults to NO ACTION, so the
    // referencing table must be deleted FIRST or the cascade raises 23503.
    expect(ORG_CASCADE_DELETE_ORDER.indexOf('script_proposal_reviews'))
      .toBeLessThan(ORG_CASCADE_DELETE_ORDER.indexOf('script_proposals'));
  });

  it('keeps the list alphabetised by localeCompare around the new entries', () => {
    const i = ORG_CASCADE_DELETE_ORDER.indexOf('script_proposal_reviews');
    expect(ORG_CASCADE_DELETE_ORDER[i - 1]).toBe('script_executions');
    expect(ORG_CASCADE_DELETE_ORDER[i + 1]).toBe('script_proposals');
    expect(ORG_CASCADE_DELETE_ORDER[i + 2]).toBe('script_tags');
  });

  it('marks reviews as audit-admin required — they are append-only', () => {
    expect(__testOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('script_proposal_reviews')).toBe(true);
    // Proposals are NOT append-only: status transitions and the merge fence
    // mutate them, so they must stay out of this set.
    expect(__testOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('script_proposals')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/scriptProposals.registration.test.ts`
Expected: FAIL — `ORG_CASCADE_DELETE_ORDER` does not contain `script_proposals`.

- [ ] **Step 3: Insert the two entries in `CORE_ORG_CASCADE_DELETE_ORDER`**

In `apps/api/src/services/tenantCascade.ts`, between `'script_executions',` (`:588`) and `'script_tags',` (`:589`):

```ts
  'script_executions',
  'script_proposal_reviews',
  'script_proposals',
  'script_tags',
```

Ordering rationale worth stating in the PR: under `localeCompare` the `_` is variable-weight, so the comparison is `proposal` vs `proposals` vs `tags` — `script_proposal_reviews` < `script_proposals` < `script_tags`, and that alphabetical order happens to *also* be the required FK order (reviews reference proposals). Verified, not assumed.

- [ ] **Step 4: Add reviews to `AUDIT_ADMIN_REQUIRED_TABLES`**

In the same file, in the set at `:973-981`:

```ts
  'pam_actuation_results',
  // Append-only review evidence: REVOKE UPDATE/DELETE from breeze_app plus an
  // immutability trigger (2026-10-16-100100), so erasure has to run as
  // breeze_audit_admin with breeze.allow_audit_retention=1.
  'script_proposal_reviews',
]);
```

- [ ] **Step 5: Run the registration test and the cascade unit suite**

Run: `cd apps/api && npx vitest run src/db/schema/scriptProposals.registration.test.ts src/services/tenantCascade`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/db/schema/scriptProposals.registration.test.ts
git commit -m "feat(tenancy): register script proposals and reviews in the org cascade and audit-admin set"
```

---

### Task 10: Org-merge disposition — fence live proposals, leave reviews for erasure

**Files:**
- Modify: `apps/api/src/services/orgMergeRegistry.ts:124` (`SPECIAL`), near the `ai_operator_*` entries at `:233-235`
- Modify: `apps/api/src/services/orgMergeCustomExecutors.ts` — new executor beside `fenceAiOperatorTasks` (`:306-370`), plus `CUSTOM_EXECUTORS` (`:1188`), `CUSTOM_RESOLVE_EXECUTORS` (`:1225`), `CUSTOM_WOULD_REVOKE_COUNTS` (`:1245`)
- Test: `apps/api/src/services/orgMergeCustomExecutors.scriptProposals.test.ts` (new)

**Interfaces:**
- Produces: registry entries `script_proposals: { kind: 'custom', … }` and `script_proposal_reviews: { kind: 'leave-for-erasure', … }`; executors `fenceScriptProposals`, `moveScriptProposals`.

**Contradiction resolved here (state it in the PR):** the roadmap (§2) says *both* tables are `leave-for-erasure` "with a pre-merge fence". That combination does not exist in this engine — `runPolicy` (`orgMerge.ts:704-707`) makes `leave-for-erasure` a **no-op in both phases**, and `CUSTOM_RESOLVE_EXECUTORS` is only consulted under `case 'custom'` (`:741-743`). A fence therefore requires `kind: 'custom'` plus a no-op move half, exactly as `ai_operator_tasks` does (`orgMergeRegistry.ts:233`). Reviews need no fence and stay `leave-for-erasure`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/orgMergeCustomExecutors.scriptProposals.test.ts
import { describe, expect, it } from 'vitest';
import { getOrgMergePolicies } from './orgMergeRegistry';
import {
  CUSTOM_EXECUTORS, CUSTOM_RESOLVE_EXECUTORS, CUSTOM_WOULD_REVOKE_COUNTS,
} from './orgMergeCustomExecutors';

describe('script proposal org-merge disposition', () => {
  it('classifies proposals as custom so the fence can run, and reviews as leave-for-erasure', () => {
    const policies = getOrgMergePolicies();
    expect(policies.get('script_proposals')).toEqual(expect.objectContaining({ kind: 'custom' }));
    expect(policies.get('script_proposal_reviews'))
      .toEqual(expect.objectContaining({ kind: 'leave-for-erasure' }));
  });

  it('declares a resolve-phase fence AND a move half — a resolve half alone strands rows', () => {
    expect(CUSTOM_RESOLVE_EXECUTORS.script_proposals).toBeTypeOf('function');
    expect(CUSTOM_EXECUTORS.script_proposals).toBeTypeOf('function');
  });

  it('mirrors the fence in the merge preview so an operator is told work will stop', () => {
    expect(CUSTOM_WOULD_REVOKE_COUNTS.script_proposals).toBeTypeOf('function');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/orgMergeCustomExecutors.scriptProposals.test.ts`
Expected: FAIL — `getOrgMergePolicies().get('script_proposals')` is `undefined`.

- [ ] **Step 3: Add the registry entries**

In `apps/api/src/services/orgMergeRegistry.ts`, in `SPECIAL` beside the `ai_operator_*` block:

```ts
  script_proposals: { kind: 'custom', note: 'non-terminal proposals are fenced to status=expired BEFORE devices repoint (resolve phase), then left for erasure with the loser shell — proposal history is source-org incident history, same rule as ai_operator_tasks and ai_agent_runs' },
  script_proposal_reviews: { kind: 'leave-for-erasure', note: 'append-only review evidence hangs off a proposal that stays with the source org via a composite (proposal_id, org_id) FK; erased with it' },
```

- [ ] **Step 4: Add the fence, the no-op move half, and the preview counter**

In `apps/api/src/services/orgMergeCustomExecutors.ts`, beside `fenceAiOperatorTasks`:

```ts
// ---------------------------------------------------------------------------
// script_proposals — FENCE, then leave for erasure (AI script authoring W01b).
//
// Same deviation from "every executor leaves ZERO rows behind" as
// fenceAiOperatorTasks above, for the same reason: a proposal's evidence — its
// reviews, its intent, its execution — all stays with the loser, so repointing
// the proposal alone would split one incident's story across two orgs. Its
// org_id also anchors the composite (proposal_id, org_id) FK from
// script_proposal_reviews, so a bare repoint would 23503 regardless.
//
// Why `custom` rather than plain `leave-for-erasure`: leaving the rows alone is
// not safe. `devices` is a plain `repoint` table, so every target device moves
// to the survivor in the move phase — and a proposal still in a non-terminal
// state with `intent_id IS NULL` remains consumable by a run_script call, which
// would dispatch a real script to a device that now belongs to someone else,
// authorised by a tenant that no longer exists.
//
// It runs in the RESOLVE phase, which is what makes "before devices repoint"
// true: resolve completes for every table before move starts for any of them.
// ---------------------------------------------------------------------------

/** Non-terminal proposal states — the ones the fence stops. */
const SCRIPT_PROPOSAL_LIVE_STATUSES = sql`('proposed', 'reviewed', 'approved', 'changes_requested', 'review_failed')`;

const fenceScriptProposals: CustomMergeExecutor = async (loser) => {
  const fenced = await run(sql`
    UPDATE script_proposals
       SET status = 'expired',
           decision_note = left(
             coalesce(decision_note || E'\n', '')
             || 'Expired by an organization merge: the owning organization was merged away, so this proposal can no longer be run.',
             4000)
     WHERE org_id = ${uuid(loser)}
       AND status IN ${SCRIPT_PROPOSAL_LIVE_STATUSES}`);

  return {
    moved: 0,
    dropped: 0,
    notes: fenced > 0
      ? [
        `script_proposals: expired ${fenced} live AI script proposal(s) from the merged-away org so `
        + 'none can be dispatched to devices that now belong to the surviving organization. The '
        + 'proposal records themselves are NOT re-tenanted — proposal and review evidence stays with '
        + 'the source org and is erased with the loser shell. Re-propose under the surviving '
        + 'organization if the work still needs doing.',
      ]
      : [],
  };
};

/**
 * script_proposals, MOVE half — a no-op. The resolve half did the whole
 * disposition; the rows stay put on purpose (leave-for-erasure semantics).
 */
const moveScriptProposals: CustomMergeExecutor = async () => ({ moved: 0, dropped: 0, notes: [] });
```

Then register all three:

```ts
// CUSTOM_EXECUTORS (:1188)
  script_proposals: moveScriptProposals,

// CUSTOM_RESOLVE_EXECUTORS (:1225)
  // Must run in resolve, not move: `devices` repoints in the move phase and a
  // live proposal targeting one of them would still be consumable.
  script_proposals: fenceScriptProposals,

// CUSTOM_WOULD_REVOKE_COUNTS (:1245) — mirrors fenceScriptProposals' WHERE exactly.
  script_proposals: (loser) => sql`
    SELECT count(*)::int AS n FROM script_proposals
     WHERE org_id = ${uuid(loser)}
       AND status IN ${SCRIPT_PROPOSAL_LIVE_STATUSES}`,
```

- [ ] **Step 5: Run the unit tests**

Run: `cd apps/api && npx vitest run src/services/orgMergeCustomExecutors.scriptProposals.test.ts src/services/orgMergeExecutors.test.ts`
Expected: PASS. `orgMergeExecutors.test.ts:191` walks every registry entry, so an unregistered `custom` executor fails there.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/orgMergeCustomExecutors.ts \
  apps/api/src/services/orgMergeCustomExecutors.scriptProposals.test.ts
git commit -m "feat(tenancy): fence live script proposals on org merge and leave review evidence for erasure"
```

---

### Task 11: Export-policy classification for two tables and eleven new columns

**Files:**
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:41` (`CORE_TENANT_EXPORT_POLICY`), `:428` (`script_executions`), `:437` (`scripts`)
- Test: extend `apps/api/src/db/schema/scriptProposals.registration.test.ts` from Task 9

**Interfaces:**
- Consumes: `tablePolicy(organizationKey, groups)` (`tenantExportPolicyRegistry.ts:17-19`) with buckets `included` / `reviewedIncluded` / `excludedSensitive` / `excludedOpen` (`:4-10`).
- **Enforcement being satisfied** (`tenantExportPolicy.ts:212-227`): an `include` on a column whose name matches `SUSPICIOUS_NAME_PARTS` (`:34-55`, includes `token`) throws unless `reviewedSensitiveName: true`; every `json`/`jsonb`/`bytea` column throws unless `openContainerReviewed: true`. Both flags come from the bucket, never hand-written.

- [ ] **Step 1: Add the failing assertions to the registration test**

Append to `apps/api/src/db/schema/scriptProposals.registration.test.ts`:

```ts
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

describe('script proposal export-policy classification', () => {
  it('classifies both new tables', () => {
    expect(CORE_TENANT_EXPORT_POLICY.script_proposals).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.script_proposal_reviews).toBeDefined();
  });

  it('excludes every open container on the new tables', () => {
    const proposals = CORE_TENANT_EXPORT_POLICY.script_proposals!.columns;
    expect(proposals.verification!.decision).toBe('exclude');
    expect(proposals.verification_result!.decision).toBe('exclude');
    expect(CORE_TENANT_EXPORT_POLICY.script_proposal_reviews!.columns.verdict!.decision).toBe('exclude');
  });

  it('includes the review token counters as reviewed sensitive names', () => {
    const reviews = CORE_TENANT_EXPORT_POLICY.script_proposal_reviews!.columns;
    for (const col of ['input_tokens', 'output_tokens'] as const) {
      expect(reviews[col]!.decision).toBe('include');
      expect(reviews[col]!.reviewedSensitiveName).toBe(true);
    }
  });

  it('classifies every new column on the two already-registered tables', () => {
    const execs = CORE_TENANT_EXPORT_POLICY.script_executions!.columns;
    for (const col of [
      'source_kind', 'proposal_id', 'language', 'timeout_seconds', 'content_digest',
      'script_version_id', 'review_id', 'approved_by', 'approval_method',
      'review_risk_tier', 'review_summary',
    ]) {
      expect(execs[col], `script_executions.${col}`).toBeDefined();
    }
    const scriptCols = CORE_TENANT_EXPORT_POLICY.scripts!.columns;
    expect(scriptCols.origin).toBeDefined();
    expect(scriptCols.origin_proposal_id).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/scriptProposals.registration.test.ts`
Expected: FAIL — `CORE_TENANT_EXPORT_POLICY.script_proposals` is `undefined`.

- [ ] **Step 3: Add the two new table entries**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, alphabetically after the `script_executions` entry (`:428`), in the file's single-line double-quoted style:

```ts
  "script_proposal_reviews": tablePolicy("org_id", {"included":["id","org_id","proposal_id","reviewer_kind","model","reviewer_prompt_version","status","summary","risk_tier","goal_match","reversible","verification_adequate","recommended_action","cost_cents","budget_reservation_id","created_at"],"reviewedIncluded":["input_tokens","output_tokens"],"excludedSensitive":[],"excludedOpen":["verdict"]}),
  "script_proposals": tablePolicy("org_id", {"included":["id","org_id","author_kind","session_id","agent_run_id","language","content","content_digest","timeout_seconds","run_as","goal","expected_effect","rollback_note","target_device_ids","scanner_version","basic_hits","strict_hits","touch_classes","status","revision","supersedes_id","risk_tier","decided_by","decided_at","decision_note","intent_id","verified_at","promoted_script_id","promoted_version_id","created_at","expires_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["verification","verification_result"]}),
```

`content` is `included`: it is the customer's own script text, the thing the tenant most needs in an export, and it is a plain `text` column, not an open container. `verification` and `verification_result` are `jsonb` and therefore `excludedOpen` regardless of how harmless their contents look.

- [ ] **Step 4: Extend the two existing entries**

`script_executions` (`:428`) — append to its `included` array:

```
,"source_kind","proposal_id","language","timeout_seconds","content_digest","script_version_id","review_id","approved_by","approval_method","review_risk_tier","review_summary"
```

`scripts` (`:437`) — append to its `included` array:

```
,"origin","origin_proposal_id"
```

- [ ] **Step 5: Confirm the device-side lists and the RLS allowlists need no change**

Read and assert, do not assume:

```bash
grep -n "script_executions" apps/api/src/routes/devices/core.ts
grep -n "script_proposal" apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
```

Expected: `script_executions` is already at `routes/devices/core.ts:294` (`CORE_DEVICE_ORG_DENORMALIZED_TABLES`, declared `:261`) and `:516` (`CORE_DEVICE_CASCADE_DELETE_TABLES`, declared `:477`) — **no change**; the new columns are not device ids. The second grep returns nothing, which is correct: shape-1 tables with a direct `org_id` are auto-discovered by the `org_id_tables` CTE at `rls-coverage.integration.test.ts:1127-1137` and belong in **no** allowlist. Record both findings in the PR body.

- [ ] **Step 6: Run the test**

Run: `cd apps/api && npx vitest run src/db/schema/scriptProposals.registration.test.ts`
Expected: PASS. A bucket mistake surfaces here as a thrown `[tenantExport] …` error at registry construction, not a soft assertion failure.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/db/schema/scriptProposals.registration.test.ts
git commit -m "feat(tenancy): classify script proposal tables and the new execution/script columns for tenant export"
```

---

### Task 12: `scriptProposals/proposals.ts` — creation, CAS transitions, consumption

**Files:**
- Create: `apps/api/src/services/scriptProposals/proposals.ts`, `apps/api/src/services/scriptProposals/index.ts`
- Test: `apps/api/src/services/scriptProposals/proposals.test.ts`

**Interfaces:**
- Consumes: `scanScriptContent`, `proposeScriptInputSchema`, `ProposeScriptInput` (`@breeze/shared`); `sha256Content` (`apps/api/src/services/scriptVersions.ts`, W01a); `ScriptProposalRow` (Task 8).
- Produces, exactly as roadmap §3.3 declares:
  ```ts
  export function createScriptProposal(auth, input, author): Promise<{ proposal: ScriptProposalRow; scan: ScriptScanResult }>;
  export function getScriptProposalForPrincipal(auth, proposalId): Promise<ScriptProposalRow | null>;
  export function supersedeProposal(tx, oldId, newId): Promise<void>;
  export function transitionProposal(tx, proposalId, from, to, patch?): Promise<boolean>;
  export function consumeProposalForIntent(tx, proposalId, intentId): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/scriptProposals/proposals.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: Record<string, unknown>[] = [];
const returningMock = vi.fn(async () => [{ id: 'p1', status: 'proposed' }]);
const updateWhereMock = vi.fn(async () => ({ rowCount: 1 }));

vi.mock('../../db', () => ({
  db: {
    insert: () => ({ values: (v: Record<string, unknown>) => { rows.push(v); return { returning: returningMock }; } }),
    update: () => ({ set: () => ({ where: updateWhereMock }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));

import { createScriptProposal } from './proposals';

const auth = { orgId: 'org-1', user: { id: 'u1' } } as never;
const input = {
  language: 'powershell' as const,
  content: 'Restart-Service -Name Spooler',
  goal: 'stuck spooler',
  expectedEffect: 'spooler restarted',
  verification: { kind: 'service_running' as const, name: 'Spooler' },
  deviceIds: ['11111111-1111-4111-8111-111111111111'],
};

beforeEach(() => { rows.length = 0; });

describe('createScriptProposal', () => {
  it('stamps the scan output, the scanner version and a sha256 content digest on the row', async () => {
    const { scan } = await createScriptProposal(auth, input, { kind: 'chat_session', sessionId: 's1' });
    const row = rows[0]!;
    expect(row.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.scannerVersion).toBe(scan.scannerVersion);
    expect(row.touchClasses).toEqual(scan.touchClasses);
    expect(row.touchClasses).toContain('services');
  });

  it('records status scan_rejected without enqueueing anything when a BASIC pattern hits', async () => {
    const { proposal, scan } = await createScriptProposal(
      auth, { ...input, content: 'Format-Volume -DriveLetter D' }, { kind: 'chat_session', sessionId: 's1' });
    expect(scan.basicHits).toEqual(['PowerShell volume format']);
    expect(rows[0]!.status).toBe('scan_rejected');
    expect(proposal).toBeDefined();
  });

  it('records a STRICT hit but leaves the proposal proposed — strict is acknowledgeable, not fatal', async () => {
    const { scan } = await createScriptProposal(
      auth, { ...input, content: 'reg add HKLM\\SOFTWARE\\X /v Y /d 1 /f' }, { kind: 'chat_session', sessionId: 's1' });
    expect(scan.strictHits.length).toBeGreaterThan(0);
    expect(rows[0]!.status).toBe('proposed');
  });

  it('stamps the agent run id and a null session id for an agent author', async () => {
    await createScriptProposal(auth, input, { kind: 'agent_run', agentRunId: 'r1' });
    expect(rows[0]!.authorKind).toBe('agent_run');
    expect(rows[0]!.agentRunId).toBe('r1');
    expect(rows[0]!.sessionId).toBeNull();
  });

  it('sets expiry 24 hours out', async () => {
    await createScriptProposal(auth, input, { kind: 'chat_session', sessionId: 's1' });
    const delta = (rows[0]!.expiresAt as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(23 * 3600_000);
    expect(delta).toBeLessThanOrEqual(24 * 3600_000 + 5_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/proposals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// apps/api/src/services/scriptProposals/proposals.ts
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  type ProposeScriptInput, type ScriptProposalStatus, type ScriptScanResult, scanScriptContent,
} from '@breeze/shared';
import { db } from '../../db';
import { scriptProposals, type ScriptProposalRow } from '../../db/schema';
import { sha256Content } from '../scriptVersions';
import type { AuthContext } from '../../middleware/auth';

export type ScriptProposalAuthor =
  // sessionId is nullable: the chat SDK's tool handlers receive `(input, auth)`
  // and the Breeze session id is not one of the arguments (only the
  // session-AWARE M365 handlers get it, and those are deliberately outside the
  // aiTools registry). `author_kind` is the column that is always truthful.
  | { kind: 'chat_session'; sessionId: string | null }
  | { kind: 'agent_run'; agentRunId: string };

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Create an immutable, content-addressed proposal.
 *
 * The scan runs BEFORE the insert and its verdict is part of the row, never a
 * later update: `content`, `content_digest`, `basic_hits`, `strict_hits`,
 * `touch_classes` and `scanner_version` are all covered by the immutability
 * trigger, so what a reviewer and an approver see is what was scanned.
 *
 * A BASIC hit lands the row in `scan_rejected` and STOPS (spec §4.4): no model
 * review is requested, no approval card is ever built, and no budget is
 * reserved. The row is still written so the attempt is auditable — a rejected
 * proposal is exactly the forensic trail you want when an assistant was steered
 * into writing something destructive.
 */
export async function createScriptProposal(
  auth: AuthContext,
  input: ProposeScriptInput,
  author: ScriptProposalAuthor,
): Promise<{ proposal: ScriptProposalRow; scan: ScriptScanResult }> {
  const scan = scanScriptContent(input.content, input.language);
  const status: ScriptProposalStatus = scan.basicHits.length > 0 ? 'scan_rejected' : 'proposed';

  const [proposal] = await db
    .insert(scriptProposals)
    .values({
      orgId: auth.orgId!,
      authorKind: author.kind,
      sessionId: author.kind === 'chat_session' ? author.sessionId : null,
      agentRunId: author.kind === 'agent_run' ? author.agentRunId : null,
      language: input.language,
      content: input.content,
      contentDigest: sha256Content(input.content),
      timeoutSeconds: input.timeoutSeconds,
      runAs: input.runAs,
      goal: input.goal,
      expectedEffect: input.expectedEffect,
      verification: input.verification,
      rollbackNote: input.rollbackNote ?? null,
      targetDeviceIds: input.deviceIds,
      scannerVersion: scan.scannerVersion,
      basicHits: scan.basicHits,
      strictHits: scan.strictHits,
      touchClasses: scan.touchClasses,
      status,
      revision: 1,
      supersedesId: input.supersedesProposalId ?? null,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    })
    .returning();

  if (!proposal) throw new Error('Failed to create script proposal');
  return { proposal, scan };
}

/** Org-scoped read. Returns null rather than throwing on a cross-org id. */
export async function getScriptProposalForPrincipal(
  auth: AuthContext,
  proposalId: string,
): Promise<ScriptProposalRow | null> {
  const [row] = await db
    .select()
    .from(scriptProposals)
    .where(and(eq(scriptProposals.id, proposalId), eq(scriptProposals.orgId, auth.orgId!)))
    .limit(1);
  return row ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * CAS on status. Returns false — never throws — when the row has already moved,
 * so a caller in a request transaction can branch instead of aborting the
 * transaction (a caught error inside `withDbAccessContext` still poisons the
 * enclosing tx and turns a mapped 409 into a 500 at commit).
 */
export async function transitionProposal(
  tx: Tx,
  proposalId: string,
  from: ScriptProposalStatus[],
  to: ScriptProposalStatus,
  patch: Partial<ScriptProposalRow> = {},
): Promise<boolean> {
  const result = await tx
    .update(scriptProposals)
    .set({ ...patch, status: to })
    .where(and(eq(scriptProposals.id, proposalId), inArray(scriptProposals.status, from)));
  return (result as { rowCount?: number }).rowCount === 1;
}

/** The revision loop: the old row becomes terminal and can never be consumed. */
export async function supersedeProposal(tx: Tx, oldId: string, newId: string): Promise<void> {
  await transitionProposal(
    tx, oldId,
    ['proposed', 'reviewed', 'changes_requested', 'review_failed', 'scan_rejected'],
    'superseded',
    { decisionNote: `Superseded by proposal ${newId}` },
  );
}

/**
 * Atomically claim the proposal for exactly one intent.
 *
 * The `intent_id IS NULL` predicate is the whole mutual exclusion: two
 * concurrent `run_script { proposalId }` calls both read `reviewed`, both try
 * this, and exactly one UPDATE matches. Status is left at `reviewed` — the
 * approval lifecycle belongs to the intent, and the proposal only records that
 * it has been spoken for. `expires_at > now()` is re-checked here rather than
 * trusted from the earlier read.
 */
export async function consumeProposalForIntent(
  tx: Tx,
  proposalId: string,
  intentId: string,
): Promise<boolean> {
  const result = await tx
    .update(scriptProposals)
    .set({ intentId })
    .where(and(
      eq(scriptProposals.id, proposalId),
      isNull(scriptProposals.intentId),
      eq(scriptProposals.status, 'reviewed'),
      sql`${scriptProposals.expiresAt} > now()`,
    ));
  return (result as { rowCount?: number }).rowCount === 1;
}
```

```ts
// apps/api/src/services/scriptProposals/index.ts
/**
 * Hub for the script-proposal service. Per-concern files behind one import
 * path, following the aiTools*.ts convention.
 */
export * from './proposals';
export * from './runnable';
export * from './guardrailContext';
export * from './dispatchSnapshot';
export * from './reviewQueue';
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/proposals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptProposals/proposals.ts apps/api/src/services/scriptProposals/index.ts \
  apps/api/src/services/scriptProposals/proposals.test.ts
git commit -m "feat(ai): script proposal creation, CAS transitions and single-intent consumption"
```

---

### Task 13: `scriptProposals/runnable.ts` — the `run_script { proposalId }` gate

**Files:**
- Create: `apps/api/src/services/scriptProposals/runnable.ts`
- Test: `apps/api/src/services/scriptProposals/runnable.test.ts`

**Interfaces:**
- Produces, exactly as roadmap §3.3 declares:
  ```ts
  export type ProposalRunnability =
    | { ok: true; proposal: ScriptProposalRow }
    | { ok: false; reason: 'not_found'|'wrong_org'|'not_reviewed'|'expired'|'superseded'|'consumed'|'device_not_targeted'|'run_as_mismatch'|'timeout_mismatch'|'parameters_not_allowed' };
  export function assertProposalRunnable(auth, input): Promise<ProposalRunnability>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/scriptProposals/runnable.test.ts
import { describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown> | null = null;
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }) }) },
}));
import { assertProposalRunnable } from './runnable';

const auth = { orgId: 'org-1' } as never;
const device = '11111111-1111-4111-8111-111111111111';
const base = {
  id: 'p1', orgId: 'org-1', status: 'reviewed', intentId: null,
  expiresAt: new Date(Date.now() + 3600_000), targetDeviceIds: [device],
  runAs: 'system', timeoutSeconds: 300,
};
const call = (over: Record<string, unknown> = {}) =>
  assertProposalRunnable(auth, { proposalId: 'p1', deviceIds: [device], ...over });

describe('assertProposalRunnable', () => {
  it('accepts a reviewed, unconsumed, unexpired proposal on a targeted device', async () => {
    stored = { ...base };
    await expect(call()).resolves.toEqual({ ok: true, proposal: stored });
  });

  it.each([
    ['not_found', null, {}],
    ['wrong_org', { ...base, orgId: 'org-2' }, {}],
    ['not_reviewed', { ...base, status: 'proposed' }, {}],
    ['superseded', { ...base, status: 'superseded' }, {}],
    ['consumed', { ...base, intentId: 'i1' }, {}],
    ['expired', { ...base, expiresAt: new Date(Date.now() - 1000) }, {}],
    ['device_not_targeted', { ...base }, { deviceIds: ['22222222-2222-4222-8222-222222222222'] }],
    ['run_as_mismatch', { ...base }, { runAs: 'user' }],
    ['timeout_mismatch', { ...base }, { timeoutSeconds: 60 }],
    ['parameters_not_allowed', { ...base }, { parameters: { a: 1 } }],
  ])('refuses with %s', async (reason, row, over) => {
    stored = row as Record<string, unknown> | null;
    await expect(call(over as Record<string, unknown>)).resolves.toEqual({ ok: false, reason });
  });

  it('never silently degrades to a library run — every refusal is explicit', async () => {
    stored = { ...base, status: 'rejected' };
    const result = await call();
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/runnable.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/scriptProposals/runnable.ts
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { scriptProposals, type ScriptProposalRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';

export type ProposalRunnabilityReason =
  | 'not_found' | 'wrong_org' | 'not_reviewed' | 'expired' | 'superseded' | 'consumed'
  | 'device_not_targeted' | 'run_as_mismatch' | 'timeout_mismatch' | 'parameters_not_allowed';

export type ProposalRunnability =
  | { ok: true; proposal: ScriptProposalRow }
  | { ok: false; reason: ProposalRunnabilityReason };

/**
 * The spec §4.2 validation list for `run_script { proposalId }`.
 *
 * Order matters for the message the author gets back: identity and lifecycle
 * first, then the request-vs-proposal equalities. A failure is ALWAYS a tool
 * error — there is no fallback to `scriptId`, because silently running a
 * different thing than the one that was reviewed is the exact failure this
 * whole design exists to prevent.
 *
 * This is a pre-check, not the mutual exclusion. `consumeProposalForIntent`
 * (proposals.ts) is the real gate, and it runs inside the intent transaction.
 * A `consumed` verdict here just turns a lost race into a readable error.
 */
export async function assertProposalRunnable(
  auth: AuthContext,
  input: {
    proposalId: string; deviceIds: string[];
    runAs?: string; timeoutSeconds?: number; parameters?: unknown;
  },
): Promise<ProposalRunnability> {
  const [proposal] = await db
    .select().from(scriptProposals).where(eq(scriptProposals.id, input.proposalId)).limit(1);

  if (!proposal) return { ok: false, reason: 'not_found' };
  if (proposal.orgId !== auth.orgId) return { ok: false, reason: 'wrong_org' };
  if (proposal.status === 'superseded') return { ok: false, reason: 'superseded' };
  if (proposal.status !== 'reviewed') return { ok: false, reason: 'not_reviewed' };
  if (proposal.intentId !== null) return { ok: false, reason: 'consumed' };
  if (proposal.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const targeted = new Set(proposal.targetDeviceIds);
  if (!input.deviceIds.every((id) => targeted.has(id))) {
    return { ok: false, reason: 'device_not_targeted' };
  }
  // Equality, not "absent means inherit": a caller that names a run context at
  // all must name the one that was reviewed, because run_as changes what the
  // script can do on the device.
  if (input.runAs !== undefined && input.runAs !== proposal.runAs) {
    return { ok: false, reason: 'run_as_mismatch' };
  }
  if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== proposal.timeoutSeconds) {
    return { ok: false, reason: 'timeout_mismatch' };
  }
  // A proposal has no parameter definitions: its content is literal and its
  // digest pins that literal content. Accepting parameters would mean running
  // something the reviewer never saw.
  if (input.parameters !== undefined && input.parameters !== null
      && Object.keys(input.parameters as Record<string, unknown>).length > 0) {
    return { ok: false, reason: 'parameters_not_allowed' };
  }

  return { ok: true, proposal };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/runnable.test.ts`
Expected: PASS (11 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptProposals/runnable.ts apps/api/src/services/scriptProposals/runnable.test.ts
git commit -m "feat(ai): validate run_script proposal runnability with typed refusal reasons"
```

---

### Task 14: `guardrailContext.ts` and `dispatchSnapshot.ts`

**Files:**
- Create: `apps/api/src/services/scriptProposals/guardrailContext.ts`, `apps/api/src/services/scriptProposals/dispatchSnapshot.ts`
- Test: `apps/api/src/services/scriptProposals/guardrailContext.test.ts`, `apps/api/src/services/scriptProposals/dispatchSnapshot.test.ts`

**Interfaces:**
- Consumes: `GuardrailContext` from `../aiGuardrails` (Task 16 defines it; if Task 16 has not landed, implement it there first — the two are a pair).
- Produces:
  ```ts
  export function loadProposalGuardrailContext(input: Record<string, unknown>, orgId: string): Promise<GuardrailContext | undefined>;
  export interface ProposalDispatchSnapshot { proposalId: string; contentDigest: string; language: ScriptLanguage; runAs: 'system'|'user'; timeoutSeconds: number; deviceIds: string[]; scannerVersion: string }
  export function proposalDispatchSnapshot(p: ScriptProposalRow, deviceIds: string[]): ProposalDispatchSnapshot;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/scriptProposals/guardrailContext.test.ts
import { describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown> | null = null;
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }) }) },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));
import { loadProposalGuardrailContext } from './guardrailContext';

describe('loadProposalGuardrailContext', () => {
  it('returns undefined when the input names no proposal — every other tool is unaffected', async () => {
    await expect(loadProposalGuardrailContext({ scriptId: 's1' }, 'org-1')).resolves.toBeUndefined();
  });

  it('returns the persisted risk tier and strict hits for a same-org proposal', async () => {
    stored = { id: 'p1', orgId: 'org-1', riskTier: 'medium', strictHits: ['PowerShell HKLM modification'] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toEqual({
      proposal: { riskTier: 'medium', strictHits: ['PowerShell HKLM modification'] },
    });
  });

  it('returns undefined for a cross-org proposal so the guardrail denies rather than borrows a tier', async () => {
    stored = { id: 'p1', orgId: 'org-2', riskTier: 'low', strictHits: [] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toBeUndefined();
  });

  it('returns undefined when no review has set a risk tier yet', async () => {
    stored = { id: 'p1', orgId: 'org-1', riskTier: null, strictHits: [] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toBeUndefined();
  });
});
```

```ts
// apps/api/src/services/scriptProposals/dispatchSnapshot.test.ts
import { describe, expect, it } from 'vitest';
import { proposalDispatchSnapshot } from './dispatchSnapshot';

const proposal = {
  id: 'p1', contentDigest: 'a'.repeat(64), language: 'powershell', runAs: 'system',
  timeoutSeconds: 300, scannerVersion: '2026-09-11.1',
} as never;

describe('proposalDispatchSnapshot', () => {
  it('sorts device ids so the digest is order-independent', () => {
    const a = proposalDispatchSnapshot(proposal, ['b-id', 'a-id']);
    const b = proposalDispatchSnapshot(proposal, ['a-id', 'b-id']);
    expect(a.deviceIds).toEqual(['a-id', 'b-id']);
    expect(a).toEqual(b);
  });

  it('carries only pinned material — no lifecycle state', () => {
    expect(Object.keys(proposalDispatchSnapshot(proposal, ['a-id'])).sort()).toEqual([
      'contentDigest', 'deviceIds', 'language', 'proposalId', 'runAs', 'scannerVersion', 'timeoutSeconds',
    ]);
  });
});
```

- [ ] **Step 2: Run both and watch them fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/guardrailContext.test.ts src/services/scriptProposals/dispatchSnapshot.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `guardrailContext.ts`**

```ts
// apps/api/src/services/scriptProposals/guardrailContext.ts
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { scriptProposals } from '../../db/schema';
import type { GuardrailContext } from '../aiGuardrails';

/**
 * The DB half of the input-aware `run_script` guardrail.
 *
 * It lives HERE, not in aiGuardrails.ts: that module must not import the DB
 * schema (aiGuardrails.imports.contract.test.ts), and `checkGuardrails` is
 * synchronous by contract. So every caller loads the context first and hands it
 * in.
 *
 * Returning `undefined` is a DENY signal, not a "no opinion": `checkGuardrails`
 * turns a `run_script` call that names a proposal but arrives with no context
 * into tier 4 / `proposal_context_missing`. That is why a cross-org id and an
 * unreviewed proposal both return undefined rather than a fabricated tier —
 * failing closed here is strictly safer than guessing.
 */
export async function loadProposalGuardrailContext(
  input: Record<string, unknown>,
  orgId: string,
): Promise<GuardrailContext | undefined> {
  const proposalId = input.proposalId;
  if (typeof proposalId !== 'string' || proposalId.length === 0) return undefined;

  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({
      orgId: scriptProposals.orgId,
      riskTier: scriptProposals.riskTier,
      strictHits: scriptProposals.strictHits,
    })
      .from(scriptProposals)
      .where(eq(scriptProposals.id, proposalId))
      .limit(1)));

  if (!row || row.orgId !== orgId || !row.riskTier) return undefined;
  return { proposal: { riskTier: row.riskTier, strictHits: row.strictHits ?? [] } };
}
```

- [ ] **Step 4: Implement `dispatchSnapshot.ts`**

```ts
// apps/api/src/services/scriptProposals/dispatchSnapshot.ts
import type { ScriptLanguage } from '@breeze/shared';
import type { ScriptProposalRow } from '../../db/schema';

/**
 * The pinned material for a proposal-backed run (spec §4.5).
 *
 * Deliberately EXCLUDES every lifecycle field — status, intent_id, expiry,
 * decision. Release re-checks those separately and fails with
 * `proposal_not_runnable`; folding them into the digest would make an ordinary,
 * expected state change look like content tampering (`content_changed`) and
 * destroy the distinction the operator needs.
 */
export interface ProposalDispatchSnapshot {
  proposalId: string;
  contentDigest: string;
  language: ScriptLanguage;
  runAs: 'system' | 'user';
  timeoutSeconds: number;
  deviceIds: string[];
  scannerVersion: string;
}

export function proposalDispatchSnapshot(
  proposal: ScriptProposalRow,
  deviceIds: string[],
): ProposalDispatchSnapshot {
  return {
    proposalId: proposal.id,
    contentDigest: proposal.contentDigest,
    language: proposal.language as ScriptLanguage,
    runAs: proposal.runAs,
    timeoutSeconds: proposal.timeoutSeconds,
    // Sorted: the same set of devices in a different argument order is the same
    // effect and must produce the same digest.
    deviceIds: [...deviceIds].sort(),
    scannerVersion: proposal.scannerVersion,
  };
}
```

- [ ] **Step 5: Run both suites**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/guardrailContext.test.ts src/services/scriptProposals/dispatchSnapshot.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/scriptProposals/guardrailContext.ts \
  apps/api/src/services/scriptProposals/dispatchSnapshot.ts \
  apps/api/src/services/scriptProposals/guardrailContext.test.ts \
  apps/api/src/services/scriptProposals/dispatchSnapshot.test.ts
git commit -m "feat(ai): proposal guardrail context loader and pinned dispatch snapshot"
```

---

### Task 15: `scriptProposals/reviewQueue.ts` — queue definition and inline wait

**Files:**
- Create: `apps/api/src/services/scriptProposals/reviewQueue.ts`
- Test: `apps/api/src/services/scriptProposals/reviewQueue.test.ts`

**Interfaces:**
- Produces, exactly as roadmap §3.3 declares: `SCRIPT_REVIEW_QUEUE = 'script-review'`, `ScriptReviewJobData = { proposalId: string; orgId: string; attempt: number }`, `enqueueScriptReview(data)`, `waitForReviewCompletion(proposalId, timeoutMs): Promise<ScriptProposalReviewRow | null>`.
- **The worker is W02.** This wave defines the contract and the inline wait only; nothing consumes the queue yet, so `propose_script` returns `review: { status: 'pending' }` in practice.
- Template: `waitForApproval` (`apps/api/src/services/aiAgent.ts:283-341`) — per-query `withSystemDbAccessContext` (never around the loop), abort check at the top of each iteration, circuit break at 5 consecutive errors. **Divergence, stated on purpose:** `waitForApproval` writes a terminal rejection on timeout; this one writes nothing. The proposal's own status is the reviewer worker's to own, and a wait that timed out has learned nothing about the review.
- Repo rule reused: BullMQ job ids must not contain colons (`apps/api/src/jobs/quoteSendQueue.ts:45`), so the job id uses `-`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/scriptProposals/reviewQueue.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const addMock = vi.fn(async () => undefined);
vi.mock('bullmq', () => ({ Queue: class { add = addMock; } }));
vi.mock('../redis', () => ({ getBullMQConnection: () => ({}) }));

let selectImpl: () => Promise<Record<string, unknown>[]> = async () => [];
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => selectImpl() }) }) }) }) },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));

import { SCRIPT_REVIEW_QUEUE, enqueueScriptReview, waitForReviewCompletion } from './reviewQueue';

afterEach(() => { vi.useRealTimers(); addMock.mockClear(); });

describe('script review queue', () => {
  it('names the queue script-review', () => {
    expect(SCRIPT_REVIEW_QUEUE).toBe('script-review');
  });

  it('enqueues with an attempt-scoped, colon-free job id so a retry is not a silent no-op', async () => {
    await enqueueScriptReview({ proposalId: 'p1', orgId: 'o1', attempt: 2 });
    const [, , options] = addMock.mock.calls[0]!;
    expect((options as { jobId: string }).jobId).toBe('script-review-p1-2');
    expect((options as { jobId: string }).jobId).not.toContain(':');
  });

  it('returns the completed review as soon as one exists', async () => {
    selectImpl = async () => [{ id: 'r1', status: 'completed' }];
    await expect(waitForReviewCompletion('p1', 5_000)).resolves.toMatchObject({ id: 'r1' });
  });

  it('returns a failed review too — the caller reports it, it is not an absence', async () => {
    selectImpl = async () => [{ id: 'r1', status: 'failed' }];
    await expect(waitForReviewCompletion('p1', 5_000)).resolves.toMatchObject({ status: 'failed' });
  });

  it('returns null after five consecutive DB errors without waiting out the timeout', async () => {
    selectImpl = async () => { throw new Error('boom'); };
    const started = Date.now();
    await expect(waitForReviewCompletion('p1', 600_000)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/reviewQueue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/scriptProposals/reviewQueue.ts
import { Queue } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { scriptProposalReviews, type ScriptProposalReviewRow } from '../../db/schema';
import { getBullMQConnection } from '../redis';

export const SCRIPT_REVIEW_QUEUE = 'script-review';

export type ScriptReviewJobData = { proposalId: string; orgId: string; attempt: number };

const POLL_INTERVAL_MS = 2_000;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_ATTEMPTS = 3;

let queue: Queue<ScriptReviewJobData> | null = null;

export function getScriptReviewQueue(): Queue<ScriptReviewJobData> {
  if (!queue) queue = new Queue<ScriptReviewJobData>(SCRIPT_REVIEW_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/**
 * Enqueue one review attempt. The worker lands in W02.
 *
 * The job id carries the ATTEMPT because BullMQ retains a completed job's hash
 * under `removeOnComplete`, which makes a re-add under the same id a silent
 * no-op — a retried review would never run. Colons are forbidden in job ids
 * (repo rule, jobs/quoteSendQueue.ts:45), so this is `-` separated, unlike the
 * budget reservation key, which is not a job id.
 */
export async function enqueueScriptReview(data: ScriptReviewJobData): Promise<void> {
  await getScriptReviewQueue().add('review', data, {
    jobId: `script-review-${data.proposalId}-${data.attempt}`,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  });
}

/**
 * Poll the reviews table for a terminal review of this proposal.
 *
 * Modelled on `waitForApproval` (services/aiAgent.ts:283-341) with two
 * deliberate differences: a flat 2 s interval rather than a 500 ms→3 s ramp
 * (a model review never completes in under a second, so a fast first poll only
 * costs a query), and NO terminal write on timeout — the reviewer worker owns
 * the proposal's status, and a wait that expired has learned nothing about the
 * review. A `null` here means "not yet", never "failed".
 */
export async function waitForReviewCompletion(
  proposalId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ScriptProposalReviewRow | null> {
  const startedAt = Date.now();
  let consecutiveErrors = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) return null;
    try {
      // Per-QUERY context, not one around the loop: holding a pooled
      // connection across a 2 s sleep is how a wait at concurrency ≥ pool size
      // becomes a hang.
      const [review] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.select().from(scriptProposalReviews)
          .where(eq(scriptProposalReviews.proposalId, proposalId))
          .orderBy(desc(scriptProposalReviews.createdAt))
          .limit(1)));
      consecutiveErrors = 0;
      if (review) return review;
    } catch (err) {
      consecutiveErrors++;
      console.error(`[script-review] review poll error (attempt ${consecutiveErrors}):`, err);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/scriptProposals/reviewQueue.test.ts`
Expected: PASS. The circuit-breaker case must finish well inside its own 600 s nominal timeout — that is the assertion proving the breaker fires.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/scriptProposals/reviewQueue.ts apps/api/src/services/scriptProposals/reviewQueue.test.ts
git commit -m "feat(ai): define the script-review queue contract and the inline review wait"
```

---

### Task 16: `GuardrailContext` — the input-aware `run_script` branch

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts:553` (`TIER3_INPUT_AWARE_TOOLS`), `:555-601` (`resolveApprovalScope`), `:1384-1476` (`checkGuardrails`), `:1739-1744` (`checkAgentGuardrails`)
- Test: `apps/api/src/services/aiGuardrails.proposalContext.test.ts` (new)
- Guarded by: `apps/api/src/services/aiGuardrails.imports.contract.test.ts`, `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts` (enumerators at `:77`, `:89`, `:107`)

**Interfaces:**
- Produces:
  ```ts
  export interface GuardrailContext { proposal?: { riskTier: RiskTier; strictHits: string[] } }
  export function checkGuardrails(toolName: string, input: Record<string, unknown>, context?: GuardrailContext): GuardrailCheck;
  export function resolveApprovalScope(toolName: string, action: string | undefined, input: Record<string, unknown>, context?: GuardrailContext): AiApprovalScope;
  export function checkAgentGuardrails(toolName, input, policy, context?: GuardrailContext): AgentGuardrailCheck;
  ```
- `RiskTier` is imported as a **type** from `@breeze/shared` — a type-only import adds no runtime edge and cannot trip the imports contract, which greps for `from './aiToolSchemas'` and `getToolDefinitions`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/aiGuardrails.proposalContext.test.ts
import { describe, expect, it } from 'vitest';
import { checkGuardrails, resolveApprovalScope } from './aiGuardrails';

const devices = ['11111111-1111-4111-8111-111111111111'];
const ctx = (riskTier: 'low' | 'medium' | 'high' | 'critical', strictHits: string[] = []) =>
  ({ proposal: { riskTier, strictHits } });

describe('run_script with a proposalId', () => {
  it('stays tier 3 and maps low/medium to supervised', () => {
    for (const tier of ['low', 'medium'] as const) {
      const check = checkGuardrails('run_script', { proposalId: 'p1', deviceIds: devices }, ctx(tier));
      expect(check.tier).toBe(3);
      expect(check.allowed).toBe(true);
      expect(check.approvalScope).toBe('supervised');
    }
  });

  it('maps high/critical to four_eyes', () => {
    for (const tier of ['high', 'critical'] as const) {
      expect(checkGuardrails('run_script', { proposalId: 'p1', deviceIds: devices }, ctx(tier)).approvalScope)
        .toBe('four_eyes');
    }
  });

  it('denies at tier 4 with proposal_context_missing when no context is supplied', () => {
    const check = checkGuardrails('run_script', { proposalId: 'p1', deviceIds: devices });
    expect(check.tier).toBe(4);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('proposal_context_missing');
  });

  it('denies when a context is supplied for a different shape (no proposal key)', () => {
    const check = checkGuardrails('run_script', { proposalId: 'p1', deviceIds: devices }, {});
    expect(check.tier).toBe(4);
    expect(check.allowed).toBe(false);
  });

  it('leaves an ordinary library run_script untouched — supervised, context ignored', () => {
    const check = checkGuardrails('run_script', { scriptId: 's1', deviceIds: devices });
    expect(check.tier).toBe(3);
    expect(check.approvalScope).toBe('supervised');
  });

  it('leaves every other tool untouched when a context is passed', () => {
    expect(checkGuardrails('query_devices', {}, ctx('critical')).tier).toBe(1);
  });

  it('resolveApprovalScope agrees with checkGuardrails for both directions', () => {
    expect(resolveApprovalScope('run_script', undefined, { proposalId: 'p1' }, ctx('low'))).toBe('supervised');
    expect(resolveApprovalScope('run_script', undefined, { proposalId: 'p1' }, ctx('high'))).toBe('four_eyes');
    // Fail-safe: no context on a proposal call resolves four_eyes, matching the
    // module's own "unclassified defaults to four_eyes" rule at :601.
    expect(resolveApprovalScope('run_script', undefined, { proposalId: 'p1' })).toBe('four_eyes');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiGuardrails.proposalContext.test.ts`
Expected: FAIL — `checkGuardrails` currently returns `approvalScope: 'supervised'` for the high/critical cases and does not deny without a context.

- [ ] **Step 3: Add the type and the scope branch**

In `apps/api/src/services/aiGuardrails.ts`, near the other tier-3 tables (`:466-553`):

```ts
import type { RiskTier } from '@breeze/shared';

/**
 * Optional, DB-FREE context a caller may hand to the guardrail so an
 * input-aware decision can read persisted state without this module importing
 * the schema (aiGuardrails.imports.contract.test.ts).
 *
 * Loaded by `loadProposalGuardrailContext`
 * (services/scriptProposals/guardrailContext.ts) — which is the only producer,
 * so the risk tier here is always the tier a completed review actually wrote.
 */
export interface GuardrailContext {
  proposal?: { riskTier: RiskTier; strictHits: string[] };
}

/** A `run_script` call that names a proposal instead of a library script. */
function isProposalRunScript(toolName: string, input: Record<string, unknown>): boolean {
  return toolName === 'run_script' && typeof input.proposalId === 'string' && input.proposalId.length > 0;
}
```

Add `'run_script'` to `TIER3_INPUT_AWARE_TOOLS` (`:553`):

```ts
const TIER3_INPUT_AWARE_TOOLS = new Set(['s1_isolate_device', 'run_script']);
```

and give `resolveApprovalScope` the parameter plus the branch, placed **before** the generic `TIER3_SUPERVISED_TOOLS` hit at `:594` (otherwise `run_script` would resolve `supervised` for every tier):

```ts
export function resolveApprovalScope(
  toolName: string,
  action: string | undefined,
  input: Record<string, unknown>,
  context?: GuardrailContext,
): AiApprovalScope {
  // …existing per-action tables…
  if (isProposalRunScript(toolName, input)) {
    // Spec §4.5. No context ⇒ four_eyes, the module's own fail-safe default —
    // checkGuardrails refuses the call outright a moment later, so this value
    // is only ever read by a caller that skipped the tier check.
    const tier = context?.proposal?.riskTier;
    return tier === 'low' || tier === 'medium' ? 'supervised' : 'four_eyes';
  }
  if (TIER3_FOUR_EYES_TOOLS.has(toolName)) return 'four_eyes';
  // …unchanged…
}
```

- [ ] **Step 4: Add the context parameter and the deny to `checkGuardrails`**

```ts
export function checkGuardrails(
  toolName: string,
  input: Record<string, unknown>,
  context?: GuardrailContext,
): GuardrailCheck {
  // …BLOCKED_TOOLS and unknown-tool denies unchanged (:1389-1406)…

  // Fail CLOSED on a proposal-backed run with no loaded context. The scope this
  // call needs is derived from a persisted review, and a missing context means
  // the proposal is absent, cross-org, or unreviewed — none of which may run.
  // Placed after the blocked/unknown denies so those keep their own reasons.
  if (isProposalRunScript(toolName, input) && !context?.proposal) {
    return {
      tier: 4,
      allowed: false,
      requiresApproval: false,
      reason: 'proposal_context_missing: run_script with a proposalId requires a reviewed proposal in the caller\'s organization',
    };
  }

  // …unchanged through to the three tier-3 returns; each one already calls
  // resolveApprovalScope(toolName, action, input) at :1431, :1441 and :1464 —
  // add the context argument to all three:
  //   approvalScope: resolveApprovalScope(toolName, action, input, context),
}
```

- [ ] **Step 5: Forward the context through `checkAgentGuardrails`**

```ts
export function checkAgentGuardrails(
  toolName: string,
  input: Record<string, unknown>,
  policy: AgentGuardrailPolicy | null | undefined,
  context?: GuardrailContext,
): AgentGuardrailCheck {
  const base = checkGuardrails(toolName, input, context);
  // …unchanged. The tier-4 base deny at :1767 already turns a missing proposal
  // context into an agent deny with the same reason.
}
```

- [ ] **Step 6: Run the new test and every guardrail contract**

Run: `cd apps/api && npx vitest run src/services/aiGuardrails.proposalContext.test.ts src/services/aiGuardrails.approvalScope.contract.test.ts src/services/aiGuardrails.imports.contract.test.ts src/services/aiGuardrails.readonly.contract.test.ts src/services/actionIntents/policyDecidable.test.ts`
Expected: PASS. If `aiGuardrails.approvalScope.contract.test.ts:107` ("every scope-table entry actually resolves to that scope at tier 3") fails on `run_script`, the branch was placed **after** the `TIER3_SUPERVISED_TOOLS` check — move it above, and keep `run_script` in `TIER3_SUPERVISED_TOOLS` so the library path still resolves `supervised`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiGuardrails.proposalContext.test.ts
git commit -m "feat(ai): input-aware run_script guardrail that reads a proposal's reviewed risk tier"
```

---

### Task 17: Every `checkGuardrails` caller loads the proposal context

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts:1042` — **the load-bearing one**
- Modify: `apps/api/src/services/aiAgentSdk.ts:719-724` and the second call site at `:1943`
- Modify: `apps/api/src/services/aiAgents/runLoop.ts:767`
- Test: `apps/api/src/services/actionIntents/intentService.proposalContext.test.ts` (new)

**Interfaces:**
- Consumes: `loadProposalGuardrailContext` (Task 14), `GuardrailContext` (Task 16).

**Contradiction found and resolved (state it in the PR):** roadmap §3.3 names only `aiAgentSdk.ts` and `runLoop.ts` as the callers that pass the context. `createActionIntent` calls `checkGuardrails(input.toolName, input.input)` **itself** at `intentService.ts:1042`, and throws `ActionIntentTierError('tool_blocked')` when the result is tier ≥ 4 (`:1043-1049`). Without the context there, every proposal-backed intent would be refused at creation, and the approval scope written to the row (`:1094`) would be the fail-safe `four_eyes` rather than the reviewed tier. It is a third required caller.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/actionIntents/intentService.proposalContext.test.ts
import { describe, expect, it, vi } from 'vitest';

const checkGuardrailsMock = vi.fn(() => ({ tier: 3, allowed: true, requiresApproval: true, approvalScope: 'supervised' }));
const loadContextMock = vi.fn(async () => ({ proposal: { riskTier: 'medium', strictHits: [] } }));

vi.mock('../aiGuardrails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiGuardrails')>()),
  checkGuardrails: checkGuardrailsMock,
}));
vi.mock('../scriptProposals', () => ({ loadProposalGuardrailContext: loadContextMock }));

import { resolveGuardrailForIntent } from './intentService';

describe('createActionIntent guardrail resolution', () => {
  it('loads the proposal context before checking guardrails for a proposal-backed run_script', async () => {
    await resolveGuardrailForIntent('run_script', { proposalId: 'p1' }, 'org-1');
    expect(loadContextMock).toHaveBeenCalledWith({ proposalId: 'p1' }, 'org-1');
    expect(checkGuardrailsMock).toHaveBeenCalledWith(
      'run_script', { proposalId: 'p1' }, { proposal: { riskTier: 'medium', strictHits: [] } });
  });

  it('does not touch the DB for any other tool', async () => {
    loadContextMock.mockClear();
    await resolveGuardrailForIntent('manage_alerts', { action: 'list' }, 'org-1');
    expect(loadContextMock).not.toHaveBeenCalled();
    expect(checkGuardrailsMock).toHaveBeenLastCalledWith('manage_alerts', { action: 'list' }, undefined);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService.proposalContext.test.ts`
Expected: FAIL — `resolveGuardrailForIntent` is not exported.

- [ ] **Step 3: Extract and use the helper in `intentService.ts`**

Add above `createActionIntent`, and replace the bare call at `:1042`:

```ts
/**
 * The guardrail check `createActionIntent` runs, with the proposal context
 * loaded first when the tool call names one.
 *
 * Exported so the seam is directly testable: without the context, a
 * proposal-backed run_script would be refused here as tier 4 `tool_blocked`,
 * and every proposal intent would die at creation.
 *
 * The load is a plain read outside any transaction — this runs BEFORE the
 * creation transaction opens (`:1520`), so it cannot double-hold a pooled
 * connection.
 */
export async function resolveGuardrailForIntent(
  toolName: string,
  input: Record<string, unknown>,
  orgId: string | null,
): Promise<GuardrailCheck> {
  const context = toolName === 'run_script' && typeof input.proposalId === 'string' && orgId
    ? await loadProposalGuardrailContext(input, orgId)
    : undefined;
  return checkGuardrails(toolName, input, context);
}
```

```ts
// at :1042, replacing `const guardrail = checkGuardrails(input.toolName, input.input);`
  const guardrail = await resolveGuardrailForIntent(
    input.toolName,
    input.input,
    // `input.orgId` is the caller-supplied address; the authoritative
    // `resolvedOrg` is computed a few lines below, and the guardrail only needs
    // the org to scope a READ that is re-validated by assertProposalRunnable
    // and by consumeProposalForIntent inside the transaction.
    input.orgId ?? auth.orgId ?? null,
  );
```

Import `loadProposalGuardrailContext` from `'../scriptProposals'` and the `GuardrailCheck` type from `'../aiGuardrails'`.

- [ ] **Step 4: Pass the context at the chat and agent call sites**

`apps/api/src/services/aiAgentSdk.ts`, replacing the bare call at `:720`:

```ts
    // Guardrails (tier check + action-based escalation). A proposal-backed
    // run_script needs the proposal's reviewed risk tier to pick supervised vs
    // four_eyes; every other tool call passes `undefined` and is unchanged.
    const guardrailContext = await loadProposalGuardrailContext(input, session.orgId);
    const guardrailCheck = checkGuardrails(toolName, input, guardrailContext);
```

Apply the same two-line change at the second call site (`:1943`). Import `loadProposalGuardrailContext` from `'./scriptProposals'`.

`apps/api/src/services/aiAgents/runLoop.ts`, replacing `:767`:

```ts
    const guardrailContext = await loadProposalGuardrailContext(input, run.orgId);
    const check = checkAgentGuardrails(toolName, input, guardrailPolicy, guardrailContext);
```

Import `loadProposalGuardrailContext` from `'../scriptProposals'`.

- [ ] **Step 5: Run the affected suites**

Run: `cd apps/api && npx vitest run src/services/actionIntents/intentService.proposalContext.test.ts src/services/actionIntents/intentService src/services/aiAgentSdk src/services/aiAgents/runLoop`
Expected: PASS. `loadProposalGuardrailContext` returns `undefined` for every input without a `proposalId`, so no existing test's guardrail verdict changes; any failure here means a suite asserts on `checkGuardrails` being called with exactly two arguments — update that assertion to `expect.anything()` for the third, do not revert the call site.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/aiAgentSdk.ts \
  apps/api/src/services/aiAgents/runLoop.ts \
  apps/api/src/services/actionIntents/intentService.proposalContext.test.ts
git commit -m "feat(ai): load the proposal guardrail context at every checkGuardrails caller"
```

---

### Task 18: `scriptDispatch.ts` — the `proposal` source kind

**Files:**
- Modify: `apps/api/src/services/scriptDispatch.ts:63-65` (`ScriptDispatchSource`), `:67-89` (`DispatchScriptInput`), `:485-518` (the execution insert)
- Test: `apps/api/src/services/scriptDispatch.proposalSource.test.ts` (new)

**Interfaces:**
- Consumes: `ProposalDispatchSnapshot` (Task 14), `headScriptVersion` + `sha256Content` (W01a `scriptVersions.ts`).
- Produces:
  ```ts
  export type ScriptDispatchSource =
    | { kind: 'saved'; script: typeof scripts.$inferSelect; automationRunId?: string | null }
    | { kind: 'raw'; content: string; language: string; provenance: string }
    | { kind: 'proposal'; proposal: ScriptProposalRow; snapshot: ProposalDispatchSnapshot };
  export interface ScriptDispatchProvenance { scriptVersionId?: string | null; reviewId?: string | null; approvedBy?: string | null; approvalMethod?: ScriptApprovalMethod | null; reviewRiskTier?: string | null; reviewSummary?: string | null }
  ```
  `provenance?: ScriptDispatchProvenance` joins `DispatchScriptInput`.

Note the pre-existing `raw` variant (`:65`) stays and still writes **no** execution row; only `saved` and `proposal` do.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/scriptDispatch.proposalSource.test.ts
import { describe, expect, it, vi } from 'vitest';

const inserted: Record<string, unknown>[] = [];
vi.mock('../db', () => ({
  db: {
    insert: () => ({ values: (v: Record<string, unknown>) => { inserted.push(v); return { returning: async () => [{ id: 'e1' }] }; } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: async () => ({ rowCount: 1 }) }) }),
  },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));

import { __testOnly } from './scriptDispatch';

const device = { id: 'd1', orgId: 'org-1' } as never;

describe('script_executions insert', () => {
  it('writes source_kind=proposal with the snapshot and the provenance, and no script_id', () => {
    const values = __testOnly.buildExecutionValues({
      device,
      source: {
        kind: 'proposal',
        proposal: { id: 'p1', language: 'powershell', timeoutSeconds: 300, runAs: 'system', contentDigest: 'a'.repeat(64) },
        snapshot: { proposalId: 'p1', contentDigest: 'a'.repeat(64), language: 'powershell', runAs: 'system', timeoutSeconds: 300, deviceIds: ['d1'], scannerVersion: '2026-09-11.1' },
      },
      runAs: 'system',
      provenance: { reviewId: 'r1', approvedBy: 'u1', approvalMethod: 'supervised_self', reviewRiskTier: 'medium', reviewSummary: 'restarts the spooler' },
    } as never);

    expect(values.sourceKind).toBe('proposal');
    expect(values.scriptId).toBeNull();
    expect(values.proposalId).toBe('p1');
    expect(values.language).toBe('powershell');
    expect(values.timeoutSeconds).toBe(300);
    expect(values.contentDigest).toBe('a'.repeat(64));
    expect(values.reviewId).toBe('r1');
    expect(values.approvalMethod).toBe('supervised_self');
    expect(values.reviewSummary).toBe('restarts the spooler');
  });

  it('writes the SAME snapshot columns for a library run so readers never need the join', () => {
    const values = __testOnly.buildExecutionValues({
      device,
      source: { kind: 'saved', script: { id: 's1', language: 'bash', timeoutSeconds: 120, content: 'echo hi' } },
      runAs: 'system',
      headVersionId: 'v9',
    } as never);

    expect(values.sourceKind).toBe('library');
    expect(values.scriptId).toBe('s1');
    expect(values.proposalId).toBeNull();
    expect(values.language).toBe('bash');
    expect(values.timeoutSeconds).toBe(120);
    expect(values.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(values.scriptVersionId).toBe('v9');
  });

  it('always takes the DEVICE org, never the proposal org', () => {
    const values = __testOnly.buildExecutionValues({
      device: { id: 'd1', orgId: 'device-org' },
      source: { kind: 'proposal', proposal: { id: 'p1', orgId: 'other-org', language: 'bash', timeoutSeconds: 60, runAs: 'system', contentDigest: 'b'.repeat(64) }, snapshot: { deviceIds: ['d1'] } },
      runAs: 'system',
    } as never);
    expect(values.orgId).toBe('device-org');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/scriptDispatch.proposalSource.test.ts`
Expected: FAIL — `__testOnly.buildExecutionValues` does not exist.

- [ ] **Step 3: Widen the source union and the input**

In `apps/api/src/services/scriptDispatch.ts`, at `:63`:

```ts
export type ScriptDispatchSource =
  | { kind: 'saved'; script: typeof scripts.$inferSelect; automationRunId?: string | null }
  | { kind: 'raw'; content: string; language: string; provenance: string }
  // AI-authored, reviewed, immutable content. NOT a hidden library script
  // (spec D11): a phantom `scripts` row created only to satisfy the FK would
  // contradict D5's "promotion is an explicit human action after a verified
  // run" and would pollute the library with one-offs.
  | { kind: 'proposal'; proposal: ScriptProposalRow; snapshot: ProposalDispatchSnapshot };

/** Written onto the execution row so "who authorised this, and on what evidence" survives erasure. */
export interface ScriptDispatchProvenance {
  scriptVersionId?: string | null;
  reviewId?: string | null;
  approvedBy?: string | null;
  approvalMethod?: ScriptApprovalMethod | null;
  reviewRiskTier?: string | null;
  reviewSummary?: string | null;
}
```

and add to `DispatchScriptInput` (`:67-89`):

```ts
  provenance?: ScriptDispatchProvenance;
```

- [ ] **Step 4: Extract and extend the execution insert**

Replace the `source.kind === 'saved'` block at `:485-518` with a call to an extracted, testable builder that serves both writing kinds:

```ts
/**
 * The `script_executions` values for one dispatch.
 *
 * Snapshot columns (`language`, `timeout_seconds`, `content_digest`) are
 * written for BOTH kinds, not just proposals. That is the whole point of the
 * change: the stale reaper INNER JOINed `scripts` for `timeout_seconds`
 * (staleCommandReaper.ts:584), so a parentless row was previously impossible.
 * Filling the snapshot for library runs too means the readers can stop joining
 * altogether instead of carrying two code paths forever.
 */
function buildExecutionValues(input: {
  device: { id: string; orgId: string };
  source: ScriptDispatchSource;
  runAs: 'system' | 'user' | 'elevated';
  parameters?: Record<string, unknown>;
  triggerType?: DispatchScriptInput['triggerType'];
  safeTriggeredBy?: string | null;
  targetSessionId?: number | null;
  headVersionId?: string | null;
  provenance?: ScriptDispatchProvenance;
}): Record<string, unknown> {
  const { device, source, provenance } = input;
  const isProposal = source.kind === 'proposal';
  const script = source.kind === 'saved' ? source.script : null;

  return {
    sourceKind: isProposal ? 'proposal' : 'library',
    scriptId: script?.id ?? null,
    proposalId: isProposal ? source.proposal.id : null,
    // Child rows always take the DEVICE's org (partner-wide fan-out rule).
    deviceId: device.id,
    orgId: device.orgId,
    triggeredBy: input.safeTriggeredBy ?? null,
    triggerType: input.triggerType ?? 'manual',
    ...(source.kind === 'saved' && source.automationRunId
      ? { automationRunId: source.automationRunId }
      : {}),
    parameters: isProposal ? null : (input.parameters ?? null),
    runAs: input.runAs,
    targetSessionId: input.targetSessionId ?? null,
    status: 'pending',
    // --- snapshot ---
    language: isProposal ? source.proposal.language : script!.language,
    timeoutSeconds: isProposal ? source.proposal.timeoutSeconds : script!.timeoutSeconds,
    contentDigest: isProposal ? source.proposal.contentDigest : sha256Content(script!.content),
    // --- provenance ---
    scriptVersionId: provenance?.scriptVersionId ?? input.headVersionId ?? null,
    reviewId: provenance?.reviewId ?? null,
    approvedBy: provenance?.approvedBy ?? null,
    approvalMethod: provenance?.approvalMethod ?? null,
    reviewRiskTier: provenance?.reviewRiskTier ?? null,
    reviewSummary: provenance?.reviewSummary?.slice(0, 600) ?? null,
  };
}

export const __testOnly = { buildExecutionValues };
```

and the insert itself:

```ts
  let executionId: string | null = null;
  if (source.kind === 'saved' || source.kind === 'proposal') {
    // The head version id for a library run, so the execution says exactly
    // which immutable definition ran (W01a cut it).
    const headVersionId = source.kind === 'saved'
      ? (await headScriptVersion(db, source.script.id))?.id ?? null
      : null;
    const [execution] = await db
      .insert(scriptExecutions)
      .values(buildExecutionValues({
        device, source, runAs, parameters, triggerType: input.triggerType,
        safeTriggeredBy, targetSessionId: input.targetSessionId ?? null,
        headVersionId, provenance: input.provenance,
      }) as typeof scriptExecutions.$inferInsert)
      .returning({ id: scriptExecutions.id });
    if (!execution) {
      return { ok: false, code: 'insert_failed', error: 'Failed to create execution' };
    }
    executionId = execution.id;
  }
```

- [ ] **Step 5: Build the agent payload from the proposal's content**

Where the payload is assembled today from `source.script`, add the proposal branch. The payload SHAPE is unchanged — `handlers_script.go` gets the same fields, so the Go agent is untouched:

```ts
  const payloadContent = source.kind === 'proposal' ? source.proposal.content
    : source.kind === 'raw' ? source.content
      : source.script.content;
  const payloadLanguage = source.kind === 'proposal' ? source.proposal.language
    : source.kind === 'raw' ? source.language
      : source.script.language;
  // A proposal's acknowledged STRICT patterns ride the same field a library
  // script's do; W01b always sends an empty array because the acknowledgement
  // ceremony lands on the decide endpoint in W03.
  const acknowledgedSecurityPatterns = source.kind === 'saved'
    ? source.script.acknowledgedSecurityPatterns
    : [];
```

- [ ] **Step 6: Run the dispatch suites**

Run: `cd apps/api && npx vitest run src/services/scriptDispatch`
Expected: PASS, including the pre-existing dispatch tests — the library path's written columns are a superset of what it wrote before, and nothing that existed changed value.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/scriptDispatch.ts apps/api/src/services/scriptDispatch.proposalSource.test.ts
git commit -m "feat(ai): dispatch proposal-backed script executions with snapshot and provenance columns"
```

---

### Task 19: Readers use the snapshot, with a fallback to the join for old rows

**Files:**
- Modify: `apps/api/src/jobs/staleCommandReaper.ts:574-592` (innerJoin for `timeoutSeconds`)
- Modify: `apps/api/src/routes/scripts.ts:1290-1323` (single-execution GET, `scripts.language`)
- Modify: `apps/api/src/services/aiToolsScripts.ts:1085-1110` (`get_script_execution`, innerJoin + the org predicate carried on `scripts.orgId`)
- Test: `apps/api/src/jobs/staleCommandReaper.proposalRows.test.ts`, `apps/api/src/services/aiToolsScripts.getExecution.proposalRows.test.ts`

**Interfaces:** no new exports. The contract is behavioural: **a proposal-backed execution must be visible to every reader, and must be reaped on its own timeout.**

Two of the three readers use an `innerJoin`, so today they would silently drop every proposal-backed row — the reaper would never time one out, and `get_script_execution` would answer "Execution not found" for a run that is on a real device. `get_script_execution_history` (`aiToolsScripts.ts:1030-1044`) joins `devices`, not `scripts`, and scopes on `scriptExecutions.orgId` — verified, **no change needed**. `routes/devices/scripts.ts:30-64` already uses a `leftJoin` and selects only `scriptName` — no change.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/jobs/staleCommandReaper.proposalRows.test.ts
import { describe, expect, it } from 'vitest';
import { __testOnly } from './staleCommandReaper';

describe('stale execution deadline resolution', () => {
  it('uses the execution snapshot when it is present', () => {
    expect(__testOnly.resolveExecutionTimeoutSeconds({ timeoutSeconds: 900, scriptTimeoutSeconds: 300 })).toBe(900);
  });

  it('falls back to the joined script for rows written before the snapshot column', () => {
    expect(__testOnly.resolveExecutionTimeoutSeconds({ timeoutSeconds: null, scriptTimeoutSeconds: 300 })).toBe(300);
  });

  it('falls back to the platform default when neither is available (a proposal row, no script)', () => {
    expect(__testOnly.resolveExecutionTimeoutSeconds({ timeoutSeconds: null, scriptTimeoutSeconds: null }))
      .toBe(__testOnly.DEFAULT_EXECUTION_TIMEOUT_SECONDS);
  });
});
```

```ts
// apps/api/src/services/aiToolsScripts.getExecution.proposalRows.test.ts
import { describe, expect, it } from 'vitest';
import { __testOnly } from './aiToolsScripts';

describe('get_script_execution row shaping', () => {
  it('reports a proposal-backed row with its own source and provenance', () => {
    const shaped = __testOnly.shapeExecutionRow({
      id: 'e1', sourceKind: 'proposal', proposalId: 'p1', scriptId: null, scriptName: null,
      language: 'powershell', timeoutSeconds: 300, reviewRiskTier: 'medium',
      reviewSummary: 'restarts the spooler', approvalMethod: 'supervised_self',
    } as never);
    expect(shaped.sourceKind).toBe('proposal');
    expect(shaped.proposalId).toBe('p1');
    expect(shaped.scriptName).toBe('AI-authored proposal');
    expect(shaped.language).toBe('powershell');
  });

  it('keeps a library row rendering exactly as before', () => {
    const shaped = __testOnly.shapeExecutionRow({
      id: 'e1', sourceKind: 'library', proposalId: null, scriptId: 's1', scriptName: 'Clear print queue',
      language: null, timeoutSeconds: null, scriptLanguage: 'powershell',
    } as never);
    expect(shaped.scriptName).toBe('Clear print queue');
    expect(shaped.language).toBe('powershell');
  });
});
```

- [ ] **Step 2: Run both and watch them fail**

Run: `cd apps/api && npx vitest run src/jobs/staleCommandReaper.proposalRows.test.ts src/services/aiToolsScripts.getExecution.proposalRows.test.ts`
Expected: FAIL — neither `__testOnly` export exists.

- [ ] **Step 3: Fix the reaper**

`apps/api/src/jobs/staleCommandReaper.ts`, replacing the query at `:574-592`:

```ts
  const staleExecs = await db
    .select({
      id: scriptExecutions.id,
      status: scriptExecutions.status,
      scriptId: scriptExecutions.scriptId,
      createdAt: scriptExecutions.createdAt,
      startedAt: scriptExecutions.startedAt,
      // Snapshot first. The join stays only to serve rows written before
      // 2026-10-16-100200 — and it is a LEFT join now, because a
      // proposal-backed execution has no scripts parent and an inner join
      // would drop it from the reaper entirely (it would then run forever).
      timeoutSeconds: scriptExecutions.timeoutSeconds,
      scriptTimeoutSeconds: scripts.timeoutSeconds,
    })
    .from(scriptExecutions)
    .leftJoin(scripts, eq(scripts.id, scriptExecutions.scriptId))
    .where(and(
      inArray(scriptExecutions.status, ['pending', 'queued', 'running']),
      lt(scriptExecutions.createdAt, conservativeCutoff),
    ))
    .orderBy(scriptExecutions.createdAt)
    .limit(MAX_REAP_PER_RUN);
```

and add the resolver plus its export:

```ts
/** Mirrors scripts.timeout_seconds' own DEFAULT 300 (schema/scripts.ts:42). */
const DEFAULT_EXECUTION_TIMEOUT_SECONDS = 300;

function resolveExecutionTimeoutSeconds(
  row: { timeoutSeconds: number | null; scriptTimeoutSeconds: number | null },
): number {
  return row.timeoutSeconds ?? row.scriptTimeoutSeconds ?? DEFAULT_EXECUTION_TIMEOUT_SECONDS;
}

export const __testOnly = { resolveExecutionTimeoutSeconds, DEFAULT_EXECUTION_TIMEOUT_SECONDS };
```

Use `resolveExecutionTimeoutSeconds(row)` where the per-row deadline is computed (`:597-600`).

- [ ] **Step 4: Fix `get_script_execution`**

`apps/api/src/services/aiToolsScripts.ts`, at `:1085-1110`:

```ts
        .select({
          id: scriptExecutions.id,
          sourceKind: scriptExecutions.sourceKind,
          scriptId: scriptExecutions.scriptId,
          proposalId: scriptExecutions.proposalId,
          scriptName: scripts.name,
          scriptLanguage: scripts.language,
          language: scriptExecutions.language,
          timeoutSeconds: scriptExecutions.timeoutSeconds,
          reviewRiskTier: scriptExecutions.reviewRiskTier,
          reviewSummary: scriptExecutions.reviewSummary,
          approvalMethod: scriptExecutions.approvalMethod,
          // …existing status/exitCode/stdout/stderr/timing selections…
        })
        .from(scriptExecutions)
        // LEFT, not INNER: a proposal-backed row has no scripts parent.
        .leftJoin(scripts, eq(scriptExecutions.scriptId, scripts.id))
        .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
        .where(and(
          eq(scriptExecutions.id, input.executionId as string),
          // TENANCY MOVED: the org predicate used to ride `scripts.orgId`
          // through the inner join. With a left join that predicate would be
          // NULL — and therefore not true — for every proposal row, so it is
          // re-anchored on the execution's OWN denormalised org_id, which is
          // the column RLS and the device-move restamp already maintain.
          ...(auth.orgCondition(scriptExecutions.orgId) ? [auth.orgCondition(scriptExecutions.orgId)!] : []),
        ))
        .limit(1);
```

and the shaper:

```ts
function shapeExecutionRow(row: {
  sourceKind: 'library' | 'proposal'; proposalId: string | null;
  scriptName: string | null; language: string | null; scriptLanguage: string | null;
  timeoutSeconds: number | null; [key: string]: unknown;
}) {
  return {
    ...row,
    // A proposal has no library name. Say so plainly rather than rendering an
    // empty string the assistant might read as "the script was deleted".
    scriptName: row.scriptName ?? (row.sourceKind === 'proposal' ? 'AI-authored proposal' : null),
    language: row.language ?? row.scriptLanguage ?? null,
  };
}

export const __testOnly = { shapeExecutionRow };
```

- [ ] **Step 5: Fix the single-execution route**

`apps/api/src/routes/scripts.ts:1312-1313` — it is already a `leftJoin`, so only the selection changes:

```ts
        scriptName: scripts.name,
        scriptLanguage: sql<string | null>`coalesce(${scriptExecutions.language}::text, ${scripts.language}::text)`,
        sourceKind: scriptExecutions.sourceKind,
        proposalId: scriptExecutions.proposalId,
        reviewRiskTier: scriptExecutions.reviewRiskTier,
        reviewSummary: scriptExecutions.reviewSummary,
        approvalMethod: scriptExecutions.approvalMethod,
```

- [ ] **Step 6: Run the reader suites**

Run: `cd apps/api && npx vitest run src/jobs/staleCommandReaper src/services/aiToolsScripts src/routes/scripts`
Expected: PASS. A failure in `aiToolsScripts.getExecution.test.ts` on the org predicate means a mock still stubs `scripts.orgId` — repoint the mock at `scriptExecutions.orgId`; the predicate move is the fix, not a regression.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/staleCommandReaper.ts apps/api/src/services/aiToolsScripts.ts \
  apps/api/src/routes/scripts.ts apps/api/src/jobs/staleCommandReaper.proposalRows.test.ts \
  apps/api/src/services/aiToolsScripts.getExecution.proposalRows.test.ts
git commit -m "fix(scripts): read execution language and timeout from the snapshot so proposal runs are visible and reapable"
```

---

### Task 20: Effect digest — a proposal resolves or intent creation fails

**Files:**
- Modify: `apps/api/src/services/actionIntents/effectDigest.ts:164-179` (the `run_script` resolver), plus a new exported error class
- Modify: `apps/api/src/services/actionIntents/intentService.ts:1888-1908` (the creation catch)
- Test: `apps/api/src/services/actionIntents/effectDigest.proposal.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export class EffectDigestUnresolvableError extends Error { constructor(public readonly resolver: string, public readonly detail: string) }
  function runScriptProposalDigestMaterial(proposal: ScriptProposalRow, args: Record<string, unknown>): string;
  ```

**Why a throw, against this file's own convention (say it in the PR):** `effectDigest.ts` currently never throws — every unresolvable case returns a sentinel (`MISSING_ARG`, `TARGET_ABSENT`, `{kind:'unresolved'}`), verified across the whole module. `intentService.ts:1544` then stores `effect_digest = NULL`, and both release paths treat NULL as "nothing to check" (`:1537-1542`). That is **fail-open**, and spec §4.5 requires the opposite: intent creation must fail if a proposal cannot be pinned. A sentinel cannot express that here, so the proposal branch introduces the module's first throwing path, deliberately and narrowly — only for `run_script` with a `proposalId`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/actionIntents/effectDigest.proposal.test.ts
import { describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown> | null = null;
vi.mock('../../db/schema', async (importOriginal) => importOriginal());
const database = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }) }),
} as never;

import { EffectDigestUnresolvableError, computeEffectDigestOutcome } from './effectDigest';

const proposal = {
  id: 'p1', contentDigest: 'a'.repeat(64), language: 'powershell', runAs: 'system',
  timeoutSeconds: 300, scannerVersion: '2026-09-11.1', status: 'reviewed',
  targetDeviceIds: ['d1', 'd2'], expiresAt: new Date(Date.now() + 3600_000), intentId: null,
};

describe('run_script effect digest with a proposalId', () => {
  it('pins a digest that is independent of device argument order', async () => {
    stored = proposal;
    const a = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d2', 'd1'] }, database);
    const b = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1', 'd2'] }, database);
    expect(a.kind).toBe('pinned');
    expect(a).toEqual(b);
  });

  it('changes when the content digest changes', async () => {
    stored = proposal;
    const before = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database);
    stored = { ...proposal, contentDigest: 'b'.repeat(64) };
    const after = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database);
    expect(after).not.toEqual(before);
  });

  it('does NOT change when only lifecycle state changes — status is never digest material', async () => {
    stored = proposal;
    const before = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database);
    stored = { ...proposal, status: 'approved', intentId: 'i1' };
    const after = await computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database);
    expect(after).toEqual(before);
  });

  it('throws rather than returning an unpinnable outcome when the proposal is absent', async () => {
    stored = null;
    await expect(
      computeEffectDigestOutcome('run_script', { proposalId: 'p1', deviceIds: ['d1'] }, database),
    ).rejects.toBeInstanceOf(EffectDigestUnresolvableError);
  });

  it('leaves the library run_script resolver alone', async () => {
    stored = null;
    const outcome = await computeEffectDigestOutcome('run_script', { deviceIds: ['d1'] }, database);
    expect(outcome.kind).not.toBe('pinned');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/actionIntents/effectDigest.proposal.test.ts`
Expected: FAIL — `EffectDigestUnresolvableError` is not exported and the resolver ignores `proposalId`.

- [ ] **Step 3: Add the error and the proposal branch**

In `apps/api/src/services/actionIntents/effectDigest.ts`:

```ts
/**
 * Thrown ONLY by the proposal branch of the run_script resolver.
 *
 * The rest of this module is total by construction — every unresolvable case
 * returns a sentinel, and intentService stores a NULL digest that both release
 * paths treat as "nothing to check". For an AI-authored script that fail-open
 * is unacceptable (spec §4.5), so this is the one case that aborts intent
 * creation instead.
 */
export class EffectDigestUnresolvableError extends Error {
  constructor(public readonly resolver: string, public readonly detail: string) {
    super(`effect digest for ${resolver} could not be resolved: ${detail}`);
    this.name = 'EffectDigestUnresolvableError';
  }
}

/**
 * Pinned material for a proposal-backed run. Lifecycle state is deliberately
 * absent: release checks status/expiry/supersession/intent_id separately and
 * fails with `proposal_not_runnable`, so an ordinary state change must not
 * masquerade as `content_changed`.
 */
function runScriptProposalDigestMaterial(
  proposal: ScriptProposalRow,
  args: Record<string, unknown>,
): string {
  const deviceIds = Array.isArray(args.deviceIds) ? [...(args.deviceIds as string[])].sort() : [];
  return JSON.stringify({
    proposalId: proposal.id,
    contentDigest: proposal.contentDigest,
    language: proposal.language,
    runAs: proposal.runAs,
    timeoutSeconds: proposal.timeoutSeconds,
    deviceIds,
    scannerVersion: proposal.scannerVersion,
  });
}
```

and at the head of the `run_script` resolver (`:164`):

```ts
  run_script: async (args, database) => {
    if (typeof args.proposalId === 'string' && args.proposalId.length > 0) {
      const [proposal] = await database
        .select().from(scriptProposals).where(eq(scriptProposals.id, args.proposalId)).limit(1);
      if (!proposal) {
        throw new EffectDigestUnresolvableError('run_script.proposal', `proposal ${args.proposalId} not found`);
      }
      const deviceIds = Array.isArray(args.deviceIds) ? (args.deviceIds as string[]) : [];
      if (deviceIds.length === 0) {
        throw new EffectDigestUnresolvableError('run_script.proposal', 'deviceIds is required');
      }
      return { kind: 'material', material: runScriptProposalDigestMaterial(proposal, args) };
    }
    // …existing buildRunScriptSnapshot path, unchanged…
  },
```

- [ ] **Step 4: Give the throw a distinct intent error code**

In `apps/api/src/services/actionIntents/intentService.ts`, in the creation catch (`:1888-1908`), **before** the generic `fanout_failed` wrap:

```ts
    // An unpinnable proposal is a deliberate refusal, not a database fault.
    // Wrapping it as `fanout_failed` would tell the operator the outbox broke.
    if (err instanceof EffectDigestUnresolvableError) {
      throw new ActionIntentError(err.message, 'effect_digest_unresolvable');
    }
```

`ActionIntentError.code` is a plain `string` (`intentService.ts:107-112`), so no union needs widening.

- [ ] **Step 5: Run the digest and intent suites**

Run: `cd apps/api && npx vitest run src/services/actionIntents/effectDigest src/services/actionIntents/intentService`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/actionIntents/effectDigest.ts apps/api/src/services/actionIntents/intentService.ts \
  apps/api/src/services/actionIntents/effectDigest.proposal.test.ts
git commit -m "feat(ai): pin a non-null effect digest for proposal-backed run_script, failing intent creation otherwise"
```

---

### Task 21: `run_script` accepts `proposalId` (XOR `scriptId`) and dispatches it

**Files:**
- Modify: `apps/api/src/services/aiToolSchemas.ts:732-744` (`run_script` zod)
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:1421-1433` (the hand-written `tool()` shape)
- Modify: `apps/api/src/services/aiToolsScripts.ts:291-310` (JSON schema + `required`), `:311-571` (handler)
- Test: `apps/api/src/services/aiToolSchemas.runScriptProposal.test.ts`, `apps/api/src/services/aiToolsScripts.runScript.proposal.test.ts`

**Interfaces:**
- Consumes: `assertProposalRunnable` (Task 13), `proposalDispatchSnapshot` (Task 14), `aiScriptAuthoringEnabled` (Task 1), the `proposal` dispatch source (Task 18).
- Contract: the return shape is **unchanged** (`{ results }` keyed by device id) plus a top-level `proposalId`. The 10-device cap and the 60 s per-device wait are unchanged.

Both schema definitions must change — `aiToolSchemas.ts:732` is what `validateToolInput` enforces, and `aiAgentSdkTools.ts:1421` is what the model is shown. The `tool()` form takes a raw zod **shape** (an object of fields), not a schema, so the XOR refinement can only live in `aiToolSchemas.ts`; the SDK shape therefore relaxes `scriptId` to optional and relies on that refinement at dispatch. Say so in the PR — it is a deliberate asymmetry, not an oversight.

- [ ] **Step 1: Write the failing schema tests**

```ts
// apps/api/src/services/aiToolSchemas.runScriptProposal.test.ts
import { describe, expect, it } from 'vitest';
import { toolInputSchemas } from './aiToolSchemas';

const schema = toolInputSchemas.run_script;
const device = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';

describe('run_script scriptId XOR proposalId', () => {
  it('accepts a scriptId alone', () => {
    expect(schema.safeParse({ scriptId: id, deviceIds: [device] }).success).toBe(true);
  });
  it('accepts a proposalId alone', () => {
    expect(schema.safeParse({ proposalId: id, deviceIds: [device] }).success).toBe(true);
  });
  it('rejects both', () => {
    expect(schema.safeParse({ scriptId: id, proposalId: id, deviceIds: [device] }).success).toBe(false);
  });
  it('rejects neither', () => {
    expect(schema.safeParse({ deviceIds: [device] }).success).toBe(false);
  });
  it('rejects parameters alongside a proposalId — a proposal has no parameter contract', () => {
    expect(schema.safeParse({ proposalId: id, deviceIds: [device], parameters: { a: 1 } }).success).toBe(false);
  });
  it('keeps the 10-device cap for both forms', () => {
    const many = Array.from({ length: 11 }, (_, i) => `1111111${i % 10}-1111-4111-8111-11111111111${i % 10}`);
    expect(schema.safeParse({ proposalId: id, deviceIds: many }).success).toBe(false);
  });
});
```

```ts
// apps/api/src/services/aiToolsScripts.runScript.proposal.test.ts
import { describe, expect, it, vi } from 'vitest';

const flagMock = vi.fn(() => true);
const runnableMock = vi.fn(async () => ({ ok: false, reason: 'not_reviewed' as const }));
const dispatchMock = vi.fn(async () => ({ ok: true, commandId: 'c1', executionId: 'e1', runAs: 'system' }));

vi.mock('../config/env', () => ({ aiScriptAuthoringEnabled: flagMock }));
vi.mock('./scriptProposals', () => ({
  assertProposalRunnable: runnableMock,
  proposalDispatchSnapshot: () => ({ proposalId: 'p1', deviceIds: ['d1'] }),
}));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: dispatchMock }));

import { __testOnly } from './aiToolsScripts';

describe('run_script proposal branch', () => {
  it('returns feature_disabled without touching the database when the flag is off', async () => {
    flagMock.mockReturnValueOnce(false);
    const out = JSON.parse(await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1'] }, {} as never));
    expect(out.error).toContain('feature_disabled');
    expect(runnableMock).not.toHaveBeenCalled();
  });

  it('returns the typed refusal reason and never falls back to a library run', async () => {
    const out = JSON.parse(await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1'] }, {} as never));
    expect(out.error).toContain('not_reviewed');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('dispatches with the proposal source kind and echoes the proposalId', async () => {
    runnableMock.mockResolvedValueOnce({
      ok: true,
      proposal: { id: 'p1', language: 'powershell', runAs: 'system', timeoutSeconds: 300, contentDigest: 'a'.repeat(64) },
    } as never);
    const out = JSON.parse(await __testOnly.runScriptHandler({ proposalId: 'p1', deviceIds: ['d1'] }, {} as never));
    expect(dispatchMock.mock.calls[0]![0].source.kind).toBe('proposal');
    expect(out.proposalId).toBe('p1');
    expect(out.results).toBeDefined();
  });
});
```

- [ ] **Step 2: Run both and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiToolSchemas.runScriptProposal.test.ts src/services/aiToolsScripts.runScript.proposal.test.ts`
Expected: FAIL — the schema has no `proposalId` and `__testOnly.runScriptHandler` is not exported.

- [ ] **Step 3: Widen the zod schema**

`apps/api/src/services/aiToolSchemas.ts`, replacing `:732-744`:

```ts
  run_script: z.object({
    // EXACTLY ONE of these. Both optional at the field level so the refinement
    // below owns the message; `required: ['deviceIds']` in the JSON schema says
    // the same thing to the model.
    scriptId: uuid.optional(),
    proposalId: uuid.optional(),
    deviceIds: z.array(uuid).min(1).max(10),
    parameters: z.record(z.string(), z.unknown()).optional(),
    // #4888 — see the original comment; unchanged.
    ...aiRunContextInputShape,
  }).superRefine((data, ctx) => {
    const named = [data.scriptId, data.proposalId].filter((v) => typeof v === 'string').length;
    if (named !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scriptId'],
        message: 'run_script takes exactly one of scriptId or proposalId',
      });
    }
    // A proposal's content is literal and its digest pins that literal content;
    // there are no parameter definitions to bind, so accepting parameters would
    // mean running something the reviewer never saw.
    if (data.proposalId && data.parameters && Object.keys(data.parameters).length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameters'],
        message: 'a proposal-backed run does not take parameters',
      });
    }
  }),
```

- [ ] **Step 4: Widen the SDK tool shape and the JSON schema**

`apps/api/src/services/aiAgentSdkTools.ts:1421-1433`:

```ts
    tool(
      'run_script',
      'Execute a script on one or more devices. Give EITHER scriptId (a saved library script) OR proposalId (a reviewed, AI-authored proposal from propose_script) — never both.',
      {
        scriptId: uuid.optional(),
        proposalId: uuid.optional(),
        deviceIds: z.array(uuid).min(1).max(10),
        parameters: z.record(z.string(), z.unknown()).optional(),
        ...aiRunContextInputShape,
      },
      makeHandler('run_script', getAuth, onPreToolUse, onPostToolUse)
    ),
```

`apps/api/src/services/aiToolsScripts.ts:299-309`:

```ts
        properties: {
          scriptId: { type: 'string', description: 'UUID of an existing library script to run' },
          proposalId: { type: 'string', description: 'UUID of a reviewed AI-authored proposal to run. Mutually exclusive with scriptId; takes no parameters.' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Device UUIDs to run on' },
          parameters: { type: 'object', description: 'Script parameters (library scripts only)' },
          ...AI_RUN_CONTEXT_JSON_SCHEMA_PROPERTIES
        },
        required: ['deviceIds']
```

- [ ] **Step 5: Add the proposal branch to the handler**

At the top of the handler (`:311`), before the existing `scriptId` lookup:

```ts
    handler: async (input, auth, context) => {
      if (typeof input.proposalId === 'string') {
        if (!aiScriptAuthoringEnabled()) {
          return JSON.stringify({ error: 'feature_disabled: AI script authoring is not enabled on this deployment' });
        }
        const deviceIds = input.deviceIds as string[];
        const runnable = await assertProposalRunnable(auth, {
          proposalId: input.proposalId,
          deviceIds,
          runAs: input.runAs as string | undefined,
          timeoutSeconds: input.timeoutSeconds as number | undefined,
          parameters: input.parameters,
        });
        // Never a silent fallback to scriptId (spec §4.2): running something
        // other than the reviewed artifact is the failure this design exists to
        // prevent, so a refusal is always surfaced as a tool error.
        if (!runnable.ok) {
          return JSON.stringify({ error: `proposal_not_runnable: ${runnable.reason}`, proposalId: input.proposalId });
        }
        const snapshot = proposalDispatchSnapshot(runnable.proposal, deviceIds);
        const results: Record<string, unknown> = {};
        // Same cap and same wait as the library path (:376, :547) — a proposal
        // is not a reason to relax either.
        for (const deviceId of deviceIds.slice(0, 10)) {
          const access = await verifyDeviceAccess(deviceId, auth, true);
          if (!access.device) { results[deviceId] = { error: access.error }; continue; }
          const dispatch = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
            dispatchScriptToDevice({
              device: access.device!,
              source: { kind: 'proposal', proposal: runnable.proposal, snapshot },
              triggerType: 'manual',
              triggeredBy: auth.user.id,
              createdBy: auth.user.id,
              runAs: runnable.proposal.runAs,
              timeoutSeconds: runnable.proposal.timeoutSeconds,
              offlinePolicy: { kind: 'reject' },
              provenance: {
                approvedBy: auth.user.id,
                approvalMethod: 'supervised_self',
                reviewRiskTier: runnable.proposal.riskTier,
              },
            })));
          if (!dispatch.ok) { results[deviceId] = { error: dispatch.error }; continue; }
          const { waitForCommandResult } = await getCommandQueue();
          const cmd = await runOutsideDbContext(() => waitForCommandResult(dispatch.commandId, 60000));
          results[deviceId] = {
            ...((cmd.result as Record<string, unknown> | undefined)
              ?? { status: 'failed', error: 'Command did not complete' }),
            commandId: cmd.id,
            executionId: dispatch.executionId,
            runAs: dispatch.runAs,
          };
        }
        return JSON.stringify({ results, proposalId: input.proposalId });
      }

      // …existing library path, unchanged from :312…
    },
```

Export the handler for the test: `export const __testOnly = { runScriptHandler, shapeExecutionRow };` (merge with the `__testOnly` added in Task 19), extracting the handler body into a named `runScriptHandler` function that the `registerTool` call references.

- [ ] **Step 6: Run every run_script suite**

Run: `cd apps/api && npx vitest run src/services/aiToolSchemas.runScriptProposal.test.ts src/services/aiToolsScripts src/services/aiToolSchemas.validateToolInput.test.ts`
Expected: PASS, including the pre-existing `aiToolsScripts.runScript.orgEquality.test.ts` and `aiToolsScripts.runScript.runContext.test.ts` — the library branch is untouched.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiAgentSdkTools.ts \
  apps/api/src/services/aiToolsScripts.ts apps/api/src/services/aiToolSchemas.runScriptProposal.test.ts \
  apps/api/src/services/aiToolsScripts.runScript.proposal.test.ts
git commit -m "feat(ai): run_script accepts a reviewed proposalId as an XOR alternative to scriptId"
```

---

### Task 22: `propose_script` and `get_script_proposal`, registered everywhere

**Files:**
- Create: `apps/api/src/services/aiToolsScriptProposals.ts`
- Modify: `apps/api/src/services/aiTools.ts` (import block `:30-89`, registration block `:261-311`)
- Modify: `apps/api/src/services/aiToolSchemas.ts` (two new schemas)
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:159` (`TOOL_TIERS`) and the `tool()` array (`:1221-2829`)
- Modify: `apps/api/src/services/aiGuardrails.ts:~611` (`TOOL_PERMISSIONS`)
- Modify: `apps/api/src/services/aiAgents/agentToolCatalog.ts:28-31` (`AgentCapabilityId`), `:33-49` (`AGENT_CAPABILITIES`), `:62` (`TOOL_CAPABILITY`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` — `aiAgentsPage.catalog.capabilities.author_scripts.{label,description}`
- Test: `apps/api/src/services/aiToolsScriptProposals.test.ts`

**Interfaces:**
- Produces: `registerScriptProposalTools(aiTools: Map<string, AiTool>): void`; tools `propose_script` (tier 1) and `get_script_proposal` (tier 1).

**Flag-gating decision, and the contradiction it resolves (state it in the PR).** Roadmap §2 says "when off, the two new tools are not registered". Taken literally that reddens `aiAgentSdkTools.registryParity.contract.test.ts:179-194` ("every `TOOL_TIERS` key is a registered tool"), because `TOOL_TIERS` is a static object literal while the registry would be conditional. **Resolution:** registration and `TOOL_TIERS` are unconditional — that keeps the two maps in static agreement — and the flag gates *exposure*, which is where it actually matters:
1. the `tool()` entries in `createBreezeMcpServer` are behind the flag (a `TOOL_TIERS` entry alone only allowlists the `mcp__breeze__` name; without a `tool()` entry the model cannot call it — `aiGuardrails.readonly.contract.test.ts:129`), following the `m365ToolDefinitions` precedent (`aiAgentSdkTools.ts:815-819`, a spread of a factory that returns `[]` when the flag is off);
2. the agent capability group is filtered out when off;
3. both handlers return `feature_disabled` when off.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/aiToolsScriptProposals.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flagMock = vi.fn(() => true);
const createMock = vi.fn(async () => ({
  proposal: { id: 'p1', status: 'proposed' },
  scan: { scannerVersion: '2026-09-11.1', basicHits: [], strictHits: [], touchClasses: ['services'], touchedNames: { services: ['Spooler'], paths: [], registryKeys: [] } },
}));
const enqueueMock = vi.fn(async () => undefined);
const waitMock = vi.fn(async () => null);
const getMock = vi.fn(async () => null);

vi.mock('../config/env', () => ({ aiScriptAuthoringEnabled: flagMock }));
vi.mock('./scriptProposals', () => ({
  createScriptProposal: createMock, enqueueScriptReview: enqueueMock,
  waitForReviewCompletion: waitMock, getScriptProposalForPrincipal: getMock,
}));

import { registerScriptProposalTools } from './aiToolsScriptProposals';
import type { AiTool } from './aiTools';

const tools = new Map<string, AiTool>();
registerScriptProposalTools(tools);
const auth = { orgId: 'org-1', user: { id: 'u1' } } as never;
const input = {
  language: 'powershell', content: 'Restart-Service -Name Spooler', goal: 'g', expectedEffect: 'e',
  verification: { kind: 'service_running', name: 'Spooler' },
  deviceIds: ['11111111-1111-4111-8111-111111111111'],
};

beforeEach(() => { enqueueMock.mockClear(); waitMock.mockClear(); flagMock.mockReturnValue(true); });

describe('propose_script', () => {
  it('is registered at tier 1 alongside get_script_proposal', () => {
    expect(tools.get('propose_script')?.tier).toBe(1);
    expect(tools.get('get_script_proposal')?.tier).toBe(1);
  });

  it('returns feature_disabled and writes nothing when the flag is off', async () => {
    flagMock.mockReturnValue(false);
    const out = JSON.parse(await tools.get('propose_script')!.handler(input, auth));
    expect(out.error).toContain('feature_disabled');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns the static scan and does NOT enqueue a review on a BASIC hit', async () => {
    createMock.mockResolvedValueOnce({
      proposal: { id: 'p2', status: 'scan_rejected' },
      scan: { scannerVersion: '2026-09-11.1', basicHits: ['PowerShell volume format'], strictHits: [], touchClasses: ['disk'], touchedNames: { services: [], paths: [], registryKeys: [] } },
    } as never);
    const out = JSON.parse(await tools.get('propose_script')!.handler(
      { ...input, content: 'Format-Volume -DriveLetter D' }, auth));
    expect(out.status).toBe('scan_rejected');
    expect(out.staticScan.basicHits).toEqual(['PowerShell volume format']);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(waitMock).not.toHaveBeenCalled();
  });

  it('enqueues a review and waits at most 45 seconds on a clean scan', async () => {
    const out = JSON.parse(await tools.get('propose_script')!.handler(input, auth));
    expect(enqueueMock).toHaveBeenCalledWith({ proposalId: 'p1', orgId: 'org-1', attempt: 1 });
    expect(waitMock).toHaveBeenCalledWith('p1', 45_000);
    expect(out.review).toEqual({ status: 'pending' });
    expect(out.proposalId).toBe('p1');
  });

  it('rejects malformed input with a validation error rather than throwing', async () => {
    const out = JSON.parse(await tools.get('propose_script')!.handler({ language: 'klingon' }, auth));
    expect(out.error).toBeDefined();
  });
});

describe('get_script_proposal', () => {
  it('reports not found for a proposal outside the caller org', async () => {
    const out = JSON.parse(await tools.get('get_script_proposal')!.handler({ proposalId: 'p9' }, auth));
    expect(out.error).toContain('not_found');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiToolsScriptProposals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool module**

```ts
// apps/api/src/services/aiToolsScriptProposals.ts
/**
 * AI script authoring tools (spec §4.2).
 *
 * - propose_script (Tier 1): a proposal is INERT — nothing runs without an
 *   action intent — so authoring is auto-execute. The gate is run_script.
 * - get_script_proposal (Tier 1): org-scoped read.
 */
import { proposeScriptInputSchema } from '@breeze/shared';
import { aiScriptAuthoringEnabled } from '../config/env';
import type { AiTool } from './aiTools';
import {
  createScriptProposal, enqueueScriptReview, getScriptProposalForPrincipal, waitForReviewCompletion,
} from './scriptProposals';

/** Spec §4.2: the inline wait before propose_script returns `pending`. */
const INLINE_REVIEW_WAIT_MS = 45_000;

function disabled(): string {
  return JSON.stringify({ error: 'feature_disabled: AI script authoring is not enabled on this deployment' });
}

export function registerScriptProposalTools(aiTools: Map<string, AiTool>): void {
  const registerTool = (tool: AiTool): void => { aiTools.set(tool.definition.name, tool); };

  registerTool({
    tier: 1,
    // deviceArgs gates every supplied id through the org+site verifyDeviceAccess
    // before the handler runs, so an author cannot propose against a device
    // they cannot see.
    deviceArgs: ['deviceIds'],
    definition: {
      name: 'propose_script',
      description:
        'Author a script as an immutable proposal for independent review. The proposal is scanned and classified immediately; a model review follows. Nothing runs until a human approves it through run_script with the returned proposalId. Use this only when no library script fits.',
      input_schema: {
        type: 'object' as const,
        properties: {
          language: { type: 'string', enum: ['powershell', 'bash', 'python', 'cmd'], description: 'Script language' },
          content: { type: 'string', description: 'The complete script body, max 64 KiB' },
          goal: { type: 'string', description: 'What problem this is meant to solve, in the user\'s terms' },
          expectedEffect: { type: 'string', description: 'What will change on the device' },
          verification: { type: 'object', description: 'A checkable claim: {kind: exit_code|service_running|process_absent|file_exists|output_matches, ...}' },
          rollbackNote: { type: 'string', description: 'How to undo this, if it can be undone' },
          deviceIds: { type: 'array', items: { type: 'string' }, description: 'Target device UUIDs, 1 to 10' },
          runAs: { type: 'string', enum: ['system', 'user'], description: 'Run context, default system' },
          timeoutSeconds: { type: 'number', description: 'Execution timeout, default 300, max 3600' },
          supersedesProposalId: { type: 'string', description: 'The proposal this revision replaces, after a Request changes' },
        },
        required: ['language', 'content', 'goal', 'expectedEffect', 'verification', 'deviceIds'],
      },
    },
    handler: async (input, auth) => {
      if (!aiScriptAuthoringEnabled()) return disabled();
      const parsed = proposeScriptInputSchema.safeParse(input);
      if (!parsed.success) {
        return JSON.stringify({ error: `invalid_input: ${parsed.error.issues.map((i) => i.message).join('; ')}` });
      }
      // The principal IS the author record. An agent run carries its run id
      // (`AuthContext.principal` = `{ kind: 'ai_agent'; agentId; runId }`,
      // middleware/auth.ts:54); a chat caller does not hand this handler the
      // Breeze session id, so `session_id` stays NULL and `author_kind` carries
      // the truth. W03's proposal detail route resolves the author from the
      // intent, not from this column.
      const author = auth.principal.kind === 'ai_agent'
        ? { kind: 'agent_run' as const, agentRunId: auth.principal.runId }
        : { kind: 'chat_session' as const, sessionId: null };

      const { proposal, scan } = await createScriptProposal(auth, parsed.data, author);
      const staticScan = {
        basicHits: scan.basicHits, strictHits: scan.strictHits, touchClasses: scan.touchClasses,
      };

      // A BASIC hit STOPS here (spec §4.4): no model review, no budget
      // reservation, no approval card. The row stays as the audit trail.
      if (scan.basicHits.length > 0) {
        return JSON.stringify({
          proposalId: proposal.id, status: 'scan_rejected', staticScan,
          review: { status: 'not_requested' },
        });
      }

      await enqueueScriptReview({ proposalId: proposal.id, orgId: auth.orgId!, attempt: 1 });
      const review = await waitForReviewCompletion(proposal.id, INLINE_REVIEW_WAIT_MS);

      return JSON.stringify({
        proposalId: proposal.id,
        status: review?.status === 'completed' ? 'reviewed' : proposal.status,
        staticScan,
        review: review
          ? {
            status: review.status, riskTier: review.riskTier, summary: review.summary,
            goalMatch: review.goalMatch, reversible: review.reversible,
            verificationAdequate: review.verificationAdequate,
            recommendedAction: review.recommendedAction,
          }
          // The reviewer worker lands in W02, so this is the normal answer in
          // W01b. It means "not yet", never "failed".
          : { status: 'pending' },
      });
    },
  });

  registerTool({
    tier: 1,
    definition: {
      name: 'get_script_proposal',
      description:
        'Read a script proposal: its status, the static scan, the independent review verdict and findings, the human decision, any executions, and the verification result.',
      input_schema: {
        type: 'object' as const,
        properties: { proposalId: { type: 'string', description: 'Proposal UUID' } },
        required: ['proposalId'],
      },
    },
    handler: async (input, auth) => {
      if (!aiScriptAuthoringEnabled()) return disabled();
      const proposal = await getScriptProposalForPrincipal(auth, String(input.proposalId));
      if (!proposal) return JSON.stringify({ error: 'not_found: no such proposal in this organization' });
      return JSON.stringify({
        proposalId: proposal.id,
        status: proposal.status,
        riskTier: proposal.riskTier,
        goal: proposal.goal,
        expectedEffect: proposal.expectedEffect,
        language: proposal.language,
        runAs: proposal.runAs,
        timeoutSeconds: proposal.timeoutSeconds,
        targetDeviceIds: proposal.targetDeviceIds,
        staticScan: {
          basicHits: proposal.basicHits, strictHits: proposal.strictHits,
          touchClasses: proposal.touchClasses, scannerVersion: proposal.scannerVersion,
        },
        decision: {
          decidedBy: proposal.decidedBy, decidedAt: proposal.decidedAt, note: proposal.decisionNote,
        },
        intentId: proposal.intentId,
        verification: { verifiedAt: proposal.verifiedAt, result: proposal.verificationResult },
        expiresAt: proposal.expiresAt,
      });
    },
  });
}
```

- [ ] **Step 4: Register in the hub, the schemas, the tiers and the permissions**

`apps/api/src/services/aiTools.ts` — import beside `:58` and register beside `:286`:

```ts
import { registerScriptProposalTools } from './aiToolsScriptProposals';
// …
registerScriptProposalTools(aiTools);
```

`apps/api/src/services/aiToolSchemas.ts`, beside `run_script`:

```ts
  // The full input contract lives in @breeze/shared so the tool handler, a
  // future HTTP route and the web form cannot disagree about it.
  propose_script: proposeScriptInputSchema,
  get_script_proposal: z.object({ proposalId: uuid }),
```

`apps/api/src/services/aiAgentSdkTools.ts:159` (`TOOL_TIERS`), beside `run_script: 3`:

```ts
  propose_script: 1,
  get_script_proposal: 1,
```

`apps/api/src/services/aiGuardrails.ts` (`TOOL_PERMISSIONS`, beside `run_script` at `:614`):

```ts
  // Authoring is inert, but it is still script work: whoever may read the
  // library may read a proposal, and whoever may run a script may write one.
  propose_script: { resource: 'scripts', action: 'execute' },
  get_script_proposal: { resource: 'scripts', action: 'read' },
```

- [ ] **Step 5: Add the flag-gated `tool()` definitions**

`apps/api/src/services/aiAgentSdkTools.ts` — a factory beside `m365ToolDefinitions`, spread into the array beside `:2825`:

```ts
function scriptProposalToolDefinitions(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
): SdkTool[] {
  // Exposure gate. Registration and TOOL_TIERS stay unconditional so the
  // registry-parity contract holds statically; without a tool() entry the model
  // simply cannot call these.
  if (!aiScriptAuthoringEnabled()) return [];
  const uuid = z.string().guid();
  return [
    tool(
      'propose_script',
      'Author a script as an immutable proposal for independent review. Nothing runs until it is reviewed and approved through run_script with the returned proposalId.',
      {
        language: z.enum(['powershell', 'bash', 'python', 'cmd']),
        content: z.string().min(1).max(65536),
        goal: z.string().min(1).max(2000),
        expectedEffect: z.string().min(1).max(2000),
        verification: z.record(z.string(), z.unknown()),
        rollbackNote: z.string().max(2000).optional(),
        deviceIds: z.array(uuid).min(1).max(10),
        runAs: z.enum(['system', 'user']).optional(),
        timeoutSeconds: z.number().int().min(1).max(3600).optional(),
        supersedesProposalId: uuid.optional(),
      },
      makeHandler('propose_script', getAuth, onPreToolUse, onPostToolUse),
    ),
    tool(
      'get_script_proposal',
      'Read a script proposal: status, static scan, review verdict, decision, executions and verification.',
      { proposalId: uuid },
      makeHandler('get_script_proposal', getAuth, onPreToolUse, onPostToolUse),
    ),
  ];
}
```

```ts
    ...scriptProposalToolDefinitions(getAuth, onPreToolUse, onPostToolUse),
```

- [ ] **Step 6: Add the agent capability group and its copy**

`apps/api/src/services/aiAgents/agentToolCatalog.ts` — extend the union (`:28-31`) with `| 'author_scripts'`, add to `AGENT_CAPABILITIES` (`:33-49`) after `scripts_commands`:

```ts
  // 'high' tone: authoring novel code is a qualitatively different grant from
  // running a reviewed library script, and the picker must say so.
  { id: 'author_scripts', tone: 'high' },
```

and to `TOOL_CAPABILITY` (`:62`):

```ts
  // ---- author_scripts ----
  propose_script: 'author_scripts',
  get_script_proposal: 'author_scripts',
```

Then add real copy to **all eight** locales at `aiAgentsPage.catalog.capabilities.author_scripts` (English shown; the other seven need genuine translations — `translationCoverage.test.ts` caps exact-English duplicates):

```json
        "author_scripts": {
          "label": "Author scripts",
          "description": "Write a new script as a proposal for independent review. Nothing an agent writes runs until it has been reviewed and approved."
        },
```

- [ ] **Step 7: Run the tool suite and every registry contract**

Run: `cd apps/api && npx vitest run src/services/aiToolsScriptProposals.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiGuardrails.readonly.contract.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiToolsRegistryParity.test.ts`
Expected: PASS. Do **not** add either name to `KNOWN_MISSING_TOOL_TIERS` or `KNOWN_UNREGISTERED_TOOL_TIERS` — those lists may only shrink.

Run: `cd apps/web && npx vitest run src/lib/i18n`
Expected: PASS — `translationCoverage.test.ts` is where a missing or copy-pasted translation surfaces.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/aiToolsScriptProposals.ts apps/api/src/services/aiToolsScriptProposals.test.ts \
  apps/api/src/services/aiTools.ts apps/api/src/services/aiToolSchemas.ts \
  apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiGuardrails.ts \
  apps/api/src/services/aiAgents/agentToolCatalog.ts apps/web/src/locales
git commit -m "feat(ai): add propose_script and get_script_proposal behind the script authoring flag"
```

---

### Task 23: Pin the chat inline release ordering that W04 depends on

**Files:**
- Test only: `apps/api/src/services/aiAgentSdk.inlineReleaseOrdering.test.ts` (new)
- Reads: `apps/api/src/services/aiAgentSdk.ts:1380-1520`

**Finding (verified, no production change needed).** Spec §4.5 requires that the chat inline release path treat an intent that is already `approved` at creation exactly like a just-approved one — it must run `revalidateApprovedIntentForRelease` before executing. It already does:

- `waitForIntentDecision` returns immediately for an intent created `approved`, and the code falls through the `pending`/`rejected` branches (`:1329-1349`).
- `requiresDurableRelease(toolName)` is checked **before** the CAS (`:1359-1361`).
- The `approved → executing` CAS runs at `:1381-1390`.
- `revalidateApprovedIntentForRelease(intentRow, winningApproval)` runs at **`aiAgentSdk.ts:1448`**, and `winningApproval` is `null` when no `approval_requests` row exists (`:1435-1441`) — which is exactly the shape of a `script_reviewer` intent. W04's no-approval-row exception therefore plugs into an ordering that is already correct.
- The effect-digest recheck follows at `:1504-1517` and fails closed, because `computeEffectDigestForRelease` returns `null` for an unpinnable outcome and `null !== '<hex>'` is `content_changed`.

So the work here is to **pin that ordering with a test**, so a future refactor cannot quietly drop the revalidation for system-decided intents.

- [ ] **Step 1: Write the ordering test**

```ts
// apps/api/src/services/aiAgentSdk.inlineReleaseOrdering.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A source-order assertion, deliberately, for the same reason
 * aiGuardrails.imports.contract.test.ts is one: the behaviour being pinned is
 * "these three things happen in this order on the inline release path", and
 * exercising it end-to-end would need a live intent, a live CAS and a live
 * tool. The cheap structural check catches the refactor that matters.
 */
const src = readFileSync(new URL('./aiAgentSdk.ts', import.meta.url), 'utf8');

describe('chat inline release ordering (spec §4.5, needed by W04)', () => {
  it('revalidates after winning the release CAS and before the digest recheck', () => {
    const cas = src.indexOf("const wonRelease = await transitionIntent(");
    const revalidate = src.indexOf('revalidateApprovedIntentForRelease(intentRow, winningApproval)');
    const digest = src.indexOf('computeEffectDigestForRelease(');
    expect(cas).toBeGreaterThan(-1);
    expect(revalidate).toBeGreaterThan(cas);
    expect(digest).toBeGreaterThan(revalidate);
  });

  it('passes a possibly-null winning approval, so an intent approved at creation still revalidates', () => {
    // `script_reviewer` intents (W04) write NO approval_requests row, so the
    // revalidation must tolerate null here rather than short-circuit on it.
    expect(src).toMatch(/winningApproval:\s*approvalRow\s*\?\?\s*null/);
    expect(src).not.toMatch(/if \(!winningApproval\)\s*\{\s*return/);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd apps/api && npx vitest run src/services/aiAgentSdk.inlineReleaseOrdering.test.ts`
Expected: PASS on the current source. If it fails, the finding above is wrong for the current HEAD — fix the ordering in `aiAgentSdk.ts` rather than weakening the test, and note the change in the PR.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/aiAgentSdk.inlineReleaseOrdering.test.ts
git commit -m "test(ai): pin the chat inline release revalidation ordering the unattended lane depends on"
```

---

### Task 24: Integration — RLS forge, immutability, and append-only enforcement

**Files:**
- Create: `apps/api/src/__tests__/integration/scriptProposalsRls.integration.test.ts`
- Template: `apps/api/src/__tests__/integration/backupSnapshotRetirementsRls.integration.test.ts:1-85`

**Interfaces:** none. Prerequisite: `pnpm test-stack up`, which writes `DATABASE_URL` into `.env.test`.

**Why the second half of each forge matters:** an insert-only 42501 test **passes for the wrong reason** when the `breeze_app` GRANT is missing. Each forge is therefore paired with a positive control proving org A sees the row and org B sees none.

- [ ] **Step 1: Write the suite**

```ts
// apps/api/src/__tests__/integration/scriptProposalsRls.integration.test.ts
import './setup';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { scriptProposalReviews, scriptProposals } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function seedTwoOrgs() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [proposal] = await db.insert(scriptProposals).values({
      orgId: orgA.id, authorKind: 'chat_session', language: 'bash',
      content: 'echo hi', contentDigest: 'a'.repeat(64), timeoutSeconds: 60,
      goal: 'g', expectedEffect: 'e', verification: { kind: 'exit_code', equals: 0 },
      targetDeviceIds: [orgA.id], scannerVersion: '2026-09-11.1', status: 'reviewed',
      expiresAt: new Date(Date.now() + 3600_000),
    }).returning();
    return { orgAId: orgA.id, orgBId: orgB.id, proposalId: proposal!.id };
  });
}

runDb('refuses a forged cross-tenant script_proposals insert with 42501', async () => {
  const { orgAId, orgBId } = await seedTwoOrgs();
  await expect(
    withDbAccessContext(orgContext(orgBId), () => db.insert(scriptProposals).values({
      orgId: orgAId, authorKind: 'chat_session', language: 'bash', content: 'echo forged',
      contentDigest: 'b'.repeat(64), timeoutSeconds: 60, goal: 'g', expectedEffect: 'e',
      verification: { kind: 'exit_code', equals: 0 }, targetDeviceIds: [orgAId],
      scannerVersion: '2026-09-11.1', expiresAt: new Date(Date.now() + 3600_000),
    })),
    // A Drizzle insert rejection wraps the Postgres error under `.cause`.
  ).rejects.toMatchObject({ cause: { code: '42501' } });
});

runDb('positive control: org A sees its proposal and org B sees none', async () => {
  const { orgAId, orgBId, proposalId } = await seedTwoOrgs();
  const seen = await withDbAccessContext(orgContext(orgAId), () =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(seen).toHaveLength(1);
  const unseen = await withDbAccessContext(orgContext(orgBId), () =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(unseen).toHaveLength(0);
});

runDb('refuses a forged cross-tenant script_proposal_reviews insert with 42501', async () => {
  const { orgAId, orgBId, proposalId } = await seedTwoOrgs();
  await expect(
    withDbAccessContext(orgContext(orgBId), () => db.insert(scriptProposalReviews).values({
      orgId: orgAId, proposalId, reviewerKind: 'model', status: 'completed', riskTier: 'low',
    })),
  ).rejects.toMatchObject({ cause: { code: '42501' } });
});

runDb('refuses a review whose org_id disagrees with its proposal (composite FK)', async () => {
  const { orgBId, proposalId } = await seedTwoOrgs();
  await expect(
    withSystemDbAccessContext(() => db.insert(scriptProposalReviews).values({
      orgId: orgBId, proposalId, reviewerKind: 'model', status: 'completed', riskTier: 'low',
    })),
  ).rejects.toMatchObject({ cause: { code: '23503' } });
});

runDb('refuses to mutate proposal content, and allows a lifecycle transition', async () => {
  const { orgAId, proposalId } = await seedTwoOrgs();
  await expect(
    withDbAccessContext(orgContext(orgAId), () =>
      db.update(scriptProposals).set({ content: 'rm -rf /' }).where(eq(scriptProposals.id, proposalId))),
  ).rejects.toMatchObject({ cause: { code: '42501' } });

  await expect(
    withDbAccessContext(orgContext(orgAId), () =>
      db.update(scriptProposals).set({ status: 'expired' }).where(eq(scriptProposals.id, proposalId))),
  ).resolves.toBeDefined();
});

runDb('refuses to update or delete a review as breeze_app — the evidence is append-only', async () => {
  const { orgAId, proposalId } = await seedTwoOrgs();
  const [review] = await withSystemDbAccessContext(() => db.insert(scriptProposalReviews).values({
    orgId: orgAId, proposalId, reviewerKind: 'model', status: 'completed', riskTier: 'low',
    summary: 'restarts the spooler',
  }).returning());

  await expect(
    withDbAccessContext(orgContext(orgAId), () => db.update(scriptProposalReviews)
      .set({ summary: 'rewritten' }).where(eq(scriptProposalReviews.id, review!.id))),
  ).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^(42501|55000)$/) } });

  await expect(
    withDbAccessContext(orgContext(orgAId), () => db.delete(scriptProposalReviews)
      .where(eq(scriptProposalReviews.id, review!.id))),
  ).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^(42501|55000)$/) } });
});
```

- [ ] **Step 2: Run it against a live database**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptProposalsRls.integration.test.ts
```

Expected: PASS. A skipped suite (no `DATABASE_URL`) is a **failure of the step**, not a pass — check the reported test count, not just the exit code.

- [ ] **Step 3: Run the RLS coverage contract**

Run: `cd apps/api && npx vitest run --config vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: PASS with no allowlist edit. Both tables are shape 1 and are picked up by the `org_id_tables` CTE automatically; if this suite asks for an allowlist entry, a policy is missing for one of the four commands — fix the migration, do not widen the allowlist.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/scriptProposalsRls.integration.test.ts
git commit -m "test(tenancy): RLS forge, immutability and append-only coverage for script proposals"
```

---

### Task 25: Integration — cascade, export roundtrip, and the merge fence

**Files:**
- Create: `apps/api/src/__tests__/integration/scriptProposalsLifecycle.integration.test.ts`
- Also run (unmodified): `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `orgLifecycleFoundations.integration.test.ts`

- [ ] **Step 1: Write the suite**

```ts
// apps/api/src/__tests__/integration/scriptProposalsLifecycle.integration.test.ts
import './setup';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { scriptProposalReviews, scriptProposals } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { deleteOrganizationCascade } from '../../services/tenantCascade';
import { executeOrgMerge } from '../../services/orgMerge';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedProposalWithReview(orgId: string, status = 'reviewed' as const) {
  return withSystemDbAccessContext(async () => {
    const [proposal] = await db.insert(scriptProposals).values({
      orgId, authorKind: 'chat_session', language: 'bash', content: 'echo hi',
      contentDigest: 'a'.repeat(64), timeoutSeconds: 60, goal: 'g', expectedEffect: 'e',
      verification: { kind: 'exit_code', equals: 0 }, targetDeviceIds: [orgId],
      scannerVersion: '2026-09-11.1', status, expiresAt: new Date(Date.now() + 3600_000),
    }).returning();
    await db.insert(scriptProposalReviews).values({
      orgId, proposalId: proposal!.id, reviewerKind: 'model', status: 'completed', riskTier: 'low',
    });
    return proposal!.id;
  });
}

runDb('org erasure removes reviews before proposals without an FK violation', async () => {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const proposalId = await seedProposalWithReview(org.id);

  await expect(deleteOrganizationCascade(org.id)).resolves.toBeDefined();

  const left = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(left).toHaveLength(0);
  const reviewsLeft = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposalReviews).where(eq(scriptProposalReviews.proposalId, proposalId)));
  expect(reviewsLeft).toHaveLength(0);
});

runDb('an org merge expires live proposals in the loser and leaves terminal ones alone', async () => {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const loser = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const survivor = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const liveId = await seedProposalWithReview(loser.id, 'reviewed');
  const terminalId = await seedProposalWithReview(loser.id, 'promoted');

  await executeOrgMerge({ loserOrgId: loser.id, survivorOrgId: survivor.id });

  const [live] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, liveId)));
  const [terminal] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, terminalId)));

  expect(live!.status).toBe('expired');
  // Left for erasure, NOT repointed: proposal history stays with the source org.
  expect(live!.orgId).toBe(loser.id);
  expect(terminal!.status).toBe('promoted');
  expect(terminal!.orgId).toBe(loser.id);
});
```

Adjust `deleteOrganizationCascade` / `executeOrgMerge` to the exact exported names and argument shapes those modules use — read `apps/api/src/services/tenantCascade.ts` and `apps/api/src/services/orgMerge.ts` before writing the calls, and copy the invocation from `tenantCascade.integration.test.ts` and `orgMergeCustomExecutors.integration.test.ts:81`.

- [ ] **Step 2: Run the new suite and the four standing contracts**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/scriptProposalsLifecycle.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```

Expected: all PASS. `orgLifecycleFoundations.integration.test.ts` is the "merge contract" that proves the composite `(proposal_id, org_id)` FK is `DEFERRABLE INITIALLY IMMEDIATE` — a non-deferrable one aborts the merge with 23503 and only this suite catches it. `tenantExportErasureRoundtrip` is the only suite that catches a missing export-policy column.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/scriptProposalsLifecycle.integration.test.ts
git commit -m "test(tenancy): org erasure, export roundtrip and merge-fence coverage for script proposals"
```

---

### Task 26: Integration — propose → run inside a real request transaction, and the consumption race

**Files:**
- Create: `apps/api/src/__tests__/integration/scriptProposalRunRoute.integration.test.ts`

**Why live-DB and not mocked:** a mocked route test cannot see either failure this pins. (1) A unique/FK violation **caught** inside `withDbAccessContext` still leaves the enclosing transaction aborted, so a neatly mapped 409 becomes a 500 at commit — only a real request transaction shows it, and the fix is a SAVEPOINT around the failing statement. (2) The single-consumption CAS is only real under concurrent transactions.

- [ ] **Step 1: Write the suite**

```ts
// apps/api/src/__tests__/integration/scriptProposalRunRoute.integration.test.ts
import './setup';

import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { scriptProposals } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { consumeProposalForIntent, createScriptProposal } from '../../services/scriptProposals';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string, userId: string | null = null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId };
}

async function seedReviewedProposal(orgId: string, deviceId: string): Promise<string> {
  const auth = { orgId, user: { id: null }, principal: { kind: 'user' } } as never;
  const { proposal } = await withDbAccessContext(orgContext(orgId), () =>
    createScriptProposal(auth, {
      language: 'bash', content: 'echo hi', goal: 'g', expectedEffect: 'e',
      verification: { kind: 'exit_code', equals: 0 }, deviceIds: [deviceId],
      runAs: 'system', timeoutSeconds: 60,
    } as never, { kind: 'chat_session', sessionId: null }));
  await withSystemDbAccessContext(() => db.update(scriptProposals)
    .set({ status: 'reviewed', riskTier: 'low' }).where(eq(scriptProposals.id, proposal.id)));
  return proposal.id;
}

runDb('creates a proposal inside a real request transaction without poisoning it', async () => {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const proposalId = await seedReviewedProposal(org.id, org.id);

  // The tx must still be usable AFTER the write — the 409-becomes-500 trap is
  // a transaction that was silently aborted by a caught error earlier in it.
  const rows = await withDbAccessContext(orgContext(org.id), async () => {
    await db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId));
    return db.select().from(scriptProposals).where(eq(scriptProposals.orgId, org.id));
  });
  expect(rows.length).toBeGreaterThan(0);
});

runDb('exactly one of two concurrent run_script calls consumes the proposal', async () => {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
  const proposalId = await seedReviewedProposal(org.id, org.id);

  const [a, b] = await Promise.all([
    withSystemDbAccessContext(() => consumeProposalForIntent(db, proposalId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
    withSystemDbAccessContext(() => consumeProposalForIntent(db, proposalId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')),
  ]);

  expect([a, b].filter(Boolean)).toHaveLength(1);
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(scriptProposals).where(eq(scriptProposals.id, proposalId)));
  expect(row!.intentId).not.toBeNull();
});

runDb('a consumed proposal cannot be consumed again, and an expired one never can', async () => {
  const partner = await withSystemDbAccessContext(() => createPartner());
  const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));

  const consumed = await seedReviewedProposal(org.id, org.id);
  await withSystemDbAccessContext(() => consumeProposalForIntent(db, consumed, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  await expect(withSystemDbAccessContext(() =>
    consumeProposalForIntent(db, consumed, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'))).resolves.toBe(false);

  const stale = await seedReviewedProposal(org.id, org.id);
  await withSystemDbAccessContext(() => db.update(scriptProposals)
    .set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(scriptProposals.id, stale)));
  await expect(withSystemDbAccessContext(() =>
    consumeProposalForIntent(db, stale, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'))).resolves.toBe(false);
});
```

- [ ] **Step 2: Run it**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/scriptProposalRunRoute.integration.test.ts
```

Expected: PASS with 3 tests executed (not skipped). If the race test reports 2 winners, `consumeProposalForIntent` lost its `intent_id IS NULL` predicate — fix the service, not the test.

- [ ] **Step 3: Tear down the test stack**

```bash
pnpm test-stack down
```

Nothing reaps it for you.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/scriptProposalRunRoute.integration.test.ts
git commit -m "test(ai): live-DB coverage for proposal creation in a request tx and single-intent consumption"
```

---

## Pre-PR checklist

- [ ] `pnpm --filter @breeze/shared test --run` and `cd apps/api && npx vitest run` both green.
- [ ] `pnpm db:check-drift` clean.
- [ ] `pnpm lint` clean.
- [ ] `./scripts/check-migration-naming.sh --against-ref origin/main` green — if `origin/main` gained a migration that sorts after `2026-10-16-100300`, rename all three files **and sweep every reference** (integration suites replay migrations by path; a missed one is an ENOENT minutes into Integration Tests).
- [ ] Integration suites named in Tasks 24-26 plus `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgLifecycleFoundations`, `migrationRlsScope`, `autoMigrate`, `aiAgentSdkTools.registryParity.contract`, `aiGuardrails.imports.contract` all green against a live stack.
- [ ] `pnpm test-stack down`.
- [ ] One review round (Codex `medium` + Sonnet — this wave touches tenancy), findings fixed, recorded in the PR body.
- [ ] PR body includes `Closes #<W01b wave sub-issue>` and records the four resolved contradictions (org-merge fence kind, the third `checkGuardrails` caller, the effect-digest throw, the flag-gating placement).
- [ ] No release-notes entry: W01b ships nothing user-visible (the flag is off and there is no reviewer yet). The entry lands in W03.

---

## Self-review

**1. Spec coverage.** §3 as-built facts: all cited lines re-read and corrected where the spec was stale (noted below). §4.1 `script_proposals` / `script_proposal_reviews` → Tasks 5, 8; `script_executions` source + snapshot + provenance → Tasks 6, 8, 18, 19; `scripts.origin` → Tasks 7, 8. §4.2 tools → Tasks 21, 22; `run_script` validation list → Task 13. §4.3 scan + classifier → Tasks 2, 3. §4.5 effect digest paragraph and run_script validation → Tasks 13, 20, 23. §5 tenancy/registration → Tasks 9, 10, 11, 24, 25. §7 testing → every task's own suite plus Tasks 24-26. §8 W01 flag → Task 1. **Out of scope by design and assigned elsewhere:** `script_versions` rebuild and `cutScriptVersion` (W01a); the reviewer worker, floors and budget reservation (W02); approval cards, STRICT acknowledgement ceremony, request-changes, verification, promotion (W03); `ai_script_policies`, `ai_script_lane_state`, `script_reviewer` autonomy (W04).

**2. Placeholder scan.** No TBD/TODO; every code step carries the actual code. Two steps deliberately say "read the file first" rather than guessing a signature — Task 25's `deleteOrganizationCascade` / `executeOrgMerge` invocation and Task 21's handler extraction — and each names the exact file and the exact existing call site to copy from, which is an instruction, not a blank.

**3. Type consistency.** `ScriptProposalRow` / `ScriptProposalReviewRow` (Task 8) are the row types every later task uses. `ScriptScanResult`, `TouchClass`, `SCANNER_VERSION`, `scanScriptContent`, `RiskTier`, `riskTierRank`, `proposeScriptInputSchema`, `SCRIPT_PROPOSAL_STATUSES`, `ScriptOrigin`, `ScriptApprovalMethod`, `GuardrailContext`, `ProposalRunnability`, `assertProposalRunnable`, `loadProposalGuardrailContext`, `ProposalDispatchSnapshot`, `proposalDispatchSnapshot`, `SCRIPT_REVIEW_QUEUE`, `ScriptReviewJobData`, `enqueueScriptReview`, `waitForReviewCompletion`, `consumeProposalForIntent`, `transitionProposal`, `supersedeProposal`, `createScriptProposal`, `getScriptProposalForPrincipal` all match roadmap §3.1/§3.3 verbatim.

### Contradictions found while writing this plan

| # | Where | What | Resolution in this plan |
|---|---|---|---|
| 1 | roadmap §2 vs `orgMerge.ts:704-707`, `:741-743` | Both new tables are listed `leave-for-erasure` "with a pre-merge fence". `leave-for-erasure` is a **no-op in both phases**, and `CUSTOM_RESOLVE_EXECUTORS` is consulted only under `case 'custom'`, so that combination cannot fence anything. | Task 10: `script_proposals` → `kind: 'custom'` + resolve fence + no-op move + preview counter (the `ai_operator_tasks` pattern, `orgMergeRegistry.ts:233`); `script_proposal_reviews` stays `leave-for-erasure`. |
| 2 | roadmap §3.3 vs `intentService.ts:1042` | Only `aiAgentSdk.ts` and `runLoop.ts` are named as context-passing callers. `createActionIntent` calls `checkGuardrails` itself and throws `tool_blocked` on tier ≥ 4, so without the context **every** proposal intent dies at creation and the persisted `approvalScope` would be the fail-safe `four_eyes`. | Task 17 adds it as a third, load-bearing caller via an exported `resolveGuardrailForIntent`. `checkAgentGuardrails` (`aiGuardrails.ts:1744`) is a fourth, handled by passthrough in Task 16. |
| 3 | roadmap §3.3 vs `effectDigest.ts` (whole module) | The roadmap says the resolver "throws `EffectDigestUnresolvableError`". The module currently never throws — every unresolvable case is a sentinel that becomes `effect_digest = NULL`, which both release paths treat as "nothing to check" (fail-OPEN). | Task 20 introduces the module's first throwing path, narrowly for the proposal branch, and maps it to a distinct `effect_digest_unresolvable` intent error code so it is not reported as `fanout_failed`. |
| 4 | roadmap §2 vs `aiAgentSdkTools.registryParity.contract.test.ts:179-194` | "When off, the two new tools are not registered" would leave `TOOL_TIERS` keys with no registry entry and redden the contract, whose allowlists may only shrink. | Task 22: registration and `TOOL_TIERS` unconditional; the flag gates the `tool()` definitions (the real exposure gate), the capability group, and the handlers. |
| 5 | spec §4.1 (`supersedes_id` "→ script_proposals") vs §5 ("the only hard FK among the new tables is reviews → proposals") | A self-referencing FK would also put a cycle in the cascade topological order. | Task 5: `supersedes_id` is a bare uuid. |
| 6 | spec §3 "Newest migration on `origin/main`" says `2026-10-15-170200-organization-key-dates.sql` | Confirmed still correct as of this writing (`ls apps/api/migrations | sort | tail`), but it is a moving target. | Pre-PR checklist re-verifies with `check-migration-naming.sh --against-ref origin/main`. |

### Open questions for the wave implementer

1. **Chat session attribution.** `propose_script` is registered in the `aiTools` execution registry, whose handlers receive `(input, auth, context?)` and never the Breeze session id (only the session-AWARE M365 handlers get one, and those are deliberately outside the registry). So a chat-authored proposal records `author_kind = 'chat_session'` with `session_id = NULL`. W02's reviewer prompt does not need it (the transcript is excluded on purpose) and W03's detail route can resolve the author from the intent — but if `session_id` must be populated, `propose_script` has to move to `makeSessionAwareHandler`, which takes it out of the registry and therefore out of `TOOL_CAPABILITY` and the registry-parity contract. Flagging rather than deciding, because it changes the tool's registration shape.
2. **`script_proposals.decided_by` FK to `users`.** Kept as `REFERENCES users(id) ON DELETE SET NULL` for readability. If org erasure ordering makes that awkward, it is a safe downgrade to a bare uuid — `users` is dual-axis and not in the org cascade, so this should be fine, but it is the one FK here that was not forced by a contract.

## Amendments after cross-wave reconciliation (2026-09-11)

- `packages/shared/src/types/scriptProposals.ts` already exists from W01a with `ScriptOrigin` and `ScriptApprovalMethod`; Task 4 extends it (its code block is the end state). Mark the file **Modify**, not Create.
- Chat-authored proposals must carry `session_id`: in the SDK `onPostToolUse` hook for `propose_script` (`aiAgentSdkTools.makeHandler` / `aiAgentSdk.ts`), when the tool output carries `proposalId`, run an org-scoped `UPDATE script_proposals SET session_id = $session WHERE id = $proposalId AND org_id = $org AND session_id IS NULL`. Add this to the task that wires the SDK callers, with a test asserting the row is updated and that a foreign-org proposal id is not.
- `CreateActionIntentInput.guardrailContext?: GuardrailContext` is the contract W04 consumes; keep the field name.
- The org-merge entry for `script_proposals` is kind `custom` (fence + no-op move), reviews stay `leave-for-erasure` — as this plan already decided; the spec and roadmap now say the same.

