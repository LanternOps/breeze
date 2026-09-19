---
tracking_issue: LanternOps/breeze#5711
---

# Execution Plane W02 — Sandbox Adapter, Workspaces Table, Compute Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the private `SandboxBackend` adapter (interface, in-process fake, Vercel Sandbox implementation) with a shared contract suite, the `ai_run_workspaces` table plus compute columns with full tenancy ceremony, the orphan reaper, compute pricing (`calculateComputeCents`), config/flag plumbing, and the nightly real-Vercel egress/cleanup suite — all dark behind `BREEZE_AI_WORKSPACE_ENABLED=false`.

**Architecture:** `services/workspace/sandboxBackend.ts` defines the E2B-shaped interface, a typed `SandboxError` family, and a factory keyed by `AI_WORKSPACE_BACKEND`; `fakeSandboxBackend.ts` (temp dir + `child_process.spawn`, never a shell string) and `vercelSandboxBackend.ts` (`@vercel/sandbox@3.3.0`, `networkPolicy:'deny-all'`, `persistent:false`, region pinned per Breeze region) both pass one `describe.each` contract suite. A Shape-1 `ai_run_workspaces` table (composite deferrable FK to `ai_agent_runs(id, org_id)`, `ON DELETE CASCADE`) records every sandbox for the 60 s BullMQ reaper, which destroys anything past `deadline_at + 120 s`, records last-known usage, and pages `destroy_failed` through Sentry. Pricing is a pure module (`aiComputePricing.ts`) re-exported from `aiCostTracker.ts`; reservation/settlement wiring is W04.

**Tech Stack:** TypeScript, Hono API, Drizzle ORM + hand-written SQL migration, BullMQ, `@vercel/sandbox@3.3.0`, Vitest (unit + `vitest.integration.config.ts` + a dedicated nightly config), prom-client, Sentry, GitHub Actions cron.

**Spec:** docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md (§2.2 D-B/D-C/D-F/D-I, §5.1, §5.6 pricing only, §6 preamble, §6.2, §6.3 compute columns, §8 hosted-only + residency assertion, §9 vendor create fails / destroy fails / usage unavailable, §10 `ai_workspace_create_seconds` + `ai_workspace_destroy_failed_total`, §12 `sandboxBackend.contract.test.ts` + `computeMetering` pricing half + nightly `workspace.vercel.e2e.test.ts`, §14 Q1 option names)

**Feature tracking:** parent issue and wave sub-issue assigned by `register_feature` after all wave plans exist; branch `feature/<parent#>-execution-plane/wave-<subissue#>`.

## Global Constraints

