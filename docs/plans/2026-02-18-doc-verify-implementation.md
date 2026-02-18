# Doc-Verify E2E Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an AI-driven documentation verification system that extracts testable assertions from MDX docs and verifies them against a local Docker stack.

**Architecture:** Three-phase pipeline — (1) Claude API reads MDX docs and extracts structured assertions into a cached manifest, (2) a runner dispatches each assertion to the right executor (HTTP for API claims, SQL for data-layer claims, Claude+Playwright for UI claims), (3) results are reported as JSON/HTML.

**Tech Stack:** TypeScript, Claude API (Anthropic SDK), Playwright, Docker Compose, PostgreSQL, tsx

---

### Task 1: Project Scaffold & Dependencies

**Files:**
- Create: `e2e-tests/doc-verify/cli.ts`
- Create: `e2e-tests/doc-verify/types.ts`
- Modify: `e2e-tests/package.json`
- Create: `e2e-tests/doc-verify/tsconfig.json`

**Step 1: Add dependencies to e2e-tests/package.json**

Add these to `e2e-tests/package.json`:

```json
{
  "scripts": {
    "doc-verify": "tsx doc-verify/cli.ts",
    "doc-verify:extract": "tsx doc-verify/cli.ts extract",
    "doc-verify:run": "tsx doc-verify/cli.ts run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "pg": "^8.13.0",
    "@types/pg": "^8.11.0"
  }
}
```

Run: `cd e2e-tests && pnpm install`

**Step 2: Create types.ts with assertion manifest types**

```typescript
// e2e-tests/doc-verify/types.ts

export interface AssertionManifest {
  version: number;
  generatedAt: string;
  pages: PageAssertions[];
}

export interface PageAssertions {
  source: string;
  contentHash: string;
  assertions: Assertion[];
}

export type Assertion = ApiAssertion | SqlAssertion | UiAssertion;

interface BaseAssertion {
  id: string;
  claim: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface ApiAssertion extends BaseAssertion {
  type: 'api';
  test: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    expect: {
      status?: number;
      bodyContains?: string[];
      bodyNotContains?: string[];
      contentType?: string;
    };
  };
}

export interface SqlAssertion extends BaseAssertion {
  type: 'sql';
  test: {
    /** Description of what to query — runner builds actual SQL */
    query: string;
    expect: Record<string, unknown>;
  };
}

export interface UiAssertion extends BaseAssertion {
  type: 'ui';
  test: {
    /** URL path to navigate to */
    navigate: string;
    /** Setup steps before verification (e.g., "log in as admin") */
    setup?: string[];
    /** Natural language verification instruction */
    verify: string;
  };
}

export interface AssertionResult {
  id: string;
  type: 'api' | 'sql' | 'ui';
  claim: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  reason: string;
  durationMs: number;
}

export interface RunReport {
  startedAt: string;
  completedAt: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  results: AssertionResult[];
}
```

**Step 3: Create CLI entry point skeleton**

```typescript
// e2e-tests/doc-verify/cli.ts
import { resolve } from 'path';

const command = process.argv[2] || 'all';

async function main() {
  switch (command) {
    case 'extract':
      console.log('Extracting assertions from docs...');
      break;
    case 'run':
      console.log('Running assertions...');
      break;
    case 'all':
      console.log('Extracting and running...');
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: doc-verify [extract|run|all]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Step 4: Verify it runs**

Run: `cd e2e-tests && pnpm doc-verify extract`
Expected: `Extracting assertions from docs...`

**Step 5: Commit**

```bash
git add e2e-tests/doc-verify/ e2e-tests/package.json
git commit -m "feat(doc-verify): scaffold project with types and CLI entry point"
```

---

### Task 2: Docker Compose for Full Test Stack

**Files:**
- Create: `docker-compose.doc-verify.yml`
- Create: `e2e-tests/doc-verify/fixtures/seed.sql`

**Step 1: Create docker-compose.doc-verify.yml**

This extends the existing test infra and adds API + web services:

```yaml
# docker-compose.doc-verify.yml
# Full stack for documentation verification tests
# Usage: docker compose -f docker-compose.doc-verify.yml up -d --wait

services:
  postgres-test:
    image: postgres:16-alpine
    container_name: breeze-dv-postgres
    environment:
      POSTGRES_USER: breeze_test
      POSTGRES_PASSWORD: breeze_test
      POSTGRES_DB: breeze_test
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data
    networks:
      - dv-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U breeze_test -d breeze_test"]
      interval: 2s
      timeout: 5s
      retries: 10
      start_period: 2s

  redis-test:
    image: redis:7-alpine
    container_name: breeze-dv-redis
    command: redis-server --appendonly no --save ""
    ports:
      - "6380:6379"
    networks:
      - dv-network
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 5s
      retries: 10
      start_period: 1s

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    container_name: breeze-dv-api
    environment:
      NODE_ENV: test
      DATABASE_URL: postgresql://breeze_test:breeze_test@postgres-test:5432/breeze_test
      REDIS_URL: redis://redis-test:6379
      AGENT_ENROLLMENT_SECRET: test-enrollment-secret
      JWT_SECRET: test-jwt-secret-must-be-at-least-32-characters-long
      APP_ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      MFA_ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      ENROLLMENT_KEY_PEPPER: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      API_PORT: "3001"
      ENABLE_REGISTRATION: "true"
      CORS_ORIGINS: "http://localhost:4321"
    depends_on:
      postgres-test:
        condition: service_healthy
      redis-test:
        condition: service_healthy
    ports:
      - "3001:3001"
    networks:
      - dv-network
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3001/health"]
      interval: 5s
      timeout: 5s
      retries: 20
      start_period: 10s

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    container_name: breeze-dv-web
    environment:
      PUBLIC_API_URL: http://localhost:3001/api/v1
    depends_on:
      api:
        condition: service_healthy
    ports:
      - "4321:4321"
    networks:
      - dv-network
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:4321"]
      interval: 5s
      timeout: 5s
      retries: 20
      start_period: 10s

