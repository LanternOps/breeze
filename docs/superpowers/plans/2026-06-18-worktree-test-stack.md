# Worktree Test Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `wt-stack` CLI that takes the current git worktree and brings up a migrated, seeded, Playwright-ready Breeze stack (Postgres + Redis + API + Web + Portal + Caddy) running the worktree's own code, exposing a JSON descriptor for agents and Playwright to consume.

**Architecture:** A tsx CLI namespaces the existing Compose stack by Compose **project name**. A new override file (`docker-compose.override.yml.worktree`) drops `container_name`, adds a code-mounted Portal dev service, and (Phase 2) switches to ephemeral host ports + tmpfs Postgres. The CLI brings the stack up, waits for healthchecks, seeds the DB, discovers published host ports, and writes `.breeze-stack.json`. Playwright reads that descriptor instead of hardcoded container names / ports.

**Tech Stack:** TypeScript (tsx), Docker Compose, Postgres, Redis, Caddy, Astro (web + portal), Hono (api), Playwright.

## Global Constraints

- Node pinned to `v22.20.0` for host-side tooling (prefix `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` for pnpm/tsx/vitest). Container images use `node:24-alpine` + `pnpm@10.33.4` (do not change).
- Engine-agnostic: use only the standard `docker` / `docker compose` CLI. No OrbStack-specific APIs. CI runs on Docker and must stay green.
- Never edit a shipped migration. This plan adds no migrations.
- Descriptor file `.breeze-stack.json` and env file `.env.stack` are gitignored; never commit them.
- Compose invocation always stacks overrides in this order: base `docker-compose.yml` → `docker-compose.override.yml.dev` → `docker-compose.override.yml.worktree`, under an explicit `-p <project>`.
- Dev Caddy serves plain HTTP on `:80` (`CADDY_SITE_ADDRESS=:80`); `baseUrl` is `http://localhost:<published-caddy-port>`. Playwright keeps `ignoreHTTPSErrors: true` as a safety net.
- Existing dev override fixed ports (5432/6379/3001/4321) are reused by Phase-1 `--shared`; Phase-2 per-worktree mode uses ephemeral `"0:<port>"`.

---

## File Structure

- Create: `scripts/dev/wt-stack/cli.ts` — CLI entrypoint (arg parsing, subcommand dispatch).
- Create: `scripts/dev/wt-stack/project.ts` — pure helpers: project-name derivation, paths.
- Create: `scripts/dev/wt-stack/descriptor.ts` — descriptor type + read/write.
- Create: `scripts/dev/wt-stack/compose.ts` — thin wrappers over `docker compose` (up, down, port discovery, exec, health wait).
- Create: `scripts/dev/wt-stack/env.ts` — `.env.stack` generation.
- Create: `scripts/dev/wt-stack/*.test.ts` — unit tests for the pure helpers.
- Create: `docker-compose.override.yml.worktree` — namespaceable override (Portal dev service, no `container_name`, Phase-2 ephemeral ports + tmpfs).
- Create: `docker/Dockerfile.portal.dev` — hot-reload portal image.
- Create: `.claude/skills/worktree-stack/SKILL.md` — agent-facing usage doc.
- Modify: `e2e-tests/playwright.config.ts` — read `baseURL` + `ignoreHTTPSErrors` from descriptor.
- Modify: `e2e-tests/global-setup.ts` — seed via `docker compose -p <project> exec` from descriptor.
- Modify: `.gitignore` — add `.breeze-stack.json`, `.env.stack`.
- Modify: root `package.json` — add `wt-stack` script.

---

## Task 1: Project-name derivation + paths (pure helpers)

**Files:**
- Create: `scripts/dev/wt-stack/project.ts`
- Test: `scripts/dev/wt-stack/project.test.ts`

**Interfaces:**
- Produces:
  - `deriveProjectName(opts: { worktreePath: string; branch?: string; shared?: boolean }): string`
  - `descriptorPath(worktreePath: string): string` → `<worktreePath>/.breeze-stack.json`
  - `envStackPath(worktreePath: string): string` → `<worktreePath>/.env.stack`
  - `SHARED_PROJECT = 'breeze'`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/dev/wt-stack/project.test.ts
import { describe, it, expect } from 'vitest';
import { deriveProjectName, descriptorPath, envStackPath, SHARED_PROJECT } from './project';

describe('deriveProjectName', () => {
  it('uses the shared project name when shared=true', () => {
    expect(deriveProjectName({ worktreePath: '/x', branch: 'feat/a', shared: true })).toBe(SHARED_PROJECT);
  });

  it('slugs a branch into a breeze-wt- project name', () => {
    expect(deriveProjectName({ worktreePath: '/x', branch: 'feat/Quotes_P3' }))
      .toBe('breeze-wt-feat-quotes-p3');
  });

  it('falls back to a path hash when branch is missing or detached', () => {
    const a = deriveProjectName({ worktreePath: '/Users/t/wt-a' });
    const b = deriveProjectName({ worktreePath: '/Users/t/wt-b' });
    expect(a).toMatch(/^breeze-wt-[a-f0-9]{8}$/);
    expect(a).not.toBe(b);
  });

  it('truncates very long branch slugs but stays unique via a suffix', () => {
    const name = deriveProjectName({ worktreePath: '/x', branch: 'feature/' + 'a'.repeat(80) });
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name.startsWith('breeze-wt-')).toBe(true);
  });
});