- Hosted-only (spec §2.2 D-I, §8): `aiWorkspaceEnabled()` is `isHosted() && BREEZE_AI_AGENTS_ENABLED && BREEZE_AI_WORKSPACE_ENABLED`; production boot refuses `BREEZE_AI_WORKSPACE_ENABLED=true` without `IS_HOSTED=true`, `AI_WORKSPACE_BACKEND=vercel` and all three Vercel credentials.
- Flags default OFF; nothing in this wave changes runtime behaviour while `BREEZE_AI_WORKSPACE_ENABLED` is unset — the reaper runs unconditionally but has no rows to act on.
- `exec` never receives a shell string from model content: the model's script is a file, executed by interpreter path (`['python3', '/work/step-1.py']`). The one `sh -c` in this wave is a compile-time constant stdin redirector whose argv is passed positionally.
- v1 sandbox has no network at all (`networkPolicy: 'deny-all'`, blocks DNS); persistence is OFF (`persistent: false`, passed explicitly); `destroy` purges snapshots via `delete({ deleteOrphanSnapshots: true })` and the nightly proves none survive.
- Every adapter method is bounded by a caller-supplied cap (`timeoutMs`, `maxStdoutBytes`, `maxBytes`, `maxTotalBytes`); every path is confined to `/work/**` (`..`, symlinks and anything outside refused with `invalid_path`).
- Region: the sandbox region equals the requested Breeze region (`eu` → `VERCEL_SANDBOX_REGION_EU` default `fra1`, `us` → `VERCEL_SANDBOX_REGION_US` default `iad1`); a mismatch after create destroys the sandbox and fails with `create_failed`. `lhr1` is never used (UK ≠ EU, spike §H.1).
- Tenancy ceremony (CLAUDE.md): Shape 1 `org_id`, RLS enable+force+four policies in the creating migration, composite FK `(run_id, org_id) → ai_agent_runs(id, org_id)` `DEFERRABLE INITIALLY IMMEDIATE`, registration in `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` (every column, jsonb → `excludedOpen`, incl. the ALTERed columns on four existing tables), `orgMergeRegistry` `SPECIAL`.
- Migration: `2026-10-16-100100-ai-run-workspaces-compute.sql`, idempotent, no inner BEGIN/COMMIT, DDL only (no `breeze.scope` election needed — say so in the header), re-check the newest committed migration before committing and rename if something newer landed.
- Status/backend/region columns are `text` + CHECK, never `pgEnum` (thin-slice precedent, 2026-10-14-100000: enum equality is not leakproof and turns the reaper poll into a post-policy filter under forced RLS). The contract names `aiWorkspaceBackend` / `aiWorkspaceStatus` / `aiWorkspaceRegion` are exported as `as const` tuples with matching `AiWorkspace*` types.
- `ai_agent_runs.workspace_id` carries NO FK: an FK would form a 2-node cycle with `ai_run_workspaces.run_id` that `topologicalCascadeOrder()` cannot resolve (the `metric_anomaly_incidents` precedent in `aiAgents.ts`).
- Pricing: `COMPUTE_PRICING.vercel = { cpuCentsPerHour: 12.8, memCentsPerGbHour: 2.12, minChargeCents: 1, minBillableWallMs: 60_000 }` (Vercel `iad1` list price, verified 2026-09-13; the fourth field is additive — the vendor's documented 1-minute memory increment), `AI_COMPUTE_PRICE_MULTIPLIER` default 1; `calculateComputeCents` throws on an unpriced backend and never returns 0 for a real one.
- Reservation and settlement (`reserveComputeCents` / `settleComputeCents`) are **W04's**, not this wave's — they need the `analysis` profile's limits and the admission path. W02 ships the pure pricing half plus the columns they will write to.
- `ai_agent_runs.staged_inputs jsonb` (spec §6.3) is likewise **W04's** column, added by `2026-10-16-100200-ai-analysis-profile-org-switch.sql` alongside the profile. This wave's migration adds only the five compute/workspace columns.
- Money and time are enforced provider-side too (spike §H.4): `Sandbox.create({ timeout })` is the hard stop; the reaper is the orphan backstop; `runCommand({ timeoutMs })` is the per-step kill backstop behind our own timer.
- Tests: Vitest, test file beside source; run ONE file with `cd apps/api && npx vitest run <path>`; the nightly suite is env-gated (`WORKSPACE_E2E=1` + credentials) and runs under its own vitest config, never in PR CI.
- No internal hosts/IPs/tokens in code or `.env.example` (`team_xxx`, `prj_xxx` placeholders only).

## Pinned `@vercel/sandbox@3.3.0` surface

**Verification provenance (re-done 2026-09-13, second pass).** `npm view @vercel/sandbox dist-tags` → `latest: 3.3.0`, `beta: 3.4.0-beta.0`; the package was `npm pack`ed and every name below read out of the shipped `package/dist/*.d.ts` (`sandbox.d.ts`, `session.d.ts`, `constants.d.ts`, `snapshot.d.ts`, `filesystem.d.ts`, `command.d.ts`, `api-client/validators.d.ts`, `api-client/api-error.d.ts`, `utils/get-credentials.d.ts`), cross-read against `https://vercel.com/docs/sandbox/sdk-reference` and `https://vercel.com/docs/sandbox/concepts/firewall`. Where the two disagree the **`.d.ts` of the pinned version wins** and the disagreement is recorded in the row. Task 4 Step 4.1 re-runs this check against the version actually installed in `node_modules` and amends this table if 3.3.0 is no longer what lands.

| Concern | Exact SDK name (3.3.0 `.d.ts`) |
|---|---|
| Credentials | `interface Credentials { token: string; projectId: string; teamId: string }` (`utils/get-credentials.d.ts`), accepted as an intersection on `Sandbox.create/get/getOrCreate/fork/list` and `Snapshot.list/get/tree`. Breeze always passes all three explicitly from `VERCEL_SANDBOX_TOKEN` / `VERCEL_PROJECT_ID` / `VERCEL_TEAM_ID` — never the SDK's ambient-env fallback. |
| Region | `Sandbox.create({ region?: SandboxRegion })`. `SandboxRegion = 'iad1' \| 'sfo1' \| 'cle1' \| 'cdg1' \| 'fra1' \| 'arn1' \| 'sin1' \| 'pdx1' \| 'lhr1' \| 'icn1' \| 'bom1' \| 'cpt1' \| 'dub1' \| 'gru1' \| 'hkg1' \| 'syd1' \| 'yul1' \| 'hnd1' \| 'kix1' \| (string & {})` and `DEFAULT_SANDBOX_REGION = 'iad1'` (`constants.d.ts`). Read back with the `sandbox.region` getter (`get region(): string`). `lhr1` is never used (UK ≠ EU, spike §H.1). |
| Deny-all | `Sandbox.create({ networkPolicy: 'deny-all' })`. Firewall docs, verbatim: "Most restrictive policy. **Denies all outbound network access, including DNS.**" Default when omitted is `'allow-all'` ("Default policy… unrestricted access to the public Internet"). An *empty* custom policy (`{}`, `{ allow: {} }`, `{ subnets: {} }`) also behaves as deny-all, but the docs say to use the explicit `'deny-all'` string when that is the intent — so we pass the string, never `{}`. |
| Persistence off | `Sandbox.create({ persistent?: boolean })` — `.d.ts` doc comment: "Enable or disable automatic restore of the filesystem between sessions." The `.d.ts` does **not** state the default, so Breeze **always passes `persistent: false` explicitly** and never relies on it. Read back with the `sandbox.persistent` getter. |
| Timeout | `Sandbox.create({ timeout?: number })` — "Timeout in **milliseconds** before the sandbox auto-terminates." Read back via `sandbox.timeout` (ms) and `sandbox.expiresAt: Date \| undefined`; extendable via `sandbox.extendTimeout(durationMs)`. Breeze passes `deadlineSeconds * 1000` and never extends. |
| Shape | `Sandbox.create({ resources?: { vcpus: number } })` — "your sandbox will get the amount of vCPUs you specify here and **2048 MB of memory per vCPU**". Read back with `sandbox.vcpus` / `sandbox.memory` (MB), both `number \| undefined`. |
| Image | `Sandbox.create({ image?: SandboxImage })` where `SandboxImage = \`vercel/sandbox/${ManagedImage}\` \| (string & {})` and `ManagedImage = 'universal' \| 'node:22' \| 'node:24' \| 'node:26' \| 'python:3.14' \| 'ubuntu' \| 'arch'`. v1 pins `'vercel/sandbox/universal'` (Ubuntu + Node 24 + Python 3.14). `runtime` is `@deprecated` in 3.x and is mutually exclusive with `image` in the type — never pass it. |
| Run | Object overload `sandbox.runCommand(params: RunCommandParams)`; `interface RunCommandParams { cmd: string; args?: string[]; cwd?: string; env?: Record<string,string>; sudo?: boolean; detached?: boolean; stdout?: Writable; stderr?: Writable; signal?: AbortSignal; timeoutMs?: number }` (`session.d.ts`). `timeoutMs` doc comment: "Maximum time in milliseconds the command may run before it is **killed with SIGKILL**. The timeout is enforced by the sandbox at exec time, so it applies whether or not the command is awaited." **Correction vs the published SDK-reference page**, which omits `timeoutMs` from the object overload — the shipped `.d.ts` has it on both the object overload and the `(command, args, opts)` string overload. Returns `CommandFinished { exitCode: number; durationMs?: number; stdout(); stderr(); output() }`; with `detached: true` returns `Command { wait(); kill(); exitCode: number \| null; durationMs?: number }`. |
| **No stdin** | `RunCommandParams` has **no stdin field** — there is no way to pipe bytes into a command. This is why `ExecOptions.stdinBytes` is implemented by writing the bytes to a file under `/work/tmp` and running the interpreter through one **compile-time-constant** `sh -c` redirector whose every model-derived value arrives as a positional argument (Task 4 Step 4.5). |
| Files (write) | `sandbox.writeFiles(files: { path: string; content: string \| Uint8Array; mode?: number }[], opts?: { signal?: AbortSignal })` — "Defaults to writing to `/vercel/sandbox` unless an **absolute path** is specified" (we always pass absolute `/work/**`). No `mkdir -p`: create parents first with `sandbox.mkDir(path)` or `sandbox.fs.mkdir(path, { recursive: true })`. The second argument carries **only** `signal` — `maxTotalBytes` is Breeze's cap, enforced before the call. |
| Files (read/list) | `sandbox.readFileToBuffer({ path, cwd? }) → Promise<Buffer \| null>` (**`null` = not found**, not a throw) and `sandbox.readFile({ path, cwd? }) → Promise<NodeJS.ReadableStream \| null>`. `sandbox.fs` is a `node:fs/promises`-compatible `FileSystem` with `mkdir/readdir({ withFileTypes: true })/stat/lstat/readFile/writeFile`. There is **no server-side byte cap** on a read — `maxBytes` is enforced after transfer, which the plan states explicitly rather than pretending otherwise. |
| Stop / usage | `sandbox.stop(opts?) → Promise<SandboxSnapshot & { snapshot?: SnapshotMetadata }>`, where `SandboxSnapshot = Omit<SessionMetaData,'networkPolicy'> & { networkPolicy?: NetworkPolicy }` (the field is not dropped, it is **re-widened to optional** — read it defensively, never assume it is present). The session fields that matter (`api-client/validators.d.ts`): **`activeCpuDurationMs?: number`**, **`duration?: number`** (wall ms), `memory: number` (MB), `vcpus: number`, `startedAt?`, `stoppedAt?`, `status`, `networkTransfer?: { ingress; egress }`. Instance getters, populated only once stopped: **`sandbox.activeCpuUsageMs`** ("The amount of CPU used by the session. Only reported once the VM is stopped"), plus cumulative `sandbox.totalActiveCpuDurationMs`, `sandbox.totalDurationMs`, `sandbox.totalEgressBytes`, `sandbox.totalIngressBytes` — all `number \| undefined`. **Both spellings are real and neither is guaranteed present**: the session payload uses `activeCpuDurationMs`/`duration`, the getters use `activeCpuUsageMs`/`totalDurationMs`. `usage()` reads the `stop()` payload first and falls back to the getters (Task 4 Step 4.7). |
| Destroy | **Correction to the first draft of this table.** `sandbox.delete(opts?: { deleteOrphanSnapshots?: boolean; signal?: AbortSignal })` exists and takes the purge flag directly — "When true, the snapshots of this sandbox that are not used by any other sandbox are deleted asynchronously too. **Defaults to false**, which keeps them until they expire." So destroy is `stop()` (to capture usage) → `delete({ deleteOrphanSnapshots: true })`, **not** a hand-rolled `Snapshot.list` + per-item `delete()` loop. After `delete()` "the instance becomes inert — all further API calls will throw immediately", which is what makes the second `destroy()` a no-op. With `persistent: false` and no call to `sandbox.snapshot()` no snapshot can be created in the first place; `deleteOrphanSnapshots` is belt-and-braces and the nightly suite is the proof. |
| Snapshots (nightly assertion only) | `Snapshot.list(params?)` and `Snapshot.get({ snapshotId })` → `Snapshot` with `.id`, `.expiresAt`, `.delete()`. `SnapshotMetadata` fields: `id`, `sourceSessionId`, `region`, `status: 'created' \| 'failed' \| 'deleted'`, `sizeBytes`, `expiresAt?`, `createdAt`, `parentId?`. |
| Reacquire | `Sandbox.get({ name: string, resume?: boolean, onResume?, signal? })` — the `.d.ts` says **"Defaults to false"** for `resume`; the published docs page says "Defaults to true". **The `.d.ts` of the pinned version wins**, and the reaper passes `resume: false` explicitly so the disagreement cannot matter. v2+ identifies a sandbox by `name` (unique per project), not by a `sandboxId`; therefore `providerRef === sandbox.name`. |
| List (nightly assertion only) | `Sandbox.list({ namePrefix?, tags?, sortBy?: 'createdAt' \| 'name' \| 'statusUpdatedAt', sortOrder?, limit?, cursor?, projectId?, signal? } & Partial<Credentials>) → Paginator<{ sandboxes: […], pagination: { count, next } }>`; the paginator is async-iterable and has `.toArray()` / `.pages()`. Rows carry `name`, `status: 'pending' \| 'running' \| 'stopping' \| 'stopped' \| 'failed' \| 'aborted' \| 'snapshotting'`, `region?`, `persistent`, `totalActiveCpuDurationMs?`, `totalDurationMs?`. |
| Errors | `APIError<ErrorData> extends Error { response: Response; json?: ErrorData; text?: string; sandboxName?: string; sessionId?: string }` and `StreamError extends Error { code: string; sessionId: string }`, both exported from the package root. Mapping used by the adapter: `response.status` 402/429 → `quota`; 404 → `not_found`; everything else → the call-site's own code. |
| Naming / tenant leakage | The sandbox `name` and `tags` are **vendor-side metadata Breeze does not control the retention of**, so neither may carry an org id, a run id, or any other tenant identifier — the same rule as the artifact blob keys (`<region>/<yyyy>/<mm>/<uuid>`). `create` generates `breeze-<region>-<random uuid>` and passes **no `tags` at all**. |
| Pricing (`iad1`, Pro) | Active CPU $0.128/h; provisioned memory $0.0212/GB-h, billed in **1-minute minimum increments**; creations $0.60/1M; egress $0.15/GB (deny-all → 0). Regional rates "vary by region" and were not extracted — `AI_COMPUTE_PRICE_MULTIPLIER` covers the gap until product sets margin. The 1-minute floor is modelled as `minBillableWallMs` in `COMPUTE_PRICING` (Task 9). |

---

### Task 1: Branch, slot re-check, dependency install

**Files:**
- none created (preflight)

**Interfaces:** none.

- [ ] **Step 1.1 — Branch from main.**
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
git fetch origin main
git checkout -b feature/<parent#>-execution-plane/wave-<subissue#> origin/main
pnpm install --frozen-lockfile
```
Expected: clean checkout, install exits 0.

- [ ] **Step 1.2 — Re-check the migration slot.**
```bash
ls apps/api/migrations | grep -E '^\d{4}-' | sort | tail -3
```
Expected today: `2026-10-15-160010-backup-snapshots-layout-manifest.sql` last (W01's `2026-10-16-100000-ai-run-artifacts.sql` may also be present). This wave's file is `2026-10-16-100100-ai-run-workspaces-compute.sql`. If anything sorts after `2026-10-16-100100-…`, rename this wave's file to sort after it (keep the `-ai-run-workspaces-compute.sql` slug) and update every reference in **Task 7**.

- [ ] **Step 1.3 — Confirm W01 state (decides the create-vs-append branch in Task 7).**
```bash
ls apps/api/src/db/schema/aiWorkspace.ts 2>/dev/null && echo "W01 merged: APPEND" || echo "W01 absent: CREATE"
grep -n "aiWorkspace" apps/api/src/db/schema/index.ts || echo "index export absent"
```
Record the answer; no commit.

---

### Task 2: `sandboxBackend.ts` — interface, `SandboxError`, factory

**Files:**
- Create: `apps/api/src/services/workspace/sandboxBackend.ts`
- Create: `apps/api/src/services/workspace/sandboxBackend.test.ts`

**Interfaces:**
- Consumes: `AiWorkspaceBackend` type from `apps/api/src/db/schema/aiWorkspace.ts` (**Task 7**, Step 7.1). That step has no dependency on Tasks 2–6, so if `tsc` cannot resolve the import, run Step 7.1 now and come back — the rest of Task 7 still happens in its written position.
- Produces (verbatim contract from the brief + additive fields flagged in the return):
```ts
export type SandboxRegion = 'eu' | 'us';
export type SandboxErrorCode =
  | 'create_failed' | 'quota' | 'exec_timeout' | 'not_found' | 'destroy_failed' | 'usage_unavailable'
  | 'file_too_large' | 'invalid_path';                       // additive: caller-cap and path-confinement refusals
export class SandboxError extends Error { readonly code: SandboxErrorCode; readonly backend: AiWorkspaceBackend | null }
export interface SandboxCreateSpec { runId: string; orgId: string; region: SandboxRegion; cpu: 1; memoryMb: 2048; deadlineSeconds: number; image: string }
export interface SandboxHandle { backend: AiWorkspaceBackend; providerRef: string; region: SandboxRegion; createdAt: Date }
export interface ExecOptions { cwd?: string; timeoutMs: number; stdinBytes?: Buffer; maxStdoutBytes: number }
export interface ExecResult { exitCode: number | null; timedOut: boolean; stdout: Buffer; stderr: Buffer; durationMs: number; stdoutTruncated: boolean; stderrTruncated: boolean } // last two additive
export interface FileStat { path: string; bytes: number; isDir: boolean; isSymlink?: boolean }   // isSymlink additive (W03 collect needs it)
export interface SandboxUsage { cpuMs: number; wallMs: number; memAllocatedMb: number; peakMemMb?: number }
export interface WriteFilesOptions { maxTotalBytes?: number }                                    // additive optional 3rd param
export interface SandboxBackend {
  readonly name: AiWorkspaceBackend;
  create(spec: SandboxCreateSpec): Promise<SandboxHandle>;
  exec(h: SandboxHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult>;
  writeFiles(h: SandboxHandle, files: Array<{ path: string; bytes: Buffer }>, opts?: WriteFilesOptions): Promise<void>;
  readFile(h: SandboxHandle, path: string, maxBytes: number): Promise<Buffer>;
  listFiles(h: SandboxHandle, dir: string): Promise<FileStat[]>;
  destroy(h: SandboxHandle): Promise<void>;
  usage(h: SandboxHandle): Promise<SandboxUsage>;
}
export const SANDBOX_WORK_DIRS: readonly ['/work/in', '/work/out', '/work/tmp'];
export function assertSandboxPath(p: string, cwd?: string): string;      // normalises; throws invalid_path outside /work
export function createCappedCollector(cap: number): { push(chunk: Buffer): void; buffer(): Buffer; readonly truncated: boolean; readonly size: number };
export function resolveSandboxBackendName(env?: NodeJS.ProcessEnv): 'vercel' | 'fake';
export function getSandboxBackendByName(name: AiWorkspaceBackend): SandboxBackend;               // additive: the reaper needs per-row dispatch
export function getSandboxBackend(): SandboxBackend;                                             // env AI_WORKSPACE_BACKEND
export function __resetSandboxBackendsForTests(): void;
```

- [ ] **Step 2.1 — Write the failing test.**

`apps/api/src/services/workspace/sandboxBackend.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

// The factory is exercised against the real fake backend and a stubbed Vercel module:
// loading @vercel/sandbox for real would drag undici/jose into this unit test for nothing.
vi.mock('./vercelSandboxBackend', () => ({
  createVercelSandboxBackend: vi.fn(() => ({ name: 'vercel' })),
}));

import {
  SandboxError,
  __resetSandboxBackendsForTests,
  assertSandboxPath,
  createCappedCollector,
  getSandboxBackend,
  getSandboxBackendByName,
  resolveSandboxBackendName,
} from './sandboxBackend';

describe('SandboxError', () => {
  it('carries a code, a backend and the cause', () => {
    const cause = new Error('boom');
    const err = new SandboxError('quota', 'vendor said no', { backend: 'vercel', cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SandboxError');
    expect(err.code).toBe('quota');
    expect(err.backend).toBe('vercel');
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('vendor said no');
  });
});

describe('resolveSandboxBackendName', () => {
  it.each([
    [{ AI_WORKSPACE_BACKEND: 'vercel' }, 'vercel'],
    [{ AI_WORKSPACE_BACKEND: ' FAKE ' }, 'fake'],
    [{ NODE_ENV: 'test' }, 'fake'],
    [{ NODE_ENV: 'development' }, 'fake'],
  ])('%o → %s', (env, expected) => {
    expect(resolveSandboxBackendName(env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it('refuses an unset backend in production (never a silent default there)', () => {
    expect(() => resolveSandboxBackendName({ NODE_ENV: 'production' } as NodeJS.ProcessEnv))
      .toThrow(SandboxError);
  });

  it('refuses an unknown backend name', () => {
    expect(() => resolveSandboxBackendName({ AI_WORKSPACE_BACKEND: 'gvisor_pool' } as NodeJS.ProcessEnv))
      .toThrowError(/Unsupported AI_WORKSPACE_BACKEND "gvisor_pool"/);
  });
});

describe('getSandboxBackend / getSandboxBackendByName', () => {
  const original = process.env.AI_WORKSPACE_BACKEND;
  afterEach(() => {
    __resetSandboxBackendsForTests();
    if (original === undefined) delete process.env.AI_WORKSPACE_BACKEND;
    else process.env.AI_WORKSPACE_BACKEND = original;
  });

  it('returns the fake backend for AI_WORKSPACE_BACKEND=fake and memoises it', () => {
    process.env.AI_WORKSPACE_BACKEND = 'fake';
    const a = getSandboxBackend();
    expect(a.name).toBe('fake');
    expect(getSandboxBackend()).toBe(a);
    expect(getSandboxBackendByName('fake')).toBe(a);
  });

  it('dispatches vercel by name and throws create_failed for an unimplemented backend', () => {
    expect(getSandboxBackendByName('vercel').name).toBe('vercel');
    expect(() => getSandboxBackendByName('agentcore')).toThrowError(
      expect.objectContaining({ code: 'create_failed' }),
    );
  });
});

describe('assertSandboxPath', () => {
  it.each([
    ['/work', '/work'],
    ['/work/in/a.txt', '/work/in/a.txt'],
    ['in/a.txt', '/work/in/a.txt'],
    ['/work/out/../in/b', '/work/in/b'],
  ])('%s → %s', (input, expected) => {
    expect(assertSandboxPath(input)).toBe(expected);
  });

  it.each(['/etc/passwd', '/work/../etc/x', '../x', '/workspace/x', '/'])('refuses %s', (bad) => {
    expect(() => assertSandboxPath(bad)).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
  });
});

describe('createCappedCollector', () => {
  it('keeps exactly cap bytes and flags truncation', () => {
    const c = createCappedCollector(5);
    c.push(Buffer.from('abc'));
    expect(c.truncated).toBe(false);
    c.push(Buffer.from('defg'));
    expect(c.buffer().toString()).toBe('abcde');
    expect(c.size).toBe(5);
    expect(c.truncated).toBe(true);
    c.push(Buffer.from('h'));
    expect(c.buffer().toString()).toBe('abcde');
  });
});
```

- [ ] **Step 2.2 — Run it; expect module-not-found.**
```bash
cd apps/api && npx vitest run src/services/workspace/sandboxBackend.test.ts
```
Expected: `Error: Failed to load url ./sandboxBackend` (or `Cannot find module`).

- [ ] **Step 2.3 — Implement `sandboxBackend.ts`.**
```ts
/**
 * Private sandbox adapter for the AI execution plane (spec §5.1).
 *
 * The loop never sees this: WorkspaceService (W03) is the only caller, the model only
 * ever sees workspace_* tool results. Every method is bounded by a caller-supplied cap,
 * every path is confined to /work, and `exec` takes an argv — the model's script is a
 * FILE executed by interpreter path, never a shell string (spec §5.1 rules; the
 * Codex/Docker Sandboxes lesson in the spike §D).
 *
 * Implementations: ./fakeSandboxBackend.ts (tests, in-process) and
 * ./vercelSandboxBackend.ts (v1 production). Later: gvisorPoolBackend, agentCoreBackend.
 */
import path from 'node:path';
import type { AiWorkspaceBackend } from '../../db/schema/aiWorkspace';
import { createFakeSandboxBackend } from './fakeSandboxBackend';
import { createVercelSandboxBackend } from './vercelSandboxBackend';

export type SandboxRegion = 'eu' | 'us';

export type SandboxErrorCode =
  | 'create_failed'
  | 'quota'
  | 'exec_timeout'
  | 'not_found'
  | 'destroy_failed'
  | 'usage_unavailable'
  // Caller-cap and path-confinement refusals. Kept separate from `quota` (a VENDOR
  // limit) so W03 can map them to distinct typed tool errors (spec §8 "each cap
  // failure is a typed tool error the model can read, and a counter").
  | 'file_too_large'
  | 'invalid_path';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly backend: AiWorkspaceBackend | null;

  constructor(
    code: SandboxErrorCode,
    message: string,
    opts: { backend?: AiWorkspaceBackend | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SandboxError';
    this.code = code;
    this.backend = opts.backend ?? null;
  }
}

export function isSandboxError(err: unknown, code?: SandboxErrorCode): err is SandboxError {
  return err instanceof SandboxError && (code === undefined || err.code === code);
}

export interface SandboxCreateSpec {
  runId: string;
  orgId: string;
  region: SandboxRegion;
  /** v1 fixed shape (spec §5.1). */
  cpu: 1;
  memoryMb: 2048;
  /** Provider-side hard stop, seconds. */
  deadlineSeconds: number;
  /** 'breeze-analysis@<digest>' — recorded; v1 uses the vendor default runtime. */
  image: string;
}

export interface SandboxHandle {
  backend: AiWorkspaceBackend;
  /** Vendor id of the sandbox — what the reaper needs to destroy it without this process. */
  providerRef: string;
  region: SandboxRegion;
  createdAt: Date;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs: number;
  stdinBytes?: Buffer;
  maxStdoutBytes: number;
}

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface FileStat {
  path: string;
  bytes: number;
  isDir: boolean;
  isSymlink?: boolean;
}

export interface SandboxUsage {
  cpuMs: number;
  wallMs: number;
  memAllocatedMb: number;
  peakMemMb?: number;
}

export interface WriteFilesOptions {
  maxTotalBytes?: number;
}

export interface SandboxBackend {
  readonly name: AiWorkspaceBackend;
  create(spec: SandboxCreateSpec): Promise<SandboxHandle>;
  exec(h: SandboxHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult>;
  writeFiles(h: SandboxHandle, files: Array<{ path: string; bytes: Buffer }>, opts?: WriteFilesOptions): Promise<void>;
  readFile(h: SandboxHandle, path: string, maxBytes: number): Promise<Buffer>;
  listFiles(h: SandboxHandle, dir: string): Promise<FileStat[]>;
  /** Idempotent; must also purge any snapshot. Called from a `finally` and from the reaper. */
  destroy(h: SandboxHandle): Promise<void>;
  /** Read after destroy. Throws `usage_unavailable` when the provider reported nothing. */
  usage(h: SandboxHandle): Promise<SandboxUsage>;
}

export const SANDBOX_ROOT = '/work';
export const SANDBOX_WORK_DIRS = ['/work/in', '/work/out', '/work/tmp'] as const;

/**
 * Normalise a sandbox path and refuse anything that escapes /work. Relative paths
 * resolve against `cwd` (default /work). Symlink escapes are checked by the backends
 * with lstat at access time — this is the static half of the fence.
 */
export function assertSandboxPath(p: string, cwd: string = SANDBOX_ROOT): string {
  const abs = path.posix.isAbsolute(p) ? p : path.posix.join(cwd, p);
  const normalized = path.posix.normalize(abs);
  if (normalized !== SANDBOX_ROOT && !normalized.startsWith(`${SANDBOX_ROOT}/`)) {
    throw new SandboxError('invalid_path', `path "${p}" is outside ${SANDBOX_ROOT}`);
  }
  return normalized;
}

/** Byte-capped accumulator shared by the fake and Vercel exec paths. */
export function createCappedCollector(cap: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    get truncated() {
      return truncated;
    },
    get size() {
      return size;
    },
    push(chunk: Buffer): void {
      if (size >= cap) {
        truncated = true;
        return;
      }
      const room = cap - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = cap;
        truncated = true;
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    },
    buffer(): Buffer {
      return Buffer.concat(chunks);
    },
  };
}

const SHIPPED_BACKENDS = new Set<string>(['vercel', 'fake']);

export function resolveSandboxBackendName(env: NodeJS.ProcessEnv = process.env): 'vercel' | 'fake' {
  const raw = (env.AI_WORKSPACE_BACKEND ?? '').trim().toLowerCase();
  if (raw === '') {
    // Outside production the fake is the sensible default (unit tests, local dev).
    // In production an unset backend must refuse rather than pick one (spec §5.6:
    // "Unknown backend → refuse to create, never $0"); validate.ts also enforces this at boot.
    if (env.NODE_ENV === 'production') {
      throw new SandboxError('create_failed', 'AI_WORKSPACE_BACKEND is not set');
    }
    return 'fake';
  }
  if (!SHIPPED_BACKENDS.has(raw)) {
    throw new SandboxError('create_failed', `Unsupported AI_WORKSPACE_BACKEND "${raw}" (expected vercel|fake)`);
  }
  return raw as 'vercel' | 'fake';
}

// One instance per backend per process: the fake keeps its sandboxes in memory, so the
// reaper and WorkspaceService must share it; the Vercel adapter caches live SDK handles
// and the stop() usage it read, which usage() relies on.
const singletons = new Map<AiWorkspaceBackend, SandboxBackend>();

export function getSandboxBackendByName(name: AiWorkspaceBackend): SandboxBackend {
  const existing = singletons.get(name);
  if (existing) return existing;
  let backend: SandboxBackend;
  switch (name) {
    case 'fake':
      backend = createFakeSandboxBackend();
      break;
    case 'vercel':
      backend = createVercelSandboxBackend();
      break;
    default:
      throw new SandboxError('create_failed', `No SandboxBackend implementation for "${name}"`, { backend: name });
  }
  singletons.set(name, backend);
  return backend;
}

export function getSandboxBackend(): SandboxBackend {
  return getSandboxBackendByName(resolveSandboxBackendName());
}

export function __resetSandboxBackendsForTests(): void {
  singletons.clear();
}
```

- [ ] **Step 2.4 — Stub the two implementation modules so the file compiles (Tasks 3 and 4 replace them).**

`apps/api/src/services/workspace/fakeSandboxBackend.ts` (temporary):
```ts
import type { SandboxBackend } from './sandboxBackend';
export function createFakeSandboxBackend(): SandboxBackend {
  throw new Error('fakeSandboxBackend: implemented in Task 3');
}
```
`apps/api/src/services/workspace/vercelSandboxBackend.ts` (temporary):
```ts
import type { SandboxBackend } from './sandboxBackend';
export function createVercelSandboxBackend(): SandboxBackend {
  throw new Error('vercelSandboxBackend: implemented in Task 4');
}
```
If `apps/api/src/db/schema/aiWorkspace.ts` does not exist yet, do **Step 7.1** now so `AiWorkspaceBackend` resolves.

- [ ] **Step 2.5 — Run the test; all but the fake-memoisation case pass (the fake throws its stub error).**
```bash
cd apps/api && npx vitest run src/services/workspace/sandboxBackend.test.ts
```
Expected: `returns the fake backend … memoises it` FAILS with `implemented in Task 3`; every other case PASSES. That one goes green in Task 3.

- [ ] **Step 2.6 — Commit.**
```bash
git add apps/api/src/services/workspace/sandboxBackend.ts apps/api/src/services/workspace/sandboxBackend.test.ts apps/api/src/services/workspace/fakeSandboxBackend.ts apps/api/src/services/workspace/vercelSandboxBackend.ts
git commit -m "feat(ai): SandboxBackend interface, SandboxError family and factory (execution plane W02)"
```

---

### Task 3: `fakeSandboxBackend.ts` — in-process temp-dir backend

**Files:**
- Modify (replace the Task 2 stub, 5 lines): `apps/api/src/services/workspace/fakeSandboxBackend.ts`
- Create: `apps/api/src/services/workspace/fakeSandboxBackend.test.ts`

**Interfaces:**
- Consumes: everything exported by `./sandboxBackend` (Task 2).
- Produces:
```ts
export interface FakeSandboxCall {
  method: 'create' | 'exec' | 'writeFiles' | 'readFile' | 'listFiles' | 'destroy' | 'usage';
  providerRef: string;
  /** argv for exec, paths for file ops, empty for create/destroy/usage. */
  detail: string[];
  at: Date;
}
export interface FakeSandboxBackend extends SandboxBackend {
  readonly name: 'fake';
  /** Every call the WorkspaceService made, in order — the assertion surface for W03. */
  readonly calls: readonly FakeSandboxCall[];
  /** Host temp dir for a live handle, so a test can inspect what the sandbox saw. */
  hostRootFor(h: SandboxHandle): string;
  /** Number of sandboxes created and not yet destroyed — leak assertion. */
  liveCount(): number;
  /** Drops every live sandbox and clears the call log. `afterEach` hook. */
  reset(): Promise<void>;
}
export function createFakeSandboxBackend(): FakeSandboxBackend;
```

Design notes that the steps below implement and that a reviewer should check for:

- **One temp dir per handle**, `fs.mkdtemp(path.join(os.tmpdir(), 'breeze-sbx-'))`, with `in/`, `out/` and `tmp/` pre-created so `/work/in` etc. exist exactly as in the real sandbox. `providerRef` is the basename of that dir — an opaque token, no org or run id (same rule as the Vercel `name`).
- **`exec` spawns an argv, never a shell.** `child_process.spawn(cmd[0], cmd.slice(1), { shell: false, … })`. `shell: true` anywhere in this file is the exact bug the whole adapter exists to prevent, and Step 3.1's test asserts a `;`-bearing script line is inert.
- **The environment handed to the child is a fixed allowlist** (`PATH`, `HOME`, `LANG`, `TMPDIR`), never `process.env`. The fake runs inside the API test process, which holds `DATABASE_URL`, `JWT_SECRET` and the rest; inheriting them would make the fake *less* isolated than the thing it stands in for, and a test that passes only because a secret leaked in is worse than no test.
- **Caps are enforced in the fake, not just documented**: `maxStdoutBytes` via `createCappedCollector` on both streams, `timeoutMs` via a `SIGKILL` timer, `maxBytes` on `readFile`, `maxTotalBytes` on `writeFiles`.
- **Path confinement is checked twice**: `assertSandboxPath` statically, then `fs.realpath` on the resolved parent, so a symlink planted inside `/work/out` pointing at `/etc` is refused with `invalid_path` rather than followed. W03's `workspace_collect` depends on this being real in the fake, because the fake is what its unit tests run against.
- **`usage()` is measured, not invented**: `process.hrtime.bigint()` deltas for `wallMs` and `process.resourceUsage()` (`userCPUTime + systemCPUTime`, microseconds) deltas across the handle's lifetime for `cpuMs`. It is a whole-process measurement and therefore an over-estimate under a parallel suite — which is the right direction for a billing input and is stated in the file header rather than glossed.
- **`destroy` is idempotent** and `usage()` keeps working after it (the values are frozen at destroy, exactly as the Vercel adapter freezes them at `stop()`).

- [ ] **Step 3.1 — Write the failing test.**

`apps/api/src/services/workspace/fakeSandboxBackend.test.ts`:
```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeSandboxBackend, type FakeSandboxBackend } from './fakeSandboxBackend';
import type { SandboxCreateSpec, SandboxHandle } from './sandboxBackend';

const SPEC: SandboxCreateSpec = {
  runId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  region: 'eu',
  cpu: 1,
  memoryMb: 2048,
  deadlineSeconds: 60,
  image: 'breeze-analysis@test',
};

describe('fakeSandboxBackend', () => {
  let backend: FakeSandboxBackend;
  let handle: SandboxHandle;

  beforeEach(async () => {
    backend = createFakeSandboxBackend();
    handle = await backend.create(SPEC);
  });

  afterEach(async () => {
    await backend.reset();
  });

  it('creates a private temp dir with the three work dirs and no tenant id in providerRef', async () => {
    const root = backend.hostRootFor(handle);
    expect(root.startsWith(os.tmpdir())).toBe(true);
    expect(handle.backend).toBe('fake');
    expect(handle.region).toBe('eu');
    expect(handle.providerRef).not.toContain(SPEC.orgId);
    expect(handle.providerRef).not.toContain(SPEC.runId);
    for (const dir of ['in', 'out', 'tmp']) {
      const stat = await fs.stat(path.join(root, dir));
      expect(stat.isDirectory()).toBe(true);
    }
    expect(backend.liveCount()).toBe(1);
  });

  it('executes an argv by path — shell metacharacters in the script are inert data', async () => {
    // The script LINE contains `; curl example.com`. If anything anywhere in the
    // stack passed this through a shell, curl would run. It must not.
    await backend.writeFiles(handle, [
      { path: '/work/step-1.sh', bytes: Buffer.from('echo hello ; curl example.com\n') },
    ]);
    const res = await backend.exec(handle, ['/bin/sh', '/work/step-1.sh'], {
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
    });
    // sh RUNS the file, so `curl` is attempted by the script itself — that is the
    // script's own content and is fine. What must never happen is the FILENAME or
    // argv being parsed by a shell. Assert with an argv-only command instead:
    const echoed = await backend.exec(handle, ['/bin/echo', 'a; curl example.com'], {
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
    });
    expect(echoed.exitCode).toBe(0);
    expect(echoed.stdout.toString()).toBe('a; curl example.com\n');
    expect(res.timedOut).toBe(false);
  });

  it('does not leak the parent process environment into the child', async () => {
    process.env.BREEZE_FAKE_SANDBOX_LEAK_CANARY = 'leaked';
    try {
      const res = await backend.exec(
        handle,
        ['/usr/bin/env'],
        { timeoutMs: 10_000, maxStdoutBytes: 65_536 },
      );
      expect(res.stdout.toString()).not.toContain('leaked');
      expect(res.stdout.toString()).not.toContain('BREEZE_FAKE_SANDBOX_LEAK_CANARY');
    } finally {
      delete process.env.BREEZE_FAKE_SANDBOX_LEAK_CANARY;
    }
  });

  it('truncates stdout at maxStdoutBytes and flags it', async () => {
    const res = await backend.exec(
      handle,
      ['/bin/sh', '-c', 'for i in 1 2 3 4 5 6 7 8 9 0; do printf "0123456789"; done'],
      { timeoutMs: 10_000, maxStdoutBytes: 16 },
    );
    expect(res.stdout.length).toBe(16);
    expect(res.stdoutTruncated).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it('kills a runaway step at timeoutMs and reports timedOut', async () => {
    const res = await backend.exec(handle, ['/bin/sh', '-c', 'sleep 30'], {
      timeoutMs: 300,
      maxStdoutBytes: 1024,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(res.durationMs).toBeLessThan(10_000);
  });

  it('roundtrips writeFiles/readFile and refuses a read over maxBytes', async () => {
    await backend.writeFiles(handle, [{ path: '/work/in/a.txt', bytes: Buffer.from('hello') }]);
    expect((await backend.readFile(handle, '/work/in/a.txt', 100)).toString()).toBe('hello');
    await expect(backend.readFile(handle, '/work/in/a.txt', 2)).rejects.toMatchObject({
      code: 'file_too_large',
    });
  });

  it('refuses a writeFiles batch over maxTotalBytes without writing anything', async () => {
    await expect(
      backend.writeFiles(
        handle,
        [
          { path: '/work/in/b.txt', bytes: Buffer.alloc(10, 0x61) },
          { path: '/work/in/c.txt', bytes: Buffer.alloc(10, 0x62) },
        ],
        { maxTotalBytes: 15 },
      ),
    ).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(backend.readFile(handle, '/work/in/b.txt', 100)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses every path outside /work, including via a planted symlink', async () => {
    await expect(backend.readFile(handle, '/etc/passwd', 100)).rejects.toMatchObject({
      code: 'invalid_path',
    });
    const root = backend.hostRootFor(handle);
    await fs.symlink('/etc', path.join(root, 'out', 'escape'));
    await expect(backend.readFile(handle, '/work/out/escape/passwd', 100)).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(
      backend.writeFiles(handle, [{ path: '/work/out/escape/x', bytes: Buffer.from('x') }]),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('lists files with sizes, dir and symlink flags', async () => {
    await backend.writeFiles(handle, [{ path: '/work/out/r.csv', bytes: Buffer.from('a,b\n') }]);
    await fs.mkdir(path.join(backend.hostRootFor(handle), 'out', 'sub'));
    const listed = await backend.listFiles(handle, '/work/out');
    expect(listed).toEqual(
      expect.arrayContaining([
        { path: '/work/out/r.csv', bytes: 4, isDir: false, isSymlink: false },
        { path: '/work/out/sub', bytes: expect.any(Number), isDir: true, isSymlink: false },
      ]),
    );
  });

  it('destroys idempotently, removes the temp dir, and keeps usage readable', async () => {
    await backend.exec(handle, ['/bin/sh', '-c', 'i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done'], {
      timeoutMs: 10_000,
      maxStdoutBytes: 1024,
    });
    const root = backend.hostRootFor(handle);
    await backend.destroy(handle);
    await backend.destroy(handle);
    await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(backend.liveCount()).toBe(0);

    const usage = await backend.usage(handle);
    expect(usage.memAllocatedMb).toBe(2048);
    expect(usage.wallMs).toBeGreaterThan(0);
    expect(usage.cpuMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(usage.cpuMs)).toBe(true);
  });

  it('records every call in order for W03 assertions', async () => {
    await backend.writeFiles(handle, [{ path: '/work/in/x', bytes: Buffer.from('x') }]);
    await backend.exec(handle, ['/bin/true'], { timeoutMs: 1000, maxStdoutBytes: 16 });
    await backend.destroy(handle);
    expect(backend.calls.map((c) => c.method)).toEqual([
      'create',
      'writeFiles',
      'exec',
      'destroy',
    ]);
    expect(backend.calls[2]?.detail).toEqual(['/bin/true']);
  });
});
```

- [ ] **Step 3.2 — Run it; expect the Task 2 stub to throw.**
```bash
cd apps/api && npx vitest run src/services/workspace/fakeSandboxBackend.test.ts
```
Expected: every case fails in `beforeEach` with `fakeSandboxBackend: implemented in Task 3`.

- [ ] **Step 3.3 — Implement the backend.**

Replace `apps/api/src/services/workspace/fakeSandboxBackend.ts` entirely:
```ts
/**
 * In-process SandboxBackend used by every unit test and by local development
 * (`AI_WORKSPACE_BACKEND=fake`, the default outside production).
 *
 * It is a REAL implementation of the contract, not a mock: one OS temp
 * directory per handle, a real `child_process.spawn` per step, and the same
 * caps and path fence the Vercel adapter enforces. `sandboxBackend.contract.
 * test.ts` runs the identical suite against this and against Vercel, so a cap
 * that is only honoured by one of them is a test failure, not a surprise in
 * production.
 *
 * What it is NOT: an isolation boundary. It runs as the API process, with the
 * API process's filesystem and network. Nothing may point `AI_WORKSPACE_BACKEND`
 * at `fake` in production — `resolveSandboxBackendName` refuses an unset value
 * there and `config/validate.ts` (Task 10) refuses `fake` with the workspace
 * flag on.
 *
 * `usage()` is a whole-PROCESS measurement (`process.resourceUsage()` deltas),
 * so under a parallel suite it over-reports CPU. That is deliberate: for a
 * billing input, over-reporting in a test backend is the safe direction, and
 * nothing bills a `fake` run (COMPUTE_PRICING.fake is all zeros, Task 9).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  SANDBOX_ROOT,
  SandboxError,
  assertSandboxPath,
  createCappedCollector,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  type SandboxBackend,
  type SandboxCreateSpec,
  type SandboxHandle,
  type SandboxUsage,
  type WriteFilesOptions,
} from './sandboxBackend';

export interface FakeSandboxCall {
  method: 'create' | 'exec' | 'writeFiles' | 'readFile' | 'listFiles' | 'destroy' | 'usage';
  providerRef: string;
  detail: string[];
  at: Date;
}

export interface FakeSandboxBackend extends SandboxBackend {
  readonly name: 'fake';
  readonly calls: readonly FakeSandboxCall[];
  hostRootFor(h: SandboxHandle): string;
  liveCount(): number;
  reset(): Promise<void>;
}

interface FakeBox {
  root: string;
  region: 'eu' | 'us';
  memAllocatedMb: number;
  startedHrNs: bigint;
  startedCpuUs: number;
  destroyed: boolean;
  frozenUsage: SandboxUsage | null;
}

/** Fixed child environment. NEVER `process.env` — see the file header. */
function childEnv(tmpDir: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: SANDBOX_ROOT,
    LANG: 'C.UTF-8',
    TMPDIR: tmpDir,
  };
}

function processCpuMicros(): number {
  const usage = process.resourceUsage();
  return usage.userCPUTime + usage.systemCPUTime;
}

export function createFakeSandboxBackend(): FakeSandboxBackend {
  const boxes = new Map<string, FakeBox>();
  const calls: FakeSandboxCall[] = [];

  function record(method: FakeSandboxCall['method'], providerRef: string, detail: string[]): void {
    calls.push({ method, providerRef, detail, at: new Date() });
  }

  function boxOf(h: SandboxHandle): FakeBox {
    const box = boxes.get(h.providerRef);
    if (!box) {
      throw new SandboxError('not_found', `no fake sandbox ${h.providerRef}`, { backend: 'fake' });
    }
    return box;
  }

  function liveBoxOf(h: SandboxHandle): FakeBox {
    const box = boxOf(h);
    if (box.destroyed) {
      throw new SandboxError('not_found', `fake sandbox ${h.providerRef} is destroyed`, {
        backend: 'fake',
      });
    }
    return box;
  }

  /**
   * Map a sandbox path to a host path, refusing anything outside the box.
   *
   * Two fences, because either alone is bypassable: `assertSandboxPath` is
   * lexical (catches `..` and absolute escapes), and the realpath check below
   * catches a SYMLINK planted inside /work that points elsewhere. W03's
   * `workspace_collect` reads model-chosen paths, so this is load-bearing.
   */
  async function hostPath(box: FakeBox, sandboxPath: string, cwd?: string): Promise<string> {
    const normalized = assertSandboxPath(sandboxPath, cwd);
    const relative = normalized === SANDBOX_ROOT ? '' : normalized.slice(SANDBOX_ROOT.length + 1);
    const candidate = path.join(box.root, relative);
    const realRoot = await fs.realpath(box.root);
    // Resolve the deepest EXISTING ancestor: the target itself may not exist yet
    // (a write), but every directory on the way to it must stay inside the box.
    let probe = candidate;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
          throw new SandboxError('invalid_path', `path "${sandboxPath}" escapes the sandbox`, {
            backend: 'fake',
          });
        }
        break;
      } catch (err) {
        if (err instanceof SandboxError) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return candidate;
  }

  const backend: FakeSandboxBackend = {
    name: 'fake',
    calls,

    async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'breeze-sbx-'));
      await Promise.all([
        fs.mkdir(path.join(root, 'in'), { recursive: true }),
        fs.mkdir(path.join(root, 'out'), { recursive: true }),
        fs.mkdir(path.join(root, 'tmp'), { recursive: true }),
      ]);
      // Opaque ref, no tenant identifier — the same rule the Vercel `name` and
      // the artifact blob keys follow.
      const providerRef = `fake-${randomUUID()}`;
      boxes.set(providerRef, {
        root,
        region: spec.region,
        memAllocatedMb: spec.memoryMb,
        startedHrNs: process.hrtime.bigint(),
        startedCpuUs: processCpuMicros(),
        destroyed: false,
        frozenUsage: null,
      });
      record('create', providerRef, []);
      return { backend: 'fake', providerRef, region: spec.region, createdAt: new Date() };
    },

    async exec(h: SandboxHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult> {
      const box = liveBoxOf(h);
      record('exec', h.providerRef, [...cmd]);
      if (cmd.length === 0) {
        throw new SandboxError('exec_timeout', 'exec requires a non-empty argv', { backend: 'fake' });
      }
      const cwd = opts.cwd ? await hostPath(box, opts.cwd) : box.root;
      const stdout = createCappedCollector(opts.maxStdoutBytes);
      const stderr = createCappedCollector(opts.maxStdoutBytes);
      const startedAt = Date.now();

      return await new Promise<ExecResult>((resolve, reject) => {
        // shell: false is the whole point of this adapter. Never change it.
        const child = spawn(cmd[0] as string, cmd.slice(1), {
          cwd,
          env: childEnv(path.join(box.root, 'tmp')),
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let timedOut = false;
        const killTimer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        if (opts.stdinBytes) child.stdin?.write(opts.stdinBytes);
        child.stdin?.end();

        child.on('error', (err) => {
          clearTimeout(killTimer);
          reject(new SandboxError('create_failed', `spawn failed: ${err.message}`, {
            backend: 'fake',
            cause: err,
          }));
        });
        child.on('close', (code) => {
          clearTimeout(killTimer);
          resolve({
            exitCode: timedOut ? null : code,
            timedOut,
            stdout: stdout.buffer(),
            stderr: stderr.buffer(),
            durationMs: Date.now() - startedAt,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          });
        });
      });
    },

    async writeFiles(
      h: SandboxHandle,
      files: Array<{ path: string; bytes: Buffer }>,
      opts?: WriteFilesOptions,
    ): Promise<void> {
      const box = liveBoxOf(h);
      record('writeFiles', h.providerRef, files.map((f) => f.path));
      const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
      // Cap FIRST: an over-cap batch must write nothing at all, so the caller
      // never has to reason about a half-staged input set.
      if (opts?.maxTotalBytes !== undefined && total > opts.maxTotalBytes) {
        throw new SandboxError(
          'file_too_large',
          `writeFiles batch is ${total} bytes, over the ${opts.maxTotalBytes}-byte cap`,
          { backend: 'fake' },
        );
      }
      const resolved = await Promise.all(files.map(async (f) => ({
        host: await hostPath(box, f.path),
        bytes: f.bytes,
      })));
      for (const file of resolved) {
        await fs.mkdir(path.dirname(file.host), { recursive: true });
        await fs.writeFile(file.host, file.bytes);
      }
    },

    async readFile(h: SandboxHandle, filePath: string, maxBytes: number): Promise<Buffer> {
      const box = liveBoxOf(h);
      record('readFile', h.providerRef, [filePath]);
      const host = await hostPath(box, filePath);
      let stat;
      try {
        stat = await fs.stat(host);
      } catch {
        throw new SandboxError('not_found', `no such file ${filePath}`, { backend: 'fake' });
      }
      if (stat.size > maxBytes) {
        throw new SandboxError(
          'file_too_large',
          `${filePath} is ${stat.size} bytes, over the ${maxBytes}-byte cap`,
          { backend: 'fake' },
        );
      }
      return await fs.readFile(host);
    },

    async listFiles(h: SandboxHandle, dir: string): Promise<FileStat[]> {
      const box = liveBoxOf(h);
      record('listFiles', h.providerRef, [dir]);
      const normalized = assertSandboxPath(dir);
      const host = await hostPath(box, dir);
      let entries;
      try {
        entries = await fs.readdir(host, { withFileTypes: true });
      } catch {
        throw new SandboxError('not_found', `no such directory ${dir}`, { backend: 'fake' });
      }
      const out: FileStat[] = [];
      for (const entry of entries) {
        const stat = await fs.lstat(path.join(host, entry.name));
        out.push({
          path: `${normalized === SANDBOX_ROOT ? '' : normalized}/${entry.name}`.replace('//', '/'),
          bytes: stat.size,
          isDir: stat.isDirectory(),
          isSymlink: stat.isSymbolicLink(),
        });
      }
      return out;
    },

    async destroy(h: SandboxHandle): Promise<void> {
      const box = boxes.get(h.providerRef);
      record('destroy', h.providerRef, []);
      if (!box || box.destroyed) return; // idempotent
      box.frozenUsage = {
        cpuMs: Math.max(0, (processCpuMicros() - box.startedCpuUs) / 1000),
        wallMs: Number((process.hrtime.bigint() - box.startedHrNs) / 1_000_000n),
        memAllocatedMb: box.memAllocatedMb,
      };
      box.destroyed = true;
      await fs.rm(box.root, { recursive: true, force: true });
    },

    async usage(h: SandboxHandle): Promise<SandboxUsage> {
      const box = boxOf(h);
      record('usage', h.providerRef, []);
      if (box.frozenUsage) return box.frozenUsage;
      return {
        cpuMs: Math.max(0, (processCpuMicros() - box.startedCpuUs) / 1000),
        wallMs: Number((process.hrtime.bigint() - box.startedHrNs) / 1_000_000n),
        memAllocatedMb: box.memAllocatedMb,
      };
    },

    hostRootFor(h: SandboxHandle): string {
      return boxOf(h).root;
    },

    liveCount(): number {
      let live = 0;
      for (const box of boxes.values()) if (!box.destroyed) live += 1;
      return live;
    },

    async reset(): Promise<void> {
      for (const box of boxes.values()) {
        if (!box.destroyed) await fs.rm(box.root, { recursive: true, force: true });
      }
      boxes.clear();
      calls.length = 0;
    },
  };

  return backend;
}
```

- [ ] **Step 3.4 — Run the fake's own suite; expect PASS.**
```bash
cd apps/api && npx vitest run src/services/workspace/fakeSandboxBackend.test.ts
```
Expected: all cases pass. If the symlink case fails on macOS, it is because `os.tmpdir()` is itself a symlink (`/var` → `/private/var`) — the `fs.realpath(box.root)` in `hostPath` is what handles that; do not "fix" it by removing the realpath check.

- [ ] **Step 3.5 — Re-run Task 2's suite; the memoisation case now goes green.**
```bash
cd apps/api && npx vitest run src/services/workspace/sandboxBackend.test.ts
```
Expected: all cases pass.

- [ ] **Step 3.6 — Commit.**
```bash
git add apps/api/src/services/workspace/fakeSandboxBackend.ts apps/api/src/services/workspace/fakeSandboxBackend.test.ts
git commit -m "feat(ai): in-process fake sandbox backend with real caps and path fence (execution plane W02)"
```

---

### Task 4: `vercelSandboxBackend.ts` — the v1 production adapter

**Files:**
- Modify (replace the Task 2 stub, 5 lines): `apps/api/src/services/workspace/vercelSandboxBackend.ts`
- Create: `apps/api/src/services/workspace/vercelSandboxBackend.test.ts`
- Modify: `apps/api/package.json` (`dependencies`, alphabetical — the `@vercel/*` scope sorts with the other `@`-scoped deps)

**Interfaces:**
- Consumes: `./sandboxBackend` (Task 2); `@vercel/sandbox` `{ Sandbox, APIError }`.
- Produces:
```ts
export function createVercelSandboxBackend(): SandboxBackend;   // name: 'vercel'
export function resolveVercelRegion(region: SandboxRegion, env?: NodeJS.ProcessEnv): string;
export function readVercelCredentials(env?: NodeJS.ProcessEnv): { token: string; teamId: string; projectId: string };
export const VERCEL_SANDBOX_IMAGE = 'vercel/sandbox/universal';
export const VERCEL_DEFAULT_REGION_EU = 'fra1';
export const VERCEL_DEFAULT_REGION_US = 'iad1';
export function __setVercelSdkForTests(sdk: { Sandbox: unknown; APIError: unknown } | null): void;
```

- [ ] **Step 4.1 — Add the dependency and re-verify the pinned surface against what actually installed.**
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
pnpm --filter @breeze/api add @vercel/sandbox@3.3.0
grep -n '"@vercel/sandbox"' apps/api/package.json
grep -c 'timeoutMs' node_modules/.pnpm/@vercel+sandbox@3.3.0/node_modules/@vercel/sandbox/dist/session.d.ts
grep -n 'deleteOrphanSnapshots\|activeCpuUsageMs\|persistent?:\|networkPolicy?:' node_modules/.pnpm/@vercel+sandbox@3.3.0/node_modules/@vercel/sandbox/dist/sandbox.d.ts
```
Expected: the dependency pins `3.3.0` exactly (no `^`); `timeoutMs` appears in `session.d.ts`; all four names appear in `sandbox.d.ts`. **If any name is missing, a different version installed** — fix the pin, then correct the "Pinned `@vercel/sandbox@3.3.0` surface" table at the top of this plan in the same commit rather than writing code against a table that no longer describes reality. Also re-read `https://vercel.com/docs/sandbox/sdk-reference` and `https://vercel.com/docs/sandbox/concepts/firewall` and note any drift in the table's provenance paragraph.

Also confirm the dependency cost is understood before committing it: `@vercel/sandbox` ships in the API image for every deployment, hosted or self-hosted, even though the feature is hosted-only and flag-off. That is accepted (it is a small pure-TS client), but the adapter must never be imported at module scope from anything that boots unconditionally — `sandboxBackend.ts` imports it statically and is itself only imported by `workspace/**` and the reaper, which is the containment.

- [ ] **Step 4.2 — Write the failing unit test.**

This suite drives the adapter against an injected fake SDK, so it runs on every PR with no credentials. The *real* SDK is exercised by the contract suite (Task 5, opt-in) and the nightly (Task 6).

`apps/api/src/services/workspace/vercelSandboxBackend.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __setVercelSdkForTests,
  createVercelSandboxBackend,
  readVercelCredentials,
  resolveVercelRegion,
} from './vercelSandboxBackend';
import type { SandboxCreateSpec } from './sandboxBackend';

const SPEC: SandboxCreateSpec = {
  runId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  region: 'eu',
  cpu: 1,
  memoryMb: 2048,
  deadlineSeconds: 90,
  image: 'breeze-analysis@test',
};

class FakeAPIError extends Error {
  constructor(public response: { status: number }) {
    super(`api error ${response.status}`);
  }
}

function makeFakeSandbox(overrides: Record<string, unknown> = {}) {
  return {
    name: 'breeze-eu-abc',
    region: 'fra1',
    persistent: false,
    memory: 2048,
    vcpus: 1,
    activeCpuUsageMs: undefined,
    totalActiveCpuDurationMs: undefined,
    totalDurationMs: undefined,
    runCommand: vi.fn(async () => ({ exitCode: 0, durationMs: 12 })),
    writeFiles: vi.fn(async () => undefined),
    readFileToBuffer: vi.fn(async () => Buffer.from('hi')),
    mkDir: vi.fn(async () => undefined),
    fs: {
      mkdir: vi.fn(async () => undefined),
      readdir: vi.fn(async () => []),
      lstat: vi.fn(async () => ({ size: 0, isDirectory: () => false, isSymbolicLink: () => false })),
    },
    stop: vi.fn(async () => ({ activeCpuDurationMs: 400, duration: 5_000, memory: 2048, vcpus: 1 })),
    delete: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('resolveVercelRegion', () => {
  it.each([
    [{}, 'eu', 'fra1'],
    [{}, 'us', 'iad1'],
    [{ VERCEL_SANDBOX_REGION_EU: 'arn1' }, 'eu', 'arn1'],
    [{ VERCEL_SANDBOX_REGION_US: 'sfo1' }, 'us', 'sfo1'],
  ])('%o + %s → %s', (env, region, expected) => {
    expect(resolveVercelRegion(region as 'eu' | 'us', env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it('refuses lhr1 for the EU region — the UK is not the EU (spike H.1)', () => {
    expect(() =>
      resolveVercelRegion('eu', { VERCEL_SANDBOX_REGION_EU: 'lhr1' } as NodeJS.ProcessEnv),
    ).toThrowError(/lhr1/);
  });
});

describe('readVercelCredentials', () => {
  it('requires all three and never falls back to ambient SDK env', () => {
    expect(() =>
      readVercelCredentials({ VERCEL_SANDBOX_TOKEN: 't' } as NodeJS.ProcessEnv),
    ).toThrowError(/VERCEL_TEAM_ID/);
    expect(
      readVercelCredentials({
        VERCEL_SANDBOX_TOKEN: 't',
        VERCEL_TEAM_ID: 'team_x',
        VERCEL_PROJECT_ID: 'prj_x',
      } as NodeJS.ProcessEnv),
    ).toEqual({ token: 't', teamId: 'team_x', projectId: 'prj_x' });
  });
});

describe('vercelSandboxBackend', () => {
  let Sandbox: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let sandbox: ReturnType<typeof makeFakeSandbox>;

  beforeEach(() => {
    process.env.VERCEL_SANDBOX_TOKEN = 'tok';
    process.env.VERCEL_TEAM_ID = 'team_x';
    process.env.VERCEL_PROJECT_ID = 'prj_x';
    sandbox = makeFakeSandbox();
    Sandbox = { create: vi.fn(async () => sandbox), get: vi.fn(async () => sandbox) };
    __setVercelSdkForTests({ Sandbox, APIError: FakeAPIError });
  });

  afterEach(() => {
    __setVercelSdkForTests(null);
    delete process.env.VERCEL_SANDBOX_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
  });

  it('creates deny-all, non-persistent, region-pinned, deadline-bounded, untagged', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);

    expect(Sandbox.create).toHaveBeenCalledTimes(1);
    const params = Sandbox.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.networkPolicy).toBe('deny-all');
    expect(params.persistent).toBe(false);
    expect(params.region).toBe('fra1');
    expect(params.timeout).toBe(90_000);
    expect(params.resources).toEqual({ vcpus: 1 });
    expect(params.image).toBe('vercel/sandbox/universal');
    expect(params.token).toBe('tok');
    expect(params.teamId).toBe('team_x');
    expect(params.projectId).toBe('prj_x');
    // No tenant identifier may reach vendor-side metadata.
    expect(params.tags).toBeUndefined();
    expect(String(params.name)).not.toContain(SPEC.orgId);
    expect(String(params.name)).not.toContain(SPEC.runId);

    expect(handle).toMatchObject({ backend: 'vercel', providerRef: 'breeze-eu-abc', region: 'eu' });
  });

  it('destroys and fails create when the vendor landed in the wrong region', async () => {
    sandbox = makeFakeSandbox({ region: 'iad1' });
    Sandbox.create.mockResolvedValue(sandbox);
    const backend = createVercelSandboxBackend();
    await expect(backend.create(SPEC)).rejects.toMatchObject({ code: 'create_failed' });
    expect(sandbox.delete).toHaveBeenCalled();
  });

  it('maps 402/429 to quota and 404 to not_found', async () => {
    const backend = createVercelSandboxBackend();
    Sandbox.create.mockRejectedValueOnce(new FakeAPIError({ status: 429 }));
    await expect(backend.create(SPEC)).rejects.toMatchObject({ code: 'quota' });
    Sandbox.create.mockRejectedValueOnce(new FakeAPIError({ status: 404 }));
    await expect(backend.create(SPEC)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('execs an argv with timeoutMs and capped stream sinks — never a shell string', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.exec(handle, ['python3', '/work/step-1.py'], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      cwd: '/work',
    });
    const params = sandbox.runCommand.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.cmd).toBe('python3');
    expect(params.args).toEqual(['/work/step-1.py']);
    expect(params.cwd).toBe('/work');
    expect(params.timeoutMs).toBe(5_000);
    expect(params.stdout).toBeDefined();
    expect(params.stderr).toBeDefined();
    expect(params.sudo).toBeUndefined();
  });

  it('routes stdinBytes through a constant sh -c redirector with model data only in argv', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.exec(handle, ['python3', '/work/step-1.py'], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
      stdinBytes: Buffer.from('row1\nrow2\n'),
    });
    // The bytes are staged as a file first…
    const written = sandbox.writeFiles.mock.calls[0]?.[0] as Array<{ path: string }>;
    expect(written[0]?.path).toMatch(/^\/work\/tmp\/stdin-[0-9a-f-]+$/);
    // …then the command runs under ONE compile-time-constant shell program,
    // with every model-derived value as a positional argument.
    const params = sandbox.runCommand.mock.calls[0]?.[0] as { cmd: string; args: string[] };
    expect(params.cmd).toBe('sh');
    expect(params.args[0]).toBe('-c');
    expect(params.args[1]).toBe('exec "$1" "$2" < "$3"');
    expect(params.args.slice(2, 4)).toEqual(['sh', 'python3']);
    expect(params.args[4]).toBe('/work/step-1.py');
    expect(params.args[5]).toMatch(/^\/work\/tmp\/stdin-/);
  });

  it('reports timedOut when the sandbox SIGKILLs the step', async () => {
    sandbox.runCommand.mockResolvedValue({ exitCode: 137, durationMs: 5_010 });
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    const res = await backend.exec(handle, ['sleep', '30'], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1024,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });

  it('refuses a path outside /work before any SDK call', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await expect(backend.readFile(handle, '/etc/passwd', 10)).rejects.toMatchObject({
      code: 'invalid_path',
    });
    expect(sandbox.readFileToBuffer).not.toHaveBeenCalled();
  });

  it('treats a null readFileToBuffer as not_found and an over-cap read as file_too_large', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    sandbox.readFileToBuffer.mockResolvedValueOnce(null);
    await expect(backend.readFile(handle, '/work/out/x', 10)).rejects.toMatchObject({
      code: 'not_found',
    });
    sandbox.readFileToBuffer.mockResolvedValueOnce(Buffer.alloc(100));
    await expect(backend.readFile(handle, '/work/out/x', 10)).rejects.toMatchObject({
      code: 'file_too_large',
    });
  });

  it('destroys with deleteOrphanSnapshots, is idempotent, and freezes usage from stop()', async () => {
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.destroy(handle);
    await backend.destroy(handle);
    expect(sandbox.stop).toHaveBeenCalledTimes(1);
    expect(sandbox.delete).toHaveBeenCalledTimes(1);
    expect(sandbox.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: true });
    await expect(backend.usage(handle)).resolves.toEqual({
      cpuMs: 400,
      wallMs: 5_000,
      memAllocatedMb: 2048,
    });
  });

  it('falls back to the instance getters when stop() reports no usage', async () => {
    sandbox.stop.mockResolvedValue({});
    sandbox.activeCpuUsageMs = 250;
    sandbox.totalDurationMs = 9_000;
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.destroy(handle);
    await expect(backend.usage(handle)).resolves.toEqual({
      cpuMs: 250,
      wallMs: 9_000,
      memAllocatedMb: 2048,
    });
  });

  it('throws usage_unavailable rather than reporting a free run', async () => {
    sandbox.stop.mockResolvedValue({});
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await backend.destroy(handle);
    await expect(backend.usage(handle)).rejects.toMatchObject({ code: 'usage_unavailable' });
  });

  it('swallows a 404 during destroy — the sandbox is already gone', async () => {
    sandbox.delete.mockRejectedValue(new FakeAPIError({ status: 404 }));
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await expect(backend.destroy(handle)).resolves.toBeUndefined();
  });

  it('surfaces a non-404 destroy failure as destroy_failed so the reaper can page', async () => {
    sandbox.delete.mockRejectedValue(new FakeAPIError({ status: 500 }));
    const backend = createVercelSandboxBackend();
    const handle = await backend.create(SPEC);
    await expect(backend.destroy(handle)).rejects.toMatchObject({ code: 'destroy_failed' });
  });

  it('reacquires a sandbox by name (resume:false) when the handle is from another process', async () => {
    const backend = createVercelSandboxBackend();
    await backend.destroy({
      backend: 'vercel',
      providerRef: 'breeze-eu-orphan',
      region: 'eu',
      createdAt: new Date(),
    });
    expect(Sandbox.get).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'breeze-eu-orphan', resume: false }),
    );
  });
});
```

- [ ] **Step 4.3 — Run it; expect the Task 2 stub to throw.**
```bash
cd apps/api && npx vitest run src/services/workspace/vercelSandboxBackend.test.ts
```
Expected: the `resolveVercelRegion` / `readVercelCredentials` describes fail on missing exports, and every `vercelSandboxBackend` case fails with `vercelSandboxBackend: implemented in Task 4`.

- [ ] **Step 4.4 — Implement the module.**

Replace `apps/api/src/services/workspace/vercelSandboxBackend.ts` entirely:
```ts
/**
 * Vercel Sandbox implementation of SandboxBackend (spec §5.1, v1).
 *
 * PINNED SDK SURFACE — @vercel/sandbox 3.3.0, read from the shipped dist/*.d.ts
 * on 2026-09-13 and cross-checked against
 *   https://vercel.com/docs/sandbox/sdk-reference
 *   https://vercel.com/docs/sandbox/concepts/firewall
 * The plan doc (docs/superpowers/plans/ai-mcp/2026-09-13-execution-plane-w02-
 * sandbox-adapter.md) carries the full table; the load-bearing names are:
 *
 *   create   Sandbox.create({ name, region, networkPolicy: 'deny-all',
 *                             persistent: false, timeout: <ms>,
 *                             resources: { vcpus }, image,
 *                             token, teamId, projectId })
 *   run      sandbox.runCommand({ cmd, args, cwd, timeoutMs, stdout, stderr })
 *            -> CommandFinished { exitCode: number; durationMs?: number }
 *            NO stdin field exists — see execWithStdin below.
 *   files    sandbox.writeFiles([{ path, content, mode? }])   (no mkdir -p)
 *            sandbox.fs.mkdir(path, { recursive: true })
 *            sandbox.readFileToBuffer({ path }) -> Buffer | null  (null = absent)
 *            sandbox.fs.readdir(path, { withFileTypes: true }) / fs.lstat
 *   stop     sandbox.stop() -> { activeCpuDurationMs?, duration?, memory?, vcpus? }
 *            getters (populated only after stop): sandbox.activeCpuUsageMs,
 *            sandbox.totalActiveCpuDurationMs, sandbox.totalDurationMs
 *   destroy  sandbox.delete({ deleteOrphanSnapshots: true })
 *   reacquire Sandbox.get({ name, resume: false, ...credentials })
 *   errors   APIError { response: Response }  (402/429 -> quota, 404 -> not_found)
 *
 * SECURITY INVARIANTS, each of which a test asserts:
 *  - networkPolicy 'deny-all' blocks ALL egress INCLUDING DNS (firewall docs).
 *    v1 never uses an allowlist policy; the nightly suite proves egress is dead.
 *  - persistent: false is passed EXPLICITLY (the .d.ts states no default), and
 *    destroy passes deleteOrphanSnapshots so no filesystem image outlives a run.
 *  - `cmd` is always an interpreter and `args` always file paths. The ONE shell
 *    invocation in this file is a compile-time-constant program string used to
 *    redirect stdin, with every model-derived value passed positionally.
 *  - The sandbox `name` and `tags` are vendor-side metadata whose retention we
 *    do not control, so neither may carry an org id, a run id, or any other
 *    tenant identifier — the same rule as the artifact blob keys. `name` is
 *    `breeze-<region>-<uuid>`; `tags` is not sent at all.
 *  - No env is passed to create or to any command: the sandbox holds no
 *    credentials (spec §8).
 */
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import * as vercelSdk from '@vercel/sandbox';

import {
  SANDBOX_ROOT,
  SandboxError,
  assertSandboxPath,
  createCappedCollector,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  type SandboxBackend,
  type SandboxCreateSpec,
  type SandboxHandle,
  type SandboxRegion,
  type SandboxUsage,
  type WriteFilesOptions,
} from './sandboxBackend';

export const VERCEL_SANDBOX_IMAGE = 'vercel/sandbox/universal';
export const VERCEL_DEFAULT_REGION_EU = 'fra1';
export const VERCEL_DEFAULT_REGION_US = 'iad1';

/**
 * Regions that must NEVER serve a Breeze "eu" workspace. `lhr1` is London:
 * post-Brexit the UK is a third country for GDPR transfer purposes, so a
 * customer told "your analysis runs in the EU" would be told something false
 * (spike §H.1). Refuse loudly at config-read time rather than silently.
 */
const NON_EU_REGIONS = new Set(['lhr1', 'iad1', 'sfo1', 'cle1', 'pdx1', 'yul1', 'gru1',
  'sin1', 'hkg1', 'syd1', 'hnd1', 'kix1', 'icn1', 'bom1', 'cpt1']);

type SdkShape = { Sandbox: unknown; APIError: unknown };
let sdkOverride: SdkShape | null = null;

/** Test seam: the real SDK opens sockets; unit tests inject a double. */
export function __setVercelSdkForTests(sdk: SdkShape | null): void {
  sdkOverride = sdk;
}

function sdk(): SdkShape {
  return sdkOverride ?? (vercelSdk as unknown as SdkShape);
}

export function resolveVercelRegion(
  region: SandboxRegion,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = (
    region === 'eu' ? env.VERCEL_SANDBOX_REGION_EU : env.VERCEL_SANDBOX_REGION_US
  )?.trim();
  const resolved = configured || (region === 'eu' ? VERCEL_DEFAULT_REGION_EU : VERCEL_DEFAULT_REGION_US);
  if (region === 'eu' && NON_EU_REGIONS.has(resolved)) {
    throw new SandboxError(
      'create_failed',
      `VERCEL_SANDBOX_REGION_EU="${resolved}" is not an EU region — an "eu" workspace must run in the EU (fra1, arn1, cdg1, dub1). lhr1 is the UK.`,
      { backend: 'vercel' },
    );
  }
  return resolved;
}

export function readVercelCredentials(env: NodeJS.ProcessEnv = process.env): {
  token: string;
  teamId: string;
  projectId: string;
} {
  const token = env.VERCEL_SANDBOX_TOKEN?.trim() ?? '';
  const teamId = env.VERCEL_TEAM_ID?.trim() ?? '';
  const projectId = env.VERCEL_PROJECT_ID?.trim() ?? '';
  const missing = [
    token ? null : 'VERCEL_SANDBOX_TOKEN',
    teamId ? null : 'VERCEL_TEAM_ID',
    projectId ? null : 'VERCEL_PROJECT_ID',
  ].filter((v): v is string => v !== null);
  if (missing.length > 0) {
    // Never fall through to the SDK's ambient-env credential discovery: a
    // half-configured deploy would then silently use whatever token the host
    // happened to carry, against whatever project that token can reach.
    throw new SandboxError('create_failed', `Missing Vercel sandbox config: ${missing.join(', ')}`, {
      backend: 'vercel',
    });
  }
  return { token, teamId, projectId };
}

function statusOf(err: unknown): number | null {
  const APIErrorCtor = sdk().APIError as (new (...args: never[]) => Error) | undefined;
  if (APIErrorCtor && err instanceof APIErrorCtor) {
    const status = (err as unknown as { response?: { status?: number } }).response?.status;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

function mapError(err: unknown, fallback: 'create_failed' | 'destroy_failed' | 'not_found'): SandboxError {
  if (err instanceof SandboxError) return err;
  const status = statusOf(err);
  if (status === 402 || status === 429) {
    return new SandboxError('quota', 'Vercel sandbox quota exhausted', { backend: 'vercel', cause: err });
  }
  if (status === 404) {
    return new SandboxError('not_found', 'Vercel sandbox not found', { backend: 'vercel', cause: err });
  }
  return new SandboxError(fallback, `Vercel sandbox ${fallback}: ${String(err)}`, {
    backend: 'vercel',
    cause: err,
  });
}

function cappedSink(cap: number) {
  const collector = createCappedCollector(cap);
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      collector.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      cb();
    },
  });
  return { collector, stream };
}

interface LiveBox {
  sandbox: Record<string, unknown>;
  memAllocatedMb: number;
  usage: SandboxUsage | null;
  usageUnavailable: boolean;
  destroyed: boolean;
}

export function createVercelSandboxBackend(): SandboxBackend {
  const boxes = new Map<string, LiveBox>();

  type AnySandbox = {
    name: string;
    region: string;
    memory?: number;
    activeCpuUsageMs?: number;
    totalActiveCpuDurationMs?: number;
    totalDurationMs?: number;
    runCommand(params: Record<string, unknown>): Promise<{ exitCode: number | null; durationMs?: number }>;
    writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<void>;
    readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
    fs: {
      mkdir(p: string, o: { recursive: boolean }): Promise<unknown>;
      readdir(p: string, o: { withFileTypes: true }): Promise<Array<{ name: string }>>;
      lstat(p: string): Promise<{ size: number; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    };
    stop(): Promise<Record<string, unknown>>;
    delete(opts: { deleteOrphanSnapshots: boolean }): Promise<void>;
  };

  /**
   * Get the SDK object for a handle. A handle created in THIS process is in
   * `boxes`; a handle the reaper loaded from `ai_run_workspaces` (written by a
   * worker that has since died) is not, so it is reacquired by name with
   * `resume: false` — the reaper wants to delete the sandbox, never to wake it.
   */
  async function acquire(h: SandboxHandle): Promise<AnySandbox> {
    const known = boxes.get(h.providerRef);
    if (known) return known.sandbox as unknown as AnySandbox;
    const SandboxCtor = sdk().Sandbox as {
      get(p: Record<string, unknown>): Promise<AnySandbox>;
    };
    try {
      return await SandboxCtor.get({ name: h.providerRef, resume: false, ...readVercelCredentials() });
    } catch (err) {
      throw mapError(err, 'not_found');
    }
  }

  return {
    name: 'vercel',

    async create(spec: SandboxCreateSpec): Promise<SandboxHandle> {
      const region = resolveVercelRegion(spec.region);
      const credentials = readVercelCredentials();
      const SandboxCtor = sdk().Sandbox as { create(p: Record<string, unknown>): Promise<AnySandbox> };
      let sandbox: AnySandbox;
      try {
        sandbox = await SandboxCtor.create({
          // Opaque: no org id, no run id. See the header's naming invariant.
          name: `breeze-${spec.region}-${randomUUID()}`,
          region,
          networkPolicy: 'deny-all',
          persistent: false,
          timeout: spec.deadlineSeconds * 1000,
          resources: { vcpus: spec.cpu },
          image: VERCEL_SANDBOX_IMAGE,
          ...credentials,
        });
      } catch (err) {
        throw mapError(err, 'create_failed');
      }

      // Residency assertion (spec §8). A sandbox that landed elsewhere is not
      // usable for a customer we told "your analysis runs in <region>", so it
      // is destroyed rather than used. Best-effort delete: the create already
      // failed, and a failed cleanup must not mask that.
      if (sandbox.region !== region) {
        try {
          await sandbox.delete({ deleteOrphanSnapshots: true });
        } catch {
          /* reported by the region error below; the reaper has no row to find. */
        }
        throw new SandboxError(
          'create_failed',
          `Vercel placed the sandbox in "${sandbox.region}" but "${region}" was requested`,
          { backend: 'vercel' },
        );
      }

      boxes.set(sandbox.name, {
        sandbox: sandbox as unknown as Record<string, unknown>,
        memAllocatedMb: sandbox.memory ?? spec.memoryMb,
        usage: null,
        usageUnavailable: false,
        destroyed: false,
      });

      // /work is not part of the managed image; create it up front so every
      // later path assertion describes something that exists.
      await sandbox.fs.mkdir(`${SANDBOX_ROOT}/in`, { recursive: true });
      await sandbox.fs.mkdir(`${SANDBOX_ROOT}/out`, { recursive: true });
      await sandbox.fs.mkdir(`${SANDBOX_ROOT}/tmp`, { recursive: true });

      return {
        backend: 'vercel',
        providerRef: sandbox.name,
        region: spec.region,
        createdAt: new Date(),
      };
    },

    async exec(h: SandboxHandle, cmd: string[], opts: ExecOptions): Promise<ExecResult> {
      if (cmd.length === 0) {
        throw new SandboxError('create_failed', 'exec requires a non-empty argv', { backend: 'vercel' });
      }
      const sandbox = await acquire(h);
      const cwd = opts.cwd ? assertSandboxPath(opts.cwd) : SANDBOX_ROOT;
      const stdout = cappedSink(opts.maxStdoutBytes);
      const stderr = cappedSink(opts.maxStdoutBytes);

      // RunCommandParams has no stdin field (pinned surface). Stage the bytes as
      // a file and redirect. The shell PROGRAM is a compile-time constant; every
      // model-derived value (interpreter, script path, stdin path) is a
      // positional argument, so nothing the model wrote is ever parsed as shell
      // syntax. `exec` replaces the shell so no extra process lingers.
      let params: Record<string, unknown>;
      if (opts.stdinBytes) {
        const stdinPath = `${SANDBOX_ROOT}/tmp/stdin-${randomUUID()}`;
        try {
          await sandbox.writeFiles([{ path: stdinPath, content: opts.stdinBytes }]);
        } catch (err) {
          throw mapError(err, 'create_failed');
        }
        if (cmd.length !== 2) {
          throw new SandboxError(
            'create_failed',
            'stdin redirection supports exactly [interpreter, scriptPath]',
            { backend: 'vercel' },
          );
        }
        params = {
          cmd: 'sh',
          args: ['-c', 'exec "$1" "$2" < "$3"', 'sh', cmd[0], cmd[1], stdinPath],
          cwd,
          timeoutMs: opts.timeoutMs,
          stdout: stdout.stream,
          stderr: stderr.stream,
        };
      } else {
        params = {
          cmd: cmd[0],
          args: cmd.slice(1),
          cwd,
          timeoutMs: opts.timeoutMs,
          stdout: stdout.stream,
          stderr: stderr.stream,
        };
      }

      const startedAt = Date.now();
      let finished: { exitCode: number | null; durationMs?: number };
      try {
        finished = await sandbox.runCommand(params);
      } catch (err) {
        throw mapError(err, 'create_failed');
      }
      const durationMs = finished.durationMs ?? Date.now() - startedAt;
      // The sandbox enforces timeoutMs with SIGKILL, which surfaces as 137
      // (128 + SIGKILL). Corroborate with elapsed time so an ordinary `exit 137`
      // is not mislabelled as a timeout.
      const timedOut = finished.exitCode === 137 && durationMs >= opts.timeoutMs;

      return {
        exitCode: timedOut ? null : finished.exitCode,
        timedOut,
        stdout: stdout.collector.buffer(),
        stderr: stderr.collector.buffer(),
        durationMs,
        stdoutTruncated: stdout.collector.truncated,
        stderrTruncated: stderr.collector.truncated,
      };
    },

    async writeFiles(
      h: SandboxHandle,
      files: Array<{ path: string; bytes: Buffer }>,
      opts?: WriteFilesOptions,
    ): Promise<void> {
      const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
      if (opts?.maxTotalBytes !== undefined && total > opts.maxTotalBytes) {
        throw new SandboxError(
          'file_too_large',
          `writeFiles batch is ${total} bytes, over the ${opts.maxTotalBytes}-byte cap`,
          { backend: 'vercel' },
        );
      }
      const normalized = files.map((f) => ({ path: assertSandboxPath(f.path), content: f.bytes }));
      const sandbox = await acquire(h);
      // writeFiles does not create parents (pinned surface).
      const dirs = new Set(normalized.map((f) => f.path.slice(0, f.path.lastIndexOf('/')) || SANDBOX_ROOT));
      try {
        for (const dir of dirs) await sandbox.fs.mkdir(dir, { recursive: true });
        await sandbox.writeFiles(normalized);
      } catch (err) {
        throw mapError(err, 'create_failed');
      }
    },

    async readFile(h: SandboxHandle, filePath: string, maxBytes: number): Promise<Buffer> {
      const normalized = assertSandboxPath(filePath);
      const sandbox = await acquire(h);
      let buffer: Buffer | null;
      try {
        buffer = await sandbox.readFileToBuffer({ path: normalized });
      } catch (err) {
        throw mapError(err, 'not_found');
      }
      if (buffer === null) {
        throw new SandboxError('not_found', `no such file ${filePath}`, { backend: 'vercel' });
      }
      // The SDK has no server-side byte cap, so this is enforced AFTER transfer.
      // W03 must therefore lstat and refuse before calling readFile for anything
      // it expects to be large — this check is the backstop, not the budget.
      if (buffer.length > maxBytes) {
        throw new SandboxError(
          'file_too_large',
          `${filePath} is ${buffer.length} bytes, over the ${maxBytes}-byte cap`,
          { backend: 'vercel' },
        );
      }
      return buffer;
    },

    async listFiles(h: SandboxHandle, dir: string): Promise<FileStat[]> {
      const normalized = assertSandboxPath(dir);
      const sandbox = await acquire(h);
      try {
        const entries = await sandbox.fs.readdir(normalized, { withFileTypes: true });
        const out: FileStat[] = [];
        for (const entry of entries) {
          const childPath = `${normalized === SANDBOX_ROOT ? '' : normalized}/${entry.name}`.replace('//', '/');
          const stat = await sandbox.fs.lstat(childPath);
          out.push({
            path: childPath,
            bytes: stat.size,
            isDir: stat.isDirectory(),
            isSymlink: stat.isSymbolicLink(),
          });
        }
        return out;
      } catch (err) {
        throw mapError(err, 'not_found');
      }
    },

    async destroy(h: SandboxHandle): Promise<void> {
      const known = boxes.get(h.providerRef);
      if (known?.destroyed) return; // idempotent
      const sandbox = await acquire(h);

      // stop() is where usage comes from; it must run BEFORE delete(), after
      // which "the instance becomes inert — all further API calls will throw".
      let stopped: Record<string, unknown> = {};
      try {
        stopped = (await sandbox.stop()) ?? {};
      } catch (err) {
        // A sandbox already stopped by its own deadline throws here. That is
        // the "provider deadline fires" row of spec §9: not an error, but the
        // usage is gone, so mark it and fall through to the delete.
        if (statusOf(err) !== 404) {
          if (known) known.usageUnavailable = true;
        }
      }

      const cpuMs = numberOr(stopped.activeCpuDurationMs, sandbox.activeCpuUsageMs, sandbox.totalActiveCpuDurationMs);
      const wallMs = numberOr(stopped.duration, sandbox.totalDurationMs);
      const memAllocatedMb = numberOr(stopped.memory, sandbox.memory) ?? known?.memAllocatedMb ?? 2048;

      if (known) {
        if (cpuMs === null || wallMs === null) {
          known.usageUnavailable = true;
        } else {
          known.usage = { cpuMs, wallMs, memAllocatedMb };
        }
      }

      try {
        await sandbox.delete({ deleteOrphanSnapshots: true });
      } catch (err) {
        // Already gone is success — destroy is idempotent by contract, and the
        // reaper calls it on rows whose sandbox may have expired hours ago.
        if (statusOf(err) !== 404) {
          throw mapError(err, 'destroy_failed');
        }
      }
      if (known) known.destroyed = true;
    },

    async usage(h: SandboxHandle): Promise<SandboxUsage> {
      const known = boxes.get(h.providerRef);
      if (known?.usage) return known.usage;
      // Never invent a number and never return zeros: spec §9 settles an
      // unavailable-usage run at the RESERVATION, which requires the caller to
      // learn that usage is missing rather than be handed a free run.
      throw new SandboxError(
        'usage_unavailable',
        `no usage recorded for ${h.providerRef} (was destroy() called?)`,
        { backend: 'vercel' },
      );
    },
  };
}

function numberOr(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}
```

- [ ] **Step 4.5 — Run the unit suite; expect PASS.**
```bash
cd apps/api && npx vitest run src/services/workspace/vercelSandboxBackend.test.ts
```
Expected: all cases pass.

- [ ] **Step 4.6 — Typecheck the three new modules together.**
```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'services/workspace' || echo 'workspace: clean'
```
Expected: `workspace: clean`. (A `db/schema/aiWorkspace` resolution error here means Step 7.1 has not been run yet — do it now.)

- [ ] **Step 4.7 — Commit.**
```bash
git add apps/api/src/services/workspace/vercelSandboxBackend.ts apps/api/src/services/workspace/vercelSandboxBackend.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(ai): Vercel sandbox backend — deny-all, non-persistent, region-pinned (execution plane W02)"
```

---

### Task 5: `sandboxBackend.contract.test.ts` — one suite, every backend

**Files:**
- Create: `apps/api/src/services/workspace/sandboxBackend.contract.test.ts`

**Interfaces:**
- Consumes: `createFakeSandboxBackend` (Task 3), `createVercelSandboxBackend` (Task 4), the `SandboxBackend` contract (Task 2).
- Produces: nothing exported — this is spec §12's `sandboxBackend.contract.test.ts`.

The shape (spec §12: "every backend passes the same suite"): a `describe.each` over the backends available in this environment. `fake` is always present, so the suite has teeth on every PR. `vercel` joins **only** when `VERCEL_SANDBOX_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` are all set, which they are not on PR CI — a developer or the nightly job opts in. The suite must never *silently* run zero backends, so it asserts at least one is registered.

- [ ] **Step 5.1 — Write the suite (it is the test; there is no separate "make it fail" edit).**

`apps/api/src/services/workspace/sandboxBackend.contract.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeSandboxBackend } from './fakeSandboxBackend';
import { createVercelSandboxBackend } from './vercelSandboxBackend';
import type { SandboxBackend, SandboxCreateSpec, SandboxHandle } from './sandboxBackend';

const VERCEL_CONFIGURED = Boolean(
  process.env.VERCEL_SANDBOX_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID,
);

interface Candidate {
  label: string;
  make: () => SandboxBackend;
  /** The interpreter guaranteed to exist in that backend's image. */
  sh: string;
  timeoutMs: number;
}

const CANDIDATES: Candidate[] = [
  { label: 'fake', make: createFakeSandboxBackend, sh: '/bin/sh', timeoutMs: 15_000 },
  ...(VERCEL_CONFIGURED
    ? [{ label: 'vercel', make: createVercelSandboxBackend, sh: 'sh', timeoutMs: 60_000 } as Candidate]
    : []),
];

// A suite that quietly registers nothing is a suite that can never go red.
it('registers at least the fake backend', () => {
  expect(CANDIDATES.map((c) => c.label)).toContain('fake');
});

describe.each(CANDIDATES)('SandboxBackend contract [$label]', (candidate) => {
  const spec: SandboxCreateSpec = {
    runId: '33333333-3333-4333-8333-333333333333',
    orgId: '44444444-4444-4444-8444-444444444444',
    region: 'eu',
    cpu: 1,
    memoryMb: 2048,
    deadlineSeconds: 300,
    image: 'breeze-analysis@contract',
  };

  let backend: SandboxBackend;
  let handle: SandboxHandle;

  beforeAll(async () => {
    backend = candidate.make();
    handle = await backend.create(spec);
  }, candidate.timeoutMs);

  afterAll(async () => {
    // Never leave a real sandbox behind, even if a case threw.
    try {
      await backend.destroy(handle);
    } catch {
      /* asserted separately */
    }
  }, candidate.timeoutMs);

  it('reports the backend name and region on the handle', () => {
    expect(backend.name).toBe(candidate.label);
    expect(handle.backend).toBe(candidate.label);
    expect(handle.region).toBe('eu');
    expect(handle.providerRef).toEqual(expect.any(String));
    expect(handle.providerRef).not.toContain(spec.orgId);
    expect(handle.providerRef).not.toContain(spec.runId);
  });

  it(
    'executes BY PATH only — a shell metacharacter in the argv is data, not syntax',
    async () => {
      // The literal `; curl example.com` is passed as ONE argv element. If any
      // layer handed it to a shell, `curl` would run (and, with deny-all, hang
      // or fail) and the echoed text would be truncated at the `;`. Getting the
      // whole string back is the proof that no shell parsed it.
      const res = await backend.exec(handle, ['echo', 'hello; curl example.com'], {
        timeoutMs: candidate.timeoutMs,
        maxStdoutBytes: 4096,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.toString().trim()).toBe('hello; curl example.com');
      expect(res.timedOut).toBe(false);
    },
    candidate.timeoutMs,
  );

  it(
    'runs a written script file by interpreter path',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/step-1.sh', bytes: Buffer.from('printf contract-ok\n') },
      ]);
      const res = await backend.exec(handle, [candidate.sh, '/work/step-1.sh'], {
        timeoutMs: candidate.timeoutMs,
        maxStdoutBytes: 4096,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.toString()).toContain('contract-ok');
    },
    candidate.timeoutMs,
  );

  it(
    'truncates stdout at maxStdoutBytes and flags stdoutTruncated',
    async () => {
      await backend.writeFiles(handle, [
        {
          path: '/work/step-loud.sh',
          bytes: Buffer.from('i=0; while [ $i -lt 200 ]; do printf 0123456789; i=$((i+1)); done\n'),
        },
      ]);
      const res = await backend.exec(handle, [candidate.sh, '/work/step-loud.sh'], {
        timeoutMs: candidate.timeoutMs,
        maxStdoutBytes: 64,
      });
      expect(res.stdout.length).toBe(64);
      expect(res.stdoutTruncated).toBe(true);
    },
    candidate.timeoutMs,
  );

  it(
    'kills a step at timeoutMs and reports timedOut with a null exit code',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/step-slow.sh', bytes: Buffer.from('sleep 120\n') },
      ]);
      const res = await backend.exec(handle, [candidate.sh, '/work/step-slow.sh'], {
        timeoutMs: 2_000,
        maxStdoutBytes: 1024,
      });
      expect(res.timedOut).toBe(true);
      expect(res.exitCode).toBeNull();
      expect(res.durationMs).toBeLessThan(60_000);
    },
    candidate.timeoutMs,
  );

  it(
    'pipes stdinBytes into the step',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/step-stdin.sh', bytes: Buffer.from('cat\n') },
      ]);
      const res = await backend.exec(handle, [candidate.sh, '/work/step-stdin.sh'], {
        timeoutMs: candidate.timeoutMs,
        maxStdoutBytes: 4096,
        stdinBytes: Buffer.from('piped-input'),
      });
      expect(res.stdout.toString()).toContain('piped-input');
    },
    candidate.timeoutMs,
  );

  it(
    'roundtrips writeFiles/readFile and refuses a read over maxBytes',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/in/roundtrip.txt', bytes: Buffer.from('contract-bytes') },
      ]);
      const read = await backend.readFile(handle, '/work/in/roundtrip.txt', 1024);
      expect(read.toString()).toBe('contract-bytes');
      await expect(backend.readFile(handle, '/work/in/roundtrip.txt', 4)).rejects.toMatchObject({
        code: 'file_too_large',
      });
    },
    candidate.timeoutMs,
  );

  it(
    'refuses a writeFiles batch over maxTotalBytes',
    async () => {
      await expect(
        backend.writeFiles(
          handle,
          [{ path: '/work/in/big.bin', bytes: Buffer.alloc(4096, 0x41) }],
          { maxTotalBytes: 1024 },
        ),
      ).rejects.toMatchObject({ code: 'file_too_large' });
    },
    candidate.timeoutMs,
  );

  it(
    'refuses every path outside /work',
    async () => {
      for (const bad of ['/etc/passwd', '/work/../etc/passwd', '../../etc/passwd']) {
        await expect(backend.readFile(handle, bad, 16)).rejects.toMatchObject({
          code: 'invalid_path',
        });
      }
    },
    candidate.timeoutMs,
  );

  it(
    'lists files with bytes, isDir and isSymlink',
    async () => {
      await backend.writeFiles(handle, [
        { path: '/work/out/listed.txt', bytes: Buffer.from('abcd') },
      ]);
      const listed = await backend.listFiles(handle, '/work/out');
      const entry = listed.find((f) => f.path === '/work/out/listed.txt');
      expect(entry).toBeDefined();
      expect(entry?.bytes).toBe(4);
      expect(entry?.isDir).toBe(false);
    },
    candidate.timeoutMs,
  );

  it(
    'destroys idempotently and then exposes a well-formed usage record',
    async () => {
      await backend.destroy(handle);
      await expect(backend.destroy(handle)).resolves.toBeUndefined();

      const usage = await backend.usage(handle);
      expect(usage.cpuMs).toEqual(expect.any(Number));
      expect(usage.wallMs).toEqual(expect.any(Number));
      expect(usage.memAllocatedMb).toEqual(expect.any(Number));
      expect(Number.isFinite(usage.cpuMs)).toBe(true);
      expect(Number.isFinite(usage.wallMs)).toBe(true);
      expect(usage.cpuMs).toBeGreaterThanOrEqual(0);
      expect(usage.wallMs).toBeGreaterThan(0);
      expect(usage.memAllocatedMb).toBeGreaterThan(0);
      if (usage.peakMemMb !== undefined) expect(usage.peakMemMb).toBeGreaterThan(0);
    },
    candidate.timeoutMs,
  );

  it(
    'refuses further work after destroy',
    async () => {
      await expect(
        backend.exec(handle, ['echo', 'after'], { timeoutMs: 5_000, maxStdoutBytes: 64 }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/not_found|destroy_failed/) });
    },
    candidate.timeoutMs,
  );
});
```

- [ ] **Step 5.2 — Run it (fake only, the PR-CI path).**
```bash
cd apps/api && npx vitest run src/services/workspace/sandboxBackend.contract.test.ts
```
Expected: PASS with one `describe` block (`[fake]`) plus the registration guard. If a case fails against the fake but the equivalent case in `fakeSandboxBackend.test.ts` passes, the bug is in the contract suite's assumptions — reconcile before touching the backend.

- [ ] **Step 5.3 — Run it against real Vercel once, by hand, before moving on.**
```bash
cd apps/api && VERCEL_SANDBOX_TOKEN=… VERCEL_TEAM_ID=team_… VERCEL_PROJECT_ID=prj_… \
  npx vitest run src/services/workspace/sandboxBackend.contract.test.ts
```
Expected: two `describe` blocks, both green. This is the first moment the pinned SDK names are exercised against the live API, so treat any failure here as the pinned table being wrong rather than the test. Record the result (pass, or the exact SDK error) in the PR body. **Then verify nothing was left running:** `Sandbox.list({ namePrefix: 'breeze-' })` via a one-off script, or the Vercel dashboard — a leaked sandbox bills until its deadline.

- [ ] **Step 5.4 — Commit.**
```bash
git add apps/api/src/services/workspace/sandboxBackend.contract.test.ts
git commit -m "test(ai): shared SandboxBackend contract suite across fake and vercel (execution plane W02)"
```

---

### Task 6: nightly real-Vercel e2e suite and its workflow

**Files:**
- Create: `apps/api/src/__tests__/integration/workspace.vercel.e2e.test.ts`
- Create: `apps/api/vitest.config.workspace-e2e.ts`
- Modify: `apps/api/package.json` (`scripts`, alphabetical — between `test:tz` and `test:run`… note the existing block is alphabetical except for the trailing `test:run`; insert `test:workspace-e2e` after `test:tz`)
- Modify: `apps/api/vitest.integration.config.ts` (`exclude` array, lines 293–326 of a 360-line file — it sits directly after the `include` array and before the `// Migrations run ONCE per invocation here` comment)
- Create: `.github/workflows/workspace-nightly.yml`

**Interfaces:** none exported.

**Why it gets its own config rather than a `skipIf`.** `vitest.integration.config.ts` includes `src/__tests__/integration/**/*.test.ts`, so a file dropped there is collected by the PR-blocking Integration Tests job — and its `setupFiles: ['src/__tests__/integration/setup.ts']` opens a real Postgres pool and TRUNCATEs core tables *before* any `skipIf` is evaluated. That is four shards paying setup cost for a file that will always skip. The repo already has the answer for "an integration-shaped file that must run on a different runner": a dedicated `vitest.config.*.ts` plus a `test:*` script, exactly as `rls`, `rls-coverage`, `request-db-role`, `site-scope-coverage` and `tz` do. Follow it. The `integration-suite-coverage` contract only scans `*.integration.test.ts` filenames, and this file is `*.e2e.test.ts`, so it needs no allowlist entry — but the exclude entry is added anyway, with a comment, so the exclusion is visible to the next reader.

- [ ] **Step 6.1 — Add the dedicated config.**

`apps/api/vitest.config.workspace-e2e.ts`:
```ts
import { defineConfig } from 'vitest/config';

/**
 * Nightly real-Vercel workspace e2e runner (spec §12, §11 step 2: "nightly
 * real-Vercel suite green for a week").
 *
 * NOT part of PR CI and NOT part of the Integration Tests job: it needs live
 * Vercel credentials, it costs real sandbox-minutes, and it asserts egress is
 * blocked — which means every case deliberately waits for a network failure.
 * Run by .github/workflows/workspace-nightly.yml, or by hand with
 * `WORKSPACE_E2E=1 pnpm --filter @breeze/api test:workspace-e2e`.
 *
 * No Postgres, no Redis, no setupFiles: the suite drives the SandboxBackend
 * adapter directly and touches no Breeze table.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/integration/workspace.vercel.e2e.test.ts'],
    fileParallelism: false,
    // A sandbox create is ~10 s and several cases wait out a deny-all timeout.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
```

- [ ] **Step 6.2 — Wire the script and the exclude.**

`apps/api/package.json`, in `scripts`, after `"test:tz"`:
```json
    "test:workspace-e2e": "vitest run --config vitest.config.workspace-e2e.ts",
```

`apps/api/vitest.integration.config.ts`, appended to the `exclude` array:
```ts
      // workspace.vercel.e2e.test.ts is the NIGHTLY real-Vercel suite: it needs
      // live VERCEL_* credentials, spends real sandbox-minutes, and every case
      // waits out a deliberate deny-all network failure. It must never run in
      // the PR-blocking Integration Tests job, and it needs no Postgres/Redis
      // setup at all — see vitest.config.workspace-e2e.ts
      // (`pnpm test:workspace-e2e`) and .github/workflows/workspace-nightly.yml.
      'src/__tests__/integration/workspace.vercel.e2e.test.ts',
```

- [ ] **Step 6.3 — Write the suite.**

`apps/api/src/__tests__/integration/workspace.vercel.e2e.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createVercelSandboxBackend } from '../../services/workspace/vercelSandboxBackend';
import type { SandboxBackend, SandboxHandle } from '../../services/workspace/sandboxBackend';

/**
 * Nightly real-Vercel evidence suite (spec §12, §10 "the nightly suite's
 * blocked-egress assertions are the evidence").
 *
 * Everything here is an assertion about the VENDOR, not about Breeze code:
 * that deny-all really blocks DNS, raw IPv4, IPv6 and ordinary HTTPS; that
 * `persistent: false` plus `delete({ deleteOrphanSnapshots: true })` really
 * leaves nothing behind; that the provider deadline really fires; that usage
 * really comes back. Breeze's own logic is covered by the contract suite.
 *
 * Double-gated so it can never run by accident: WORKSPACE_E2E=1 AND all three
 * Vercel credentials.
 */
const ENABLED = process.env.WORKSPACE_E2E === '1'
  && Boolean(process.env.VERCEL_SANDBOX_TOKEN)
  && Boolean(process.env.VERCEL_TEAM_ID)
  && Boolean(process.env.VERCEL_PROJECT_ID);

const SH = 'sh';
const MIB = 1024 * 1024;

/** Run a one-line shell script by writing it and executing it by path. */
async function runScript(
  backend: SandboxBackend,
  handle: SandboxHandle,
  name: string,
  script: string,
  timeoutMs = 45_000,
) {
  await backend.writeFiles(handle, [{ path: `/work/${name}`, bytes: Buffer.from(`${script}\n`) }]);
  return backend.exec(handle, [SH, `/work/${name}`], { timeoutMs, maxStdoutBytes: 64 * 1024 });
}

describe.skipIf(!ENABLED)('workspace vercel e2e (nightly)', () => {
  let backend: SandboxBackend;
  let handle: SandboxHandle;

  beforeAll(async () => {
    backend = createVercelSandboxBackend();
    handle = await backend.create({
      runId: '55555555-5555-4555-8555-555555555555',
      orgId: '66666666-6666-4666-8666-666666666666',
      region: 'eu',
      cpu: 1,
      memoryMb: 2048,
      deadlineSeconds: 600,
      image: 'breeze-analysis@nightly',
    });
  });

  afterAll(async () => {
    try {
      await backend.destroy(handle);
    } catch {
      /* the cleanup case asserts this separately */
    }
  });

  it('landed in the requested EU region', () => {
    expect(handle.region).toBe('eu');
    expect(handle.backend).toBe('vercel');
  });

  it('cannot resolve DNS', async () => {
    const res = await runScript(
      backend,
      handle,
      'egress-dns.sh',
      'getent hosts example.com || nslookup example.com || echo DNS_BLOCKED',
    );
    expect(`${res.stdout}${res.stderr}`).toContain('DNS_BLOCKED');
  });

  it('cannot reach a public host over HTTPS', async () => {
    const res = await runScript(
      backend,
      handle,
      'egress-https.sh',
      'curl -sS --max-time 20 https://example.com >/dev/null && echo REACHED || echo HTTPS_BLOCKED',
    );
    expect(`${res.stdout}${res.stderr}`).toContain('HTTPS_BLOCKED');
    expect(res.stdout.toString()).not.toContain('REACHED');
  });

  it('cannot reach a raw IPv4 address (no DNS required)', async () => {
    const res = await runScript(
      backend,
      handle,
      'egress-ipv4.sh',
      'curl -sS --max-time 20 http://1.1.1.1/ >/dev/null && echo REACHED || echo IPV4_BLOCKED',
    );
    expect(`${res.stdout}${res.stderr}`).toContain('IPV4_BLOCKED');
    expect(res.stdout.toString()).not.toContain('REACHED');
  });

  it('cannot reach a raw IPv6 address', async () => {
    const res = await runScript(
      backend,
      handle,
      'egress-ipv6.sh',
      'curl -sS -6 --max-time 20 "http://[2606:4700:4700::1111]/" >/dev/null && echo REACHED || echo IPV6_BLOCKED',
    );
    expect(`${res.stdout}${res.stderr}`).toContain('IPV6_BLOCKED');
    expect(res.stdout.toString()).not.toContain('REACHED');
  });

  it('carries no Breeze credential in its environment', async () => {
    const res = await runScript(backend, handle, 'env-dump.sh', 'env | sort');
    const dump = res.stdout.toString();
    for (const secret of ['DATABASE_URL', 'JWT_SECRET', 'APP_ENCRYPTION_KEY', 'VERCEL_SANDBOX_TOKEN', 'ANTHROPIC']) {
      expect(dump).not.toContain(secret);
    }
  });

  it('stages a 256 MiB input successfully', async () => {
    await backend.writeFiles(
      handle,
      [{ path: '/work/in/big.bin', bytes: Buffer.alloc(256 * MIB, 0x42) }],
      { maxTotalBytes: 512 * MIB },
    );
    const listed = await backend.listFiles(handle, '/work/in');
    expect(listed.find((f) => f.path === '/work/in/big.bin')?.bytes).toBe(256 * MIB);
  }, 300_000);

  it('refuses an over-cap stage before touching the vendor', async () => {
    await expect(
      backend.writeFiles(
        handle,
        [{ path: '/work/in/over.bin', bytes: Buffer.alloc(8 * MIB) }],
        { maxTotalBytes: 1 * MIB },
      ),
    ).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('reports usage after destroy and it is non-zero', async () => {
    await runScript(
      backend,
      handle,
      'burn.sh',
      'i=0; while [ $i -lt 2000000 ]; do i=$((i+1)); done; echo burned',
    );
    await backend.destroy(handle);
    const usage = await backend.usage(handle);
    expect(usage.cpuMs).toBeGreaterThan(0);
    expect(usage.wallMs).toBeGreaterThan(0);
    expect(usage.memAllocatedMb).toBe(2048);
  });

  it('leaves nothing behind after destroy — no live sandbox, no snapshot', async () => {
    const { Sandbox, Snapshot } = await import('@vercel/sandbox');
    const credentials = {
      token: process.env.VERCEL_SANDBOX_TOKEN as string,
      teamId: process.env.VERCEL_TEAM_ID as string,
      projectId: process.env.VERCEL_PROJECT_ID as string,
    };
    const sandboxes = await (await Sandbox.list({ namePrefix: handle.providerRef, ...credentials })).toArray();
    const live = sandboxes.filter((s) => s.status !== 'stopped' && s.status !== 'aborted');
    expect(live).toEqual([]);

    const snapshots = await (await Snapshot.list({ ...credentials })).toArray();
    // persistent:false plus deleteOrphanSnapshots means this run can have made
    // no snapshot at all. Assert none references our session.
    expect(snapshots.filter((s) => s.status === 'created' && s.sizeBytes > 0
      && String(s.sourceSessionId).includes(handle.providerRef))).toEqual([]);
  });

  it('fires the provider deadline on a short-lived sandbox', async () => {
    const shortLived = await backend.create({
      runId: '77777777-7777-4777-8777-777777777777',
      orgId: '88888888-8888-4888-8888-888888888888',
      region: 'eu',
      cpu: 1,
      memoryMb: 2048,
      deadlineSeconds: 60,
      image: 'breeze-analysis@nightly-deadline',
    });
    try {
      // Wait past the provider deadline, then prove the sandbox is gone rather
      // than merely idle: a further exec must fail, not succeed silently.
      await new Promise((resolve) => setTimeout(resolve, 75_000));
      await expect(
        backend.exec(shortLived, ['echo', 'still-alive'], {
          timeoutMs: 15_000,
          maxStdoutBytes: 256,
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/not_found|create_failed/) });
    } finally {
      await backend.destroy(shortLived).catch(() => undefined);
    }
  }, 180_000);
});
```

- [ ] **Step 6.4 — Prove the gate: it must collect and skip with no credentials.**
```bash
cd apps/api && npx vitest run --config vitest.config.workspace-e2e.ts
```
Expected: 1 file, all tests **skipped**, exit 0 — no network call, no credential read.

- [ ] **Step 6.5 — Prove the PR-CI path does NOT pick it up.**
```bash
cd apps/api && npx vitest list --config vitest.integration.config.ts 2>/dev/null | grep -c 'workspace.vercel.e2e'
```
Expected: `0`. A non-zero count means the `exclude` entry in Step 6.2 did not land — fix it before committing, because the alternative is four Integration shards paying real setup cost for a skipped file.

- [ ] **Step 6.6 — Add the nightly workflow.**

Read `.github/workflows/ci.yml` first for the house conventions this file must match: actions pinned by full commit SHA with a trailing `# vN` comment, `pnpm/action-setup` at `${{ env.PNPM_VERSION }}`, `actions/setup-node` with `node-version-file: .node-version` and `cache: 'pnpm'`, `permissions: contents: read` at the top with per-job opt-in, `persist-credentials: false` on checkout.

`.github/workflows/workspace-nightly.yml`:
```yaml
name: Workspace Nightly (Vercel Sandbox)

# Spec §11 rollout step 2: "nightly real-Vercel suite green for a week" is the
# gate between shipping the adapter dark and enabling the capability for the
# first partner. This workflow is that gate.
#
# Deliberately NOT on pull_request: it needs live Vercel credentials (which a
# fork PR must never see), it spends real sandbox-minutes, and several cases
# wait out a deliberate network timeout. `CI Success` does not depend on it —
# it is evidence for a human rollout decision, not a merge gate.
on:
  schedule:
    # 03:17 UTC — off the hour so it does not pile onto the runner surge every
    # other cron in this repo lands on.
    - cron: '17 3 * * *'
  workflow_dispatch:

concurrency:
  group: workspace-nightly
  cancel-in-progress: false

permissions:
  contents: read

env:
  PNPM_VERSION: '10.34.5'

jobs:
  vercel-sandbox-e2e:
    name: Vercel Sandbox e2e
    runs-on: ubuntu-latest
    # Well above the suite's own ceiling: a hung vendor call must fail the job,
    # not hold a runner for six hours.
    timeout-minutes: 30
    # `github.repository` guard so a fork that enables Actions cannot schedule
    # this against secrets it does not have (it would fail anyway; this makes
    # the skip explicit rather than a nightly red on someone else's fork).
    if: github.repository == 'LanternOps/breeze'

    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          persist-credentials: false

      - name: Setup pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version-file: .node-version
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run the Vercel sandbox e2e suite
        env:
          WORKSPACE_E2E: '1'
          AI_WORKSPACE_BACKEND: vercel
          VERCEL_SANDBOX_TOKEN: ${{ secrets.VERCEL_SANDBOX_TOKEN }}
          VERCEL_TEAM_ID: ${{ secrets.VERCEL_TEAM_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
          VERCEL_SANDBOX_REGION_EU: fra1
          VERCEL_SANDBOX_REGION_US: iad1
          NODE_ENV: test
        run: pnpm --filter @breeze/api test:workspace-e2e

      # A failed suite can leave a sandbox running until its 10-minute deadline.
      # That is bounded and self-healing, but a create that succeeded while the
      # job was cancelled has no `finally` at all — so sweep unconditionally.
      - name: Sweep any sandbox this job left behind
        if: always()
        env:
          VERCEL_SANDBOX_TOKEN: ${{ secrets.VERCEL_SANDBOX_TOKEN }}
          VERCEL_TEAM_ID: ${{ secrets.VERCEL_TEAM_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
        run: |
          node --input-type=module -e '
            import { Sandbox } from "@vercel/sandbox";
            const credentials = {
              token: process.env.VERCEL_SANDBOX_TOKEN,
              teamId: process.env.VERCEL_TEAM_ID,
              projectId: process.env.VERCEL_PROJECT_ID,
            };
            const page = await Sandbox.list({ namePrefix: "breeze-", ...credentials });
            for (const row of await page.toArray()) {
              if (row.status === "stopped" || row.status === "aborted") continue;
              const sandbox = await Sandbox.get({ name: row.name, resume: false, ...credentials });
              await sandbox.delete({ deleteOrphanSnapshots: true });
              console.log("swept", row.name);
            }
          '
        working-directory: apps/api
```

- [ ] **Step 6.7 — Lint the workflow file.**
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/workspace-nightly.yml')); print('yaml ok')"
grep -n 'uses:' .github/workflows/workspace-nightly.yml
grep -n 'uses: actions/checkout@\|uses: pnpm/action-setup@\|uses: actions/setup-node@' .github/workflows/ci.yml | head -3
```
Expected: `yaml ok`, and every `uses:` SHA in the new file matches the SHA `ci.yml` uses for the same action. A drifted pin is a review finding, not a nit — the pins are the supply-chain control (`scripts/check-supply-chain-hardening.sh`).

- [ ] **Step 6.8 — Record the three required repo secrets in the PR body.**

`VERCEL_SANDBOX_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` must exist as **repository** secrets or the nightly fails on its first run with a `Missing Vercel sandbox config` from `readVercelCredentials`. This plan cannot create them; the PR body must say so explicitly under a "Before merge" heading so it is not discovered by a red nightly at 03:17 UTC.

- [ ] **Step 6.9 — Commit.**
```bash
git add apps/api/src/__tests__/integration/workspace.vercel.e2e.test.ts \
        apps/api/vitest.config.workspace-e2e.ts \
        apps/api/vitest.integration.config.ts \
        apps/api/package.json \
        .github/workflows/workspace-nightly.yml
git commit -m "test(ai): nightly real-Vercel egress/cleanup/deadline suite and its workflow (execution plane W02)"
```

---

### Task 7: `ai_run_workspaces` + compute columns — schema, migration, and every registration

**Files:**
- Create **or append** (Step 1.3 decided which): `apps/api/src/db/schema/aiWorkspace.ts`
- Modify: `apps/api/src/db/schema/index.ts` (export list, ~line 69, after `'./aiOperatorTasks'`)
- Modify: `apps/api/src/db/schema/aiAgents.ts` (`aiAgentRuns` table body, ~lines 82–221)
- Modify: `apps/api/src/db/schema/ai.ts` (`aiSessions` ~line 27, `aiCostUsage` ~line 146, `aiBudgets` ~line 168)
- Create: `apps/api/migrations/2026-10-16-100100-ai-run-workspaces-compute.sql`
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, ~lines 296–300)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`, lines 70 / 81 / 82 / 94 plus one new entry)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (~lines 233–236)
- Create: `apps/api/src/__tests__/integration/aiRunWorkspaces.integration.test.ts`

