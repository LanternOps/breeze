import type { TFunction } from 'i18next';
import type { AlertLifecycleDefaultsResponse, AlertLifecycleValues, LifecycleSource } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';

/**
 * Reads the lifecycle defaults for one org, or the partner default when `orgId`
 * is null. The caller owns the scoping: an ambient switcher org must not narrow
 * a partner-default read to that org's override.
 */
export async function fetchLifecycleDefaults(orgId: string | null): Promise<AlertLifecycleDefaultsResponse> {
  const url = orgId ? `/alerts/lifecycle-defaults?orgId=${encodeURIComponent(orgId)}` : '/alerts/lifecycle-defaults';
  const response = await fetchWithAuth(url, { skipOrgIdInjection: true });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const body = await response.json();
  const data = body?.data ?? body;
  if (!data?.partner || !data?.effective || !data?.sources || !data?.monitorOverrideCounts) {
    throw new Error('malformed response');
  }
  return data as AlertLifecycleDefaultsResponse;
}

export function autoResolveLabel(t: TFunction, value: boolean): string {
  return value ? t('monitoring:lifecycle.autoResolveOn') : t('monitoring:lifecycle.autoResolveOff');
}

export function rearmLabel(t: TFunction, values: Pick<AlertLifecycleValues, 'rearmMode' | 'rearmDelayMinutes'>): string {
  return values.rearmMode === 'after_delay' && values.rearmDelayMinutes !== null
    ? t('monitoring:lifecycle.rearmAfterMinutes', { count: values.rearmDelayMinutes })
    : t('monitoring:lifecycle.rearmNewEvidence');
}

/** The defaults endpoint resolves partner → org only, so `monitor` and `legacy` never reach here. */
export function sourceLabel(t: TFunction, source: LifecycleSource): string {
  switch (source) {
    case 'org':
      return t('monitoring:lifecycle.sources.org');
    case 'builtin':
      return t('monitoring:lifecycle.sources.builtin');
    default:
      return t('monitoring:lifecycle.sources.partner');
  }
}
