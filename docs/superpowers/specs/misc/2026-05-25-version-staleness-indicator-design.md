# Version Staleness Indicator — Design Spec

**Date:** 2026-05-25
**Origin:** Discord feature request from SemoTech (self-hoster)
**Status:** Approved — ready for implementation plan

## Problem

Self-hosters running Breeze have no in-app signal that their Web or API is behind the latest release. They have to manually check GitHub Releases and compare against the version string in the sidebar footer ([Sidebar.tsx:544](apps/web/src/components/layout/Sidebar.tsx#L544)). Result: deployments drift, missing security/bug fixes (e.g. #646 hosted-SaaS download URL bug, agent manifest trust root #612) until someone notices externally.

## Goal

Color the existing `Web X · API Y` footer text red when a newer release is available, green when up to date. Hover tooltip names the latest version. Falls back silently when GitHub is unreachable so disconnected/air-gapped installs aren't permanently marked red.

## Non-goals

- Agent version staleness — already surfaced in device views.
- CTA button, "view release notes" link, or upgrade automation.
- Env override for an alternate manifest source (`LATEST_VERSION_MANIFEST_URL` etc.). Can be added later if a self-hoster asks; YAGNI for now.
- Differentiating hosted-SaaS vs self-hosted audiences. Everyone with sidebar access sees the indicator.

## Architecture

Three pieces:

1. **`apps/api/src/services/latestVersion.ts`** — fetches and caches the latest GitHub release tag.
2. **`packages/shared/src/utils/semverCompare.ts`** — tiny semver compare util, used by both API (server-side `isStale` for API version) and Web (client-side `isStale` for `WEB_VERSION`).
3. **`GET /system/version`** — extended to include `latest`, `isStale`, `latestFetchedAt`.
4. **`apps/web/src/components/layout/Sidebar.tsx`** — colors the two version spans + adds tooltips.

### Data flow

```
Sidebar mount
  └─ fetchWithAuth('/system/version')
       └─ API route system.ts
            └─ getLatestVersion() ──── in-process cache (1h TTL)
                 └─ on miss: fetch api.github.com/repos/breeze-mm/breeze/releases/latest
                      └─ on any failure: return { latest: null }, log warn
            └─ compare API_VERSION vs latest using semverCompare → isStale
            └─ respond { version, latest, isStale, latestFetchedAt }
       └─ Sidebar receives response
            └─ webIsStale = semverCompare(WEB_VERSION, latest) < 0
            └─ render two <span> elements with stale/fresh/unknown classes + title
```

## Component details

### 1. `apps/api/src/services/latestVersion.ts` (new file)

Public API:

```ts
export interface LatestVersionResult {
  latest: string | null;          // e.g. "0.65.10", or null if unknown
  fetchedAt: Date;
  source: 'github' | 'cache' | 'error';
}

export async function getLatestVersion(): Promise<LatestVersionResult>;
export function _resetLatestVersionCache(): void;  // test-only
```

Implementation notes:

- Module-level cache: `{ value: LatestVersionResult; expiresAt: number } | null`
- TTL: `60 * 60 * 1000` ms (1 hour).
- Fetch URL: `https://api.github.com/repos/breeze-mm/breeze/releases/latest`
- Required headers: `User-Agent: breeze-rmm-api`, `Accept: application/vnd.github+json`.
- Timeout: 5 seconds via `AbortController`.
- Tag normalization: strip leading `v` from `tag_name` (`v0.65.10` → `0.65.10`).
- Validate the stripped tag matches `/^\d+\.\d+\.\d+(-[\w.]+)?$/`. Anything else → `latest: null`.
- Reject prerelease tags (any `-` suffix). Reason: GitHub's `/releases/latest` endpoint already excludes prereleases, but defense-in-depth in case a release is mistagged.
- On any error (network, 4xx, 5xx, parse, timeout): log via `console.warn('[latestVersion] ...', err.message)`, return `{ latest: null, fetchedAt: now, source: 'error' }`, and **still cache the result for the full TTL** so a flaky GitHub doesn't generate retry storms.

### 2. `packages/shared/src/utils/semverCompare.ts` (new file)

```ts
/**
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Prerelease suffix is ignored for comparison purposes:
 *   "0.65.10-dev" compares equal to "0.65.10".
 * Returns null if either input is unparseable.
 */
export function semverCompare(a: string, b: string): number | null;
```

Parser: regex `/^(\d+)\.(\d+)\.(\d+)/` → `[major, minor, patch]` numbers. Compare lexicographically as tuples. Unparseable input → null.

### 3. `apps/api/src/routes/system.ts` — extend `GET /system/version`

Current:
```ts
systemRoutes.get('/version', async (c) => {
  return c.json({ version: API_VERSION });
});
```

New:
```ts
systemRoutes.get('/version', async (c) => {
  const { latest, fetchedAt, source } = await getLatestVersion();
  const cmp = latest ? semverCompare(API_VERSION, latest) : null;
  const isStale = cmp !== null && cmp < 0;
  return c.json({
    version: API_VERSION,
    latest,                          // string | null
    isStale,                         // boolean (false when latest is null)
    latestFetchedAt: fetchedAt.toISOString(),
    latestSource: source,            // 'github' | 'cache' | 'error' — for debug, ignore in UI
  });
});
```

No new permission required — endpoint is already behind `authMiddleware`.

### 4. `apps/web/src/components/layout/Sidebar.tsx`

Replace the existing `apiVersion` state with a richer shape:

```ts
interface VersionInfo {
  apiVersion: string;
  latest: string | null;
}
const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
```

Fetch handler updates `versionInfo` with `{ apiVersion: data.version, latest: data.latest }`. On error, set `{ apiVersion: 'unavailable', latest: null }`.

Compute `webIsStale` and `apiIsStale` client-side using the shared `semverCompare`. Server's `isStale` flag is informational (for tooling/debug); UI re-computes for the web version anyway, so use it for both to keep one code path.

Render (replacing [Sidebar.tsx:542-546](apps/web/src/components/layout/Sidebar.tsx#L542)):

```tsx
{showLabels && (
  <div className="border-t px-4 py-2 text-[10px] text-muted-foreground/50">
    <p>
      Web <VersionSpan version={WEB_VERSION} latest={versionInfo?.latest ?? null} component="Web" />
      {versionInfo?.apiVersion && versionInfo.apiVersion !== 'unavailable' && (
        <>
          {' · '}API <VersionSpan version={versionInfo.apiVersion} latest={versionInfo.latest} component="API" />
        </>
      )}
    </p>
  </div>
)}
```

`VersionSpan` is a small inline component (defined in the same file — too trivial to extract):

```tsx
function VersionSpan({ version, latest, component }: { version: string; latest: string | null; component: 'Web' | 'API' }) {
  if (!latest) {
    return <span title={`${component} ${version} — latest version unknown`}>{version}</span>;
  }
  const cmp = semverCompare(version, latest);
  if (cmp === null) {
    return <span title={`${component} ${version} — latest version unknown`}>{version}</span>;
  }
  if (cmp < 0) {
    return (
      <span className="text-red-500/80" title={`${component} ${version} — update available (latest ${latest})`}>
        {version}
      </span>
    );
  }
  return (
    <span className="text-green-500/70" title={`${component} ${version} — up to date`}>
      {version}
    </span>
  );
}
```

### Behavior matrix

| State | Web color | API color | Tooltip example |
|---|---|---|---|
| Both current (0.65.10 vs 0.65.10) | green | green | "Web 0.65.10 — up to date" |
| Both stale (0.65.5 vs 0.65.10) | red | red | "API 0.65.5 — update available (latest 0.65.10)" |
| Only API stale | green | red | per-version |
| Latest unknown (GitHub down / air-gapped / no internet) | muted (default) | muted (default) | "Web X — latest version unknown" |
| Dev build (0.65.11-dev vs 0.65.10) | green | green | "up to date" — suffix ignored by comparator |

## Failure modes

| Failure | Behavior |
|---|---|
| GitHub returns 404 / 5xx / rate-limit | `latest: null`, cached 1h, log warn, UI shows muted with "unknown" tooltip |
| GitHub fetch times out (>5s) | Same as above |
| API server has no outbound internet (air-gapped) | Same as above — no permanent red state |
| `WEB_VERSION` env unset (defaults to `0.1.0`) | semverCompare will likely return stale; that's correct — the build is unversioned |
| Malformed tag in GitHub release | Validation regex rejects it → `latest: null` |
| User on outdated sidebar tab for hours | Cache is API-side; client fetches once per mount. Page reload picks up newer values. Acceptable. |

## Testing

### New tests

**`apps/api/src/services/latestVersion.test.ts`**
- Successful fetch → returns parsed version, `source: 'github'`
- Cached call within TTL → no second fetch, `source: 'cache'`
- Expired cache → re-fetches
- HTTP 404 / 500 / rate-limit → returns `{ latest: null, source: 'error' }`, still caches
- Timeout (>5s, mock AbortController) → same
- Malformed JSON → same
- Prerelease tag (`v0.65.10-rc1`) → rejected, `latest: null`
- `User-Agent` header is set
- `_resetLatestVersionCache()` clears state between tests

**`packages/shared/src/utils/semverCompare.test.ts`**
- Equal versions → 0
- a < b at each position (major, minor, patch)
- a > b at each position
- Prerelease suffix ignored: `0.65.10-dev` vs `0.65.10` → 0
- Unparseable input → null
- Empty string → null

### Modified tests

**`apps/api/src/routes/system.test.ts`** (or create if missing)
- `/system/version` includes `version`, `latest`, `isStale`, `latestFetchedAt`
- Mock `getLatestVersion` to return null → `isStale: false`
- Mock to return older version → `isStale: false`
- Mock to return newer version → `isStale: true`

**`apps/web/src/components/layout/Sidebar.test.tsx`** (or focused new test file)
- Mock fetch returning current versions → both spans get green class
- Mock fetch returning stale API → API span gets red class with correct tooltip
- Mock fetch returning `latest: null` → neither span gets color class
- Mock fetch erroring → API span shows `unavailable`, no color

## Out of scope

- `LATEST_VERSION_MANIFEST_URL` env override for air-gapped mirrors.
- Server-pushed staleness via WebSocket. Polling once per page load is sufficient.
- Surfacing `latestSource` to the UI. Debug-only field.
- Caching across API replicas via Redis. Single-droplet today; revisit when scaling.

## Open questions

None — all design choices confirmed during brainstorming session 2026-05-25.

## References

- Origin: Discord #general thread, SemoTech 2026-05-25 11:54
- Existing code: [Sidebar.tsx:260-271](apps/web/src/components/layout/Sidebar.tsx#L260), [Sidebar.tsx:542-546](apps/web/src/components/layout/Sidebar.tsx#L542), [system.ts:19](apps/api/src/routes/system.ts#L19)
- GitHub API: https://docs.github.com/en/rest/releases/releases#get-the-latest-release