networks:
  dv-network:
    driver: bridge
    name: breeze-dv-network
```

**Step 2: Create seed fixture**

```typescript
// e2e-tests/doc-verify/fixtures/seed.ts
import pg from 'pg';
import crypto from 'crypto';

const { Client } = pg;

export interface SeedData {
  orgId: string;
  siteId: string;
  enrollmentKey: string;
  adminEmail: string;
  adminPassword: string;
}

export async function seedTestData(dbUrl: string): Promise<SeedData> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // Check if seed data already exists
    const existing = await client.query(
      "SELECT id FROM organizations WHERE name = 'Doc Verify Test Org' LIMIT 1"
    );
    if (existing.rows.length > 0) {
      const org = existing.rows[0];
      const site = await client.query(
        "SELECT id FROM sites WHERE org_id = $1 LIMIT 1",
        [org.id]
      );
      const key = await client.query(
        "SELECT key FROM enrollment_keys WHERE org_id = $1 AND expires_at > NOW() LIMIT 1",
        [org.id]
      );
      return {
        orgId: org.id,
        siteId: site.rows[0]?.id || '',
        enrollmentKey: key.rows[0]?.key || '',
        adminEmail: 'admin@breeze.local',
        adminPassword: 'BreezeAdmin123!',
      };
    }

    // This is a placeholder — the actual seed depends on the exact schema.
    // The API's db:seed command should handle this.
    // We'll call the API registration endpoint instead.
    console.log('No existing seed data found. Will seed via API.');
    return {
      orgId: '',
      siteId: '',
      enrollmentKey: '',
      adminEmail: 'admin@breeze.local',
      adminPassword: 'BreezeAdmin123!',
    };
  } finally {
    await client.end();
  }
}

