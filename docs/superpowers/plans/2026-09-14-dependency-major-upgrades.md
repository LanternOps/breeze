# Dependency Major-Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the backlog of major-version dependency bumps that dependabot cannot propose on its own, in an order where each PR is independently green and revertible, with the two high-blast-radius bumps (ioredis 6, BullMQ 6) isolated and soaked before release.

**Architecture:** Six waves, one PR per task, ordered by blast radius. Wave 1 is Node-floor-only majors that change no API we call. Wave 2 pins the ioredis wire protocol before the bump so the driver upgrade is behaviour-neutral. Wave 3 migrates every BullMQ repeatable registration to the Job Scheduler API *on BullMQ 5* (supported since 5.16), ships a one-release legacy-key sweep, and only then bumps to 6. Waves 4–6 are toolchain. A deferred list names what is blocked and by what.

**Tech Stack:** pnpm 10.34 workspace, Node 22.23.2 (floor `>=22.22.2`), Vitest 4.1, Vite 8.2, TypeScript 5.9, Expo SDK 57 / RN 0.86.

**Spec:** This document is self-contained. Source facts: `pnpm outdated -r` on 2026-09-14 and upstream changelogs researched the same day (URLs inline per task).

## Global Constraints

- Node floor stays `>=22.22.2` (`package.json` engines, `.nvmrc` 22.23.2). Every package below has a Node floor at or under 22, so no engine change is needed.
- One PR per task. No bundling of majors across tasks; a red queue run must point at one package.
- Every PR runs `pnpm install --frozen-lockfile`, the affected package's `tsc --noEmit` (with `NODE_OPTIONS=--max-old-space-size=8192` for `apps/api`), and the unit suites of every file importing the bumped package. Waves 2–3 also run the integration suite on a `pnpm test-stack up` stack and a `pnpm wt-stack up` boot smoke. Tear both down after.
- Merge via `gh pr merge <N>` (merge queue). Never `--admin`.
- `pnpm outdated` crashes in `e2e-tests/` on pnpm 10.34.5; that directory is dependabot-covered and out of scope here.
- Baseline PR already merged or queued: #5821 (Anthropic SDKs + dependabot `anthropic` group + root npm limit 10→15).

---

## Wave 1 — Node-floor-only majors (low blast radius, one afternoon)

Each of these changes nothing we call. Verification is typecheck + the importing files' tests. Rigor: low.

### Task 1.1: nodemailer 9 → 10

**Files:**
- Modify: `apps/api/package.json` (`nodemailer`, `@types/nodemailer`)
- Test: `apps/api/src/services/email.test.ts` (existing)

Breaking changes: Node ≥20 only; TypeScript rewrite with dual ESM/CJS, `@types/nodemailer` layout preserved. Source: https://github.com/nodemailer/nodemailer/blob/master/CHANGELOG.md

- [ ] **Step 1: Bump**

```bash
pnpm --filter @breeze/api up nodemailer@latest @types/nodemailer@latest
```

- [ ] **Step 2: Typecheck + tests**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
npx vitest run src/services/email
```

Expected: 0 TS errors; email suites pass.

- [ ] **Step 3: Commit + PR**

```bash
git checkout -b chore/deps-nodemailer-10 origin/main
git commit -am "chore(deps): nodemailer 9 → 10"
gh pr create --fill
```

### Task 1.2: archiver 7 → 8 (+ @types/archiver 8)

**Files:**
- Modify: `apps/api/package.json`
- Test: `apps/api/src/services/installerAppZip.test.ts`, `installerBuilder.test.ts`, `tenantExport*.test.ts`

Breaking: Node ≥18; transitive `readable-stream` 4 / `zip-stream` 7 / `tar-stream` 3. We only call `archiver('zip', {zlib})`, `.append()`, `.directory()`. `@types/archiver@8` must move with it. Source: https://github.com/archiverjs/node-archiver/blob/master/CHANGELOG.md

- [ ] **Step 1: Bump**

```bash
pnpm --filter @breeze/api up archiver@latest @types/archiver@latest
```

- [ ] **Step 2: Typecheck + tests**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
npx vitest run src/services/installerAppZip src/services/installerBuilder src/services/tenantExport
```

- [ ] **Step 3: Byte-level regression check.** The installer zip is shipped to customer machines, so prove the archive is still readable by the platform unzip:

```bash
cd apps/api && npx tsx -e "
import { buildInstallerAppZip } from './src/services/installerAppZip';
" 2>/dev/null || true
# Use the existing test fixture path instead: run the installerAppZip test with
# ARCHIVER_DUMP=/tmp/x.zip if the suite supports it; otherwise unzip -t on the
# artifact produced by the tenantExport test's temp dir.
unzip -t /tmp/x.zip
```

If neither suite writes a file, add a 5-line test in `installerAppZip.test.ts` that writes the stream to a temp file and asserts `unzip -t` exits 0 (`execFileSync('unzip', ['-t', path])`). Commit it with the bump.

- [ ] **Step 4: Commit + PR** (`chore/deps-archiver-8`).

### Task 1.3: pdfkit 0.19 → 0.20

