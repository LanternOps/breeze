import { captureException } from './sentry';

const GITHUB_URL = 'https://api.github.com/repos/LanternOps/breeze/releases/latest';
// 1h keeps us well under GitHub's 60 req/hr unauthenticated rate limit while
// letting self-hosters see a new release within an hour.
const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
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
    // Cache error results for the full TTL so flaky GitHub / air-gapped installs
    // don't trigger retry storms.
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
