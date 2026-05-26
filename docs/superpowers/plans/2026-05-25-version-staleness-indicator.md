# Version Staleness Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Color the sidebar footer's Web and API version strings red when behind the latest GitHub release, green when up to date, with tooltips naming the latest version. Fail silently for air-gapped / disconnected installs.

**Architecture:** API service fetches `repos/breeze-mm/breeze/releases/latest` from GitHub on a 1h in-process cache. The existing `GET /system/version` endpoint is extended to include `latest`, `isStale`, and `latestFetchedAt`. Sidebar consumes the response and uses a shared `semverCompare` util to color the existing version spans client-side.

**Tech Stack:** TypeScript (Hono on API, React on Web), Vitest for both. No new runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-05-25-version-staleness-indicator-design.md](../specs/2026-05-25-version-staleness-indicator-design.md)

---

## File Structure

**Create:**
- `packages/shared/src/utils/semverCompare.ts` — semver comparison util (suffix-ignoring)
- `packages/shared/src/utils/semverCompare.test.ts` — unit tests for the util
- `apps/api/src/services/latestVersion.ts` — cached GitHub release lookup
- `apps/api/src/services/latestVersion.test.ts` — unit tests w/ fetch mocked
- `apps/web/src/components/layout/Sidebar.staleness.test.tsx` — focused tests for the new VersionSpan logic

**Modify:**
- `packages/shared/src/utils/index.ts` — re-export `semverCompare`
- `apps/api/src/routes/system.ts` — extend `GET /system/version` response
- `apps/api/src/routes/system.test.ts` — add coverage for new response fields
- `apps/web/src/components/layout/Sidebar.tsx` — replace plain version text with colored `<VersionSpan>` and consume `latest` from API response

---

## Task 1: Shared semver compare util

**Files:**
- Create: `packages/shared/src/utils/semverCompare.ts`
- Test: `packages/shared/src/utils/semverCompare.test.ts`
- Modify: `packages/shared/src/utils/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/utils/semverCompare.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { semverCompare } from './semverCompare';

describe('semverCompare', () => {
  it('returns 0 for equal versions', () => {
    expect(semverCompare('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns negative when a < b at patch level', () => {
    expect(semverCompare('1.2.3', '1.2.4')).toBeLessThan(0);
  });

  it('returns negative when a < b at minor level', () => {
    expect(semverCompare('1.2.9', '1.3.0')).toBeLessThan(0);
  });

  it('returns negative when a < b at major level', () => {
    expect(semverCompare('1.9.9', '2.0.0')).toBeLessThan(0);
  });

  it('returns positive when a > b at patch level', () => {
    expect(semverCompare('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });

  it('returns positive when a > b at minor level', () => {
    expect(semverCompare('1.3.0', '1.2.9')).toBeGreaterThan(0);
  });

  it('returns positive when a > b at major level', () => {
    expect(semverCompare('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('ignores prerelease suffix when comparing', () => {
    expect(semverCompare('0.65.10-dev', '0.65.10')).toBe(0);
    expect(semverCompare('0.65.10', '0.65.10-rc1')).toBe(0);
    expect(semverCompare('0.65.11-dev', '0.65.10')).toBeGreaterThan(0);
  });

  it('handles multi-digit components', () => {
    expect(semverCompare('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(semverCompare('10.0.0', '9.99.99')).toBeGreaterThan(0);
  });

  it('returns null for unparseable input', () => {
    expect(semverCompare('not-a-version', '1.2.3')).toBeNull();
    expect(semverCompare('1.2.3', 'invalid')).toBeNull();
    expect(semverCompare('', '1.2.3')).toBeNull();
    expect(semverCompare('1.2', '1.2.3')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/shared test -- src/utils/semverCompare.test.ts`
Expected: FAIL with "Cannot find module './semverCompare'"

- [ ] **Step 3: Implement the util**

Create `packages/shared/src/utils/semverCompare.ts`:

```ts
/**
 * Compare two semver-ish version strings of the form MAJOR.MINOR.PATCH[-suffix].
 * The prerelease suffix is intentionally ignored so dev/local builds (e.g. "0.65.10-dev")
 * compare equal to their release counterparts.
 *
 * @returns negative if a < b, 0 if equal, positive if a > b, null if either is unparseable.
 */
export function semverCompare(a: string, b: string): number | null {
  const parsed = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(v);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parsed(a);
  const pb = parsed(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/shared test -- src/utils/semverCompare.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Re-export from utils barrel**

Modify `packages/shared/src/utils/index.ts` — append a new line so it reads:

```ts
export * from './formatBytes';
export * from './docsMapping';
export * from './semverCompare';
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/utils/semverCompare.ts packages/shared/src/utils/semverCompare.test.ts packages/shared/src/utils/index.ts
git commit -m "feat(shared): add semverCompare util for version staleness checks"
```

---

## Task 2: Latest-version service with GitHub cache

**Files:**
- Create: `apps/api/src/services/latestVersion.ts`
- Test: `apps/api/src/services/latestVersion.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/latestVersion.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLatestVersion, _resetLatestVersionCache } from './latestVersion';

describe('latestVersion', () => {
  beforeEach(() => {
    _resetLatestVersionCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed tag from GitHub on first call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v0.65.10' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBe('0.65.10');
    expect(r.source).toBe('github');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('api.github.com/repos/breeze-mm/breeze/releases/latest');
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('breeze-rmm-api');
  });

  it('returns cached value on second call within TTL', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tag_name: 'v0.65.10' }), { status: 200 }),
    );
    await getLatestVersion();
    const r2 = await getLatestVersion();
    expect(r2.latest).toBe('0.65.10');
    expect(r2.source).toBe('cache');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns null and source=error on HTTP 5xx', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('returns null and source=error on HTTP 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('returns null on network failure', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ENOTFOUND'));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('returns null on malformed JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('rejects prerelease tags', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v0.65.10-rc1' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('rejects malformed tag', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'release-2026-01-01' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
  });

  it('caches error result for the full TTL (no retry storm)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    await getLatestVersion();
    await getLatestVersion();
    await getLatestVersion();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('strips leading v from tag', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBe('1.2.3');
  });

  it('accepts tag without leading v', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: '1.2.3' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBe('1.2.3');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- src/services/latestVersion.test.ts`
Expected: FAIL with "Cannot find module './latestVersion'"

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/latestVersion.ts`:

```ts
const GITHUB_URL = 'https://api.github.com/repos/breeze-mm/breeze/releases/latest';
const TTL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 5000;
const TAG_RE = /^\d+\.\d+\.\d+$/; // no prerelease suffix allowed

export interface LatestVersionResult {
  latest: string | null;
  fetchedAt: Date;
  source: 'github' | 'cache' | 'error';
}

interface CacheEntry {
  value: LatestVersionResult;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

export function _resetLatestVersionCache(): void {
  cache = null;
}

export async function getLatestVersion(): Promise<LatestVersionResult> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return { ...cache.value, source: 'cache' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(GITHUB_URL, {
      headers: {
        'User-Agent': 'breeze-rmm-api',
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { tag_name?: unknown };
    const tagName = typeof body.tag_name === 'string' ? body.tag_name : '';
    const stripped = tagName.startsWith('v') ? tagName.slice(1) : tagName;
    if (!TAG_RE.test(stripped)) {
      throw new Error(`Rejected tag: ${tagName}`);
    }
    const value: LatestVersionResult = {
      latest: stripped,
      fetchedAt: new Date(now),
      source: 'github',
    };
    cache = { value, expiresAt: now + TTL_MS };
    return value;
  } catch (err) {
    console.warn('[latestVersion] failed:', err instanceof Error ? err.message : err);
    const value: LatestVersionResult = {
      latest: null,
      fetchedAt: new Date(now),
      source: 'error',
    };
    cache = { value, expiresAt: now + TTL_MS };
    return value;
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- src/services/latestVersion.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/latestVersion.ts apps/api/src/services/latestVersion.test.ts
git commit -m "feat(api): add latestVersion service with GitHub release lookup + 1h cache"
```

---

## Task 3: Extend GET /system/version response

**Files:**
- Modify: `apps/api/src/routes/system.ts`
- Modify: `apps/api/src/routes/system.test.ts`

- [ ] **Step 1: Add failing tests for the new response shape**

First, add this mock near the top of `apps/api/src/routes/system.test.ts` alongside the other `vi.mock(...)` calls (i.e. between the existing `vi.mock('../middleware/auth', ...)` block and the `import` statements at lines 24–31):

```ts
vi.mock('../services/latestVersion', () => ({
  getLatestVersion: vi.fn(),
}));
```

Then add this import alongside the others around line 31:

```ts
import { getLatestVersion } from '../services/latestVersion';
```

Then add this nested describe block inside the existing `describe('system routes', ...)` (place it before the `// ────────────────────── GET /config-status` block):

```ts
  // ────────────────────── GET /version ──────────────────────
  describe('GET /version', () => {
    it('includes version, latest, isStale, latestFetchedAt fields', async () => {
      vi.mocked(getLatestVersion).mockResolvedValueOnce({
        latest: '99.99.99',
        fetchedAt: new Date('2026-05-25T00:00:00Z'),
        source: 'github',
      });
      const res = await app.request('/system/version');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('latest', '99.99.99');
      expect(body).toHaveProperty('isStale', true);
      expect(body).toHaveProperty('latestFetchedAt', '2026-05-25T00:00:00.000Z');
      expect(body).toHaveProperty('latestSource', 'github');
    });

    it('returns isStale=false when running version >= latest', async () => {
      vi.mocked(getLatestVersion).mockResolvedValueOnce({
        latest: '0.0.1',
        fetchedAt: new Date(),
        source: 'github',
      });
      const res = await app.request('/system/version');
      const body = await res.json();
      expect(body.isStale).toBe(false);
    });

    it('returns isStale=false and latest=null when GitHub is unreachable', async () => {
      vi.mocked(getLatestVersion).mockResolvedValueOnce({
        latest: null,
        fetchedAt: new Date(),
        source: 'error',
      });
      const res = await app.request('/system/version');
      const body = await res.json();
      expect(body.latest).toBeNull();
      expect(body.isStale).toBe(false);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/api test -- src/routes/system.test.ts`
Expected: FAIL — the existing endpoint returns only `{ version }`, so the `latest`/`isStale`/`latestFetchedAt`/`latestSource` assertions fail.

- [ ] **Step 3: Update the route handler**

Modify `apps/api/src/routes/system.ts`. Add two new imports near the top alongside the existing ones:

```ts
import { semverCompare } from '@breeze/shared';
import { getLatestVersion } from '../services/latestVersion';
```

Then replace the `GET /version` handler (currently [system.ts:18-21](apps/api/src/routes/system.ts#L18)) with:

```ts
// GET /system/version — returns the current API version + latest available release
systemRoutes.get('/version', async (c) => {
  const { latest, fetchedAt, source } = await getLatestVersion();
  const cmp = latest ? semverCompare(API_VERSION, latest) : null;
  const isStale = cmp !== null && cmp < 0;
  return c.json({
    version: API_VERSION,
    latest,
    isStale,
    latestFetchedAt: fetchedAt.toISOString(),
    latestSource: source,
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- src/routes/system.test.ts`
Expected: All `GET /version` tests PASS, all pre-existing tests still PASS.

- [ ] **Step 5: Type-check the API**

Run: `cd apps/api && npx tsc --noEmit`
Expected: No new errors (pre-existing errors in `agents.test.ts` / `apiKeyAuth.test.ts` are acknowledged in CLAUDE.md and unrelated).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/system.ts apps/api/src/routes/system.test.ts
git commit -m "feat(api): extend GET /system/version with latest release + isStale"
```

---

## Task 4: Sidebar — colored version spans with tooltips

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx`
- Create: `apps/web/src/components/layout/Sidebar.staleness.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/layout/Sidebar.staleness.test.tsx`. This file tests just the `VersionSpan` component in isolation to avoid pulling in the full Sidebar's many dependencies.

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { VersionSpan } from './Sidebar';

describe('VersionSpan', () => {
  it('renders muted with "unknown" tooltip when latest is null', () => {
    const { container } = render(<VersionSpan version="0.65.9" latest={null} component="Web" />);
    const span = container.querySelector('span')!;
    expect(span.textContent).toBe('0.65.9');
    expect(span.className).toBe('');
    expect(span.getAttribute('title')).toContain('latest version unknown');
  });

  it('renders green when running version equals latest', () => {
    const { container } = render(<VersionSpan version="0.65.9" latest="0.65.9" component="Web" />);
    const span = container.querySelector('span')!;
    expect(span.className).toContain('text-green');
    expect(span.getAttribute('title')).toContain('up to date');
  });

  it('renders green when running version is newer than latest (dev build)', () => {
    const { container } = render(<VersionSpan version="0.65.11-dev" latest="0.65.10" component="API" />);
    const span = container.querySelector('span')!;
    expect(span.className).toContain('text-green');
    expect(span.getAttribute('title')).toContain('up to date');
  });

  it('renders red with upgrade tooltip when running version is older than latest', () => {
    const { container } = render(<VersionSpan version="0.65.5" latest="0.65.10" component="API" />);
    const span = container.querySelector('span')!;
    expect(span.className).toContain('text-red');
    const title = span.getAttribute('title')!;
    expect(title).toContain('update available');
    expect(title).toContain('0.65.10');
    expect(title).toContain('API');
  });

  it('renders muted when version is unparseable', () => {
    const { container } = render(<VersionSpan version="not-a-version" latest="0.65.10" component="Web" />);
    const span = container.querySelector('span')!;
    expect(span.className).toBe('');
    expect(span.getAttribute('title')).toContain('latest version unknown');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/web test -- src/components/layout/Sidebar.staleness.test.tsx`
Expected: FAIL with "VersionSpan is not exported from './Sidebar'"

- [ ] **Step 3: Update Sidebar.tsx — imports**

Modify `apps/web/src/components/layout/Sidebar.tsx`. Add to the existing imports at the top of the file:

```ts
import { semverCompare } from '@breeze/shared';
```

- [ ] **Step 4: Update Sidebar.tsx — state and fetch**

Find the existing version state (around [Sidebar.tsx:260-271](apps/web/src/components/layout/Sidebar.tsx#L260)):

```tsx
  // Fetch API version once
  const [apiVersion, setApiVersion] = useState<string | null>(null);
  useEffect(() => {
    fetchWithAuth('/system/version')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { version: string }) => setApiVersion(data.version))
      .catch((err) => {
        console.warn('[Sidebar] Failed to fetch API version:', err);
        setApiVersion('unavailable');
      });
  }, []);
```

Replace it with:

```tsx
  // Fetch API version + latest release info once
  const [apiVersion, setApiVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  useEffect(() => {
    fetchWithAuth('/system/version')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { version: string; latest: string | null }) => {
        setApiVersion(data.version);
        setLatestVersion(data.latest);
      })
      .catch((err) => {
        console.warn('[Sidebar] Failed to fetch API version:', err);
        setApiVersion('unavailable');
      });
  }, []);
```

- [ ] **Step 5: Add the VersionSpan component**

Still in `apps/web/src/components/layout/Sidebar.tsx`, add an exported `VersionSpan` function component near the bottom of the file (after the closing brace of the `Sidebar` component, before any trailing helpers or default export):

```tsx
export function VersionSpan({
  version,
  latest,
  component,
}: {
  version: string;
  latest: string | null;
  component: 'Web' | 'API';
}) {
  if (!latest) {
    return <span title={`${component} ${version} — latest version unknown`}>{version}</span>;
  }
  const cmp = semverCompare(version, latest);
  if (cmp === null) {
    return <span title={`${component} ${version} — latest version unknown`}>{version}</span>;
  }
  if (cmp < 0) {
    return (
      <span
        className="text-red-500/80"
        title={`${component} ${version} — update available (latest ${latest})`}
      >
        {version}
      </span>
    );
  }
  return (
    <span
      className="text-green-500/70"
      title={`${component} ${version} — up to date`}
    >
      {version}
    </span>
  );
}
```

- [ ] **Step 6: Update Sidebar.tsx — render**

Find the existing footer render (around [Sidebar.tsx:542-546](apps/web/src/components/layout/Sidebar.tsx#L542)):

```tsx
      {showLabels && (
        <div className="border-t px-4 py-2 text-[10px] text-muted-foreground/50">
          <p>Web {WEB_VERSION}{apiVersion ? ` · API ${apiVersion}` : ''}</p>
        </div>
      )}
```

Replace it with:

```tsx
      {showLabels && (
        <div className="border-t px-4 py-2 text-[10px] text-muted-foreground/50">
          <p>
            Web <VersionSpan version={WEB_VERSION} latest={latestVersion} component="Web" />
            {apiVersion && apiVersion !== 'unavailable' && (
              <>
                {' · '}API <VersionSpan version={apiVersion} latest={latestVersion} component="API" />
              </>
            )}
            {apiVersion === 'unavailable' && ' · API unavailable'}
          </p>
        </div>
      )}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @breeze/web test -- src/components/layout/Sidebar.staleness.test.tsx`
Expected: All 5 tests PASS.

- [ ] **Step 8: Type-check the web app**

Run: `cd apps/web && npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.staleness.test.tsx
git commit -m "feat(web): color sidebar version strings red/green based on staleness"
```

---

## Task 5: End-to-end verification

**Files:** none — runtime sanity check.

- [ ] **Step 1: Run the full test suites for affected packages**

Run: `pnpm --filter @breeze/shared test && pnpm --filter @breeze/api test && pnpm --filter @breeze/web test`
Expected: All tests pass. (If pre-existing failures unrelated to this work surface, confirm they exist on `main` before treating them as blockers.)

- [ ] **Step 2: Manual UI smoke**

Start the dev stack (`pnpm dev` or your usual flow), log in, and confirm at the bottom of the sidebar:

1. Open browser devtools → Network → search `/system/version`. Confirm the response now includes `latest`, `isStale`, `latestFetchedAt`, `latestSource`.
2. Hover over the `Web X.Y.Z` text — tooltip should appear, naming the latest version and saying either "up to date" or "update available".
3. Hover over `API X.Y.Z` — same.
4. If you happen to be running a build older than the latest GitHub release, the numbers should appear red. Otherwise green. If GitHub is blocked / `latest` is null, they should appear in the default muted color.

- [ ] **Step 3: Negative-path manual check (optional but recommended)**

Temporarily edit `apps/api/src/services/latestVersion.ts` to point `GITHUB_URL` at `https://api.github.com/repos/nonexistent-owner/nonexistent-repo/releases/latest`, restart API. Confirm:

1. Footer text remains in default muted color (no red).
2. Tooltip says "latest version unknown".
3. API logs show `[latestVersion] failed: ...` warning once, not on every request (cache works).

Revert the edit afterwards. Do **not** commit this change.

- [ ] **Step 4: Final commit (no-op if previous tasks committed cleanly)**

Run `git status` and confirm there are no leftover files. If there are, investigate; if intentional, commit.

---

## Self-Review (performed)

**Spec coverage:**
- ✅ Latest version source: Task 2 hits GitHub Releases API.
- ✅ Audience: visible to everyone — no role gating added; footer render unchanged for who sees it.
- ✅ Color-only visual: Task 4 uses red/green classes + tooltip, no icons.
- ✅ Dev-build handling: Task 1's `semverCompare` strips suffix; Task 4 verifies dev-build path.
- ✅ 1h cache: Task 2 implements TTL + cache test.
- ✅ Failure modes (GitHub down, malformed, prerelease, network error): Task 2 covers all of them.
- ✅ Behavior matrix rows (both current / both stale / mixed / unknown / dev build): covered across Task 4 tests + Task 5 manual check.

**Placeholder scan:** No TBDs, no "implement later", no "add error handling" — every step has code or an exact command.

**Type consistency:** `VersionSpan({ version, latest, component })`, `LatestVersionResult`, `semverCompare(a, b)` all used identically in service, route, test, and component.

**No spec gaps found.**