**Interfaces:**
- Produces (contract names, verbatim):
```ts
export const aiWorkspaceBackend: readonly ['vercel', 'gvisor_pool', 'agentcore', 'fake'];
export type AiWorkspaceBackend = (typeof aiWorkspaceBackend)[number];
export const aiWorkspaceStatus: readonly ['creating', 'ready', 'destroying', 'destroyed', 'destroy_failed'];
export type AiWorkspaceStatus = (typeof aiWorkspaceStatus)[number];
export const aiWorkspaceRegion: readonly ['eu', 'us'];
export type AiWorkspaceRegion = (typeof aiWorkspaceRegion)[number];
export const aiRunWorkspaces: PgTable;                 // 'ai_run_workspaces'
export type AiRunWorkspaceRow = typeof aiRunWorkspaces.$inferSelect;
```

Tenancy decisions, each with its reason (a reviewer should be able to check every one against CLAUDE.md):

- **Shape 1** (direct NOT NULL `org_id`) — RLS is auto-discovered, so `rls-coverage.integration.test.ts` needs **no** allowlist entry. Verify that rather than assume it (Step 7.6).
- **`text` + CHECK, never `pgEnum`**, for `backend` / `status` / `region`. Under `FORCE ROW LEVEL SECURITY` only leakproof operators are promoted to index conditions; enum equality is not leakproof, so an enum `status` would turn the reaper's every-60-seconds poll into a post-policy filter over the whole table. Precedent and full account: the header of `2026-10-14-100000-ai-operator-thin-slice.sql` (note 1).
- **Partial-index predicates are literal constants** so the planner's predicate proof can see them (same migration, note 2).
- **Composite FK `(run_id, org_id) → ai_agent_runs(id, org_id)`, `ON DELETE CASCADE`, `DEFERRABLE INITIALLY IMMEDIATE`.** The deferrable clause is not optional: org merge runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent and child `org_id` in separate statements, and a non-deferrable composite aborts the merge with 23503. `orgLifecycleFoundations.integration.test.ts` ("merge contract") enforces it, and it only runs in Integration shard 2 — a unit-green PR still goes red there (#4585 did).
- **`ai_agent_runs.workspace_id` carries NO foreign key.** An FK both ways would be a 2-node cycle that `topologicalCascadeOrder()` cannot resolve — exactly the `metric_anomaly_incidents.agent_run_id` precedent documented in `aiAgents.ts`. The pointer is a plain `uuid`, and `ai_run_workspaces.run_id` is the edge with the constraint.
- **DDL only — no `breeze.scope` election.** This file creates a table, adds columns and adds constraints; it issues no `UPDATE`/`DELETE`/`INSERT`/`MERGE`. `ADD COLUMN … DEFAULT` is DDL, not DML, so `migrationRlsScope.test.ts` has nothing to flag. State that in the file header so the next author does not "helpfully" add a scope line and the one after that does not assume DML is allowed without one.

- [ ] **Step 7.1 — Schema file (create-if-missing; append if W01 landed first).**

If `apps/api/src/db/schema/aiWorkspace.ts` **exists** (W01 merged), add only the enum tuples/types this wave owns and the `aiRunWorkspaces` table, leaving W01's `aiRunArtifacts` and `aiArtifactKind` untouched. If it does **not** exist, create it with exactly the content below; W01 will append `aiRunArtifacts` to the same file.

```ts
/**
 * AI execution-plane workspaces (spec §6.2) — one row per sandbox instance.
 *
 * Shape 1 (direct NOT NULL `org_id`). Created by
 * migrations/2026-10-16-100100-ai-run-workspaces-compute.sql, which also
 * carries the RLS enable/force/policies, the composite deferrable FK to
 * `ai_agent_runs(id, org_id)`, and the compute columns added to
 * `ai_agent_runs`, `ai_cost_usage`, `ai_sessions` and `ai_budgets`.
 *
 * `backend`, `status` and `region` are `text` + CHECK, NOT pgEnum: under forced
 * RLS enum equality is not leakproof and would demote the reaper's
 * `status`/`deadline_at` poll to a post-policy filter over the whole table.
 * Same reasoning, same words, as ai_operator_tasks.state — see the header of
 * 2026-10-14-100000-ai-operator-thin-slice.sql.
 *
 * The tuples below are the single source of truth for the vocabulary; the SQL
 * CHECK constraints must list exactly the same members, and
 * aiRunWorkspaces.enums.test.ts asserts they do.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations';

export const aiWorkspaceBackend = ['vercel', 'gvisor_pool', 'agentcore', 'fake'] as const;
export type AiWorkspaceBackend = (typeof aiWorkspaceBackend)[number];

export const aiWorkspaceStatus = [
  'creating',
  'ready',
  'destroying',
  'destroyed',
  'destroy_failed',
] as const;
export type AiWorkspaceStatus = (typeof aiWorkspaceStatus)[number];

export const aiWorkspaceRegion = ['eu', 'us'] as const;
export type AiWorkspaceRegion = (typeof aiWorkspaceRegion)[number];

/** One step of a run's transcript (spec §5.8), stored in `steps` jsonb. */
export interface AiWorkspaceStep {
  ordinal: number;
  language: 'bash' | 'python' | 'node';
  scriptArtifactHandle: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutHandle?: string;
}

export const aiRunWorkspaces = pgTable('ai_run_workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // Composite FK (run_id, org_id) -> ai_agent_runs(id, org_id), ON DELETE
  // CASCADE, DEFERRABLE INITIALLY IMMEDIATE, is SQL-only: aiAgents.ts would
  // otherwise have to import this module for the reverse edge and the two
  // files would form an import cycle. Same technique as
  // ai_agent_runs.task_id -> ai_operator_tasks.
  runId: uuid('run_id').notNull(),

  backend: text('backend').$type<AiWorkspaceBackend>().notNull(),
  /** Vendor sandbox id. Opaque, carries no tenant identifier. */
  providerRef: text('provider_ref').notNull(),
  region: text('region').$type<AiWorkspaceRegion>().notNull(),
  bootstrapHash: text('bootstrap_hash'),
  status: text('status').$type<AiWorkspaceStatus>().notNull().default('creating'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
  /** Provider-side hard stop. The reaper's key: anything past this + 120s dies. */
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),

  cpuMs: bigint('cpu_ms', { mode: 'number' }),
  wallMs: bigint('wall_ms', { mode: 'number' }),
  memAllocatedMb: integer('mem_allocated_mb'),
  computeCents: integer('compute_cents'),

  stagedBytes: bigint('staged_bytes', { mode: 'number' }).notNull().default(0),
  artifactBytes: bigint('artifact_bytes', { mode: 'number' }).notNull().default(0),
  stepCount: integer('step_count').notNull().default(0),

  /** Step transcript (spec §5.8). jsonb => excludedOpen in the export policy. */
  steps: jsonb('steps').$type<AiWorkspaceStep[]>().notNull().default(sql`'[]'::jsonb`),

  destroyAttempts: integer('destroy_attempts').notNull().default(0),
  /** Last destroy failure, for the paged `destroy_failed` row. No secrets. */
  lastError: text('last_error'),
}, (table) => ({
  orgRunIdx: index('ai_run_workspaces_org_run_idx').on(table.orgId, table.runId),
  // Spec §6.2: "a run has at most one live" workspace. Partial so a destroyed
  // row never blocks anything; predicate is a literal constant so the planner
  // can prove it.
  orgRunLiveUq: uniqueIndex('ai_run_workspaces_org_run_live_uq')
    .on(table.orgId, table.runId)
    .where(sql`status <> 'destroyed'`),
  // The reaper's poll. Literal-constant predicate, leakproof text equality.
  reaperIdx: index('ai_run_workspaces_reaper_idx')
    .on(table.deadlineAt)
    .where(sql`status <> 'destroyed'`),
}));

export type AiRunWorkspaceRow = typeof aiRunWorkspaces.$inferSelect;
```

Then `apps/api/src/db/schema/index.ts`, after `export * from './aiOperatorTasks';`:
```ts
export * from './aiWorkspace';
```
(If W01 already added that line, leave it.)

- [ ] **Step 7.2 — Write the failing vocabulary test.**

`apps/api/src/db/schema/aiRunWorkspaces.enums.test.ts`:
```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  aiWorkspaceBackend,
  aiWorkspaceRegion,
  aiWorkspaceStatus,
} from './aiWorkspace';

const MIGRATION = path.join(
  __dirname,
  '../../../migrations/2026-10-16-100100-ai-run-workspaces-compute.sql',
);

/**
 * The TS tuples and the SQL CHECK constraints are two copies of one
 * vocabulary. Nothing else compares them, so a member added to one and not the
 * other would ship as a runtime 23514 on the first row that used it.
 */
describe('ai_run_workspaces vocabulary', () => {
  const sqlText = fs.readFileSync(MIGRATION, 'utf8');

  it.each([
    ['backend', aiWorkspaceBackend],
    ['status', aiWorkspaceStatus],
    ['region', aiWorkspaceRegion],
  ])('%s CHECK lists exactly the TS members', (column, members) => {
    const match = new RegExp(
      `ai_run_workspaces_${column}_chk[\\s\\S]*?CHECK \\(${column} IN \\(([^)]*)\\)\\)`,
    ).exec(sqlText);
    expect(match, `no CHECK found for ${column}`).not.toBeNull();
    const listed = (match?.[1] ?? '')
      .split(',')
      .map((v) => v.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .sort();
    expect(listed).toEqual([...members].sort());
  });

  it('creates the table with RLS enabled AND forced, and four policies', () => {
    expect(sqlText).toContain('ALTER TABLE ai_run_workspaces ENABLE ROW LEVEL SECURITY;');
    expect(sqlText).toContain('ALTER TABLE ai_run_workspaces FORCE ROW LEVEL SECURITY;');
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(sqlText).toContain(`CREATE POLICY breeze_org_isolation_${cmd} ON ai_run_workspaces`);
    }
    expect(sqlText).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ai_run_workspaces TO breeze_app;');
  });

  it('makes the composite tenant FK deferrable — org merge aborts otherwise', () => {
    expect(sqlText).toMatch(
      /ai_run_workspaces_run_org_fk[\s\S]*?REFERENCES ai_agent_runs \(id, org_id\)[\s\S]*?DEFERRABLE INITIALLY IMMEDIATE/,
    );
  });

  it('gives ai_agent_runs.workspace_id NO foreign key (2-node cascade cycle)', () => {
    expect(sqlText).toContain('workspace_id uuid');
    expect(sqlText).not.toMatch(/workspace_id[^;]*REFERENCES ai_run_workspaces/);
  });
});
```