**Files:**
- Modify: `apps/api/package.json`
- Test: `apps/api/src/services/invoicePdf*.test.ts`, `quotePdf*.test.ts`, `contractDocumentService*.test.ts` (8 suites)

Breaking: Node ≥20; `pdfkit/virtual-fs` removed (we do not import it — verified by grep); internals moved from `Buffer` to `Uint8Array`. We `Buffer.concat(chunks)` on the `data` stream and pass `Buffer` to `doc.image()` and `registerFont()`. Both accept `Uint8Array` superset, but `chunks` typing may need `Uint8Array[]`. Source: https://github.com/foliojs/pdfkit/releases

- [ ] **Step 1: Bump**

```bash
pnpm --filter @breeze/api up pdfkit@latest @types/pdfkit@latest
```

- [ ] **Step 2: Typecheck.** If `Buffer.concat(chunks)` errors on `Uint8Array[]`, change the chunk arrays to `Uint8Array[]` and keep `Buffer.concat` (it accepts `Uint8Array`).

- [ ] **Step 3: Golden-output check.** Run the 8 PDF suites. Then render one invoice and one quote through the integration path and open them (`invoicePdf.integration.test.ts` needs the test stack):

```bash
cd apps/api && npx vitest run src/services/invoicePdf src/services/quotePdf src/services/contractDocumentService
pnpm test-stack up && pnpm --filter @breeze/api test:integration src/services/invoicePdf.integration.test.ts; pnpm test-stack down
```

- [ ] **Step 4: Commit + PR** (`chore/deps-pdfkit-0.20`).

### Task 1.4: @simplewebauthn/server 13 → 14 and /browser 13 → 14 (together)

**Files:**
- Modify: `apps/api/package.json`, `apps/web/package.json`
- Test: `apps/api/src/services/passkeys.test.ts`, `approverWebAuthn.test.ts`; `apps/web/src/stores/auth*.test.ts`, `authenticator*.test.ts`, `lib/mfaStepUp*.test.ts`

Breaking: runtime floor only (Node 22 per notes; `engines` says ≥20). No API or return-shape changes in 14.0.0–14.0.2. Server pulls `@peculiar/x509 ^2.1.0` — that satisfies Task 1.6 transitively. Server still depends on `@levischuck/tiny-cbor ^0.2.x`; **do not** bump our direct tiny-cbor to 0.3 (see Deferred). Source: https://github.com/MasterKale/SimpleWebAuthn/releases/tag/v14.0.0

- [ ] **Step 1: Bump both**

```bash
pnpm --filter @breeze/api up @simplewebauthn/server@latest
pnpm --filter @breeze/web up @simplewebauthn/browser@latest
```