export async function seedViaApi(apiUrl: string): Promise<SeedData> {
  const adminEmail = 'admin@breeze.local';
  const adminPassword = 'BreezeAdmin123!';

  // Register admin user
  const registerRes = await fetch(`${apiUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: adminEmail,
      password: adminPassword,
      firstName: 'Test',
      lastName: 'Admin',
    }),
  });

  // Login to get token
  const loginRes = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  const { token } = await loginRes.json() as { token: string };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // Get or create org
  const orgsRes = await fetch(`${apiUrl}/api/v1/organizations`, { headers });
  const orgs = await orgsRes.json() as { id: string }[];
  const orgId = orgs[0]?.id || '';

  // Get or create site
  const sitesRes = await fetch(`${apiUrl}/api/v1/sites?orgId=${orgId}`, { headers });
  const sites = await sitesRes.json() as { id: string }[];
  const siteId = sites[0]?.id || '';

  // Create enrollment key
  const keyRes = await fetch(`${apiUrl}/api/v1/enrollment-keys`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      orgId,
      siteId,
      name: 'doc-verify-key',
      expiresInMinutes: 60,
      maxUses: 100,
    }),
  });
  const { key: enrollmentKey } = await keyRes.json() as { key: string };

  return { orgId, siteId, enrollmentKey, adminEmail, adminPassword };
}
```

**Step 3: Test Docker stack starts**

Run: `docker compose -f docker-compose.doc-verify.yml up -d --wait`
Expected: All 4 services healthy.

Run: `curl -s http://localhost:3001/health`
Expected: `{"status":"ok"}` (or similar)

Run: `docker compose -f docker-compose.doc-verify.yml down -v`

**Step 4: Commit**

```bash
git add docker-compose.doc-verify.yml e2e-tests/doc-verify/fixtures/
git commit -m "feat(doc-verify): add Docker Compose stack and seed fixtures"
```

---

### Task 3: Assertion Extractor (Claude API)

**Files:**
- Create: `e2e-tests/doc-verify/extractor.ts`

**Step 1: Write a test for content hash computation**

```typescript
// e2e-tests/doc-verify/extractor.test.ts
import { describe, it, expect } from 'vitest';
import { computeContentHash } from './extractor';

describe('extractor', () => {
  it('computes stable content hash', () => {
    const hash1 = computeContentHash('hello world');
    const hash2 = computeContentHash('hello world');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('different content produces different hash', () => {
    const hash1 = computeContentHash('hello');
    const hash2 = computeContentHash('world');
    expect(hash1).not.toBe(hash2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd e2e-tests && npx vitest run doc-verify/extractor.test.ts`
Expected: FAIL — `computeContentHash` not defined

**Step 3: Write the extractor**

```typescript
// e2e-tests/doc-verify/extractor.ts
import { readFile, writeFile, readdir } from 'fs/promises';
import { resolve, relative } from 'path';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { AssertionManifest, PageAssertions, Assertion } from './types';

const DOCS_DIR = resolve(__dirname, '../../apps/docs/src/content/docs');

export function computeContentHash(content: string): string {
  const hash = createHash('sha256').update(content).digest('hex');
  return `sha256:${hash}`;
}

const EXTRACTION_PROMPT = `You are a test assertion extractor. Given documentation for an RMM (Remote Monitoring and Management) platform, extract testable assertions.

For each claim the documentation makes, create a structured assertion. Categorize each as:
- "api": Claims about HTTP endpoints (status codes, response shapes, headers). These will be tested with direct HTTP requests.
- "sql": Claims about data storage (what gets stored, how it's hashed, permissions). These will be tested with DB queries.
- "ui": Claims about what users see in the dashboard (pages, elements, behavior). These will be tested by an AI navigating the browser.

Rules:
- Only extract claims that are concretely testable against a running instance
- Skip claims about external systems (Let's Encrypt, Cloudflare, etc.)
- Skip platform-specific claims that require a specific OS (Windows registry, systemd, etc.)
- For API assertions, include the exact method, path, expected status, and key response fields
- For UI assertions, include the page to navigate to and what to verify in natural language
- Give each assertion a unique ID like "pagename-NNN"
- Set severity: "critical" for auth/security/enrollment, "warning" for core features, "info" for nice-to-haves

Respond with a JSON array of assertions. Each assertion must match one of these shapes:

API assertion:
{
  "id": "string",
  "type": "api",
  "claim": "human readable claim",
  "severity": "critical|warning|info",
  "test": {
    "method": "GET|POST|PUT|DELETE",
    "path": "/api/v1/...",
    "body": {},
    "headers": {},
    "expect": {
      "status": 200,
      "bodyContains": ["field1", "field2"],
      "contentType": "application/json"
    }
  }
}

SQL assertion:
{
  "id": "string",
  "type": "sql",
  "claim": "human readable claim",
  "severity": "critical|warning|info",
  "test": {
    "query": "description of what to check",
    "expect": { "description": "expected result" }
  }
}

UI assertion:
{
  "id": "string",
  "type": "ui",
  "claim": "human readable claim",
  "severity": "critical|warning|info",
  "test": {
    "navigate": "/page-path",
    "verify": "natural language description of what to verify on the page"
  }
}

Return ONLY the JSON array, no markdown fencing.`;

export async function extractAssertions(
  docPaths: string[],
  existingManifest?: AssertionManifest,
  incremental = false,
): Promise<AssertionManifest> {
  const client = new Anthropic();
  const pages: PageAssertions[] = [];

  for (const docPath of docPaths) {
    const fullPath = resolve(DOCS_DIR, docPath);
    const content = await readFile(fullPath, 'utf-8');
    const contentHash = computeContentHash(content);

    // Skip if content hasn't changed (incremental mode)
    if (incremental && existingManifest) {
      const existingPage = existingManifest.pages.find((p) => p.source === docPath);
      if (existingPage && existingPage.contentHash === contentHash) {
        pages.push(existingPage);
        console.log(`  [skip] ${docPath} (unchanged)`);
        continue;
      }
    }

    console.log(`  [extract] ${docPath}...`);

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `Extract testable assertions from this documentation page (source: ${docPath}):\n\n${content}`,
        },
      ],
      system: EXTRACTION_PROMPT,
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    let assertions: Assertion[];
    try {
      assertions = JSON.parse(text);
    } catch {
      console.error(`  [error] Failed to parse assertions for ${docPath}`);
      console.error(`  Response: ${text.slice(0, 200)}`);
      assertions = [];
    }

    pages.push({ source: docPath, contentHash, assertions });
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    pages,
  };
}

export async function listDocPages(scope: string[]): Promise<string[]> {
  const paths: string[] = [];

  for (const dir of scope) {
    const fullDir = resolve(DOCS_DIR, dir);
    try {
      const files = await readdir(fullDir);
      for (const file of files) {
        if (file.endsWith('.mdx')) {
          paths.push(`${dir}/${file}`);
        }
      }
    } catch {
      console.error(`  [warn] Directory not found: ${dir}`);
    }
  }

  return paths;
}

export async function loadManifest(path: string): Promise<AssertionManifest | undefined> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export async function saveManifest(manifest: AssertionManifest, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(manifest, null, 2));
}
```

**Step 4: Run test to verify it passes**

Run: `cd e2e-tests && npx vitest run doc-verify/extractor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add e2e-tests/doc-verify/extractor.ts e2e-tests/doc-verify/extractor.test.ts
git commit -m "feat(doc-verify): add assertion extractor with Claude API integration"
```

---

### Task 4: API Executor

**Files:**
- Create: `e2e-tests/doc-verify/executors/api.ts`
- Create: `e2e-tests/doc-verify/executors/api.test.ts`

**Step 1: Write test for API executor**

```typescript
// e2e-tests/doc-verify/executors/api.test.ts
import { describe, it, expect } from 'vitest';
import { resolveVariables } from './api';

describe('api executor', () => {
  it('resolves template variables', () => {
    const env = { ENROLLMENT_SECRET: 'my-secret' };
    const result = resolveVariables('{{ENROLLMENT_SECRET}}', env);
    expect(result).toBe('my-secret');
  });

  it('leaves unknown variables as-is', () => {
    const result = resolveVariables('{{UNKNOWN}}', {});
    expect(result).toBe('{{UNKNOWN}}');
  });

  it('resolves multiple variables in string', () => {
    const env = { A: 'hello', B: 'world' };
    const result = resolveVariables('{{A}} {{B}}', env);
    expect(result).toBe('hello world');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd e2e-tests && npx vitest run doc-verify/executors/api.test.ts`
Expected: FAIL

**Step 3: Write API executor**

```typescript
// e2e-tests/doc-verify/executors/api.ts
import type { ApiAssertion, AssertionResult } from '../types';

export function resolveVariables(
  template: string,
  env: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return env[key] ?? match;
  });
}

function resolveObject(
  obj: Record<string, unknown>,
  env: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = resolveVariables(value, env);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = resolveObject(value as Record<string, unknown>, env);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function executeApiAssertion(
  assertion: ApiAssertion,
  apiUrl: string,
  env: Record<string, string>,
): Promise<AssertionResult> {
  const start = Date.now();
  const { method, path, body, headers: rawHeaders, expect: expected } = assertion.test;

  const url = `${apiUrl}${resolveVariables(path, env)}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(rawHeaders
      ? Object.fromEntries(
          Object.entries(rawHeaders).map(([k, v]) => [k, resolveVariables(v, env)]),
        )
      : {}),
  };

  // Add auth token if available in env
  if (env.AUTH_TOKEN && !headers.Authorization) {
    headers.Authorization = `Bearer ${env.AUTH_TOKEN}`;
  }

  const resolvedBody = body ? resolveObject(body, env) : undefined;

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: resolvedBody ? JSON.stringify(resolvedBody) : undefined,
    });

    const responseBody = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(responseBody);
    } catch {
      json = null;
    }

    const failures: string[] = [];

    // Check status code
    if (expected.status && response.status !== expected.status) {
      failures.push(`Expected status ${expected.status}, got ${response.status}`);
    }

    // Check content type
    if (expected.contentType) {
      const ct = response.headers.get('content-type') || '';
      if (!ct.includes(expected.contentType)) {
        failures.push(`Expected content-type "${expected.contentType}", got "${ct}"`);
      }
    }

    // Check body contains fields
    if (expected.bodyContains && json && typeof json === 'object') {
      for (const field of expected.bodyContains) {
        if (!(field in (json as Record<string, unknown>))) {
          failures.push(`Response body missing field "${field}"`);
        }
      }
    }

    // Check body does NOT contain fields
    if (expected.bodyNotContains && json && typeof json === 'object') {
      for (const field of expected.bodyNotContains) {
        if (field in (json as Record<string, unknown>)) {
          failures.push(`Response body should not contain field "${field}"`);
        }
      }
    }

    return {
      id: assertion.id,
      type: 'api',
      claim: assertion.claim,
      status: failures.length === 0 ? 'pass' : 'fail',
      reason: failures.length === 0 ? 'All checks passed' : failures.join('; '),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: assertion.id,
      type: 'api',
      claim: assertion.claim,
      status: 'error',
      reason: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
```

**Step 4: Run tests**

Run: `cd e2e-tests && npx vitest run doc-verify/executors/api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add e2e-tests/doc-verify/executors/
git commit -m "feat(doc-verify): add API assertion executor with variable resolution"
```

---

### Task 5: SQL Executor

**Files:**
- Create: `e2e-tests/doc-verify/executors/sql.ts`

**Step 1: Write SQL executor**

```typescript
// e2e-tests/doc-verify/executors/sql.ts
import pg from 'pg';
import type { SqlAssertion, AssertionResult } from '../types';

const { Client } = pg;

export async function executeSqlAssertion(
  assertion: SqlAssertion,
  dbUrl: string,
  context: Record<string, string>,
): Promise<AssertionResult> {
  const start = Date.now();
  const client = new Client({ connectionString: dbUrl });

  try {
    await client.connect();

    // The assertion.test.query is a description, not raw SQL.
    // We map known query patterns to actual SQL.
    const result = await runQuery(client, assertion.test.query, context);

    // Basic verification — the expect object describes what to check
    const expectation = assertion.test.expect;
    const failures: string[] = [];

    if ('notNull' in expectation && expectation.notNull && result === null) {
      failures.push('Expected non-null result, got null');
    }

    if ('startsWith_not' in expectation && typeof result === 'string') {
      const prefix = expectation.startsWith_not as string;
      if (result.startsWith(prefix)) {
        failures.push(`Value should not start with "${prefix}"`);
      }
    }

    if ('rowCount' in expectation) {
      const expected = expectation.rowCount as number;
      const actual = typeof result === 'number' ? result : 0;
      if (actual !== expected) {
        failures.push(`Expected ${expected} rows, got ${actual}`);
      }
    }

    return {
      id: assertion.id,
      type: 'sql',
      claim: assertion.claim,
      status: failures.length === 0 ? 'pass' : 'fail',
      reason: failures.length === 0 ? 'All checks passed' : failures.join('; '),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: assertion.id,
      type: 'sql',
      claim: assertion.claim,
      status: 'error',
      reason: `SQL query failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  } finally {
    await client.end();
  }
}

async function runQuery(
  client: pg.Client,
  queryDescription: string,
  context: Record<string, string>,
): Promise<unknown> {
  // Map descriptive queries to actual SQL
  const desc = queryDescription.toLowerCase();

  if (desc.includes('agenttokenhash') && context.deviceId) {
    const res = await client.query(
      'SELECT agent_token_hash FROM devices WHERE id = $1',
      [context.deviceId],
    );
    return res.rows[0]?.agent_token_hash ?? null;
  }

  if (desc.includes('device') && desc.includes('count') && context.orgId) {
    const res = await client.query(
      'SELECT COUNT(*) as count FROM devices WHERE org_id = $1',
      [context.orgId],
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  }

  // Fallback: return null for unrecognized queries
  console.warn(`  [sql] Unrecognized query pattern: ${queryDescription}`);
  return null;
}
```

**Step 2: Commit**

```bash
git add e2e-tests/doc-verify/executors/sql.ts
git commit -m "feat(doc-verify): add SQL assertion executor"
```

---

### Task 6: UI Executor (Claude + Playwright)

**Files:**
- Create: `e2e-tests/doc-verify/executors/ui.ts`

**Step 1: Write UI executor**

This executor uses Claude API + Playwright to navigate the app and verify claims:

```typescript
// e2e-tests/doc-verify/executors/ui.ts
import { chromium, type Browser, type Page } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import type { UiAssertion, AssertionResult } from '../types';

let browser: Browser | null = null;
let page: Page | null = null;

export async function initBrowser(): Promise<void> {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}

async function loginIfNeeded(
  p: Page,
  baseUrl: string,
  env: Record<string, string>,
): Promise<void> {
  // Check if we're on the login page
  const url = p.url();
  if (url.includes('/login') || url === 'about:blank') {
    await p.goto(`${baseUrl}/login`);
    await p.locator('#email').fill(env.ADMIN_EMAIL || 'admin@breeze.local');
    await p.locator('#password').fill(env.ADMIN_PASSWORD || 'BreezeAdmin123!');
    await p.locator('button[type="submit"]').click();
    await p.waitForURL('**/*', { timeout: 15_000 });
    // Wait for app to load
    await p.waitForTimeout(2000);
  }
}

export async function executeUiAssertion(
  assertion: UiAssertion,
  baseUrl: string,
  env: Record<string, string>,
): Promise<AssertionResult> {
  const start = Date.now();

  if (!page) {
    return {
      id: assertion.id,
      type: 'ui',
      claim: assertion.claim,
      status: 'error',
      reason: 'Browser not initialized. Call initBrowser() first.',
      durationMs: Date.now() - start,
    };
  }

  try {
    // Login if needed
    await loginIfNeeded(page, baseUrl, env);

    // Navigate to the target page
    const targetUrl = `${baseUrl}${assertion.test.navigate}`;
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(1000); // Let dynamic content settle

    // Take a DOM snapshot (accessible tree)
    const snapshot = await page.accessibility.snapshot();
    const bodyText = await page.locator('body').innerText();

    // Use Claude to verify the claim
    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `You are verifying a documentation claim against a live web application.

Page URL: ${targetUrl}

Page text content (truncated to 5000 chars):
${bodyText.slice(0, 5000)}

Accessibility tree (truncated):
${JSON.stringify(snapshot, null, 2).slice(0, 3000)}

Documentation claim to verify:
"${assertion.claim}"

Specific verification instruction:
${assertion.test.verify}

Respond with ONLY this JSON (no markdown):
{"pass": true/false, "reason": "brief explanation"}`,
        },
      ],
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    let verification: { pass: boolean; reason: string };
    try {
      verification = JSON.parse(text);
    } catch {
      verification = { pass: false, reason: `Failed to parse AI response: ${text.slice(0, 200)}` };
    }

    return {
      id: assertion.id,
      type: 'ui',
      claim: assertion.claim,
      status: verification.pass ? 'pass' : 'fail',
      reason: verification.reason,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: assertion.id,
      type: 'ui',
      claim: assertion.claim,
      status: 'error',
      reason: `UI verification failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
```

**Step 2: Commit**

```bash
git add e2e-tests/doc-verify/executors/ui.ts
git commit -m "feat(doc-verify): add UI assertion executor with Claude + Playwright"
```

---

### Task 7: Runner Orchestrator

**Files:**
- Create: `e2e-tests/doc-verify/runner.ts`

**Step 1: Write the runner**

```typescript
// e2e-tests/doc-verify/runner.ts
import type { AssertionManifest, Assertion, AssertionResult, RunReport } from './types';
import { executeApiAssertion } from './executors/api';
import { executeSqlAssertion } from './executors/sql';
import { executeUiAssertion, initBrowser, closeBrowser } from './executors/ui';

interface RunOptions {
  apiUrl: string;
  baseUrl: string;
  dbUrl: string;
  env: Record<string, string>;
  page?: string;
  typeFilter?: ('api' | 'sql' | 'ui')[];
}

export async function runAssertions(
  manifest: AssertionManifest,
  options: RunOptions,
): Promise<RunReport> {
  const startedAt = new Date().toISOString();
  const results: AssertionResult[] = [];

  // Filter pages if --page specified
  let pages = manifest.pages;
  if (options.page) {
    pages = pages.filter((p) => p.source.includes(options.page!));
  }

  // Collect all assertions
  let allAssertions: { assertion: Assertion; source: string }[] = [];
  for (const page of pages) {
    for (const assertion of page.assertions) {
      if (options.typeFilter && !options.typeFilter.includes(assertion.type)) {
        continue;
      }
      allAssertions.push({ assertion, source: page.source });
    }
  }

  console.log(`\nRunning ${allAssertions.length} assertions...\n`);

  // Check if we need a browser
  const hasUiAssertions = allAssertions.some((a) => a.assertion.type === 'ui');
  if (hasUiAssertions) {
    console.log('Initializing browser for UI assertions...');
    await initBrowser();
  }

  // Shared context for cross-assertion data (e.g., deviceId from enrollment)
  const context: Record<string, string> = { ...options.env };

  // Execute assertions in order (some depend on prior results)
  for (const { assertion, source } of allAssertions) {
    const prefix = `[${assertion.type}] ${assertion.id}`;
    process.stdout.write(`  ${prefix}: ${assertion.claim.slice(0, 60)}...`);

    let result: AssertionResult;

    switch (assertion.type) {
      case 'api':
        result = await executeApiAssertion(assertion, options.apiUrl, context);
        break;
      case 'sql':
        result = await executeSqlAssertion(assertion, options.dbUrl, context);
        break;
      case 'ui':
        result = await executeUiAssertion(assertion, options.baseUrl, context);
        break;
      default:
        result = {
          id: assertion.id,
          type: assertion.type,
          claim: assertion.claim,
          status: 'skip',
          reason: `Unknown assertion type: ${assertion.type}`,
          durationMs: 0,
        };
    }

    // Print result
    const icon = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : result.status === 'error' ? 'ERR ' : 'SKIP';
    console.log(` ${icon} (${result.durationMs}ms)`);
    if (result.status !== 'pass') {
      console.log(`    ${result.reason}`);
    }

    results.push(result);
  }

  if (hasUiAssertions) {
    await closeBrowser();
  }

  const report: RunReport = {
    startedAt,
    completedAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
  };

  return report;
}
```

**Step 2: Commit**

```bash
git add e2e-tests/doc-verify/runner.ts
git commit -m "feat(doc-verify): add runner orchestrator for assertion execution"
```

---

### Task 8: Report Generator

**Files:**
- Create: `e2e-tests/doc-verify/report.ts`

**Step 1: Write report generator**

```typescript
// e2e-tests/doc-verify/report.ts
import { writeFile } from 'fs/promises';
import type { RunReport } from './types';

export function printSummary(report: RunReport): void {
  console.log('\n' + '='.repeat(60));
  console.log('Documentation Verification Report');
  console.log('='.repeat(60));
  console.log(`Total:   ${report.total}`);
  console.log(`Passed:  ${report.passed}`);
  console.log(`Failed:  ${report.failed}`);
  console.log(`Errors:  ${report.errors}`);
  console.log(`Skipped: ${report.skipped}`);
  console.log(`Time:    ${new Date(report.completedAt).getTime() - new Date(report.startedAt).getTime()}ms`);
  console.log('='.repeat(60));

  if (report.failed > 0 || report.errors > 0) {
    console.log('\nFailed/Error assertions:');
    for (const r of report.results) {
      if (r.status === 'fail' || r.status === 'error') {
        console.log(`  [${r.status.toUpperCase()}] ${r.id}: ${r.claim}`);
        console.log(`    Reason: ${r.reason}`);
      }
    }
  }
}

export async function saveJsonReport(report: RunReport, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`\nJSON report saved to ${path}`);
}

export async function saveHtmlReport(report: RunReport, path: string): Promise<void> {
  const passRate = report.total > 0 ? Math.round((report.passed / report.total) * 100) : 0;
  const statusColor = passRate === 100 ? '#22c55e' : passRate >= 80 ? '#eab308' : '#ef4444';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Doc Verification Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    .summary { display: flex; gap: 1rem; margin: 1rem 0; }
    .stat { padding: 1rem; border-radius: 8px; background: #f3f4f6; flex: 1; text-align: center; }
    .stat .num { font-size: 2rem; font-weight: bold; }
    .pass { color: #22c55e; } .fail { color: #ef4444; } .error { color: #f59e0b; } .skip { color: #9ca3af; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { background: #f9fafb; font-weight: 600; }
    .badge { padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-pass { background: #dcfce7; color: #166534; }
    .badge-fail { background: #fee2e2; color: #991b1b; }
    .badge-error { background: #fef3c7; color: #92400e; }
    .badge-skip { background: #f3f4f6; color: #6b7280; }
  </style>
</head>
<body>
  <h1>Documentation Verification Report</h1>
  <p>Generated: ${new Date(report.completedAt).toLocaleString()}</p>
  <div class="summary">
    <div class="stat"><div class="num">${report.total}</div>Total</div>
    <div class="stat"><div class="num pass">${report.passed}</div>Passed</div>
    <div class="stat"><div class="num fail">${report.failed}</div>Failed</div>
    <div class="stat"><div class="num error">${report.errors}</div>Errors</div>
  </div>
  <div style="text-align:center;font-size:1.5rem;color:${statusColor};font-weight:bold;margin:1rem 0;">
    ${passRate}% Pass Rate
  </div>
  <table>
    <thead><tr><th>ID</th><th>Type</th><th>Claim</th><th>Status</th><th>Time</th><th>Details</th></tr></thead>
    <tbody>
      ${report.results
        .map(
          (r) => `<tr>
        <td><code>${r.id}</code></td>
        <td>${r.type}</td>
        <td>${r.claim}</td>
        <td><span class="badge badge-${r.status}">${r.status.toUpperCase()}</span></td>
        <td>${r.durationMs}ms</td>
        <td>${r.status !== 'pass' ? r.reason : ''}</td>
      </tr>`,
        )
        .join('\n')}
    </tbody>
  </table>
</body>
</html>`;

  await writeFile(path, html);
  console.log(`HTML report saved to ${path}`);
}
```

**Step 2: Commit**

```bash
git add e2e-tests/doc-verify/report.ts
git commit -m "feat(doc-verify): add JSON and HTML report generators"
```

---

### Task 9: Wire Up the CLI

**Files:**
- Modify: `e2e-tests/doc-verify/cli.ts`

**Step 1: Complete the CLI**

```typescript
// e2e-tests/doc-verify/cli.ts
import { resolve } from 'path';
import {
  extractAssertions,
  listDocPages,
  loadManifest,
  saveManifest,
} from './extractor';
import { runAssertions } from './runner';
import { printSummary, saveJsonReport, saveHtmlReport } from './report';
import { seedViaApi } from './fixtures/seed';

const MANIFEST_PATH = resolve(__dirname, 'assertions.json');
const REPORT_DIR = resolve(__dirname, 'reports');

// Initial scope: getting-started + agents docs
const DOC_SCOPE = ['getting-started', 'agents'];

function getEnv(): Record<string, string> {
  return {
    ENROLLMENT_SECRET: process.env.AGENT_ENROLLMENT_SECRET || 'test-enrollment-secret',
    ADMIN_EMAIL: process.env.E2E_ADMIN_EMAIL || 'admin@breeze.local',
    ADMIN_PASSWORD: process.env.E2E_ADMIN_PASSWORD || 'BreezeAdmin123!',
    AUTH_TOKEN: '', // Populated during seed
  };
}

async function extract(incremental: boolean) {
  console.log('Extracting assertions from documentation...');
  const docPaths = await listDocPages(DOC_SCOPE);
  console.log(`Found ${docPaths.length} doc pages in scope.`);

  const existing = incremental ? await loadManifest(MANIFEST_PATH) : undefined;
  const manifest = await extractAssertions(docPaths, existing, incremental);

  await saveManifest(manifest, MANIFEST_PATH);

  const totalAssertions = manifest.pages.reduce((sum, p) => sum + p.assertions.length, 0);
  console.log(`\nExtracted ${totalAssertions} assertions across ${manifest.pages.length} pages.`);
  console.log(`Manifest saved to ${MANIFEST_PATH}`);
}

async function run(pageFilter?: string) {
  const manifest = await loadManifest(MANIFEST_PATH);
  if (!manifest) {
    console.error('No assertions.json found. Run "doc-verify extract" first.');
    process.exit(1);
  }

  const apiUrl = process.env.DOC_VERIFY_API_URL || 'http://localhost:3001';
  const baseUrl = process.env.DOC_VERIFY_BASE_URL || 'http://localhost:4321';
  const dbUrl =
    process.env.DOC_VERIFY_DB_URL ||
    'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

  // Seed test data
  console.log('Seeding test data...');
  const seedData = await seedViaApi(apiUrl);
  const env = {
    ...getEnv(),
    ORG_ID: seedData.orgId,
    SITE_ID: seedData.siteId,
    ENROLLMENT_KEY: seedData.enrollmentKey,
  };

  // Login to get auth token
  const loginRes = await fetch(`${apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
    }),
  });
  if (loginRes.ok) {
    const { token } = (await loginRes.json()) as { token: string };
    env.AUTH_TOKEN = token;
  }

  const report = await runAssertions(manifest, {
    apiUrl,
    baseUrl,
    dbUrl,
    env,
    page: pageFilter,
  });

  printSummary(report);

  // Save reports
  const { mkdirSync } = await import('fs');
  mkdirSync(REPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await saveJsonReport(report, resolve(REPORT_DIR, `report-${timestamp}.json`));
  await saveHtmlReport(report, resolve(REPORT_DIR, `report-${timestamp}.html`));

  // Exit with error code if any failures
  if (report.failed > 0 || report.errors > 0) {
    process.exit(1);
  }
}

async function main() {
  const command = process.argv[2] || 'all';
  const flags = process.argv.slice(3);
  const incremental = flags.includes('--incremental');
  const pageFlag = flags.find((f) => f.startsWith('--page='));
  const page = pageFlag?.split('=')[1];

  switch (command) {
    case 'extract':
      await extract(incremental);
      break;
    case 'run':
      await run(page);
      break;
    case 'all':
      await extract(incremental);
      await run(page);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: doc-verify [extract|run|all] [--incremental] [--page=path]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Step 2: Add reports/ and assertions.json to .gitignore**

Add to `e2e-tests/.gitignore`:
```
doc-verify/assertions.json
doc-verify/reports/
```

**Step 3: Test the CLI help**

Run: `cd e2e-tests && pnpm doc-verify help`
Expected: `Unknown command: help` + usage message

**Step 4: Commit**

```bash
git add e2e-tests/doc-verify/cli.ts e2e-tests/.gitignore
git commit -m "feat(doc-verify): wire up CLI with extract, run, and all commands"
```

---

### Task 10: GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/doc-verify.yml`

**Step 1: Create the workflow**

```yaml
# .github/workflows/doc-verify.yml
name: Documentation Verification

on:
  pull_request:
    paths:
      - 'apps/docs/src/content/docs/getting-started/**'
      - 'apps/docs/src/content/docs/agents/**'
      - 'e2e-tests/doc-verify/**'

jobs:
  doc-verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install

      - name: Install Playwright browsers
        run: cd e2e-tests && npx playwright install chromium

      - name: Start test stack
        run: docker compose -f docker-compose.doc-verify.yml up -d --wait
        timeout-minutes: 5

      - name: Wait for services
        run: |
          for i in $(seq 1 30); do
            curl -sf http://localhost:3001/health && break
            echo "Waiting for API... ($i/30)"
            sleep 2
          done

      - name: Extract assertions
        run: cd e2e-tests && pnpm doc-verify extract --incremental
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Run assertions
        run: cd e2e-tests && pnpm doc-verify run
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          DOC_VERIFY_API_URL: http://localhost:3001
          DOC_VERIFY_BASE_URL: http://localhost:4321
          DOC_VERIFY_DB_URL: postgresql://breeze_test:breeze_test@localhost:5433/breeze_test

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: doc-verify-report
          path: e2e-tests/doc-verify/reports/

      - name: Tear down
        if: always()
        run: docker compose -f docker-compose.doc-verify.yml down -v
```

**Step 2: Commit**

```bash
git add .github/workflows/doc-verify.yml
git commit -m "ci: add GitHub Actions workflow for documentation verification"
```

---

### Task 11: Integration Test — End-to-End Smoke Run

**Files:** None new — this is a manual verification task.

**Step 1: Start the Docker stack**

Run: `docker compose -f docker-compose.doc-verify.yml up -d --wait`
Expected: All services healthy.

**Step 2: Run extraction on one page**

Run: `cd e2e-tests && ANTHROPIC_API_KEY=<your-key> pnpm doc-verify extract`
Expected: Assertions extracted and saved to `assertions.json`.

**Step 3: Inspect the manifest**

Run: `cat e2e-tests/doc-verify/assertions.json | head -50`
Expected: Valid JSON with page entries and assertion objects.

**Step 4: Run assertions**

Run: `cd e2e-tests && ANTHROPIC_API_KEY=<your-key> pnpm doc-verify run`
Expected: Assertions execute, some pass, results printed to terminal + reports/ directory.

**Step 5: Fix any issues discovered during smoke run**

Iterate on the extractor prompt, executor logic, or Docker config as needed.

**Step 6: Tear down**

Run: `docker compose -f docker-compose.doc-verify.yml down -v`

**Step 7: Final commit**

```bash
git add -A
git commit -m "feat(doc-verify): complete doc verification E2E system"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Scaffold + types + CLI skeleton | `types.ts`, `cli.ts`, `package.json` |
| 2 | Docker Compose + seed fixtures | `docker-compose.doc-verify.yml`, `fixtures/seed.ts` |
| 3 | Assertion extractor (Claude API) | `extractor.ts`, `extractor.test.ts` |
| 4 | API executor | `executors/api.ts`, `executors/api.test.ts` |
| 5 | SQL executor | `executors/sql.ts` |
| 6 | UI executor (Claude + Playwright) | `executors/ui.ts` |
| 7 | Runner orchestrator | `runner.ts` |
| 8 | Report generator | `report.ts` |
| 9 | Wire up CLI | `cli.ts` (update) |
| 10 | CI workflow | `.github/workflows/doc-verify.yml` |
| 11 | Integration smoke test | Manual verification |