- [ ] **Step 7.3 — Run it; expect a missing-migration failure.**
```bash
cd apps/api && npx vitest run src/db/schema/aiRunWorkspaces.enums.test.ts
```
Expected: every case fails with `ENOENT … 2026-10-16-100100-ai-run-workspaces-compute.sql`.

- [ ] **Step 7.4 — Re-check the slot, then write the migration.**
```bash
ls apps/api/migrations | grep -E '^[0-9]{4}-' | sort | tail -2
```
If anything sorts at or after `2026-10-16-100100-…`, rename this file to sort after it (keep the slug) and update the path in Step 7.2's test and in Step 7.8's `git add` before continuing.

`apps/api/migrations/2026-10-16-100100-ai-run-workspaces-compute.sql`:
```sql
-- 2026-10-16: AI execution plane W02 — ai_run_workspaces + compute columns.
--
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md
--       §6 (preamble: tenancy contract), §6.2 (this table), §6.3 (compute
--       columns on four existing tables), §5.6 (metering), §5.8 (step
--       transcript), §8 (residency), §9 (destroy_failed).
--
-- DDL ONLY. This file creates a table, adds columns and adds constraints; it
-- issues no UPDATE/DELETE/INSERT/MERGE, so it elects no `breeze.scope`
-- (`ADD COLUMN ... DEFAULT` is DDL, not DML). Any FUTURE migration in this
-- family that writes rows MUST put
--   SELECT set_config('breeze.scope','system',true);
-- before its first write — 425 of 442 tables are FORCE ROW LEVEL SECURITY,
-- which binds the owner role migrations run as, so without it an UPDATE
-- silently matches zero rows and an INSERT aborts with 42501. Enforced by
-- apps/api/src/db/migrationRlsScope.test.ts.
--
-- Design points, each traceable to a contract:
--
--  1. `backend`, `status` and `region` are `text` + CHECK, never pgEnum. Under
--     FORCE ROW LEVEL SECURITY only leakproof operators become index
--     conditions; enum equality is not leakproof, so an enum `status` would
--     demote the reaper's once-a-minute poll to a post-policy filter over the
--     whole table (2026-10-14-100000 header note 1; the 2026-09-03 US
--     device-feed incident).
--
--  2. Partial-index predicates are literal constants, never parameters, so the
--     planner's predicate proof can see them (same header, note 2).
--
--  3. The composite `(run_id, org_id) -> ai_agent_runs(id, org_id)` FK is
--     DEFERRABLE INITIALLY IMMEDIATE. Org merge runs `SET CONSTRAINTS ALL
--     DEFERRED` and re-points parent and child `org_id` in separate
--     statements; a non-deferrable composite aborts the merge with 23503
--     (orgLifecycleFoundations.integration.test.ts, Integration shard 2).
--
--  4. `ai_agent_runs.workspace_id` gets NO foreign key. A real FK in both
--     directions would be a 2-node cycle that tenantCascade.ts's
--     topologicalCascadeOrder() cannot resolve — the exact
--     `metric_anomaly_incidents.agent_run_id` precedent. The constrained edge
--     is `ai_run_workspaces.run_id`; `workspace_id` is a plain pointer.
--
--  5. `ai_run_workspaces.provider_ref` is the VENDOR's sandbox id and is what
--     the reaper needs to destroy a sandbox whose worker process has died. It
--     is opaque and carries no tenant identifier (services/workspace/
--     vercelSandboxBackend.ts generates `breeze-<region>-<uuid>`), the same
--     rule the artifact blob keys follow.
--
--  6. `compute_cents` columns are added to ai_agent_runs (int), ai_cost_usage
--     (real) and ai_sessions (real). The int/real split is not an oversight:
--     it mirrors the existing `cost_cents int` on ai_agent_runs versus
--     `total_cost_cents real` on ai_cost_usage/ai_sessions, so the new column
--     has the same type as the token column it sits beside on each table.
--
-- Idempotent throughout: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP CONSTRAINT/POLICY IF EXISTS before each ADD/CREATE. autoMigrate
-- wraps this file in one transaction — no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- 1. ai_run_workspaces
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_run_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  run_id uuid NOT NULL,

  backend text NOT NULL
    CONSTRAINT ai_run_workspaces_backend_chk
    CHECK (backend IN ('vercel', 'gvisor_pool', 'agentcore', 'fake')),

  provider_ref text NOT NULL
    CONSTRAINT ai_run_workspaces_provider_ref_len_chk CHECK (length(provider_ref) <= 200),

  region text NOT NULL
    CONSTRAINT ai_run_workspaces_region_chk CHECK (region IN ('eu', 'us')),

  bootstrap_hash text
    CONSTRAINT ai_run_workspaces_bootstrap_hash_len_chk CHECK (bootstrap_hash IS NULL OR length(bootstrap_hash) <= 128),

  status text NOT NULL DEFAULT 'creating'
    CONSTRAINT ai_run_workspaces_status_chk
    CHECK (status IN ('creating', 'ready', 'destroying', 'destroyed', 'destroy_failed')),

  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  destroyed_at timestamptz,
  deadline_at timestamptz NOT NULL,

  cpu_ms bigint CONSTRAINT ai_run_workspaces_cpu_ms_chk CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
  wall_ms bigint CONSTRAINT ai_run_workspaces_wall_ms_chk CHECK (wall_ms IS NULL OR wall_ms >= 0),
  mem_allocated_mb integer CONSTRAINT ai_run_workspaces_mem_chk CHECK (mem_allocated_mb IS NULL OR mem_allocated_mb >= 0),
  compute_cents integer CONSTRAINT ai_run_workspaces_compute_cents_chk CHECK (compute_cents IS NULL OR compute_cents >= 0),

  staged_bytes bigint NOT NULL DEFAULT 0
    CONSTRAINT ai_run_workspaces_staged_bytes_chk CHECK (staged_bytes >= 0),
  artifact_bytes bigint NOT NULL DEFAULT 0
    CONSTRAINT ai_run_workspaces_artifact_bytes_chk CHECK (artifact_bytes >= 0),
  step_count integer NOT NULL DEFAULT 0
    CONSTRAINT ai_run_workspaces_step_count_chk CHECK (step_count >= 0),

  -- Step transcript (spec §5.8). jsonb, therefore `excludedOpen` in
  -- CORE_TENANT_EXPORT_POLICY — an open container may embed anything.
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,

  destroy_attempts integer NOT NULL DEFAULT 0
    CONSTRAINT ai_run_workspaces_destroy_attempts_chk CHECK (destroy_attempts >= 0),
  last_error text
    CONSTRAINT ai_run_workspaces_last_error_len_chk CHECK (last_error IS NULL OR length(last_error) <= 2000)
);

-- Tenant FK. Deferrable (header note 3); CASCADE so an erased run takes its
-- workspace row with it.
ALTER TABLE ai_run_workspaces DROP CONSTRAINT IF EXISTS ai_run_workspaces_run_org_fk;
ALTER TABLE ai_run_workspaces ADD CONSTRAINT ai_run_workspaces_run_org_fk
  FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS ai_run_workspaces_org_run_idx
  ON ai_run_workspaces (org_id, run_id);

-- Spec §6.2: at most one LIVE workspace per run. Literal-constant predicate.
CREATE UNIQUE INDEX IF NOT EXISTS ai_run_workspaces_org_run_live_uq
  ON ai_run_workspaces (org_id, run_id)
  WHERE status <> 'destroyed';

-- The reaper's poll (jobs/workspaceReaper.ts): oldest deadline first among
-- everything not yet destroyed. Literal-constant predicate, leakproof text
-- comparison, so it survives forced RLS as an index condition.
CREATE INDEX IF NOT EXISTS ai_run_workspaces_reaper_idx
  ON ai_run_workspaces (deadline_at)
  WHERE status <> 'destroyed';

ALTER TABLE ai_run_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_run_workspaces FORCE ROW LEVEL SECURITY;

-- Shape 1: the canonical idiom is a plain breeze_has_org_access(org_id) with
-- NO separate system branch — the helper already returns TRUE for system scope
-- (0001-baseline.sql). Identical to ai_operator_tasks / action_intents.
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_run_workspaces;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_run_workspaces;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_run_workspaces;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_run_workspaces;

CREATE POLICY breeze_org_isolation_select ON ai_run_workspaces
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_run_workspaces
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_run_workspaces
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_run_workspaces
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_run_workspaces TO breeze_app;

-- ---------------------------------------------------------------------------
-- 2. ai_agent_runs — compute accounting (spec §6.3)
-- ---------------------------------------------------------------------------
--
-- `workspace_id` is deliberately FK-less (header note 4).

ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS compute_cpu_ms bigint;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS compute_wall_ms bigint;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS compute_cents integer;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS compute_reserved_cents integer;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS workspace_id uuid;

ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_compute_nonneg_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_compute_nonneg_chk CHECK (
  (compute_cpu_ms IS NULL OR compute_cpu_ms >= 0)
  AND (compute_wall_ms IS NULL OR compute_wall_ms >= 0)
  AND (compute_cents IS NULL OR compute_cents >= 0)
  AND (compute_reserved_cents IS NULL OR compute_reserved_cents >= 0)
);

-- ---------------------------------------------------------------------------
-- 3. ai_cost_usage / ai_sessions / ai_budgets (spec §6.3)
-- ---------------------------------------------------------------------------
--
-- `real` beside the existing `total_cost_cents real` on the two rollup tables;
-- `integer` beside `cost_cents integer` on the per-run table (header note 6).
-- NOT NULL DEFAULT 0 so every existing row reads as "no compute spent" rather
-- than NULL, which is the truth: nothing before this migration could spend any.

ALTER TABLE ai_cost_usage ADD COLUMN IF NOT EXISTS compute_cents real NOT NULL DEFAULT 0;
ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS total_compute_cents real NOT NULL DEFAULT 0;

-- Daily per-org compute ceiling. 500 cents ($5/day) is the conservative
-- default the spec's §5.6 reservation path checks against; an org may raise it
-- through the existing budget settings surface.
ALTER TABLE ai_budgets ADD COLUMN IF NOT EXISTS max_compute_cents_per_day integer NOT NULL DEFAULT 500;

ALTER TABLE ai_budgets DROP CONSTRAINT IF EXISTS ai_budgets_max_compute_cents_chk;
ALTER TABLE ai_budgets ADD CONSTRAINT ai_budgets_max_compute_cents_chk
  CHECK (max_compute_cents_per_day >= 0);
```

