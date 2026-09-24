import { captureException } from './sentry';

// Deliberately not routed through releaseSource: the staleness banner tracks upstream product releases even on BYO-signing deployments.
const GITHUB_URL = 'https://api.github.com/repos/LanternOps/breeze/releases/latest';
// 1h keeps us well under GitHub's 60 req/hr unauthenticated rate limit while
// letting self-hosters see a new release within an hour.
const TTL_MS = 60 * 60 * 1000;
// Failures are cached briefly so one transient abort doesn't pin the UI on
// "latest version unknown" for an hour (#6629). 5 min still caps a persistently
// failing (flaky / air-gapped) install at 12 req/hr — no retry storm.
const ERROR_TTL_MS = 5 * 60 * 1000;
// Cold GitHub API latency can approach 4-5s; 10s leaves headroom (#6629).
const FETCH_TIMEOUT_MS = 10_000;
const TAG_RE = /^\d+\.\d+\.\d+$/;

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
    if (isUnexpectedError(err)) {
      captureException(err);
      console.error('[latestVersion] unexpected error:', err);
    } else {
      console.warn('[latestVersion] failed:', err instanceof Error ? err.message : err);
    }
    // Cache error results for the short ERROR_TTL_MS: long enough that flaky
    // GitHub / air-gapped installs don't retry-storm, short enough that one
    // transient failure recovers within minutes.
    const value: LatestVersionResult = {
      latest: null,
      fetchedAt: new Date(now),
      source: 'error',
    };
    cache = { value, expiresAt: now + ERROR_TTL_MS };
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function isUnexpectedError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // Network / abort / parse / our own thrown errors are all expected operational failures.
  if (err.name === 'AbortError' || err.name === 'TypeError' || err.name === 'SyntaxError') {
    return false;
  }
  if (err.message.startsWith('GitHub returned HTTP') || err.message.startsWith('Rejected tag:')) {
    return false;
  }
  return true;
}
