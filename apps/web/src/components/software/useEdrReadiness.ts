import { useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import type { IntegrationProvider } from './providerBranding';

export interface ReadinessCheck {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
  fixHref?: string;
}

export interface EdrReadiness {
  status: 'loading' | 'ready' | 'incomplete' | 'unknown';
  checks: ReadinessCheck[];
  mappedOrgCount?: number;
  firstGap?: ReadinessCheck;
}

const LOADING: EdrReadiness = { status: 'loading', checks: [] };
const UNKNOWN: EdrReadiness = { status: 'unknown', checks: [] };
const INTEGRATIONS_FIX = '/integrations';
const SOFTWARE_FIX = '/software';

function finalize(checks: ReadinessCheck[], mappedOrgCount?: number): EdrReadiness {
  const firstGap = checks.find((c) => !c.ok);
  return {
    status: firstGap ? 'incomplete' : 'ready',
    checks,
    mappedOrgCount,
    firstGap,
  };
}

async function fetchHuntress(): Promise<EdrReadiness> {
  const res = await fetchWithAuth('/huntress/integration');
  if (!res.ok) return UNKNOWN;
  const json = (await res.json()) as {
    data?: { isActive?: boolean; hasAccountKey?: boolean; lastSyncOrgs?: number | null } | null;
  };
  const data = json.data ?? null;
  const connected = !!data && data.isActive === true;
  const accountKey = !!data?.hasAccountKey;
  const mappedOrgCount = data?.lastSyncOrgs ?? 0;
  const checks: ReadinessCheck[] = [
    { key: 'connected', label: 'Integration connected', ok: connected, fixHref: INTEGRATIONS_FIX },
    {
      key: 'accountKey',
      label: 'Account key configured',
      ok: accountKey,
      detail: accountKey ? undefined : 'Add your Huntress account key in Integrations',
      fixHref: INTEGRATIONS_FIX,
    },
    {
      key: 'orgsMapped',
      label: 'Organizations mapped',
      ok: mappedOrgCount > 0,
      detail: `${mappedOrgCount} org${mappedOrgCount === 1 ? '' : 's'} mapped`,
      fixHref: INTEGRATIONS_FIX,
    },
  ];
  return finalize(checks, mappedOrgCount);
}

async function fetchSentinelOne(s1VersionCount: number): Promise<EdrReadiness> {
  // S1 exposes an integration status endpoint mirroring Huntress. hasSiteToken is
  // derived server-side (the site token is a per-org secret). When the endpoint or
  // field is unavailable we degrade to the two checks we can prove client-side
  // (connected + installer uploaded) rather than inventing a signal.
  // Route mounts at /s1 (apps/api/src/index.ts). The status endpoint exposes
  // `isActive` (connected) but NO site-token boolean — the S1 site token is a
  // per-org secret in s1_org_mappings, not surfaced here. So `hasSiteToken`
  // stays undefined and the site-token check is omitted (2-check readiness),
  // per the plan's "don't invent a backend field" fallback.
  let connected: boolean | undefined;
  let hasSiteToken: boolean | undefined;
  try {
    const res = await fetchWithAuth('/s1/integration');
    if (res.ok) {
      const json = (await res.json()) as {
        data?: { isActive?: boolean; hasSiteToken?: boolean } | null;
      };
      const data = json.data ?? null;
      connected = !!data && data.isActive === true;
      hasSiteToken = typeof data?.hasSiteToken === 'boolean' ? data.hasSiteToken : undefined;
    }
  } catch {
    /* fall through to the version-only readiness below */
  }

  const installerUploaded = s1VersionCount >= 1;
  const checks: ReadinessCheck[] = [];
  if (connected !== undefined) {
    checks.push({ key: 'connected', label: 'Integration connected', ok: connected, fixHref: INTEGRATIONS_FIX });
  }
  checks.push({
    key: 'installerUploaded',
    label: 'Installer uploaded',
    ok: installerUploaded,
    detail: installerUploaded ? undefined : 'Upload the SentinelOne installer (Versions tab)',
    fixHref: SOFTWARE_FIX,
  });
  if (hasSiteToken !== undefined) {
    checks.push({
      key: 'siteToken',
      label: 'Site token configured',
      ok: hasSiteToken,
      detail: hasSiteToken ? undefined : 'Connect SentinelOne so the site token syncs',
      fixHref: INTEGRATIONS_FIX,
    });
  }
  // If we couldn't read the integration at all and the installer is present, we
  // can't prove readiness — report unknown so Deploy defers to the server.
  if (connected === undefined && installerUploaded) return UNKNOWN;
  return finalize(checks);
}

export function useEdrReadiness(
  providers: IntegrationProvider[],
  opts?: { s1VersionCount?: number },
): Record<IntegrationProvider, EdrReadiness> {
  const s1VersionCount = opts?.s1VersionCount ?? 0;
  const key = useMemo(
    () => `${Array.from(new Set(providers)).sort().join(',')}|${s1VersionCount}`,
    [providers, s1VersionCount],
  );
  const [map, setMap] = useState<Record<IntegrationProvider, EdrReadiness>>({
    huntress: LOADING,
    sentinelone: LOADING,
  });

  useEffect(() => {
    let cancelled = false;
    const [provPart] = key.split('|');
    const wanted = provPart ? (provPart.split(',') as IntegrationProvider[]) : [];

    if (wanted.includes('huntress')) {
      setMap((m) => ({ ...m, huntress: LOADING }));
      fetchHuntress()
        .then((r) => { if (!cancelled) setMap((m) => ({ ...m, huntress: r })); })
        .catch(() => { if (!cancelled) setMap((m) => ({ ...m, huntress: UNKNOWN })); });
    }
    if (wanted.includes('sentinelone')) {
      setMap((m) => ({ ...m, sentinelone: LOADING }));
      fetchSentinelOne(s1VersionCount)
        .then((r) => { if (!cancelled) setMap((m) => ({ ...m, sentinelone: r })); })
        .catch(() => { if (!cancelled) setMap((m) => ({ ...m, sentinelone: UNKNOWN })); });
    }
    return () => { cancelled = true; };
  }, [key, s1VersionCount]);

  return map;
}