Mirror the four ALTERed tables in Drizzle in the same commit:
- `aiAgents.ts`, inside `aiAgentRuns`'s column object, after `costCents`:
```ts
  // Execution plane W02 (spec §6.3). `workspaceId` carries NO Drizzle
  // `.references()` and no SQL FK: a real FK here plus
  // ai_run_workspaces.run_id -> ai_agent_runs would be a 2-node cycle
  // topologicalCascadeOrder() cannot resolve (the metric_anomaly_incidents
  // precedent above). The constrained edge lives on the child table.
  computeCpuMs: bigint('compute_cpu_ms', { mode: 'number' }),
  computeWallMs: bigint('compute_wall_ms', { mode: 'number' }),
  computeCents: integer('compute_cents'),
  computeReservedCents: integer('compute_reserved_cents'),
  workspaceId: uuid('workspace_id'),
```
(add `bigint` to the `drizzle-orm/pg-core` import list if it is not already there)
- `ai.ts`: `aiCostUsage` gains `computeCents: real('compute_cents').notNull().default(0)`; `aiSessions` gains `totalComputeCents: real('total_compute_cents').notNull().default(0)`; `aiBudgets` gains `maxComputeCentsPerDay: integer('max_compute_cents_per_day').notNull().default(500)`.

- [ ] **Step 7.5 — Run the vocabulary test; expect PASS.**
```bash
cd apps/api && npx vitest run src/db/schema/aiRunWorkspaces.enums.test.ts
```

