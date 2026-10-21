import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

/**
 * Whether the server has an email transport (#9256), from the partner bootstrap
 * payload (`GET /partner/me`). `undefined` = unknown (not loaded yet, or the
 * lookup failed) — callers keep their default copy then, and only an explicit
 * `false` switches to the "not emailed" wording.
 */
let cached: boolean | undefined;
let inflight: Promise<boolean | undefined> | null = null;

function load(): Promise<boolean | undefined> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (inflight) return inflight;
  const run = async (): Promise<boolean | undefined> => {
    try {
      const res = await fetchWithAuth('/partner/me');
      if (!res?.ok) {
        console.warn('[useEmailConfigured] /partner/me failed', res?.status);
        return undefined;
      }
      const body = await res.json();
      if (typeof body?.emailConfigured === 'boolean') cached = body.emailConfigured;
      return cached;
    } catch (err) {
      console.warn('[useEmailConfigured] could not read email capability', err);
      return undefined;
    }
  };
  const p = run();
  inflight = p;
  // Clear AFTER assignment so a synchronously-settling run can't leave a stale promise behind.
  void p.finally(() => { if (inflight === p) inflight = null; });
  return p;
}

export function useEmailConfigured(): boolean | undefined {
  const [value, setValue] = useState<boolean | undefined>(cached);
  useEffect(() => {
    if (cached !== undefined) { setValue(cached); return; }
    let cancelled = false;
    void load().then((v) => { if (!cancelled) setValue(v); });
    return () => { cancelled = true; };
  }, []);
  return value;
}

/** Test helper: clears the module cache. */
export function resetEmailConfiguredCache(): void {
  cached = undefined;
  inflight = null;
}