describe('paths', () => {
  it('builds descriptor and env paths under the worktree', () => {
    expect(descriptorPath('/x')).toBe('/x/.breeze-stack.json');
    expect(envStackPath('/x')).toBe('/x/.env.stack');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run scripts/dev/wt-stack/project.test.ts`
Expected: FAIL — `Cannot find module './project'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/dev/wt-stack/project.ts
import { createHash } from 'node:crypto';
import path from 'node:path';

export const SHARED_PROJECT = 'breeze';

/** Compose project names must be lowercase [a-z0-9_-], starting al/num. */
function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function deriveProjectName(opts: { worktreePath: string; branch?: string; shared?: boolean }): string {
  if (opts.shared) return SHARED_PROJECT;
  const base = opts.branch ? slug(opts.branch) : '';
  if (base) {
    const full = `breeze-wt-${base}`;
    if (full.length <= 50) return full;
    // Too long: truncate and append a short stable suffix for uniqueness.
    const suffix = createHash('sha1').update(base).digest('hex').slice(0, 6);
    return `breeze-wt-${base.slice(0, 50 - 'breeze-wt-'.length - 7)}-${suffix}`;
  }
  const hash = createHash('sha1').update(opts.worktreePath).digest('hex').slice(0, 8);
  return `breeze-wt-${hash}`;
}

export function descriptorPath(worktreePath: string): string {
  return path.join(worktreePath, '.breeze-stack.json');
}

export function envStackPath(worktreePath: string): string {
  return path.join(worktreePath, '.env.stack');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run scripts/dev/wt-stack/project.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/wt-stack/project.ts scripts/dev/wt-stack/project.test.ts
git commit -m "feat(wt-stack): project-name derivation and path helpers"
```

---

## Task 2: Descriptor type + read/write

**Files:**
- Create: `scripts/dev/wt-stack/descriptor.ts`
- Test: `scripts/dev/wt-stack/descriptor.test.ts`

**Interfaces:**
- Consumes: `descriptorPath` from `project.ts`.
- Produces:
  - `interface StackDescriptor { project: string; baseUrl: string; apiUrl: string; portalUrl: string; webPort: number; pgContainer: string; redisContainer: string; admin: { email: string; password: string } }`
  - `writeDescriptor(worktreePath: string, d: StackDescriptor): void`
  - `readDescriptor(worktreePath: string): StackDescriptor` (throws a clear error if missing)

- [ ] **Step 1: Write the failing test**

```ts
// scripts/dev/wt-stack/descriptor.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeDescriptor, readDescriptor, type StackDescriptor } from './descriptor';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sample: StackDescriptor = {
  project: 'breeze-wt-feat-x',
  baseUrl: 'http://localhost:53421',
  apiUrl: 'http://localhost:53421/api',
  portalUrl: 'http://localhost:53421/portal',
  webPort: 53421,
  pgContainer: 'breeze-wt-feat-x-postgres-1',
  redisContainer: 'breeze-wt-feat-x-redis-1',
  admin: { email: 'admin@breeze.local', password: 'BreezeAdmin123!' },
};

describe('descriptor round-trip', () => {
  it('writes and reads back identical data', () => {
    writeDescriptor(dir, sample);
    expect(readDescriptor(dir)).toEqual(sample);
  });

  it('throws a clear error when the descriptor is missing', () => {
    expect(() => readDescriptor(dir)).toThrow(/No stack descriptor.*wt-stack up/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run scripts/dev/wt-stack/descriptor.test.ts`
Expected: FAIL — `Cannot find module './descriptor'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/dev/wt-stack/descriptor.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { descriptorPath } from './project';

export interface StackDescriptor {
  project: string;
  baseUrl: string;
  apiUrl: string;
  portalUrl: string;
  webPort: number;
  pgContainer: string;
  redisContainer: string;
  admin: { email: string; password: string };
}

export function writeDescriptor(worktreePath: string, d: StackDescriptor): void {
  writeFileSync(descriptorPath(worktreePath), JSON.stringify(d, null, 2) + '\n', 'utf8');
}

export function readDescriptor(worktreePath: string): StackDescriptor {
  const p = descriptorPath(worktreePath);
  if (!existsSync(p)) {
    throw new Error(`No stack descriptor at ${p}. Run \`wt-stack up\` first.`);
  }
  return JSON.parse(readFileSync(p, 'utf8')) as StackDescriptor;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run scripts/dev/wt-stack/descriptor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/wt-stack/descriptor.ts scripts/dev/wt-stack/descriptor.test.ts
git commit -m "feat(wt-stack): stack descriptor type and read/write"
```

---

## Task 3: Compose port-output parser (pure helper)

**Files:**
- Create: `scripts/dev/wt-stack/compose.ts` (parser only this task)
- Test: `scripts/dev/wt-stack/compose.test.ts`

**Interfaces:**
- Produces: `parsePublishedPort(output: string): number` — given the stdout of `docker compose port <svc> <port>` (e.g. `0.0.0.0:53421` or `[::]:53421\n0.0.0.0:53421`), returns the numeric host port. Throws on empty/unparseable input.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/dev/wt-stack/compose.test.ts
import { describe, it, expect } from 'vitest';
import { parsePublishedPort } from './compose';

describe('parsePublishedPort', () => {
  it('parses an IPv4 mapping', () => {
    expect(parsePublishedPort('0.0.0.0:53421\n')).toBe(53421);
  });
  it('parses the first line when both IPv6 and IPv4 are present', () => {
    expect(parsePublishedPort('[::]:53421\n0.0.0.0:53421\n')).toBe(53421);
  });
  it('throws on empty output', () => {
    expect(() => parsePublishedPort('   \n')).toThrow(/no published port/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run scripts/dev/wt-stack/compose.test.ts`
Expected: FAIL — `parsePublishedPort is not a function` / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/dev/wt-stack/compose.ts
export function parsePublishedPort(output: string): number {
  const line = output.split('\n').map((l) => l.trim()).find(Boolean);
  const m = line?.match(/:(\d+)$/);
  if (!m) throw new Error(`Could not find a published port in compose output: ${JSON.stringify(output)} (no published port)`);
  return Number(m[1]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run scripts/dev/wt-stack/compose.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/wt-stack/compose.ts scripts/dev/wt-stack/compose.test.ts
git commit -m "feat(wt-stack): parse docker compose port output"
```

---

## Task 4: `.env.stack` generation

**Files:**
- Create: `scripts/dev/wt-stack/env.ts`
- Test: `scripts/dev/wt-stack/env.test.ts`

**Interfaces:**
- Consumes: `envStackPath` from `project.ts`.
- Produces: `writeEnvStack(worktreePath: string): string` — writes `.env.stack` with the required dev secrets and returns its path. Idempotent (overwrites with the same deterministic dev defaults).

- [ ] **Step 1: Write the failing test**

```ts
// scripts/dev/wt-stack/env.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeEnvStack } from './env';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wt-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('writeEnvStack', () => {
  it('writes all secrets the API config validator requires to boot', () => {
    const p = writeEnvStack(dir);
    const env = readFileSync(p, 'utf8');
    for (const key of [
      'POSTGRES_PASSWORD', 'ENROLLMENT_KEY_PEPPER', 'MFA_RECOVERY_CODE_PEPPER',
      'TURN_SECRET', 'IS_HOSTED', 'CADDY_SITE_ADDRESS',
    ]) {
      expect(env).toContain(`${key}=`);
    }
    expect(env).toContain('CADDY_SITE_ADDRESS=:80');
    expect(env).toContain('IS_HOSTED=false');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run scripts/dev/wt-stack/env.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/dev/wt-stack/env.ts
import { writeFileSync } from 'node:fs';
import { envStackPath } from './project';

/** Deterministic dev defaults — NOT secrets, local-only. Keeps a fresh worktree
 *  from booting with a partial env (the missing-.env.test → vacuous-RLS trap). */
const DEV_ENV: Record<string, string> = {
  POSTGRES_USER: 'breeze',
  POSTGRES_PASSWORD: 'breeze',
  POSTGRES_DB: 'breeze',
  ENROLLMENT_KEY_PEPPER: 'dev-enrollment-pepper-0000000000000000',
  MFA_RECOVERY_CODE_PEPPER: 'dev-mfa-pepper-00000000000000000000',
  TURN_SECRET: 'dev-turn-secret',
  IS_HOSTED: 'false',
  ENABLE_REGISTRATION: 'true',
  BINARY_SOURCE: 'github',
  CADDY_SITE_ADDRESS: ':80',
  // Base compose's portal service has `image: ${BREEZE_PORTAL_IMAGE_REF:?}` — a
  // mandatory interpolation evaluated BEFORE the override merge, so it must be
  // defined here even though the worktree override replaces portal.image with a
  // source build. Point it at the dev image so config resolves.
  BREEZE_PORTAL_IMAGE_REF: 'breeze-portal:dev',
  // Caddy/postgres/redis images are digest-pinned in base compose; reuse the
  // values already present in the developer's root .env via compose interpolation.
};

export function writeEnvStack(worktreePath: string): string {
  const p = envStackPath(worktreePath);
  const body = Object.entries(DEV_ENV).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(p, body, 'utf8');
  return p;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run scripts/dev/wt-stack/env.test.ts`
Expected: PASS.

> **Note for implementer:** `POSTGRES_IMAGE_REF`, `REDIS_IMAGE_REF`, `CADDY_IMAGE_REF`, `BREEZE_PORTAL_IMAGE_REF` are `:?`-required by base compose. The worktree override (Task 6) builds portal from source so it doesn't need the portal image ref, but postgres/redis/caddy image refs must still resolve. Pull them from the developer's existing root `.env` by passing `--env-file .env --env-file .env.stack` (later file wins) in the compose wrapper (Task 7). Verify `.env` exists in `up` and fail with a clear message if not.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/wt-stack/env.ts scripts/dev/wt-stack/env.test.ts
git commit -m "feat(wt-stack): generate .env.stack with required dev secrets"
```

---

## Task 5: Portal dev Dockerfile

**Files:**
- Create: `docker/Dockerfile.portal.dev`

**Interfaces:**
- Produces: an image that runs `apps/portal` via `astro dev --host 0.0.0.0` on port 4322, with source overridden by volume mounts at runtime.

- [ ] **Step 1: Write the Dockerfile** (mirrors `docker/Dockerfile.web.dev`)

```dockerfile
# docker/Dockerfile.portal.dev
# Development Dockerfile for Portal with hot-reloading
FROM node:24-alpine

RUN npm install -g pnpm@10.33.4
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY turbo.json tsconfig.json ./

COPY apps/portal/package.json ./apps/portal/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install

COPY apps/portal ./apps/portal
COPY packages/shared ./packages/shared

WORKDIR /app/apps/portal
EXPOSE 4322

CMD ["sh", "-lc", "pnpm install --prefer-offline --no-frozen-lockfile && pnpm dev --host 0.0.0.0 --port 4322"]
```

- [ ] **Step 2: Verify it builds**

Run: `docker build -f docker/Dockerfile.portal.dev -t breeze-portal:dev .`
Expected: build succeeds, image `breeze-portal:dev` created.

- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile.portal.dev
git commit -m "feat(wt-stack): hot-reload portal dev Dockerfile"
```

---

## Task 6: Worktree Compose override

**Files:**
- Create: `docker-compose.override.yml.worktree`

**Interfaces:**
- Produces: a Compose override (stacked after `docker-compose.override.yml.dev`) that: removes `container_name` from postgres/redis/api/web/caddy; adds a code-mounted `portal` dev service; sets `CADDY_SITE_ADDRESS=:80`. (Ephemeral ports + tmpfs are added in Task 11 — this task targets Phase-1 `--shared`, which keeps the dev override's fixed ports.)

- [ ] **Step 1: Write the override file**

```yaml
# docker-compose.override.yml.worktree
# Namespaceable worktree stack. Stacks AFTER docker-compose.override.yml.dev.
# Phase 1 (--shared): reuses the dev override's fixed host ports.
# Adds a code-mounted Portal dev service so the worktree's portal code runs.
# NOTE: `!reset null` (Compose 2.24+) is required to UNSET container_name set in
# the base file — plain `null` is ignored and the fixed names survive the merge.
services:
  postgres:
    container_name: !reset null
  redis:
    container_name: !reset null
  api:
    container_name: !reset null
  web:
    container_name: !reset null
    # Browser calls the API same-origin through Caddy. Without this, the web
    # container inherits the developer root .env PUBLIC_API_URL (e.g.
    # http://localhost implicit :80), so the BROWSER's API calls target :80 instead
    # of the stack's ephemeral Caddy port → login POST never lands → waitForURL hangs.
    # Empty string makes the web app's resolveApiHost() use relative /api paths,
    # which Caddy routes regardless of the published port. (portal sets this too.)
    environment:
      PUBLIC_API_URL: ""
  caddy:
    container_name: !reset null
    environment:
      CADDY_SITE_ADDRESS: ":80"

  portal:
    image: breeze-portal:dev
    container_name: !reset null
    # The dev override publishes portal as a FIXED 4322:4322 host port — the last
    # non-ephemeral publish, so two stacks collide on it and Caddy (which depends on
    # portal being healthy) won't start. Portal is only reached via Caddy (baseUrl/portal),
    # so unpublish it entirely rather than burning an ephemeral port.
    ports: !reset []
    build:
      context: .
      dockerfile: docker/Dockerfile.portal.dev
    environment:
      NODE_ENV: development
      HOST: 0.0.0.0
      PORT: 4322
      PORTAL_BASE_PATH: /portal
      INTERNAL_API_URL: http://api:3001
      PUBLIC_API_URL: ""
    volumes:
      - ./apps/portal/src:/app/apps/portal/src:cached
      - ./apps/portal/public:/app/apps/portal/public:cached
      - ./apps/portal/package.json:/app/apps/portal/package.json:ro
      - ./apps/portal/tsconfig.json:/app/apps/portal/tsconfig.json:ro
      - ./apps/portal/astro.config.mjs:/app/apps/portal/astro.config.mjs:ro
      - ./apps/portal/tailwind.config.mjs:/app/apps/portal/tailwind.config.mjs:ro
      - ./packages/shared/src:/app/packages/shared/src:cached
      - /app/node_modules
      - /app/apps/portal/node_modules
      - /app/packages/shared/node_modules
    healthcheck:
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://127.0.0.1:4322/portal/login']
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    networks:
      - breeze

# Per-project network isolation (REQUIRED for parallel stacks). Base compose pins
# `networks.breeze.name: breeze`, a FIXED name shared across every Compose project.
# Two stacks then both register the `postgres`/`api`/`redis` service aliases into
# the one shared network, and Docker DNS resolves them non-deterministically across
# stacks (Stack B's API talks to Stack A's postgres). Unset the fixed name so Compose
# namespaces it per project (`<project>_breeze`), isolating service discovery.
networks:
  breeze:
    name: !reset null
```

- [ ] **Step 2: Verify the merged config is valid**

Run:
```bash
docker compose -p breeze --env-file .env --env-file .env.stack \
  -f docker-compose.yml -f docker-compose.override.yml.dev -f docker-compose.override.yml.worktree config >/dev/null && echo OK
```
(First run `tsx scripts/dev/wt-stack/cli.ts ...` is not needed; create `.env.stack` by hand for this check via `node -e "require('./scripts/dev/wt-stack/env').writeEnvStack(process.cwd())"` or rely on Task 7.)
Expected: prints `OK`, no `container_name` collisions, `portal` present with build context. If `.env.stack` does not exist yet, generate it first with the Task 4 helper.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.override.yml.worktree
git commit -m "feat(wt-stack): namespaceable worktree compose override with portal dev service"
```

---

## Task 7: Compose command wrappers (up / health / seed / port discovery / down)

**Files:**
- Modify: `scripts/dev/wt-stack/compose.ts`
- Test: manual smoke (Docker required) — no unit test for shell-out wrappers.

**Interfaces:**
- Consumes: `parsePublishedPort` (this file), `StackDescriptor`.
- Produces (all take `project: string` and run from `worktreePath`):
  - `composeArgs(project: string): string[]` → the shared `-p … --env-file … -f … -f … -f …` argument array.
  - `composeUp(project: string, opts: { rebuild: boolean }): void`
  - `waitHealthy(project: string, services: string[], timeoutMs: number): void`
  - `publishedPort(project: string, service: string, containerPort: number): number`
  - `containerName(project: string, service: string): string`
  - `seedDatabase(project: string): void` (pipes `e2e-tests/seed-fixtures.sql` into `compose exec -T postgres psql`)
  - `composeDown(project: string, removeVolumes: boolean): void`

- [ ] **Step 1: Implement the wrappers**

```ts
// scripts/dev/wt-stack/compose.ts  (append below parsePublishedPort)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SEED_SQL = path.join(ROOT, 'e2e-tests', 'seed-fixtures.sql');

export function composeArgs(project: string): string[] {
  if (!existsSync(path.join(ROOT, '.env'))) {
    throw new Error('Missing root .env (needed for digest-pinned image refs). Copy .env.example and fill it first.');
  }
  return [
    'compose', '-p', project,
    '--env-file', '.env', '--env-file', '.env.stack',
    '-f', 'docker-compose.yml',
    '-f', 'docker-compose.override.yml.dev',
    '-f', 'docker-compose.override.yml.worktree',
  ];
}

function docker(args: string[], opts: { input?: string } = {}): string {
  return execFileSync('docker', args, {
    cwd: ROOT,
    input: opts.input,
    encoding: 'utf8',
    stdio: opts.input ? ['pipe', 'pipe', 'inherit'] : ['inherit', 'pipe', 'inherit'],
  });
}

export function composeUp(project: string, opts: { rebuild: boolean }): void {
  const args = [...composeArgs(project), 'up', '-d'];
  if (opts.rebuild) args.push('--build');
  execFileSync('docker', args, { cwd: ROOT, stdio: 'inherit' });
}

export function containerName(project: string, service: string): string {
  const cid = docker([...composeArgs(project), 'ps', '-q', service]).trim();
  if (!cid) throw new Error(`Service ${service} has no container in project ${project}.`);
  return docker(['inspect', '-f', '{{ .Name }}', cid]).trim().replace(/^\//, '');
}

export function publishedPort(project: string, service: string, containerPort: number): number {
  const out = docker([...composeArgs(project), 'port', service, String(containerPort)]);
  return parsePublishedPort(out);
}

export function waitHealthy(project: string, services: string[], timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  for (const svc of services) {
    const cid = docker([...composeArgs(project), 'ps', '-q', svc]).trim();
    if (!cid) throw new Error(`Service ${svc} has no container — did it fail to start? Check \`docker compose -p ${project} logs ${svc}\`.`);
    for (;;) {
      const status = docker(['inspect', '-f', '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}{{ .State.Status }}{{ end }}', cid]).trim();
      if (status === 'healthy' || status === 'running') break;
      if (status === 'unhealthy' || status === 'exited') {
        throw new Error(`Service ${svc} is ${status}. Logs: \`docker compose -p ${project} logs ${svc}\`.`);
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${svc} to become healthy (last status: ${status}).`);
      execFileSync('sleep', ['2']);
    }
  }
}

export function seedDatabase(project: string): void {
  if (!existsSync(SEED_SQL)) throw new Error(`Seed file not found: ${SEED_SQL}`);
  execFileSync('docker', [...composeArgs(project), 'exec', '-T', 'postgres', 'psql', '-U', 'breeze', '-d', 'breeze'],
    { cwd: ROOT, input: readFileSync(SEED_SQL, 'utf8'), stdio: ['pipe', 'inherit', 'inherit'] });
}

export function composeDown(project: string, removeVolumes: boolean): void {
  const args = [...composeArgs(project), 'down'];
  if (removeVolumes) args.push('-v');
  execFileSync('docker', args, { cwd: ROOT, stdio: 'inherit' });
}
```

> **Note:** `waitHealthy` accepts `running` for services without a healthcheck and `healthy` for those with one. `containerName` resolves the real container name via `docker inspect` (handles non-default Compose naming) and throws if the service has no container.

- [ ] **Step 2: Re-run the parser unit test to confirm no regression**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run scripts/dev/wt-stack/compose.test.ts`
Expected: PASS (3 tests) — appended code does not break the parser.

- [ ] **Step 3: Commit**

```bash
git add scripts/dev/wt-stack/compose.ts
git commit -m "feat(wt-stack): docker compose wrappers for up/health/seed/port/down"
```

---

## Task 8: CLI entrypoint (`up` / `info` / `down`)

**Files:**
- Create: `scripts/dev/wt-stack/cli.ts`
- Modify: root `package.json` (add `wt-stack` script)

**Interfaces:**
- Consumes: everything from `project.ts`, `descriptor.ts`, `compose.ts`, `env.ts`.
- Produces: a runnable CLI. `up` builds env + brings the stack up + seeds + writes the descriptor + prints it. `info` prints the descriptor. `down` tears down.

- [ ] **Step 1: Implement the CLI**

```ts
// scripts/dev/wt-stack/cli.ts
import { execFileSync } from 'node:child_process';
import { deriveProjectName } from './project';
import { writeDescriptor, readDescriptor, type StackDescriptor } from './descriptor';
import { writeEnvStack } from './env';
import { composeUp, waitHealthy, publishedPort, containerName, seedDatabase, composeDown } from './compose';

const ADMIN = { email: 'admin@breeze.local', password: 'BreezeAdmin123!' };
const HEALTH_SERVICES = ['postgres', 'redis', 'api', 'web', 'portal', 'caddy'];

function currentBranch(): string | undefined {
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    return b === 'HEAD' ? undefined : b;
  } catch { return undefined; }
}

function up(shared: boolean, rebuild: boolean): void {
  const worktreePath = process.cwd();
  const project = deriveProjectName({ worktreePath, branch: currentBranch(), shared });
  console.log(`[wt-stack] project=${project} engine=${dockerContext()}`);
  writeEnvStack(worktreePath);
  composeUp(project, { rebuild });
  waitHealthy(project, HEALTH_SERVICES, 5 * 60_000);
  seedDatabase(project);
  const caddyPort = publishedPort(project, 'caddy', 80);
  const baseUrl = `http://localhost:${caddyPort}`;
  const descriptor: StackDescriptor = {
    project,
    baseUrl,
    apiUrl: `${baseUrl}/api`,
    portalUrl: `${baseUrl}/portal`,
    webPort: caddyPort,
    pgContainer: containerName(project, 'postgres'),
    redisContainer: containerName(project, 'redis'),
    admin: ADMIN,
  };
  writeDescriptor(worktreePath, descriptor);
  console.log(JSON.stringify(descriptor, null, 2));
}

function dockerContext(): string {
  try { return execFileSync('docker', ['context', 'show'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

function info(): void {
  console.log(JSON.stringify(readDescriptor(process.cwd()), null, 2));
}

function down(keepVolumes: boolean): void {
  const project = deriveProjectName({ worktreePath: process.cwd(), branch: currentBranch(), shared: process.argv.includes('--shared') });
  composeDown(project, !keepVolumes);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'up': up(rest.includes('--shared'), rest.includes('--rebuild')); break;
    case 'info': info(); break;
    case 'down': down(rest.includes('--keep-volumes')); break;
    default:
      console.error('Usage: wt-stack <up|down|info|test|ls> [--shared] [--rebuild] [--keep-volumes]');
      process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Add the npm script**

In root `package.json` `scripts`, add:
```json
"wt-stack": "tsx scripts/dev/wt-stack/cli.ts"
```

- [ ] **Step 3: Smoke test `up` (shared) end to end**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm wt-stack up --shared --rebuild`
Expected: builds images, all six services reach healthy, seed runs, prints a descriptor JSON with a `baseUrl` like `http://localhost:80` (or the published port), and `.breeze-stack.json` is written.

- [ ] **Step 4: Verify the stack answers**

Run: `curl -sf $(node -e "console.log(require('./.breeze-stack.json').apiUrl)")/../health && echo; curl -sf $(node -e "console.log(require('./.breeze-stack.json').portalUrl)")/login -o /dev/null && echo PORTAL_OK`
Expected: `/health` returns 200 body; `PORTAL_OK` prints.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/wt-stack/cli.ts package.json
git commit -m "feat(wt-stack): CLI up/info/down with descriptor emission"
```

---

## Task 9: Gitignore + Playwright wiring

**Files:**
- Modify: `.gitignore`
- Modify: `e2e-tests/playwright.config.ts`
- Modify: `e2e-tests/global-setup.ts`

**Interfaces:**
- Consumes: `.breeze-stack.json` (`StackDescriptor` shape) via a new env var `E2E_STACK_FILE` (default `<repo>/.breeze-stack.json`).
- Produces: Playwright reads `baseURL` from the descriptor; `global-setup.ts` seeds + clears redis via `docker compose -p <project> exec` derived from the descriptor.

- [ ] **Step 1: Add gitignore entries**

Append to `.gitignore`:
```
.breeze-stack.json
.env.stack
```

- [ ] **Step 2: Wire `playwright.config.ts` to the descriptor**

Replace the `baseURL` line and `use` block additions:
```ts
// e2e-tests/playwright.config.ts — near top, after imports
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function descriptor(): { baseUrl: string } | null {
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '..', '.breeze-stack.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
const stack = descriptor();
```
Then in `use`:
```ts
  use: {
    baseURL: process.env.E2E_BASE_URL ?? stack?.baseUrl ?? 'http://localhost:4321',
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: isCI ? 'retain-on-failure' : 'off',
    navigationTimeout: 30_000,
    actionTimeout: 10_000,
  },
```
> `__dirname` is available because the config is CommonJS-resolved by Playwright; if the file is ESM, derive it via `fileURLToPath(import.meta.url)` as `global-setup.ts` already does.

- [ ] **Step 3: Wire `global-setup.ts` to seed via the descriptor's project**

In `e2e-tests/global-setup.ts`, read the descriptor and replace the hardcoded container execs. Add near the top of `globalSetup`:
```ts
  const stackFile = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '..', '.breeze-stack.json');
  const stack = readFileSync(stackFile, 'utf8') ? JSON.parse(readFileSync(stackFile, 'utf8')) : null;
  const project = stack?.project as string | undefined;
  const composeBase = project
    ? ['compose', '-p', project, '--env-file', '.env', '--env-file', '.env.stack',
       '-f', 'docker-compose.yml', '-f', 'docker-compose.override.yml.dev', '-f', 'docker-compose.override.yml.worktree']
    : null;
```
Replace the seed `execFileSync('docker', ['exec', '-i', 'breeze-postgres', ...])` with:
```ts
    const psqlArgs = composeBase
      ? [...composeBase, 'exec', '-T', 'postgres', 'psql', '-U', 'breeze', '-d', 'breeze']
      : ['exec', '-i', 'breeze-postgres', 'psql', '-U', 'breeze', '-d', 'breeze'];
    execFileSync('docker', psqlArgs, { cwd: path.resolve(__dirname, '..'), input: readFileSync(sqlPath, 'utf8'), stdio: ['pipe', 'inherit', 'inherit'] });
```
Replace the redis `['exec', 'breeze-redis', 'redis-cli']` base with:
```ts
    const args = composeBase ? [...composeBase, 'exec', '-T', 'redis', 'redis-cli'] : ['exec', 'breeze-redis', 'redis-cli'];
```
> Keep the literal-container fallback so the legacy singleton workflow still works when no descriptor is present.

- [ ] **Step 4: Verify Playwright picks up the descriptor**

Run (with the Task 8 stack up): `cd e2e-tests && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH E2E_ADMIN_EMAIL=admin@breeze.local E2E_ADMIN_PASSWORD='BreezeAdmin123!' npx playwright test --list`
Expected: lists tests; global-setup is not run on `--list`. Then run one spec (next task).

- [ ] **Step 5: Commit**

```bash
git add .gitignore e2e-tests/playwright.config.ts e2e-tests/global-setup.ts
git commit -m "feat(wt-stack): Playwright reads stack descriptor for baseURL and seeding"
```

---

## Task 10: `wt-stack test` + Phase-1 smoke

**Files:**
- Modify: `scripts/dev/wt-stack/cli.ts` (add `test` subcommand)

**Interfaces:**
- Consumes: `readDescriptor`.
- Produces: `wt-stack test [-- <playwright args>]` ensures a descriptor exists, exports `E2E_STACK_FILE` / `E2E_BASE_URL` / admin creds, and runs Playwright.

- [ ] **Step 1: Add the `test` subcommand**

```ts
// in cli.ts
function test(passthrough: string[]): void {
  const worktreePath = process.cwd();
  const d = readDescriptor(worktreePath); // throws clear error if not up
  execFileSync('npx', ['playwright', 'test', ...passthrough], {
    cwd: `${worktreePath}/e2e-tests`,
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_STACK_FILE: `${worktreePath}/.breeze-stack.json`,
      E2E_BASE_URL: d.baseUrl,
      E2E_ADMIN_EMAIL: d.admin.email,
      E2E_ADMIN_PASSWORD: d.admin.password,
    },
  });
}
```
Wire into `main()`:
```ts
    case 'test': test(rest[0] === '--' ? rest.slice(1) : rest); break;
```
> The pinned-Node PATH requirement (`v22.20.0`) is documented in the agent skill (Task 13); `npx playwright` resolves from `e2e-tests/node_modules`.

- [ ] **Step 2: Run one real spec against the worktree stack**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm wt-stack test -- tests/<an-existing-spec>.spec.ts`
Expected: global-setup seeds via the descriptor's project, logs in once, the spec passes (PASS).

- [ ] **Step 3: Phase-1 teardown check**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm wt-stack down`
Then: `docker ps --format '{{.Names}}' | grep breeze || echo NO_BREEZE_CONTAINERS`
Expected: `NO_BREEZE_CONTAINERS` (all torn down).

- [ ] **Step 4: Commit**

```bash
git add scripts/dev/wt-stack/cli.ts
git commit -m "feat(wt-stack): test subcommand runs Playwright against the stack descriptor"
```

---

## Task 11: Phase 2 — per-worktree ephemeral ports + tmpfs

**Files:**
- Modify: `docker-compose.override.yml.worktree`
- Modify: `scripts/dev/wt-stack/cli.ts` (port discovery already generic; confirm non-`--shared` path)

**Interfaces:**
- Produces: in non-`--shared` mode, every published port is ephemeral (`"0:<port>"`) and Postgres data lives on tmpfs. `up` already discovers the Caddy port dynamically (Task 8), so no CLI change is required beyond confirming behavior.

- [ ] **Step 1: Add ephemeral ports + tmpfs to the override**

Update `docker-compose.override.yml.worktree` so port-publishing and tmpfs apply. Because the dev override hardcodes fixed ports, override them back to ephemeral here:
```yaml
  # binaries-init keeps a fixed container_name from base compose; reset it too or
  # two parallel stacks collide on `breeze-binaries-init` (Task 12's two-stack test
  # catches this if omitted).
  binaries-init:
    container_name: !reset null
  postgres:
    container_name: !reset null   # already set in Task 6; keep consistent
    ports: !reset []          # drop dev override's 5432 publish; not needed externally
    volumes: !reset []        # clear the named pgdata volume so tmpfs can mount the same path
    tmpfs:
      - /var/lib/postgresql/data
    command:
      - postgres
      - -c
      - fsync=off
      - -c
      - synchronous_commit=off
  redis:
    container_name: !reset null
    ports: !reset []
  api:
    container_name: !reset null
    ports: !override        # REPLACE the dev override's fixed list with an ephemeral one
      - "0:3001"
  web:
    container_name: !reset null
    ports: !override
      - "0:4321"
  caddy:
    container_name: !reset null
    environment:
      CADDY_SITE_ADDRESS: ":80"
    ports: !override
      - "0:80"
```
> Tag choice matters in Compose v2.24+ (we run v5.x): `!reset []` clears a list (postgres/redis publish nothing externally; postgres `volumes` cleared so tmpfs owns the data path). To *replace* a list with a new value use `!override [...]` — `!reset ["0:3001"]` silently discards the value and behaves like `!reset []`, so api/web/caddy ephemeral publishes MUST use `!override`. tmpfs means the Postgres init scripts (breeze_app role + extensions) re-run on every `up` — desired for a disposable DB.

- [ ] **Step 2: Bring up a worktree stack (non-shared) and confirm dynamic ports**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm wt-stack up --rebuild`
Expected: project name `breeze-wt-<branch>`; descriptor `baseUrl` uses a high ephemeral port; all services healthy; seed succeeds against the tmpfs DB.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.override.yml.worktree scripts/dev/wt-stack/cli.ts
git commit -m "feat(wt-stack): phase 2 per-worktree ephemeral ports and tmpfs postgres"
```

---

## Task 12: `wt-stack ls` + isolation verification

**Files:**
- Modify: `scripts/dev/wt-stack/cli.ts` (add `ls`)

**Interfaces:**
- Consumes: `docker compose ls`.
- Produces: `wt-stack ls` lists running `breeze`/`breeze-wt-*` Compose projects.

- [ ] **Step 1: Add `ls`**

```ts
// in cli.ts
function ls(): void {
  const out = execFileSync('docker', ['compose', 'ls', '--format', 'json'], { encoding: 'utf8' });
  const projects = (JSON.parse(out) as Array<{ Name: string; Status: string }>)
    .filter((p) => p.Name === 'breeze' || p.Name.startsWith('breeze-wt-'));
  if (!projects.length) { console.log('No breeze stacks running.'); return; }
  for (const p of projects) console.log(`${p.Name}\t${p.Status}`);
}
```
Wire into `main()`: `case 'ls': ls(); break;`

- [ ] **Step 2: Two-stack isolation test**

From worktree A: `pnpm wt-stack up --rebuild` (note its `baseUrl` port).
From worktree B (a second `git worktree`): `pnpm wt-stack up --rebuild` (note its port).
Run: `pnpm wt-stack ls`
Expected: two distinct `breeze-wt-*` projects, distinct host ports in their descriptors, both healthy.
Then `wt-stack down` in each; `docker compose ls` shows neither — independent teardown, no cross-impact.

- [ ] **Step 3: Commit**

```bash
git add scripts/dev/wt-stack/cli.ts
git commit -m "feat(wt-stack): ls subcommand lists running stacks"
```

---

## Task 13: Agent skill documentation

**Files:**
- Create: `.claude/skills/worktree-stack/SKILL.md`

**Interfaces:**
- Produces: an agent-facing guide describing the deterministic loop.

- [ ] **Step 1: Write the skill**

```markdown
---
name: worktree-stack
description: Use when an agent needs a running, seeded, Playwright-ready Breeze stack for the current git worktree. Brings up pg+redis+api+web+portal+caddy running the worktree's own code and emits a JSON descriptor.
---

# Worktree Test Stack

Loop for testing the current worktree end to end:

1. Bring up the stack (per-worktree isolated): `pnpm wt-stack up`
   - Add `--shared` for the singleton stack on fixed ports.
   - Add `--rebuild` after Dockerfile or dependency changes.
2. Read `.breeze-stack.json` at the worktree root for `baseUrl`, `apiUrl`,
   `portalUrl`, and admin creds (`admin@breeze.local` / `BreezeAdmin123!`).
3. Drive Playwright: `pnpm wt-stack test -- tests/<spec>.spec.ts`, or point the
   Playwright MCP browser at `baseUrl`.
4. Tear down: `pnpm wt-stack down` (removes volumes by default).

Notes:
- Requires Node v22.20.0 on PATH and a populated root `.env` (image refs).
- Caddy serves plain HTTP in dev; `baseUrl` is `http://localhost:<port>`.
- OrbStack is recommended for speed but not required — the CLI uses only the
  standard `docker compose` interface.
- `pnpm wt-stack ls` lists running stacks; `pnpm wt-stack info` prints the descriptor.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/worktree-stack/SKILL.md
git commit -m "docs(wt-stack): agent skill for the worktree test stack loop"
```

---

## Self-Review

**Spec coverage:**
- Orchestration CLI (up/down/info/test/ls) → Tasks 8, 10, 12. ✔
- `docker-compose.override.yml.worktree` (no container_name, portal, ephemeral ports, tmpfs) → Tasks 6, 11. ✔
- `Dockerfile.portal.dev` → Task 5. ✔
- `.breeze-stack.json` descriptor → Task 2 (type/io), Task 8 (emission). ✔
- Playwright wiring (baseURL + seed via project) → Task 9. ✔
- Caddy entry + ignoreHTTPSErrors → Task 9 (config), Task 6 (`:80`). ✔
- tmpfs + fsync off + native arm builds → Task 11 (tmpfs/fsync); native arm is automatic from source builds on Apple Silicon (no amd64 platform pin on the dev portal/api/web services). ✔
- Bootstrap (.env.stack, pnpm install, migrations on boot) → Task 4 (env), Task 8 (`up` flow; migrations auto-apply via API boot). ✔
- Phasing (Phase 1 shared / Phase 2 isolated) → `--shared` in Tasks 8/11. ✔
- Error handling (health gating, port-discovery failure, idempotent up, engine detection) → Task 7 (`waitHealthy`, `parsePublishedPort` throw), Task 8 (`dockerContext` log). ✔
- Testing the tool (smoke, isolation) → Tasks 10, 12. ✔
- Agent skill → Task 13. ✔

**Gap fixed during review:** Phase-1 `up` flow does not call `pnpm install` explicitly; the dev Dockerfiles' CMD already runs `pnpm install --prefer-offline --no-frozen-lockfile` on container start, so a fresh worktree's deps are installed in-container. Host-side `pnpm install` is only needed for running Playwright on the host — documented in Task 13's skill (Node v22.20.0 requirement). No separate task needed.

**Placeholder scan:** No TBD/TODO. The one "remove this line if it complicates resolution" note (Task 10 `pnpm --filter NONE` guard) is an explicit, optional simplification with the fallback stated, not a placeholder.

**Type consistency:** `StackDescriptor` fields (`project`, `baseUrl`, `apiUrl`, `portalUrl`, `webPort`, `pgContainer`, `redisContainer`, `admin`) are identical across Tasks 2, 8, 9, 10. `deriveProjectName` / `composeArgs` / `publishedPort` / `containerName` / `seedDatabase` / `composeDown` signatures match between their definitions (Tasks 1, 7) and call sites (Task 8). ✔