- [ ] **Step 7.6 — Bring up a private stack, apply the migration, and watch the cascade contract go RED before registering anything.**

This is the red step that matters for this task: the whole point of `CORE_ORG_CASCADE_DELETE_ORDER` is that code review has caught a missing entry **0 of 5 times** while the contract test caught it **5 of 5**. Seeing it red first is the proof the test would have caught you.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts
```
Expected: **RED**, with a message naming `ai_run_workspaces` as an `org_id` table missing from `CORE_ORG_CASCADE_DELETE_ORDER`. If it is green, the migration did not apply — check `globalSetup`'s autoMigrate output before going further, because a green here means nothing was tested.

- [ ] **Step 7.7 — Register in all four places, one grep per registration.**

1. `apps/api/src/services/tenantCascade.ts`, in `CORE_ORG_CASCADE_DELETE_ORDER`, alphabetically between `'ai_operator_tasks'` and `'ai_screenshots'` (and after W01's `'ai_run_artifacts'` if present — `ai_run_artifacts` < `ai_run_workspaces` under `localeCompare`):
```ts
  // Execution plane W02 (#…): one row per sandbox instance, Shape 1 with a
  // NOT NULL org_id, so an entry here is mandatory. Its only outbound FK is
  // the composite (run_id, org_id) -> ai_agent_runs ON DELETE CASCADE, and
  // ai_agent_runs sorts EARLIER in this alphabetical list — harmless, because
  // the FK carries an explicit ON DELETE and topologicalCascadeOrder()'s
  // runtime pg_constraint read, not this array, decides the real DELETE order.
  'ai_run_workspaces',
```
Not an append-only table (no REVOKE DELETE, no immutability trigger), so **no** `AUDIT_ADMIN_REQUIRED_TABLES` entry.

2. `apps/api/src/services/tenantExportPolicyRegistry.ts` — a new entry plus **four edits to existing entries**. This is the registration that fires on a new COLUMN, not just a new table, and it is the one most likely to be forgotten:
```ts
  "ai_run_workspaces": tablePolicy("org_id", {"included":["id","org_id","run_id","backend","provider_ref","region","bootstrap_hash","status","created_at","ready_at","destroyed_at","deadline_at","cpu_ms","wall_ms","mem_allocated_mb","compute_cents","staged_bytes","artifact_bytes","step_count","destroy_attempts","last_error"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["steps"]}),
```
and add to the existing entries' `included` arrays:
- `"ai_agent_runs"`: `"compute_cpu_ms","compute_wall_ms","compute_cents","compute_reserved_cents","workspace_id"`
- `"ai_cost_usage"`: `"compute_cents"`
- `"ai_sessions"`: `"total_compute_cents"`
- `"ai_budgets"`: `"max_compute_cents_per_day"`

Classification reasoning, stated so a reviewer can check it: every added column is a monotonic counter, a cents amount, a status vocabulary member, a timestamp, or an opaque vendor/tenant identifier — ordinary customer data, `included`. None matches `SUSPICIOUS_NAME_PARTS`, so nothing goes in `reviewedIncluded`. Nothing is credential, key or verifier material, so nothing goes in `excludedSensitive`. `steps` is `jsonb` and therefore `excludedOpen` **unconditionally** — an open container may embed a capability or a credential regardless of what today's writer puts in it.

3. `apps/api/src/services/orgMergeRegistry.ts`, beside the other `ai_*` dispositions:
```ts
  ai_run_workspaces: { kind: 'leave-for-erasure', note: 'a workspace is the sandbox record of one run, and runs never follow a merge (ai_agent_runs disposition, 2026-08-23 owner decision); the composite (run_id, org_id) FK also makes a bare org_id repoint fragile — rows die with the loser shell' },
```
This migration adds **no** `BEFORE UPDATE` trigger to any `org_id` table, so there is nothing to classify in `ORG_ID_*_TRIGGERS` — confirm with the grep below rather than assuming.

4. RLS coverage allowlists: **nothing to add.** `ai_run_workspaces` is Shape 1, which `rls-coverage.integration.test.ts` auto-discovers. Prove it in Step 7.8 rather than asserting it here.

Verification greps (each must print a hit):
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
grep -n "ai_run_workspaces" apps/api/src/services/tenantCascade.ts
grep -c "ai_run_workspaces" apps/api/src/services/tenantExportPolicyRegistry.ts
grep -n "compute_cpu_ms\|compute_reserved_cents\|total_compute_cents\|max_compute_cents_per_day" apps/api/src/services/tenantExportPolicyRegistry.ts
grep -n "ai_run_workspaces" apps/api/src/services/orgMergeRegistry.ts
grep -n "BEFORE UPDATE" apps/api/migrations/2026-10-16-100100-ai-run-workspaces-compute.sql || echo "no triggers added — nothing to classify in orgMergeRegistry ORG_ID_*_TRIGGERS"
```

- [ ] **Step 7.8 — Run every contract suite this touches; all must be GREEN.**
```bash
cd apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
pnpm test:rls-coverage
npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: all green. Notes on what a failure means:
- `tenantCascade` red → the entry is missing, mis-sorted, or names a table that does not exist.
- `tenant-export-policy` red → a column is unclassified; the message names it. This is the suite that fires on the four ALTERed tables.
- `orgLifecycleFoundations` ("merge contract") red → the composite FK is not `DEFERRABLE INITIALLY IMMEDIATE`. It only runs in Integration shard 2, which is why it is run explicitly here.
- `migrationRlsScope` red → something in the migration writes rows after all; either remove the write or elect system scope, and **never** add the file to that test's frozen baseline (#4518).

- [ ] **Step 7.9 — Drift check.**
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
export DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test"
pnpm db:check-drift
```
Expected: no drift. Drift here almost always means a Drizzle column type that does not match the SQL (`bigint` vs `integer`, `real` vs `doublePrecision`, a missing `.notNull()` or `.default()`), not a missing migration.

- [ ] **Step 7.10 — Forge a cross-tenant insert as `breeze_app` by hand.**

CLAUDE.md requires this, and it is the only check in the list that exercises the actual policy rather than its metadata.
```bash
docker exec -it $(docker ps --filter name=postgres-test --format '{{.Names}}' | head -1) \
  psql -U breeze_app -d breeze_test -c "
    SELECT set_config('breeze.scope','org',false),
           set_config('breeze.org_ids','{00000000-0000-0000-0000-000000000001}',false);
    INSERT INTO ai_run_workspaces (org_id, run_id, backend, provider_ref, region, deadline_at)
    VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',
            'fake','forged','eu', now() + interval '1 hour');"
```
Expected: `ERROR: new row violates row-level security policy for table "ai_run_workspaces"`. A `23503` foreign-key error instead means RLS let the row through and only the FK stopped it — that is a **failure**, not a pass; fix the policy.

- [ ] **Step 7.11 — Add the dedicated RLS/cascade integration suite.**

`apps/api/src/__tests__/integration/aiRunWorkspaces.integration.test.ts`. The house pattern for a live-DB tenancy proof in this directory is `aiAgentsPartnerRls.integration.test.ts` — read it first and copy it structurally: `import './setup'`, fixtures from `db-utils.ts` (`createPartner` / `createOrganization` / `createUser`), writes through the **normal `db` proxy** wrapped in `withDbAccessContext(<attacker context>, …)`, and the SQLSTATE asserted off `err.cause.code`. There is no raw-client escape hatch and none is needed: `DB_CONTEXTLESS_WRITE_STRICT` fires on a **contextless** connection, not on a wrong-tenant one, so an insert made *inside* an attacker's own org context reaches Postgres and is refused by the policy with `42501`.

```ts
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents } from '../../db/schema';
import { aiRunWorkspaces } from '../../db/schema/aiWorkspace';
import { createOrganization, createPartner, createUser } from './db-utils';

/**
 * Live-DB proof for ai_run_workspaces (spec §6.2). Five properties:
 *  1. the owning org CAN insert its own row  — the positive control, without
 *     which the 42501 case below could be green for the wrong reason
 *     (a typo'd column, a missing table, a fixture that never ran);
 *  2. an org context CANNOT insert a row for another org (42501);
 *  3. an org context cannot SELECT another org's workspace row;
 *  4. deleting the parent run cascades the workspace row away;
 *  5. at most one LIVE workspace per run (partial unique index).
 *
 * Every write goes through the normal `db` proxy inside an explicit
 * DbAccessContext, exactly as aiAgentsPartnerRls.integration.test.ts does.
 * The forged insert reuses the VICTIM's own (run_id, org_id) pair so the
 * composite FK is satisfiable — if the row were refused with 23503 we would
 * be proving the FK works, not the policy.
 */

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

interface Tenant {
  partnerId: string;
  orgId: string;
  runId: string;
}

/** One partner + one org + one ai_agents row + one ai_agent_runs row. */
async function seedTenantWithRun(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });

  const runId = await withSystemDbAccessContext(async () => {
    const [agent] = await db
      .insert(aiAgents)
      .values({
        orgId: org.id,
        partnerId: null,
        kind: 'triage',
        name: 'Workspace fixture',
        createdBy: user.id,
      })
      .returning({ id: aiAgents.id });
    const [run] = await db
      .insert(aiAgentRuns)
      .values({
        agentId: agent!.id,
        orgId: org.id,
        triggerKind: 'manual',
        dedupeKey: `workspace-${randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: { schemaVersion: 1 } as never,
      })
      .returning({ id: aiAgentRuns.id });
    return run!.id as string;
  });

  return { partnerId: partner.id, orgId: org.id, runId };
}

function workspaceValues(t: Tenant, providerRef: string) {
  return {
    orgId: t.orgId,
    runId: t.runId,
    backend: 'fake' as const,
    providerRef,
    region: 'eu' as const,
    deadlineAt: new Date(Date.now() + 3_600_000),
  };
}

afterEach(async () => {
  await withSystemDbAccessContext(() => db.delete(aiRunWorkspaces));
});