- [ ] **Step 2: Typecheck both packages + suites**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && npx vitest run src/services/passkeys src/services/approverWebAuthn
cd ../web && npx tsc --noEmit && npx vitest run src/stores/auth src/stores/authenticator src/lib/mfaStepUp
```

- [ ] **Step 3: Live passkey round-trip.** Auth is high blast radius, so a real browser check is required. `pnpm wt-stack up`, then with Playwright (`e2e-tests`, virtual authenticator — see `e2e-tests/README.md` WebAuthn note) register a passkey and sign in with it. Existing spec: `e2e-tests/tests/passkeys.spec.ts` if present, else run the manual flow at `/settings/security`. Record PASS in the PR body.

- [ ] **Step 4: Commit + PR** (`chore/deps-simplewebauthn-14`). Label it `auth`.

### Task 1.5: @azure/msal-node 3 → 6

**Files:**
- Modify: `apps/m365-communications-executor/package.json`
- Test: `apps/m365-communications-executor/src/microsoft/delegatedClient.test.ts`

Breaking (v5, there is no v4): Node ≥20; `proxyUrl`/`customAgentOptions` removed from system options; `protocolMode` moved `auth`→`system`; HTTP client on native `fetch`. (v6): `acquireTokenInteractive` default `responseMode` `query`→`form_post`; `loopbackClient` removed. We construct `ConfidentialClientApplication` with `auth.{clientId, authority, clientCertificate}` only and call `acquireTokenSilent` / `acquireTokenByCode` — none of the removed surface. Sources: `lib/msal-node/docs/v5-migration.md` and `v6-migration.md` in the MSAL.js repo.

- [ ] **Step 1: Bump** `pnpm --filter @breeze/m365-communications-executor up @azure/msal-node@latest`
- [ ] **Step 2: Typecheck + suite** (`npx tsc --noEmit && npx vitest run src/microsoft/delegatedClient`).
- [ ] **Step 3: Executor image builds.** The executor ships as its own Docker image; run `docker build -f apps/m365-communications-executor/Dockerfile .` locally (or rely on the `smoke-test` job) and confirm it boots to its health endpoint.
- [ ] **Step 4: Commit + PR** (`chore/deps-msal-node-6`).

### Task 1.6: @googleapis/{admin,calendar,gmail,licensing} majors + google-auth-library 11

**Files:**
- Modify: `apps/api/package.json`
- Test: `apps/api/src/services/googleClient*.test.ts`, `googleWorkspace*.test.ts`

Breaking: all four `@googleapis/*` majors are regenerated clients + `googleapis-common` 8→9 + Node ≥22. `google-auth-library` 11: Node ≥22, `Transporter` class removed, `additionalOptions` removed from AuthClient constructors. We build the JWT via each package's own `auth` namespace (`googleClient.ts:88`), so the direct `google-auth-library` dep is only there for types; `googleapis-common@9` pins its own `google-auth-library@10.5.0` internally, so two copies will coexist. Move all five in one PR.

- [ ] **Step 1: Bump**

```bash
pnpm --filter @breeze/api up @googleapis/admin@latest @googleapis/calendar@latest @googleapis/gmail@latest @googleapis/licensing@latest google-auth-library@latest
```

- [ ] **Step 2: Typecheck.** The `admin_directory_v1` / `gmail_v1` / `calendar_v3` / `licensing_v1` namespace types are regenerated; expect optional-field drift. Fix by narrowing at the call site, never by casting the whole response.
- [ ] **Step 3: Suites** `npx vitest run src/services/googleClient src/services/googleWorkspace`.
- [ ] **Step 4: Live DWD check** if a Google Workspace sandbox connection exists in the dev stack (memory: `prod_integrations_enabled_us_eu_2026_07`); otherwise state "not live-checked" in the PR body.
- [ ] **Step 5: Commit + PR** (`chore/deps-googleapis-v9-gen`).

### Task 1.7: firebase-admin 13 → 14

**Files:**
- Modify: `apps/api/package.json`
- Test: `apps/api/src/services/fcm.test.ts`

Breaking: Node ≥22; Instance ID service removed; legacy namespace removed; legacy FCM types dropped; error-code structure revamped. We call `admin.messaging().send({token,…})` and match `messaging/registration-token-not-registered` / `messaging/invalid-registration-token` codes. The `token` param is deprecated in 14.1 in favour of `fid` but still works. Source: https://github.com/firebase/firebase-admin-node/releases/tag/v14.0.0

- [ ] **Step 1: Bump** `pnpm --filter @breeze/api up firebase-admin@latest`
- [ ] **Step 2: Assert the dead-token codes still match.** Before typecheck, extend `fcm.test.ts` with a case that throws a v14-shaped `FirebaseMessagingError` (`{ code: 'messaging/registration-token-not-registered' }` via the SDK's own error class) and asserts `sendFcmNotification` returns `{ unregistered: true }`. Run it red on 13 if the class import differs, then green on 14.
- [ ] **Step 3: Typecheck + suite. Commit + PR** (`chore/deps-firebase-admin-14`).

### Task 1.8: dotenv 16 → 17

**Files:**
- Modify: `apps/api/package.json`, `ee/workspace/package.json`, `e2e-tests/package.json`
- Modify: `apps/api/src/db/index.ts:1`, `apps/api/src/__tests__/integration/loadEnv.ts:13`, `apps/api/vitest.config.rls-coverage.ts`, `apps/api/vitest.integration.config.ts`, `e2e-tests/live-signup/monitor.ts`, `e2e-tests/perf-harness/run-perf.ts`

Breaking: v17 turns the "injecting env" banner **on** by default. Pass `quiet: true` at every `config()` call so API logs and test output stay clean.

- [ ] **Step 1: Bump in all three packages** (`pnpm -r up dotenv@latest` is fine here — same major everywhere).
- [ ] **Step 2: Add `{ quiet: true }`** to each of the seven `config(...)` calls listed above (merge into the existing options object where one exists).
- [ ] **Step 3: Prove silence.** `cd apps/api && npx tsx -e "import './src/db/index'" 2>&1 | grep -c '\[dotenv' ` must print `0`.
- [ ] **Step 4: Commit + PR** (`chore/deps-dotenv-17`).

### Task 1.9: @testing-library/jest-dom 6 → 7

**Files:**
- Modify: `apps/web/package.json`, `apps/portal/package.json`, `apps/helper/package.json`

Breaking: `@testing-library/dom >=10 <11` is now a **required peer** (web and portal already declare `^10.4.1`; helper must add it); Node ≥22. No matcher renames.

- [ ] **Step 1: Bump + add the peer to helper**

```bash
pnpm --filter @breeze/web --filter @breeze/portal --filter breeze-helper up @testing-library/jest-dom@latest
pnpm --filter breeze-helper add -D @testing-library/dom@^10.4.1
```

- [ ] **Step 2: Run all three web suites** (`pnpm --filter @breeze/web test --run`, same for portal and helper). Expected: same pass count as `main`.
- [ ] **Step 3: Commit + PR** (`chore/deps-jest-dom-7`).

### Task 1.10: cron-parser 4 → 5 (devDependency)

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/jobs/scheduleRegistry.contract.test.ts:33` and its `parser.parseExpression(...)` calls

Breaking: `parseExpression()` → `CronExpressionParser.parse()`; `utc` option removed (pass `tz: 'UTC'`); `fields` is now a readonly collection. BullMQ 6 itself depends on cron-parser 5.10.1, so this aligns ahead of Wave 3. The test's own comment (`:687`) records that 4.9.0 silently accepted short patterns — re-run that case and update the expectation if v5 now rejects them (that would be a *tightening*, keep the assertion that our validator rejects them regardless).

- [ ] **Step 1: Bump** `pnpm --filter @breeze/api up -D cron-parser@latest`
- [ ] **Step 2: Rewrite imports/calls** in the contract test: `import { CronExpressionParser } from 'cron-parser'` and `CronExpressionParser.parse(expr, { tz: 'UTC', currentDate })`.
- [ ] **Step 3: Run** `npx vitest run src/jobs/scheduleRegistry.contract.test.ts` — must pass with the same case count.
- [ ] **Step 4: Commit + PR** (`chore/deps-cron-parser-5`).

### Task 1.11: Small remaining majors (one PR each, same recipe)

- **`@peculiar/x509` 1 → 2** (`apps/api`): v2 dropped its own `reflect-metadata` dep. Add `reflect-metadata` to `apps/api` dependencies and `import 'reflect-metadata'` once at the top of `apps/api/src/services/attestation/appleAppAttest.ts` (the only runtime importer; the two `__fixtures__` files are test-only). Task 1.4 pulls x509 2 transitively anyway, so do this **before or with** 1.4. Run `npx vitest run src/services/attestation`.
- **`monaco-editor` 0.55 → 0.56** (`apps/web`): `stackOridinal` → `stackOrdinal` typo fix in `IOverlayWidgetPosition`; deprecated worker types removed. Grep `stackOridinal|IMirrorModel|IWorkerContext` in `apps/web/src` (expect 0), bump, `tsc`, run the script-editor suites, and open `/scripts/new` on a wt-stack to confirm the editor loads.
- **`office-addin-dev-certs` 2 → 3, `office-addin-manifest` 2 → 3** (four `apps/*-addin` packages): lockstep monorepo bump; manifest 3 rejects `addZipFile` paths outside the manifest dir (we don't use export packaging). Bump all four, run each `validate-manifest` script. CI's add-in jobs cover the rest.
- **`@sentry/cli` 2 → 3** (`apps/mobile`, pinned exact `2.58.4`): removed `files`/`releases files`/`send-metric` subcommands and legacy API-key auth. Grep `.github/workflows` and `apps/mobile` for `sentry-cli` invocations (none found on 2026-09-14 besides the pin). Bump to `3.7.0`, confirm the Expo config plugin's sourcemap upload still runs in **Build Mobile iOS** (that job is merge-queue-blocking).

---

## Wave 2 — ioredis 5 → 6 (high blast radius: every Redis reader)

Breaking: Node ≥20; **default wire protocol RESP2 → RESP3**; new TS exports; cluster MOVED validation. RESP3 changes reply shapes for hashes/sets in some commands and is the one thing that can silently alter behaviour. Pin `protocol: 2` at every client construction first, on ioredis 5 (where the option is accepted and a no-op), then bump. Source: https://github.com/redis/ioredis/releases/tag/v6.0.0

### Task 2.1: Pin RESP2 on ioredis 5

**Files:**
- Modify: `apps/api/src/services/redis.ts:117` (`getRedis`), `:205` (`getBullMQConnection`), `apps/api/src/services/eventDispatcher.ts:65` (subscriber)
- Modify: `apps/api/src/__tests__/integration/setup.ts` and `apps/api/src/__tests__/fixtures/remoteWsLeaseServer.ts` (test clients)
- Test: `apps/api/src/services/redis.test.ts`

**Interfaces:** Produces `REDIS_CLIENT_BASE_OPTIONS: Pick<RedisOptions, 'protocol'>` exported from `redis.ts` so every `new Redis(url, {...REDIS_CLIENT_BASE_OPTIONS, ...})` site shares one pin.

- [ ] **Step 1: Write the failing test** in `redis.test.ts`:

```ts
it('constructs every client with the RESP2 protocol pin', async () => {
  const ctor = vi.fn();
  vi.doMock('ioredis', () => ({ default: class { constructor(...a: unknown[]) { ctor(...a); } on() {} } }));
  const mod = await import('./redis');
  mod.getRedis(); mod.getBullMQConnection();
  for (const call of ctor.mock.calls) expect(call[1]).toMatchObject({ protocol: 2 });
});
```

- [ ] **Step 2: Run red** `npx vitest run src/services/redis.test.ts -t RESP2`.
- [ ] **Step 3: Implement** — export `REDIS_CLIENT_BASE_OPTIONS = { protocol: 2 } as const` and spread it into the three production constructors and the two test fixtures.
- [ ] **Step 4: Run green**, then the full redis-adjacent unit set: `npx vitest run src/services/redis src/services/eventDispatcher src/services/agentOrgRateLimit src/services/clientAiSessionStore src/routes/agentWs`.
- [ ] **Step 5: Commit + PR** (`chore/redis-pin-resp2`). Merge before 2.2.

### Task 2.2: Bump ioredis to 6

- [ ] **Step 1: Bump** `pnpm --filter @breeze/api up ioredis@latest`. Check `pnpm why ioredis` — BullMQ 5.81 declares `ioredis ^5`; pnpm will keep a second copy for BullMQ. That is acceptable for this wave (BullMQ moves to `>=5` optional peer in Wave 3, which collapses it).
- [ ] **Step 2: Typecheck** (`RedisOptions` gained fields; `ScanStreamOptions` is now exported — replace any local re-declaration).
- [ ] **Step 3: Integration on a real Redis.**

```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration   # full, not scoped — every queue/rate-limit/session suite
pnpm --filter @breeze/api test:rls
pnpm test-stack down
```

- [ ] **Step 4: Boot smoke + 10-minute soak.** `pnpm wt-stack up`; confirm `/health` 200, agent WebSocket connects (a lab agent from `kit_lab_ubuntu_src_vm`), a script runs end-to-end, and `docker logs breeze-api` shows zero `ERR`/`WRONGTYPE`/`protocol` lines over 10 minutes. `pnpm wt-stack down`.
- [ ] **Step 5: Commit + PR** (`chore/deps-ioredis-6`). Label `high-blast-radius`. Release it in its own version (not stacked with Wave 3) so a prod regression bisects to one package.

---

## Wave 3 — BullMQ 5 → 6 (highest blast radius: 104 job files)

BullMQ 6 **removes** the legacy repeatable API: `queue.add(name, data, { repeat })`, `getRepeatableJobs()`, `removeRepeatableByKey()`, `repeat.utc`, `debounce`; `Queue.resume()` becomes async; `'paused'` leaves `JobType`. Source: https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6

Repo surface on 2026-09-14 (`grep`, excludes tests/fixtures):

| Legacy usage | Count |
|---|---|
| `repeat: {` registrations | 127 in 104 files |
| `getRepeatableJobs()` | 107 |
| `removeRepeatableByKey()` | 106 |
| test files mocking either | 65 |
| `getJobCounts(..., 'paused')` | 1 (`eventDispatchWorker.ts:855`) |
| `queue.resume()` | 2 |

The Job Scheduler API (`upsertJobScheduler`) exists on BullMQ 5 (16 sites already use it), so the migration is done **on 5**, verified against the current runtime, and the 6 bump becomes a small PR. This is the only safe ordering: the legacy-key sweep in 3.2 needs `getRepeatableJobs()`, which 6 deletes.

### Task 3.1: Shared scheduler helper + contract-test scanner

**Files:**
- Create: `apps/api/src/jobs/registerScheduler.ts`
- Test: `apps/api/src/jobs/registerScheduler.test.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.contract.test.ts` (scanner already handles both idioms per its header; add the helper as a third recognised idiom)

**Interfaces (Produces):**

```ts
export type SchedulerRepeat = { pattern: string; tz?: string } | { every: number };
export async function registerScheduler(
  queue: Queue,
  id: string,                      // scheduler id; use the legacy job name
  repeat: SchedulerRepeat,
  job: { name: string; data: unknown; opts?: JobsOptions },
): Promise<void>;                  // wraps queue.upsertJobScheduler(id, repeat, { name, data, opts })
export async function removeLegacyRepeatables(queue: Queue, names: string[]): Promise<number>;
// Task 3.2 only: getRepeatableJobs() → removeRepeatableByKey() for entries whose `name` is in `names`
// AND whose key is not a scheduler id. Returns the removed count and logs it.
```

- [ ] **Step 1: Failing tests** — `registerScheduler` forwards `(id, repeat, {name,data,opts})` to `upsertJobScheduler` exactly once; `removeLegacyRepeatables` removes only entries matching `names` and returns the count. Use a hand-rolled `{ upsertJobScheduler: vi.fn(), getRepeatableJobs: vi.fn().mockResolvedValue([...]) , removeRepeatableByKey: vi.fn() }` queue stub, not a Drizzle mock.
- [ ] **Step 2: Run red; implement; run green.**
- [ ] **Step 3: Extend the scanner.** The contract test's AST walker resolves `queue.add(…, {repeat})` and `upsertJobScheduler(id, repeatOpts, …)`. Add a branch for `registerScheduler(queue, id, repeatOpts, …)` (repeat is the 3rd argument) and a fixture in `apps/api/src/__tests__/fixtures/epochAlignedRepeat.fixture.ts` proving it is discovered. The epoch-alignment guard (memory: `bullmq_every_24h_epoch_aligned_stampede`) must keep firing for `every` values ≥ 1 h through the new idiom.
- [ ] **Step 4: Commit + PR** (`chore/bullmq-register-scheduler-helper`).

### Task 3.2: Codemod the 127 registrations (on BullMQ 5)

**Files:**
- Modify: all 104 files from `grep -rlE '^\s*repeat:\s*\{' apps/api/src ee --include='*.ts' | grep -v '\.test\.' | grep -v fixture`
- Modify: the 65 test files that mock `getRepeatableJobs`/`repeat`
- Create: `scripts/codemods/bullmq-repeat-to-scheduler.ts` (ts-morph; committed so the diff is reproducible)

Transform, per site:

```ts
// before
const existing = await queue.getRepeatableJobs();
for (const job of existing) if (job.name === 'scan-orgs') await queue.removeRepeatableByKey(job.key);
await queue.add('scan-orgs', data, { repeat: { pattern: jobSchedule('security-posture-scan') }, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } });

// after
await removeLegacyRepeatables(queue, ['scan-orgs']);           // transition-only; deleted in Task 3.4
await registerScheduler(queue, 'scan-orgs', { pattern: jobSchedule('security-posture-scan') },
  { name: 'scan-orgs', data, opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } } });
```

Rules the codemod must enforce (each is a `throw` in the script, not a warning):
- Scheduler `id` = the legacy job name, unless the legacy call passed an explicit `jobId` (e.g. `stripeReconcileSweep.ts:113`) — then use that `jobId`, since it is already the dedupe key operators know.
- `repeat.utc` → `tz: 'UTC'`. `repeat.tz` passes through. Any other key under `repeat` (`limit`, `endDate`, `immediately`) passes through unchanged — they are all still supported on the scheduler.
- `debounce:` anywhere → abort; hand-migrate to `deduplication` (expected 0 sites).
- A `repeat` whose value is not an object literal (`repeat: helper()`, spread) → abort and list; hand-migrate (the contract scanner already fails closed on these, so expect 0).

- [ ] **Step 1: Write and run the codemod.** `npx tsx scripts/codemods/bullmq-repeat-to-scheduler.ts --dry` prints the 127 sites; `--write` applies. Commit the codemod and the diff separately.
- [ ] **Step 2: Fix the 65 tests.** Most stub `queue.add` and assert on `repeat`. Replace with an assertion on `upsertJobScheduler` args. Do this by hand — it is where vacuous assertions creep in (memory: `drizzle_condition_deep_search_matches_enum_values_vacuous`). Each test must assert the concrete `pattern`/`every` value, not `expect.anything()`.
- [ ] **Step 3: Unit + contract.** `npx vitest run src/jobs` and `npx vitest run src/jobs/scheduleRegistry.contract.test.ts`. The contract test must report the same registration count as before (127 + 16 existing) — a drop means the scanner lost sites.
- [ ] **Step 4: Integration proof on a real Redis.** Add `apps/api/src/__tests__/integration/jobSchedulers.integration.test.ts`: boot every worker's `initialize*` on the test stack, then assert for every queue `getJobSchedulers()` length equals the number of `registerScheduler` calls into it and `getRepeatableJobs()` contains **no** legacy-format entries (legacy keys contain the `name:jobId:endDate:tz:pattern` colon-delimited shape; scheduler keys are the bare id). Run twice in a row — the second boot must be idempotent (same counts, zero removals logged).
- [ ] **Step 5: Stampede check.** On the wt-stack, after boot, dump `ZRANGE bull:<queue>:repeat 0 -1 WITHSCORES` for the 24 h `every` queues and confirm the scores are not all on one millisecond (the `scheduleRegistry` minute-lane allocation must survive the idiom change).
- [ ] **Step 6: Commit + PR** (`chore/bullmq-migrate-repeat-to-schedulers`). **Ship this in its own release (vN)** — the `removeLegacyRepeatables` sweep runs at boot in prod and clears the old keys. Watch prod Redis after deploy: `redis-cli --scan --pattern 'bull:*:repeat'` and per-queue `ZCARD` should equal scheduler counts.

### Task 3.3: Bump BullMQ to 6

Prerequisite: Task 3.2's release has run in prod on both regions for ≥ 24 h (one full daily cycle of every scheduler) with no double-fires in the job telemetry.

**Files:**
- Modify: `apps/api/package.json`, `ee/*/package.json` if any declare bullmq
- Modify: `apps/api/src/jobs/eventDispatchWorker.ts:855` (drop `'paused'` from `getJobCounts`)
- Modify: the 2 `queue.resume()` sites (`await`)
- Modify: `apps/api/src/jobs/registerScheduler.ts` — delete `removeLegacyRepeatables` and its 104 call sites (second, mechanical codemod pass: remove the line).

- [ ] **Step 1: Bump** `pnpm --filter @breeze/api up bullmq@latest`. `pnpm why ioredis` should now show a single copy (BullMQ 6 peers on `ioredis >=5`).
- [ ] **Step 2: Typecheck.** Expected errors are exactly: `getRepeatableJobs`/`removeRepeatableByKey` (from the helper), `'paused'` in `getJobCounts`, and `resume()` returning a Promise where a value was used. Anything else is a missed site — investigate, do not cast.
- [ ] **Step 3: Delete the sweep** and its call lines; delete its test.
- [ ] **Step 4: Full unit + integration + soak**, same commands as Task 2.2 steps 3–4, plus `jobSchedulers.integration.test.ts` from 3.2.
- [ ] **Step 5: Telemetry check.** BullMQ 6 makes `createGauge` mandatory in the telemetry interface and renames "status" → `JobState`. Grep `apps/api/src` for `bullmq/dist/esm/interfaces/telemetry` / `Telemetry` (expect the Sentry/OTel bridge in `attachWorkerObservability`); implement `createGauge` if we supply a custom telemetry object.
- [ ] **Step 6: Commit + PR** (`chore/deps-bullmq-6`). Own release again.

---

## Wave 4 — Vitest 4 → 5 and @vitest/coverage-v8 5 (18 packages)

Breaking that touches us: `clearMocks` default flips to `true`; `vi.mock()` outside module top level now throws; `expect.poll` fails on timeout; `toThrow('')` matches any message; `test.sequential` removed (0 uses); coverage `include`/`exclude` become relative-path matched; `VITEST_POOL_ID` is 1-based; `@vitest/coverage-v8@5.0.0` exact-pins `vitest@5.0.0`. Peer: Vite `^6.4 || ^7 || ^8` (we are on 8.2 — fine). Node `^22.12` — fine. Source: https://vitest.dev/guide/migration/

### Task 4.1: Freeze behaviour before the bump

- [ ] **Step 1: Pin `clearMocks: false`** explicitly in every `vitest*.config.ts` that does not already set it (`apps/web` sets `true`; the other 23 configs are silent). This makes the bump behaviour-neutral; flipping to `true` per package is a follow-up, one PR each, since it exposes cross-test mock bleed.
- [ ] **Step 2: Grep the hazards**, fix on 4.x, commit:

```bash
grep -rnE "toThrow\(''\)|toThrow\(\"\"\)" apps packages --include='*.test.ts*'      # expect 0; if found, use toThrow(/./)
grep -rnE "expect\.poll" apps packages --include='*.test.ts*'                         # review each: timeout now fails
grep -rnE "VITEST_POOL_ID|VITEST_WORKER_ID" apps packages --include='*.ts'            # 1-based now; used in apps/api integration DB naming?
grep -rnE "from 'vitest/(coverage|reporters|environments|snapshot|runners|suite)'" apps packages   # removed subpaths
grep -rnE "\.(sequential)\(" apps packages --include='*.test.ts*'                    # expect 0
```

- [ ] **Step 3: Coverage globs.** `apps/api/vitest.config.integration-suite-coverage.ts` and `vitest.config.site-scope-coverage.ts` use `include`/`exclude` for coverage; convert any absolute or `**/`-anchored patterns to repo-relative. Verify `pnpm --filter @breeze/api test:coverage` (or the CI coverage step in `ci.yml`) still reports the same file set.
- [ ] **Step 4: Commit + PR** (`chore/vitest-5-prep`).

### Task 4.2: Bump

- [ ] **Step 1:** `pnpm -r up vitest@5 @vitest/coverage-v8@5` (both must be exactly 5.0.0 together).
- [ ] **Step 2: Whole-repo unit run**, package by package, comparing test counts to `main`: `pnpm test` at the root. A package whose count dropped has silently lost files (vitest 5 no longer searches ancestor dirs for config — check any package that relied on a parent config).
- [ ] **Step 3: CI shape.** `ci.yml`'s `Test API` job uses `compatibility.test.ts` scoping with `--run`; confirm that flag is still accepted. The 4-shard `integration-test` job passes `--shard` — unchanged in 5.
- [ ] **Step 4: Commit + PR** (`chore/deps-vitest-5`).

---

## Wave 5 — TypeScript 5.9 → 6.x (NOT 7) and helper Tailwind 3 → 4

### Task 5.1: TypeScript 6

TS 6 deprecates `baseUrl` (10 of our tsconfigs use it — replace with `paths` entries relative to `${configDir}`), `moduleResolution: node` (we use `bundler` ×15, `NodeNext` ×1 — fine), forces `esModuleInterop` on (we already set it where it matters), and defaults `strict`/`module: esnext`/`types: []`/`noUncheckedSideEffectImports: true`. `types: []` is the one that bites: any package relying on ambient `@types/node` auto-inclusion must list it. Source: https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/

Precondition: `@typescript-eslint/*` must publish support for the exact 6.x minor (its range on 2026-09-14 is `>=4.8.4 <6.1.0`, so 6.0.x is in). Check `pnpm view @typescript-eslint/typescript-estree peerDependencies.typescript` first.

- [ ] **Step 1: Remove `baseUrl`** from the 10 tsconfigs, rewriting each `paths` value to be relative to the config file. Typecheck every package on 5.9 first — this is a pure refactor and must be green before the bump.
- [ ] **Step 2: Bump** `pnpm -r up typescript@6`. Typecheck every package (`pnpm -r --workspace-concurrency=1 exec tsc --noEmit`, with the 8 GB heap for api).
- [ ] **Step 3: Add `types: ["node"]`** (or the relevant set) wherever step 2 reports missing globals. Add `ignoreDeprecations: "6.0"` only for a deprecation we cannot fix in-PR, with a comment naming the follow-up issue.
- [ ] **Step 4: Toolchain.** `pnpm lint` (typescript-eslint), `pnpm build` (tsup in `packages/*`, Astro in web/portal/docs, Vite in helper/viewer, Expo typecheck in mobile). All must be green; any of them red means the wave waits for that tool.
- [ ] **Step 5: Commit + PR** (`chore/deps-typescript-6`).

### Task 5.2: Tailwind 3 → 4 in `apps/helper` only

Web and portal are already on Tailwind 4.3 (`@tailwindcss/vite@4.3.3` in the lockfile); helper is the last v3 holdout. Run `npx @tailwindcss/upgrade` in `apps/helper`, replace the PostCSS plugin with `@tailwindcss/vite`, review the utility renames the tool applies (`shadow-sm→shadow-xs`, `outline-none→outline-hidden`, `ring` default width/colour, `*-opacity-*` → `/opacity`), and screenshot the helper's three screens on a wt-stack before/after. PR: `chore/helper-tailwind-4`.

---

## Wave 6 — Mobile (blocked on Expo SDK 58)

### Task 6.1: @sentry/react-native 7 → 8 (can go now)

8.x is a native-floor bump only: iOS 15+, AGP 7.4+, Kotlin 1.8+, Xcode 16.4+. Expo SDK 57 already satisfies all of these. No `Sentry.init` option changes. Source: https://docs.sentry.io/platforms/react-native/guides/expo/migration/v7-to-v8/

- [ ] **Step 1:** `pnpm --filter breeze-mobile up @sentry/react-native@latest`, then `npx expo prebuild --clean` locally to confirm the config plugin (`app.json:113`) still applies.
- [ ] **Step 2:** `pnpm --filter breeze-mobile test --run` and the **Build Mobile iOS** CI job green (memory: `ci_flaky_macos_runner_checkout_dns` — a DNS failure there is a rerun, not a regression).
- [ ] **Step 3:** Trigger a test crash in a dev build and confirm it lands in Sentry with symbolicated frames.
- [ ] **Step 4: Commit + PR** (`chore/deps-sentry-rn-8`).

### Task 6.2: Expo SDK 58 + RN 0.87 + gesture-handler 3 (deferred until Expo 58 is stable)

RN 0.87 is only reachable via `expo@canary` on 2026-09-14; Expo SDK 57 targets RN 0.86. gesture-handler 3.x is New-Architecture-only and rewrites the Gesture API (`Gesture.Pan()` builder → `usePanGesture()` hook; `onStart→onActivate`, `onEnd→onDeactivate`, `onChange` merged into `onUpdate`). Our surface is 3 files (`App.tsx`, `ApprovalScreen.tsx`, `IssueRow.tsx`). Plan when Expo 58 ships: `npx expo install --fix` for the SDK, then migrate the three gesture sites in the same PR, then `expo prebuild`, then TestFlight (memory: `ios_app_store_approved_2026_09_13` — the App Store build pipeline is live and must stay green). Sources: https://reactnative.dev/blog/2026/08/11/react-native-0.87 , https://docs.swmansion.com/react-native-gesture-handler/docs/guides/upgrading-to-3/

---

## Deferred (do not attempt; re-check the unblock condition monthly)

| Package | Blocked by | Unblock signal |
|---|---|---|
| `typescript` 7.x | typescript-eslint crashes on TS7 (eslint/typescript-eslint#12518); Astro blocks TS7 (withastro/roadmap#1321); tsup DTS crashes; Expo `app.config.ts` fails (expo/expo#47627). TS 7.0.2 ships no programmatic compiler API. | TS 7.1 (compiler API) **and** typescript-eslint + Astro + tsup release notes naming 7.x support. |
| `react-native` 0.87, `react-native-gesture-handler` 3 | Expo SDK 57 targets RN 0.86; gesture-handler 3 is new-arch-only. | Expo SDK 58 stable. Do as Task 6.2. |
| `@levischuck/tiny-cbor` 0.3 | `@simplewebauthn/server@14` still pins `^0.2.x`; bumping our direct dep diverges from what upstream tests. | simplewebauthn/server moves to `^0.3`. Then drop our direct dep if it was only there for the fixture, or match theirs. |
| `bullmq` 6 before Wave 3.2 has run in prod | Legacy repeat keys must be swept while `getRepeatableJobs()` still exists. | Task 3.2 deployed both regions ≥ 24 h. |

## Release sequencing

- **vN (next):** Wave 1 (all), Task 2.1 (RESP2 pin, inert on ioredis 5), Task 4.1 prep, Task 6.1.
- **vN+1:** Task 2.2 (ioredis 6) alone among the risky items. Task 3.1 + 3.2 (scheduler migration on BullMQ 5, with the boot-time sweep).
- **vN+2:** Task 3.3 (BullMQ 6, sweep removed) after the ≥ 24 h prod check. Task 4.2 (Vitest 5), 5.1 (TS 6), 5.2 (helper Tailwind 4) — CI-only blast radius, can ride along.
- **Later:** Task 6.2 and the Deferred table when their signals fire.

## Self-review notes

- Every package from the 2026-09-14 `pnpm outdated` "MAJOR" list has a task or a Deferred row. `@types/archiver` rides with archiver; `google-auth-library` rides with the googleapis task.
- Node floor: nothing in the plan requires raising the repo's `>=22.22.2`.
- The BullMQ wave is the only one with a mandatory prod-observation gap between PRs; the plan records why (the sweep needs an API that 6 deletes) so nobody collapses 3.2 and 3.3 into one PR.
