const GITHUB_URL = 'https://api.github.com/repos/breeze-mm/breeze/releases/latest';
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