describe('ai_run_workspaces RLS', () => {
  it('lets the owning org insert and read its own workspace row (positive control)', async () => {
    const t = await seedTenantWithRun();
    const rows = await withDbAccessContext(orgContext(t.orgId, t.partnerId), () =>
      db.insert(aiRunWorkspaces).values(workspaceValues(t, 'fake-own')).returning(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(t.orgId);
    expect(rows[0]?.status).toBe('creating');

    const read = await withDbAccessContext(orgContext(t.orgId, t.partnerId), () =>
      db.select().from(aiRunWorkspaces),
    );
    expect(read.map((r) => r.providerRef)).toEqual(['fake-own']);
  });

  it('refuses a forged cross-tenant insert with 42501', async () => {
    const attacker = await seedTenantWithRun();
    const victim = await seedTenantWithRun();
    // The victim's own (run_id, org_id) pair — the composite FK is satisfied,
    // so the ONLY thing that can refuse this row is the policy.
    await expectSqlState(
      () =>
        withDbAccessContext(orgContext(attacker.orgId, attacker.partnerId), () =>
          db.insert(aiRunWorkspaces).values(workspaceValues(victim, 'forged')).returning(),
        ),
      '42501',
    );
  });

  it('hides another org’s rows from an org context', async () => {
    const owner = await seedTenantWithRun();
    const other = await seedTenantWithRun();
    await withSystemDbAccessContext(() =>
      db.insert(aiRunWorkspaces).values(workspaceValues(owner, 'fake-owner')),
    );
    const rows = await withDbAccessContext(orgContext(other.orgId, other.partnerId), () =>
      db.select().from(aiRunWorkspaces),
    );
    expect(rows).toEqual([]);
  });

  it('cascades away when the parent run is deleted', async () => {
    const t = await seedTenantWithRun();
    await withSystemDbAccessContext(async () => {
      await db.insert(aiRunWorkspaces).values(workspaceValues(t, 'fake-cascade'));
      await db.delete(aiAgentRuns).where(eq(aiAgentRuns.id, t.runId));
      expect(await db.select().from(aiRunWorkspaces)).toEqual([]);
    });
  });

  it('allows at most one live workspace per run', async () => {
    const t = await seedTenantWithRun();
    await expectSqlState(
      () =>
        withSystemDbAccessContext(async () => {
          await db.insert(aiRunWorkspaces).values(workspaceValues(t, 'fake-first'));
          await db.insert(aiRunWorkspaces).values(workspaceValues(t, 'fake-second'));
        }),
      '23505',
    );
  });
});
```

Do **not** invent fixture helpers: `createPartner` / `createOrganization` / `createUser` are the real exports of `db-utils.ts` (signatures: `createPartner(opts?)`, `createOrganization({ partnerId })`, `createUser({ partnerId, orgId? })`), and **never** write a "repair the whole DB" helper — that is what masked the deferrable-FK contract in CI once already.

- [ ] **Step 7.11b — Prove the red before the green.**

Run the suite against a database that has NOT yet had this wave's migration applied (or with the policy block commented out of the migration) and confirm the forge case is the one that fails — a `42501` that appears without the policy existing would mean the assertion is reading someone else's error.

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiRunWorkspaces.integration.test.ts
```
Expected: all green.

- [ ] **Step 7.12 — Commit.**
```bash
git add apps/api/src/db/schema/aiWorkspace.ts \
        apps/api/src/db/schema/index.ts \
        apps/api/src/db/schema/aiAgents.ts \
        apps/api/src/db/schema/ai.ts \
        apps/api/src/db/schema/aiRunWorkspaces.enums.test.ts \
        apps/api/migrations/2026-10-16-100100-ai-run-workspaces-compute.sql \
        apps/api/src/services/tenantCascade.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts \
        apps/api/src/services/orgMergeRegistry.ts \
        apps/api/src/__tests__/integration/aiRunWorkspaces.integration.test.ts
git commit -m "feat(ai): ai_run_workspaces table and compute columns with full tenancy registration (execution plane W02)"
```

---

### Task 8: `workspaceReaper.ts` — the orphan backstop

**Files:**
- Create: `apps/api/src/jobs/workspaceReaper.ts`
- Create: `apps/api/src/jobs/workspaceReaper.test.ts`
- Create: `apps/api/src/services/aiWorkspaceMetrics.ts`
- Modify: `apps/api/src/services/workerRegistry.ts` (the registry array, beside the `approvalExpiryReaper` entry ~line 948)

**Interfaces:**
- Consumes: `getSandboxBackendByName` (Task 2), `aiRunWorkspaces` (Task 7), `withSystemDbAccessContext` / `db` (`apps/api/src/db`), `captureException` (`apps/api/src/services/sentry`), `getBullMQConnection` (`apps/api/src/services/redis`), `attachWorkerObservability` (`./workerObservability`).
- Produces:
```ts
export async function reapExpiredWorkspaces(): Promise<{ destroyed: number; failed: number }>;
export async function initializeWorkspaceReaper(): Promise<void>;
export async function shutdownWorkspaceReaper(): Promise<void>;
// aiWorkspaceMetrics.ts (spec §10)
export function observeWorkspaceCreateSeconds(seconds: number, labels: { backend: string; region: string }): void;
export function incWorkspaceDestroyFailed(labels: { backend: string; region: string }): void;
export function addWorkspaceComputeSeconds(seconds: number, labels: { backend: string; region: string }): void;
```

Design decisions, with reasons:

- **The job is modelled on `approvalExpiryReaper.ts`** — same BullMQ queue/worker/repeatable-job shape, same `attachWorkerObservability`, same `captureException` on worker `error` and `failed`, same `shutdown*` pair, same `placement: 'global'` registry entry. Copy that file's structure rather than inventing one; a reviewer should be able to diff them.
- **Every 60 s, `deadline_at < now() - interval '120 seconds'`, status not `destroyed`** (spec §6 step 6). The 120 s grace is what keeps the reaper from racing a run's own `finally`.
- **It runs unconditionally**, with no flag check. With `BREEZE_AI_WORKSPACE_ENABLED` off nothing writes `ai_run_workspaces`, so the poll finds nothing. Gating the reaper on the flag would mean turning the feature *off* strands every live sandbox billing until its provider deadline — the same "off means start nothing new, never stop watching what already happened" rule `aiOperatorTasksEnabled` states explicitly.
- **Claim before destroying.** The row is flipped `destroying` in a `FOR UPDATE SKIP LOCKED` CTE, exactly as the approval reaper claims its rows, so two API instances never call `destroy` on the same sandbox concurrently.
- **`destroy` is dispatched per row by `getSandboxBackendByName(row.backend)`**, not by `getSandboxBackend()`. A row written while `AI_WORKSPACE_BACKEND=vercel` must still be destroyable after someone flips the env, and the fake's sandboxes live in the process that made them.
- **A failure sets `destroy_failed`, increments `destroy_attempts`, records `last_error`, increments `ai_workspace_destroy_failed_total`, and calls `captureException`** (spec §9: "Row `destroy_failed`, paged"). It does **not** throw — one stuck vendor row must not stop the reaper draining the rest.
- **It runs inside `withSystemDbAccessContext`.** Cross-org by construction; the bare pool is forbidden.

- [ ] **Step 8.1 — Write the metrics module first (leaf, no db/route imports).**

`apps/api/src/services/aiWorkspaceMetrics.ts`:
```ts
/**
 * AI execution-plane workspace metrics (spec §10).
 *
 * A LEAF module by construction — it imports `metricsRegistry` and nothing
 * else — so the worker role can serve /metrics without pulling the
 * route/db/service graph in behind it. `workerEntrypointClosure.contract.
 * test.ts` enforces that invariant mechanically; see
 * aiOperatorCoordinatorMetrics.ts for the same pattern and the same reason.
 *
 * Names are used verbatim from spec §10, unprefixed, matching the
 * `ai_operator_*` family already on this registry.
 */
import { Counter, Histogram } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';

const createSeconds = new Histogram({
  name: 'ai_workspace_create_seconds',
  help: 'Wall time to create an AI workspace sandbox, by backend and region',
  labelNames: ['backend', 'region'] as const,
  // A cold Firecracker boot is seconds, not milliseconds; the interesting
  // question is "did it cross 30s and blow the run's wall clock".
  buckets: [1, 2, 5, 10, 20, 30, 60, 120],
  registers: [metricsRegistry],
});

const destroyFailed = new Counter({
  name: 'ai_workspace_destroy_failed_total',
  help: 'Workspace sandboxes the reaper could not destroy (each one is a paged destroy_failed row and a billing sandbox we are still paying for)',
  labelNames: ['backend', 'region'] as const,
  registers: [metricsRegistry],
});

const computeSeconds = new Counter({
  name: 'ai_workspace_compute_seconds_total',
  help: 'Cumulative sandbox wall-clock seconds, by backend and region',
  labelNames: ['backend', 'region'] as const,
  registers: [metricsRegistry],
});

export function observeWorkspaceCreateSeconds(
  seconds: number,
  labels: { backend: string; region: string },
): void {
  createSeconds.observe(labels, seconds);
}

export function incWorkspaceDestroyFailed(labels: { backend: string; region: string }): void {
  destroyFailed.inc(labels);
}

export function addWorkspaceComputeSeconds(
  seconds: number,
  labels: { backend: string; region: string },
): void {
  computeSeconds.inc(labels, seconds);
}
```

- [ ] **Step 8.2 — Write the failing reaper test.**

Read `apps/api/src/jobs/approvalExpiryReaper.test.ts` first and match its mocking style exactly (how it stubs `../db`, `../services/redis` and `../services/sentry`); the skeleton below assumes that style.

`apps/api/src/jobs/workspaceReaper.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const destroy = vi.fn(async () => undefined);
const execute = vi.fn();
const update = vi.fn();
const captureException = vi.fn();

vi.mock('../db', () => ({
  db: {
    execute: (...args: unknown[]) => execute(...args),
    update: (...args: unknown[]) => update(...args),
  },
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../services/sentry', () => ({ captureException }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/workspace/sandboxBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSandboxBackendByName: vi.fn(() => ({ name: 'fake', destroy })),
}));

import { getSandboxBackendByName } from '../services/workspace/sandboxBackend';
import { reapExpiredWorkspaces } from './workspaceReaper';

function claimReturns(rows: Array<Record<string, unknown>>) {
  execute.mockResolvedValueOnce({ rows });
}

function setBuilder() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  update.mockReturnValueOnce({ set });
  return { set, where };
}

describe('reapExpiredWorkspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    destroy.mockResolvedValue(undefined);
  });

  it('claims nothing and destroys nothing when no row is overdue', async () => {
    claimReturns([]);
    await expect(reapExpiredWorkspaces()).resolves.toEqual({ destroyed: 0, failed: 0 });
    expect(destroy).not.toHaveBeenCalled();
  });

  it('destroys an overdue sandbox by its OWN backend and marks it destroyed', async () => {
    claimReturns([
      { id: 'w1', org_id: 'o1', run_id: 'r1', backend: 'vercel', provider_ref: 'breeze-eu-1', region: 'eu' },
    ]);
    const marked = setBuilder();

    await expect(reapExpiredWorkspaces()).resolves.toEqual({ destroyed: 1, failed: 0 });

    // Dispatched per ROW, not by the process-wide AI_WORKSPACE_BACKEND: a row
    // written before an env flip must still be destroyable.
    expect(getSandboxBackendByName).toHaveBeenCalledWith('vercel');
    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'vercel', providerRef: 'breeze-eu-1', region: 'eu' }),
    );
    expect(marked.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'destroyed', destroyedAt: expect.any(Date) }),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it('marks destroy_failed, records the error, pages, and keeps going', async () => {
    claimReturns([
      { id: 'w1', org_id: 'o1', run_id: 'r1', backend: 'vercel', provider_ref: 'a', region: 'eu' },
      { id: 'w2', org_id: 'o1', run_id: 'r2', backend: 'vercel', provider_ref: 'b', region: 'eu' },
    ]);
    destroy.mockRejectedValueOnce(new Error('vendor 500'));
    const failedUpdate = setBuilder();
    const okUpdate = setBuilder();

    await expect(reapExpiredWorkspaces()).resolves.toEqual({ destroyed: 1, failed: 1 });

    expect(failedUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'destroy_failed', lastError: expect.stringContaining('vendor 500') }),
    );
    expect(okUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'destroyed' }));
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('never throws out of a single bad row', async () => {
    claimReturns([{ id: 'w1', org_id: 'o1', run_id: 'r1', backend: 'nope', provider_ref: 'c', region: 'eu' }]);
    (getSandboxBackendByName as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('No SandboxBackend implementation for "nope"');
    });
    setBuilder();
    await expect(reapExpiredWorkspaces()).resolves.toEqual({ destroyed: 0, failed: 1 });
  });

  it('claims with a 120-second grace and skips rows another instance holds', async () => {
    claimReturns([]);
    await reapExpiredWorkspaces();
    const sqlText = JSON.stringify(execute.mock.calls[0]?.[0] ?? '');
    expect(sqlText).toContain('120 seconds');
    expect(sqlText).toContain('FOR UPDATE SKIP LOCKED');
    expect(sqlText).toContain("'destroying'");
  });
});
```

- [ ] **Step 8.3 — Run it; expect module-not-found.**
```bash
cd apps/api && npx vitest run src/jobs/workspaceReaper.test.ts
```
Expected: `Failed to load url ./workspaceReaper`.

- [ ] **Step 8.4 — Implement the reaper.**

`apps/api/src/jobs/workspaceReaper.ts`:
```ts
/**
 * Workspace orphan reaper (spec §6 step 6, §9 "Worker crash mid-run").
 *
 * Every 60 seconds, destroys any `ai_run_workspaces` row past
 * `deadline_at + 120s` that is not yet `destroyed`, records the outcome, and
 * pages on `destroy_failed`.
 *
 * WHY IT EXISTS: a run's own `finally` destroys its sandbox. A worker that
 * dies mid-run has no `finally`, and the sandbox then bills until its
 * provider-side deadline with nothing in Breeze recording that it is alive.
 * `provider_ref` is precisely what makes that recoverable from another
 * process, which is why §6.2 puts it in the table.
 *
 * WHY IT IS NOT FLAG-GATED: with BREEZE_AI_WORKSPACE_ENABLED off nothing
 * writes this table, so the poll finds nothing and the job is free. Gating it
 * on the flag would mean turning the feature OFF strands every live sandbox —
 * "off" must mean "start nothing new", never "stop watching what already
 * happened" (the same rule aiOperatorTasksEnabled states for the reconciler).
 *
 * Structure deliberately mirrors jobs/approvalExpiryReaper.ts: same queue /
 * worker / repeatable-job shape, same observability attachment, same
 * shutdown pair, same `placement: 'global'` registry entry.
 */
import { Job, Queue, Worker } from 'bullmq';
import { eq, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { aiRunWorkspaces } from '../db/schema/aiWorkspace';
import type { AiWorkspaceBackend, AiWorkspaceRegion } from '../db/schema/aiWorkspace';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { incWorkspaceDestroyFailed } from '../services/aiWorkspaceMetrics';
import { getSandboxBackendByName } from '../services/workspace/sandboxBackend';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'workspace-reaper';
const REAP_INTERVAL_MS = 60 * 1000;
/**
 * Grace after the provider deadline before the reaper takes a row. Long enough
 * that a healthy run's own `finally` always wins the race; short enough that a
 * dead worker's sandbox is reclaimed inside the same minute. Spec §6 step 6.
 */
const REAP_GRACE_SECONDS = 120;
const MAX_REAP_PER_RUN = 100;

type ReaperJobData = { type: 'reap-expired-workspaces'; queuedAt: string };

interface ClaimedRow {
  id: string;
  org_id: string;
  run_id: string;
  backend: AiWorkspaceBackend;
  provider_ref: string;
  region: AiWorkspaceRegion;
}

let reaperQueue: Queue<ReaperJobData> | null = null;
let reaperWorker: Worker<ReaperJobData> | null = null;

function getQueue(): Queue<ReaperJobData> {
  if (!reaperQueue) {
    reaperQueue = new Queue<ReaperJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reaperQueue;
}

function rowsOf(result: unknown): ClaimedRow[] {
  const maybe = result as { rows?: ClaimedRow[] } | ClaimedRow[];
  const rows = Array.isArray(maybe) ? maybe : maybe?.rows;
  return Array.isArray(rows) ? rows : [];
}

/**
 * One pass. Claims up to MAX_REAP_PER_RUN overdue rows by flipping them to
 * `destroying` under FOR UPDATE SKIP LOCKED — so two API instances never call
 * destroy() on the same sandbox — then destroys each one.
 */
export async function reapExpiredWorkspaces(): Promise<{ destroyed: number; failed: number }> {
  const claimed = await db.execute<ClaimedRow>(sql`
    WITH due AS (
      SELECT id
      FROM ai_run_workspaces
      WHERE status <> 'destroyed'
        AND status <> 'destroying'
        AND deadline_at < now() - interval '120 seconds'
      ORDER BY deadline_at ASC
      LIMIT ${MAX_REAP_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ai_run_workspaces AS w
    SET status = 'destroying'
    FROM due
    WHERE w.id = due.id
    RETURNING w.id, w.org_id, w.run_id, w.backend, w.provider_ref, w.region;
  `);

  const rows = rowsOf(claimed);
  let destroyed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const backend = getSandboxBackendByName(row.backend);
      await backend.destroy({
        backend: row.backend,
        providerRef: row.provider_ref,
        region: row.region,
        createdAt: new Date(0),
      });
      await db
        .update(aiRunWorkspaces)
        .set({ status: 'destroyed', destroyedAt: new Date(), lastError: null })
        .where(eq(aiRunWorkspaces.id, row.id));
      destroyed += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Spec §9: the row is marked destroy_failed and PAGED. The reaper picks
      // it up again next minute (status <> 'destroyed'), which is the backoff.
      // Never rethrow: one stuck vendor row must not stop the rest draining.
      await db
        .update(aiRunWorkspaces)
        .set({
          status: 'destroy_failed',
          destroyAttempts: sql`${aiRunWorkspaces.destroyAttempts} + 1`,
          lastError: message.slice(0, 2000),
        })
        .where(eq(aiRunWorkspaces.id, row.id))
        .catch((updateErr) => {
          console.error('[WorkspaceReaper] Failed to record destroy_failed:', updateErr);
        });
      incWorkspaceDestroyFailed({ backend: row.backend, region: row.region });
      console.error(
        `[WorkspaceReaper] destroy failed for workspace ${row.id} (${row.backend}/${row.provider_ref}):`,
        err,
      );
      captureException(err instanceof Error ? err : new Error(message), undefined, {
        job: 'workspaceReaper',
        backend: row.backend,
        region: row.region,
      });
    }
  }

  if (rows.length === MAX_REAP_PER_RUN) {
    console.warn(`[WorkspaceReaper] Hit ${MAX_REAP_PER_RUN}-item cap — backlog may be growing`);
  }

  return { destroyed, failed };
}

function createWorker(): Worker<ReaperJobData> {
  return new Worker<ReaperJobData>(
    QUEUE_NAME,
    async (_job: Job<ReaperJobData>) => {
      try {
        const result = await withSystemDbAccessContext(reapExpiredWorkspaces);
        if (result.destroyed > 0 || result.failed > 0) {
          console.log(
            `[WorkspaceReaper] destroyed ${result.destroyed}, failed ${result.failed}`,
          );
        }
        return result;
      } catch (err) {
        console.error('[WorkspaceReaper] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === 'reap-expired-workspaces') {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    'reap-expired-workspaces',
    { type: 'reap-expired-workspaces', queuedAt: new Date().toISOString() },
    {
      jobId: 'workspace-reaper',
      repeat: { every: REAP_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeWorkspaceReaper(): Promise<void> {
  if (reaperWorker) return;
  reaperWorker = createWorker();
  attachWorkerObservability(reaperWorker, 'workspaceReaper');
  reaperWorker.on('error', (error) => {
    console.error('[WorkspaceReaper] Worker error:', error);
    captureException(error);
  });
  reaperWorker.on('failed', (job, error) => {
    console.error(`[WorkspaceReaper] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reaperWorker.close();
    reaperWorker = null;
    throw err;
  }
  console.log('[WorkspaceReaper] Initialized');
}

export async function shutdownWorkspaceReaper(): Promise<void> {
  const worker = reaperWorker;
  const queue = reaperQueue;
  reaperWorker = null;
  reaperQueue = null;
  if (worker) {
    try {
      await worker.close();
    } catch (err) {
      console.error('[WorkspaceReaper] Error closing worker:', err);
    }
  }
  if (queue) {
    try {
      await queue.close();
    } catch (err) {
      console.error('[WorkspaceReaper] Error closing queue:', err);
    }
  }
}
```

Note the deliberate mismatch between the SQL literal `interval '120 seconds'` and the `REAP_GRACE_SECONDS` constant: Drizzle's `sql` template would parameterise an interpolated number, and a **parameter** in that predicate is invisible to the planner's partial-index proof against `ai_run_workspaces_reaper_idx` (migration header note 2). The constant is kept for documentation and asserted against the literal in the test below — if you change one, the test makes you change the other.

Add to `workspaceReaper.test.ts`:
```ts
  it('keeps the SQL literal and the documented grace constant in step', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./workspaceReaper.ts', import.meta.url), 'utf8'));
    const constant = /REAP_GRACE_SECONDS = (\d+)/.exec(source)?.[1];
    expect(source).toContain(`interval '${constant} seconds'`);
  });
```

- [ ] **Step 8.5 — Run the reaper suite; expect PASS.**
```bash
cd apps/api && npx vitest run src/jobs/workspaceReaper.test.ts
```

- [ ] **Step 8.6 — Register the job.**

`apps/api/src/services/workerRegistry.ts`, immediately after the `approvalExpiryReaper` entry:
```ts
  {
    name: 'workspaceReaper',
    // 'global', like approvalExpiryReaper: it touches Postgres and the sandbox
    // vendor only — no agent WS, no socket-local dispatch — so any role may
    // host it, and exactly one instance claims each row (FOR UPDATE SKIP
    // LOCKED). Not flag-gated on purpose; see the job's header.
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/workspaceReaper');
      return { init: m.initializeWorkspaceReaper, shutdown: m.shutdownWorkspaceReaper };
    },
  },
```

Then run whatever guards that file:
```bash
cd apps/api && npx vitest run src/services/workerRegistry src/services/workerEntrypointClosure.contract.test.ts
```
Expected: green. A `workerEntrypointClosure` failure means the reaper's import graph reaches a route or the full service graph — the usual culprit is importing a metrics helper that is not a leaf, which is exactly why `aiWorkspaceMetrics.ts` imports only `metricsRegistry`.

- [ ] **Step 8.7 — Commit.**
```bash
git add apps/api/src/jobs/workspaceReaper.ts apps/api/src/jobs/workspaceReaper.test.ts \
        apps/api/src/services/aiWorkspaceMetrics.ts apps/api/src/services/workerRegistry.ts
git commit -m "feat(ai): workspace orphan reaper and execution-plane metrics (execution plane W02)"
```

---

### Task 9: compute pricing — `COMPUTE_PRICING` and `calculateComputeCents`

**Files:**
- Create: `apps/api/src/services/aiComputePricing.ts`
- Create: `apps/api/src/services/aiComputePricing.test.ts`
- Modify: `apps/api/src/services/aiCostTracker.ts` (re-export block, near the `MODEL_PRICING` / `OFFERABLE_AI_MODELS` section ~lines 92–125)

**Interfaces:**
- Produces:
```ts
export interface ComputePrice {
  cpuCentsPerHour: number;
  memCentsPerGbHour: number;
  minChargeCents: number;
  /** additive: vendor bills memory in whole-minute increments. */
  minBillableWallMs: number;
}
export const COMPUTE_PRICING: Partial<Record<AiWorkspaceBackend, ComputePrice>>;
export function computePriceMultiplier(env?: NodeJS.ProcessEnv): number;  // AI_COMPUTE_PRICE_MULTIPLIER, default 1
export function calculateComputeCents(
  backend: AiWorkspaceBackend,
  usage: SandboxUsage,
  memGb: number,
): number;   // throws SandboxError('create_failed') on an unpriced backend
export const AI_COMPUTE_PRICE_MULTIPLIER_ENV = 'AI_COMPUTE_PRICE_MULTIPLIER';
```
`aiCostTracker.ts` re-exports `COMPUTE_PRICING` and `calculateComputeCents` so the contract's "in `aiCostTracker.ts`" is satisfied without adding another ~120 lines to a file already at 1,523.

Design decisions:

- **`Partial<Record<...>>`, not a full record.** Spec §5.6: "Unknown backend → refuse to create, never $0." A full record forces a number for `gvisor_pool` and `agentcore`, which are not implemented and have no price; a partial record lets `calculateComputeCents` throw for them, which is the specified behaviour. `fake` IS priced — at all zeros, with `minChargeCents: 0` — because a test backend that threw would make every W03 unit test need a pricing stub.
- **`minBillableWallMs: 60_000` for vercel** is the vendor's documented 1-minute minimum increment on provisioned memory. Modelling it is the difference between a plausible number and a correct one for the common case (a 4-second analysis step).
- **`Math.ceil`, never `Math.round`.** Cents are the billing unit; rounding a 0.4-cent run to 0 is the "$0 run" the spec forbids, and `minChargeCents` would be the only thing standing between us and free compute.
- **The multiplier is read at CALL time**, like every other runtime flag in this repo, so a test can set it per case without `vi.resetModules()`.
- **Reservation/settlement (`reserveComputeCents` / `settleComputeCents`) is W04's**, not this wave's: it needs the `analysis` profile's limits and the admission path. This task ships only the pure pricing half, which is exactly what spec §12's `computeMetering.test.ts` covers for W02.

- [ ] **Step 9.1 — Write the failing test.**

`apps/api/src/services/aiComputePricing.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPUTE_PRICING,
  calculateComputeCents,
  computePriceMultiplier,
} from './aiComputePricing';

const HOUR_MS = 3_600_000;

afterEach(() => {
  delete process.env.AI_COMPUTE_PRICE_MULTIPLIER;
});

describe('COMPUTE_PRICING', () => {
  it('prices vercel from the verified list price and charges a 1-cent minimum', () => {
    expect(COMPUTE_PRICING.vercel).toEqual({
      cpuCentsPerHour: 12.8,
      memCentsPerGbHour: 2.12,
      minChargeCents: 1,
      minBillableWallMs: 60_000,
    });
  });

  it('prices fake at zero so unit tests need no pricing stub', () => {
    expect(COMPUTE_PRICING.fake?.minChargeCents).toBe(0);
  });

  it('leaves unimplemented backends unpriced rather than free', () => {
    expect(COMPUTE_PRICING.gvisor_pool).toBeUndefined();
    expect(COMPUTE_PRICING.agentcore).toBeUndefined();
  });
});

describe('computePriceMultiplier', () => {
  it.each([
    [undefined, 1],
    ['1', 1],
    ['2.5', 2.5],
    ['', 1],
    ['not-a-number', 1],
    ['-3', 1],
    ['0', 1],
  ])('%s → %s', (raw, expected) => {
    const env = (raw === undefined ? {} : { AI_COMPUTE_PRICE_MULTIPLIER: raw }) as NodeJS.ProcessEnv;
    expect(computePriceMultiplier(env)).toBe(expected);
  });
});

describe('calculateComputeCents', () => {
  it('throws on an unpriced backend — never returns 0 (spec §5.6)', () => {
    expect(() =>
      calculateComputeCents('gvisor_pool', { cpuMs: HOUR_MS, wallMs: HOUR_MS, memAllocatedMb: 2048 }, 2),
    ).toThrowError(/gvisor_pool/);
  });

  it('prices one CPU-hour at one full-memory hour correctly', () => {
    // 1 cpu-hour * 12.8 + 2 GB * 1 h * 2.12 = 12.8 + 4.24 = 17.04 -> ceil 18
    const cents = calculateComputeCents(
      'vercel',
      { cpuMs: HOUR_MS, wallMs: HOUR_MS, memAllocatedMb: 2048 },
      2,
    );
    expect(cents).toBe(18);
  });

  it('applies the vendor one-minute memory floor to a short run', () => {
    // 4 s of wall clock bills as 60 s of memory:
    //   cpu 1000ms   -> 12.8 * (1000/3.6e6)      = 0.003555…
    //   mem 2 GB*60s -> 2.12 * 2 * (60000/3.6e6) = 0.070666…
    //   total 0.0742… -> below the 1-cent minimum
    expect(
      calculateComputeCents('vercel', { cpuMs: 1_000, wallMs: 4_000, memAllocatedMb: 2048 }, 2),
    ).toBe(1);
  });

  it('never returns 0 for a real backend even at zero usage', () => {
    expect(calculateComputeCents('vercel', { cpuMs: 0, wallMs: 0, memAllocatedMb: 2048 }, 2)).toBe(1);
  });

  it('returns 0 for the fake backend', () => {
    expect(calculateComputeCents('fake', { cpuMs: HOUR_MS, wallMs: HOUR_MS, memAllocatedMb: 2048 }, 2))
      .toBe(0);
  });

  it('applies AI_COMPUTE_PRICE_MULTIPLIER at call time', () => {
    process.env.AI_COMPUTE_PRICE_MULTIPLIER = '3';
    expect(
      calculateComputeCents('vercel', { cpuMs: HOUR_MS, wallMs: HOUR_MS, memAllocatedMb: 2048 }, 2),
    ).toBe(52); // 17.04 * 3 = 51.12 -> ceil 52
  });

  it('rejects a non-finite or negative usage rather than billing nonsense', () => {
    expect(() =>
      calculateComputeCents('vercel', { cpuMs: Number.NaN, wallMs: 1, memAllocatedMb: 2048 }, 2),
    ).toThrowError(/usage/);
    expect(() =>
      calculateComputeCents('vercel', { cpuMs: -1, wallMs: 1, memAllocatedMb: 2048 }, 2),
    ).toThrowError(/usage/);
  });
});

describe('aiCostTracker re-exports', () => {
  it('exposes the pricing surface at the contract-named module', async () => {
    const tracker = await import('./aiCostTracker');
    expect(tracker.COMPUTE_PRICING).toBe(COMPUTE_PRICING);
    expect(tracker.calculateComputeCents).toBe(calculateComputeCents);
  });
});
```

- [ ] **Step 9.2 — Run it; expect module-not-found.**
```bash
cd apps/api && npx vitest run src/services/aiComputePricing.test.ts
```

- [ ] **Step 9.3 — Implement.**

`apps/api/src/services/aiComputePricing.ts`:
```ts
/**
 * Sandbox compute pricing (spec §5.6).
 *
 * A PURE module — no db, no env at import time, no I/O — so it can be unit
 * tested without a single mock and imported by the worker role for free. It is
 * re-exported from aiCostTracker.ts (the name the cross-wave contract uses)
 * rather than living there, because that file is already 1,500 lines and this
 * is a self-contained concern.
 *
 * PRICES ARE VENDOR LIST PRICES, VERIFIED 2026-09-13 for Vercel `iad1` on the
 * Pro plan: active CPU $0.128/h, provisioned memory $0.0212/GB-h billed in
 * 1-minute minimum increments. Regional rates "vary by region" and were not
 * extracted; AI_COMPUTE_PRICE_MULTIPLIER covers that gap (and any margin
 * product later decides) without another code change. Do NOT edit these
 * numbers without re-confirming against the vendor pricing page, exactly as
 * MODEL_PRICING in aiCostTracker.ts says of the token rates.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE (spec §5.6, §9):
 *  1. An unknown or unimplemented backend REFUSES — it never prices at $0.
 *     That is why COMPUTE_PRICING is a Partial record: `gvisor_pool` and
 *     `agentcore` are declared in the vocabulary but not implemented, and a
 *     full Record<> would force a made-up number for them.
 *  2. A real run is never free. Math.ceil, not Math.round, plus a
 *     minChargeCents floor.
 */
import type { AiWorkspaceBackend } from '../db/schema/aiWorkspace';
import { SandboxError, type SandboxUsage } from './workspace/sandboxBackend';

export const AI_COMPUTE_PRICE_MULTIPLIER_ENV = 'AI_COMPUTE_PRICE_MULTIPLIER';

const HOUR_MS = 3_600_000;

export interface ComputePrice {
  cpuCentsPerHour: number;
  memCentsPerGbHour: number;
  /** Floor for any priced run. Vercel's own creation fee is folded into this. */
  minChargeCents: number;
  /**
   * Vendor bills provisioned memory in whole-minute increments, so a 4-second
   * step still costs a minute of RAM. Modelling it is the difference between a
   * plausible number and a correct one for the common case.
   */
  minBillableWallMs: number;
}

export const COMPUTE_PRICING: Partial<Record<AiWorkspaceBackend, ComputePrice>> = {
  vercel: {
    cpuCentsPerHour: 12.8,
    memCentsPerGbHour: 2.12,
    minChargeCents: 1,
    minBillableWallMs: 60_000,
  },
  // The in-process fake costs nothing and must never be billed. Priced (rather
  // than absent) so W03's unit tests can call this without a pricing stub.
  fake: {
    cpuCentsPerHour: 0,
    memCentsPerGbHour: 0,
    minChargeCents: 0,
    minBillableWallMs: 0,
  },
  // gvisor_pool and agentcore are DELIBERATELY absent — see rule 1 above.
};

/** Read at call time so a test (and an operator) can change it without a reload. */
export function computePriceMultiplier(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[AI_COMPUTE_PRICE_MULTIPLIER_ENV]?.trim();
  if (!raw) return 1;
  const parsed = Number(raw);
  // A malformed or non-positive multiplier must not zero out billing; fall back
  // to 1 and keep charging list price.
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

export function calculateComputeCents(
  backend: AiWorkspaceBackend,
  usage: SandboxUsage,
  memGb: number,
): number {
  const price = COMPUTE_PRICING[backend];
  if (!price) {
    throw new SandboxError(
      'create_failed',
      `No compute price for backend "${backend}" — refusing to price a run at $0 (spec §5.6)`,
      { backend },
    );
  }
  for (const [label, value] of [['cpuMs', usage.cpuMs], ['wallMs', usage.wallMs], ['memGb', memGb]] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new SandboxError('usage_unavailable', `invalid usage.${label}: ${value}`, { backend });
    }
  }

  const billableWallMs = Math.max(usage.wallMs, price.minBillableWallMs);
  const cpuCents = (usage.cpuMs / HOUR_MS) * price.cpuCentsPerHour;
  const memCents = memGb * (billableWallMs / HOUR_MS) * price.memCentsPerGbHour;
  const raw = (cpuCents + memCents) * computePriceMultiplier();

  if (price.minChargeCents === 0 && raw === 0) return 0;
  // Ceil, not round: a 0.4-cent run must cost 1 cent, never 0.
  return Math.max(price.minChargeCents, Math.ceil(raw));
}
```

`apps/api/src/services/aiCostTracker.ts`, beside the `MODEL_PRICING` block:
```ts
// Sandbox COMPUTE pricing (spec §5.6) lives in its own pure module and is
// re-exported here because that is the name the execution-plane wave contract
// uses. Kept out of this file's body deliberately: aiCostTracker.ts is already
// ~1,500 lines, and compute pricing has no dependency on anything in it.
export {
  AI_COMPUTE_PRICE_MULTIPLIER_ENV,
  COMPUTE_PRICING,
  type ComputePrice,
  calculateComputeCents,
  computePriceMultiplier,
} from './aiComputePricing';
```

- [ ] **Step 9.4 — Run it; expect PASS.**
```bash
cd apps/api && npx vitest run src/services/aiComputePricing.test.ts
```
Expected: all green, including the `aiCostTracker` re-export case. If that last case fails with a module-load error rather than an assertion, the re-export pulled the pricing module into `aiCostTracker`'s already-heavy import graph in a way that broke a mock in another suite — run `npx vitest run src/services/aiCostTracker` and fix before continuing.

- [ ] **Step 9.5 — Commit.**
```bash
git add apps/api/src/services/aiComputePricing.ts apps/api/src/services/aiComputePricing.test.ts \
        apps/api/src/services/aiCostTracker.ts
git commit -m "feat(ai): sandbox compute pricing — COMPUTE_PRICING and calculateComputeCents (execution plane W02)"
```

---

### Task 10: config — flags, `.env.example`, and the production boot check

**Files:**
- Modify: `apps/api/src/config/env.ts` (after the `aiOperatorServiceRecoveryEnabled` block, ~line 140)
- Modify: `apps/api/src/config/validate.ts` (`envObjectSchema` declarations ~line 622; production `superRefine` block ~line 1276, beside the `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` rule)
- Modify: `apps/api/src/config/validate.test.ts` (the existing `describe('validateConfig', …)` block — its `withEnv` helper and `validEnv` base live at lines 1–42 and are the only harness this wave uses)
- Modify: `.env.example` (repo root — there is **no** `apps/api/.env.example`; verify with `ls apps/api/.env* 2>/dev/null`)

**Interfaces:**
- Produces:
```ts
// env.ts
export function aiWorkspaceEnabled(): boolean;   // isHosted() && AI agents flag && workspace sub-flag
```

- [ ] **Step 10.1 — Write the failing config test.**

The harness already exists in `apps/api/src/config/validate.test.ts` (lines 1–42): a module-local `withEnv(overrides, fn)` that mutates `process.env` and restores it, a shared `validEnv` base object, and `validateConfig()` — **no arguments; it reads `process.env`**. That is the whole harness: there is no env-parsing function that takes an object and no production-fixture factory, so do not import or invent one. `withEnv` can only *set* keys, so a "missing" variable is expressed as `''`, exactly as the neighbouring `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` cases do (`validate.test.ts:603-635`).

Append inside the existing `describe('validateConfig', …)` block, beside those cases:
```ts
  // Execution plane W02 (spec §8 "Hosted only", §2.2 D-I). The workspace flag
  // spends LanternOps' own money in LanternOps' own Vercel tenant, so a
  // production deploy that turns it on without a backend and credentials must
  // die at boot, not at the first analysis run.
  const workspaceProdEnv = {
    ...validEnv,
    NODE_ENV: 'production',
    CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
    TRUST_PROXY_HEADERS: 'true',
    IS_HOSTED: 'true',
  };

  it('boots in production when the workspace flag is off, whatever else is unset', () => {
    withEnv({
      ...workspaceProdEnv,
      BREEZE_AI_WORKSPACE_ENABLED: 'false',
      AI_WORKSPACE_BACKEND: '',
      VERCEL_SANDBOX_TOKEN: '',
      VERCEL_TEAM_ID: '',
      VERCEL_PROJECT_ID: '',
    }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });

  it('refuses BREEZE_AI_WORKSPACE_ENABLED in production without AI_WORKSPACE_BACKEND', () => {
    withEnv({
      ...workspaceProdEnv,
      BREEZE_AI_WORKSPACE_ENABLED: 'true',
      AI_WORKSPACE_BACKEND: '',
      VERCEL_SANDBOX_TOKEN: 'prod-test-vercel-sandbox-token',
      VERCEL_TEAM_ID: 'team_xxx',
      VERCEL_PROJECT_ID: 'prj_xxx',
    }, () => {
      expect(() => validateConfig()).toThrow(/AI_WORKSPACE_BACKEND/);
    });
  });

  it('refuses the fake backend in production with the workspace flag on', () => {
    withEnv({
      ...workspaceProdEnv,
      BREEZE_AI_WORKSPACE_ENABLED: 'true',
      AI_WORKSPACE_BACKEND: 'fake',
      VERCEL_SANDBOX_TOKEN: 'prod-test-vercel-sandbox-token',
      VERCEL_TEAM_ID: 'team_xxx',
      VERCEL_PROJECT_ID: 'prj_xxx',
    }, () => {
      expect(() => validateConfig()).toThrow(/AI_WORKSPACE_BACKEND/);
    });
  });

  it('refuses the workspace flag without IS_HOSTED=true', () => {
    withEnv({
      ...workspaceProdEnv,
      IS_HOSTED: 'false',
      BREEZE_AI_WORKSPACE_ENABLED: 'true',
      AI_WORKSPACE_BACKEND: 'vercel',
      VERCEL_SANDBOX_TOKEN: 'prod-test-vercel-sandbox-token',
      VERCEL_TEAM_ID: 'team_xxx',
      VERCEL_PROJECT_ID: 'prj_xxx',
    }, () => {
      expect(() => validateConfig()).toThrow(/IS_HOSTED/);
    });
  });

  it.each(['VERCEL_SANDBOX_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'])(
    'refuses the workspace flag without %s',
    (missing) => {
      withEnv({
        ...workspaceProdEnv,
        BREEZE_AI_WORKSPACE_ENABLED: 'true',
        AI_WORKSPACE_BACKEND: 'vercel',
        VERCEL_SANDBOX_TOKEN: 'prod-test-vercel-sandbox-token',
        VERCEL_TEAM_ID: 'team_xxx',
        VERCEL_PROJECT_ID: 'prj_xxx',
        [missing]: '',
      }, () => {
        expect(() => validateConfig()).toThrow(new RegExp(missing));
      });
    },
  );

  it('accepts a fully configured hosted deployment', () => {
    withEnv({
      ...workspaceProdEnv,
      BREEZE_AI_WORKSPACE_ENABLED: 'true',
      AI_WORKSPACE_BACKEND: 'vercel',
      VERCEL_SANDBOX_TOKEN: 'prod-test-vercel-sandbox-token',
      VERCEL_TEAM_ID: 'team_xxx',
      VERCEL_PROJECT_ID: 'prj_xxx',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('production');
    });
  });
```

Two things a reviewer should check here. First, the placeholders: `team_xxx` / `prj_xxx` and a literal `prod-test-…` token — never a real Vercel id or token, in this file or in `.env.example`. Second, the `it.each` cases assert on a `RegExp` built from the variable name, so the production rule in Step 10.4 **must name the missing variable in its message** — a generic "Vercel credentials are required" would leave three tests red and the operator guessing.

- [ ] **Step 10.2 — Run it; expect the "accepts" case to pass and every refusal case to fail (no rule exists yet).**
```bash
cd apps/api && npx vitest run src/config/validate.test.ts
```

- [ ] **Step 10.3 — Add the runtime flag helper.**

`apps/api/src/config/env.ts`, after `aiOperatorServiceRecoveryEnabled`:
```ts
/**
 * AI execution-plane workspaces (spec §8 "Hosted only", §2.2 D-I).
 *
 * THREE conditions, all read at CALL time so a test can flip one without
 * vi.resetModules(): the deployment is hosted, the AI agents platform switch is
 * on, and this sub-flag is on. Default OFF.
 *
 * Hosted-only is not squeamishness: the sandbox runs on a third-party vendor
 * under LanternOps' own account and billing, so a self-hosted deployment
 * enabling it would be spending our money in our tenant. config/validate.ts
 * refuses the flag in production without IS_HOSTED=true, a `vercel` backend and
 * all three Vercel credentials, so a misconfigured deploy fails at boot rather
 * than at the first analysis run.
 */
export function aiWorkspaceEnabled(): boolean {
  return (
    isHosted()
    && envFlag('BREEZE_AI_AGENTS_ENABLED', false)
    && envFlag('BREEZE_AI_WORKSPACE_ENABLED', false)
  );
}
```

- [ ] **Step 10.4 — Declare the env vars and add the production rule.**

`apps/api/src/config/validate.ts`, in `envObjectSchema` beside `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`:
```ts
    // AI execution plane (spec §8). Sub-flag of BREEZE_AI_AGENTS_ENABLED, read
    // at runtime by aiWorkspaceEnabled() in env.ts. Validated here for boolean
    // format only — the production coupling rule is in the superRefine below.
    BREEZE_AI_WORKSPACE_ENABLED: z.string().optional(),
    // 'vercel' | 'fake'. Resolved at runtime by resolveSandboxBackendName()
    // (services/workspace/sandboxBackend.ts), which refuses an unset value in
    // production; the superRefine below additionally refuses 'fake' there.
    AI_WORKSPACE_BACKEND: z.string().optional(),
    VERCEL_SANDBOX_TOKEN: z.string().optional(),
    VERCEL_TEAM_ID: z.string().optional(),
    VERCEL_PROJECT_ID: z.string().optional(),
    VERCEL_SANDBOX_REGION_EU: z.string().optional(),
    VERCEL_SANDBOX_REGION_US: z.string().optional(),
    // Margin/regional-rate multiplier on COMPUTE_PRICING (services/
    // aiComputePricing.ts). Default 1; a malformed value falls back to 1 there
    // rather than zeroing billing.
    AI_COMPUTE_PRICE_MULTIPLIER: z.string().optional(),
```

and, in the production `superRefine` block immediately after the `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` rule:
```ts
      // AI execution plane (spec §8, §2.2 D-I). Modelled on the manifest-key
      // rule above: a feature whose misconfiguration is SILENT at boot and
      // expensive at runtime gets a boot-time refusal, not a console.error.
      //
      // Three couplings, each a real failure mode:
      //  - IS_HOSTED: the sandbox vendor account and its bill are LanternOps';
      //    a self-hoster enabling this spends our money in our tenant.
      //  - backend must be 'vercel': 'fake' runs model-authored code IN the API
      //    process with the API process's filesystem and network — not a
      //    sandbox at all — and an unset value would have
      //    resolveSandboxBackendName() throw on the first analysis run instead
      //    of here.
      //  - all three Vercel credentials: readVercelCredentials() deliberately
      //    never falls back to the SDK's ambient-env discovery, so a
      //    half-configured deploy fails every run rather than quietly using
      //    whatever token the host carries.
      const workspaceFlag = (data.BREEZE_AI_WORKSPACE_ENABLED ?? '').trim().toLowerCase();
      if (workspaceFlag === 'true' || workspaceFlag === '1' || workspaceFlag === 'yes') {
        if ((data.IS_HOSTED ?? '').trim().toLowerCase() !== 'true') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['IS_HOSTED'],
            message:
              'BREEZE_AI_WORKSPACE_ENABLED=true requires IS_HOSTED=true — the AI execution plane runs on a third-party sandbox vendor under the LanternOps account and is hosted-only (execution-plane design §8).',
          });
        }
        const backend = (data.AI_WORKSPACE_BACKEND ?? '').trim().toLowerCase();
        if (backend !== 'vercel') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['AI_WORKSPACE_BACKEND'],
            message:
              'BREEZE_AI_WORKSPACE_ENABLED=true requires AI_WORKSPACE_BACKEND=vercel in production. "fake" executes model-authored code inside the API process with the API process\'s filesystem and network — it is a test double, not an isolation boundary.',
          });
        }
        for (const key of ['VERCEL_SANDBOX_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] as const) {
          if (!data[key]?.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message:
                `${key} must be set when BREEZE_AI_WORKSPACE_ENABLED=true — the Vercel SDK's ambient-credential fallback is deliberately not used, so a missing value fails every analysis run instead of booting cleanly.`,
            });
          }
        }
      }
```

- [ ] **Step 10.5 — Run the config suite; expect PASS.**
```bash
cd apps/api && npx vitest run src/config/validate.test.ts src/config/env
```

- [ ] **Step 10.6 — Document every new var in `.env.example`.**

Append to the AI section of the repo-root `.env.example` (after the `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` block, ~line 1100). **Generic placeholders only** — never a real team id, project id or token:
```bash
# AI execution plane — sandboxed analysis workspaces (hosted only).
# Sub-flag of BREEZE_AI_AGENTS_ENABLED above; default false. When true in
# production the API refuses to boot unless IS_HOSTED=true, the backend is
# `vercel`, and all three VERCEL_* values below are set.
# BREEZE_AI_WORKSPACE_ENABLED=false
#
# Sandbox provider. `vercel` in production; `fake` is an in-process test double
# that runs code in the API process itself and is refused in production.
# AI_WORKSPACE_BACKEND=vercel
#
# Vercel Sandbox credentials. The token needs sandbox create/exec/delete on the
# project below; the SDK's ambient-credential fallback is deliberately unused.
# VERCEL_SANDBOX_TOKEN=
# VERCEL_TEAM_ID=team_xxxxxxxxxxxxxxxxxxxxxxxx
# VERCEL_PROJECT_ID=prj_xxxxxxxxxxxxxxxxxxxxxxxx
#
# Sandbox region per Breeze region. The sandbox region is asserted to equal the
# org's region at create. Do NOT use lhr1 for EU — the UK is a third country
# for GDPR transfer purposes.
# VERCEL_SANDBOX_REGION_EU=fra1
# VERCEL_SANDBOX_REGION_US=iad1
#
# Multiplier applied to vendor list compute prices (margin, and the regional
# rate spread we have not extracted). Default 1.0; a malformed or non-positive
# value falls back to 1.0 rather than zeroing billing.
# AI_COMPUTE_PRICE_MULTIPLIER=1.0
```

Then check no secret leaked in:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
grep -nE 'team_[a-zA-Z0-9]{10,}|prj_[a-zA-Z0-9]{10,}' .env.example | grep -v 'xxxxx' || echo 'no real ids'
bash scripts/check-supply-chain-hardening.sh || true
```
Expected: `no real ids`, and the hardening script passes (it also scans the new workflow file).

- [ ] **Step 10.7 — Whole-wave verification before opening the PR.**

The wave touches tenancy, a migration and billing, so the full suites run now — a targeted-file sweep is **not** CI (a fixer's touched-file sweep has missed Test API contracts before).

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
pnpm lint
cd apps/api && npx tsc --noEmit -p tsconfig.json
# FULL unit suite, not a path filter — this is the Test API job.
npx vitest run
# The contract suites pnpm test does NOT cover:
pnpm test:rls
pnpm test:rls-coverage
pnpm test:integration-suite-coverage
npx vitest run --config vitest.integration.config.ts
# And prove the nightly still collects-and-skips with no credentials:
npx vitest run --config vitest.config.workspace-e2e.ts
```
Expected: all green. Then tear the stack down — nothing reaps it for you:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e && pnpm test-stack down
```

- [ ] **Step 10.8 — Commit and open the PR.**
```bash
git add apps/api/src/config/env.ts apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts .env.example
git commit -m "feat(ai): workspace flag, Vercel config and production boot gate (execution plane W02)"
git push -u origin HEAD
```

The PR body must carry, under a **Before merge** heading:
1. The three repository secrets the nightly needs (`VERCEL_SANDBOX_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`) — absent, the nightly reds on its first 03:17 UTC run.
2. The result of Step 5.3 (the one manual real-Vercel contract run): pass, or the exact SDK error.
3. A statement that every flag ships **off** and that nothing in this wave changes runtime behaviour while `BREEZE_AI_WORKSPACE_ENABLED` is unset — the reaper runs unconditionally but has no rows.
4. `Closes #<wave sub-issue>`.

And, because this PR adds a migration and touches the cascade/export registries, note in the body that **Integration Tests shard 2 and shard 3 are the gates that matter here** (merge contract, org-merge registry), and that a stacked branch runs no CI at all — if this PR is based on a sibling branch rather than `main`, dispatch CI per branch (`gh workflow run CI --ref <branch>`) before enqueueing.
