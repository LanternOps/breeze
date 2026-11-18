import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { BadgeCheck } from 'lucide-react';
import { ENTITLEMENT_KEYS, type EntitlementKey } from '@breeze/shared';
import { useEntitlements } from '../../hooks/useEntitlement';
import type { ClientEntitlement } from '../../lib/entitlementsCache';
import { formatDate } from '@/lib/dateTimeFormat';
import { formatNumber } from '@/lib/i18n/format';
import { fetchWithAuth } from '../../stores/auth';
import { useFeaturesStore } from '../../stores/featuresStore';
import { PageHeader } from '../shared/PageHeader';

/**
 * Settings → Plan & features (/settings/plan). Read-only view of the partner's
 * plan and every registry entitlement: whether it is included, where that
 * answer comes from (plan default / billing / licence / manual), its expiry and
 * grace window, and its limits. Locked features stay listed so the partner can
 * see what an upgrade adds. No mutations live here — grants are platform-admin
 * only (`/admin/partners/:id/entitlements`). Plan changes happen in the billing
 * app (`/billing/plans`), which this page only links to — and only when the
 * billing app is present (`features.billing`; self-hosted has none). When the
 * partner is at its device admission limit it also says why new enrollment is
 * paused (`GET /partner/device-capacity`, read-only).
 */

/**
 * The capacity read. Full-partner-access users get the counts; everyone else
 * gets only `{ paused, reason }` from the API, so `counts` is then null and
 * the message is shown without numbers.
 */
type DeviceCapacity = {
  pausedForDeviceLimit: boolean;
  counts: { limit: number; activeCount: number } | null;
};

const CHANGE_PLAN_HREF = '/billing/plans';

function parseDeviceCapacity(value: unknown): DeviceCapacity | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.paused !== 'boolean') return null;
  return {
    pausedForDeviceLimit: v.paused && v.reason === 'device_limit',
    counts: typeof v.limit === 'number' && typeof v.activeCount === 'number'
      ? { limit: v.limit, activeCount: v.activeCount }
      : null,
  };
}

// Supplemental: on any failure the page simply shows no pause message.
function useDeviceCapacity(): DeviceCapacity | null {
  const [capacity, setCapacity] = useState<DeviceCapacity | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetchWithAuth('/partner/device-capacity', { skipOrgIdInjection: true });
        if (!res.ok) return;
        const parsed = parseDeviceCapacity(await res.json());
        if (active && parsed) setCapacity(parsed);
      } catch (err) {
        // No pause reason when the capacity read is unavailable.
        console.warn('[PlanAndFeaturesPage] device capacity read failed:', err instanceof Error ? err.message : err);
      }
    })();
    return () => { active = false; };
  }, []);
  return capacity;
}

function isExpiredWithinGrace(e: ClientEntitlement, now: number): boolean {
  if (!e.expiresAt || !e.graceUntil) return false;
  const expires = Date.parse(e.expiresAt);
  const grace = Date.parse(e.graceUntil);
  return Number.isFinite(expires) && Number.isFinite(grace) && expires <= now && grace > now;
}

// A null limit value means "no cap" (e.g. verified_library.maxVerifiedPackages),
// rendered with the same placeholder as an absent limits object.
function formatLimitValue(value: unknown, none: string): string {
  if (value === null || value === undefined) return none;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function limitPairs(limits: unknown, none: string): string[] {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return [];
  return Object.entries(limits as Record<string, unknown>).map(([k, v]) => `${k}: ${formatLimitValue(v, none)}`);
}

export default function PlanAndFeaturesPage() {
  const { t } = useTranslation('settings');
  const { snapshot, loading, failed, reload } = useEntitlements();
  const capacity = useDeviceCapacity();
  const billing = useFeaturesStore((s) => s.features.billing);
  const loadFeatures = useFeaturesStore((s) => s.load);
  useEffect(() => { void loadFeatures(); }, [loadFeatures]);

  const features: Record<EntitlementKey, { label: string; why: string }> = {
    onboarding_supervisor: {
      label: t('planAndFeatures.features.onboarding_supervisor.label'),
      why: t('planAndFeatures.features.onboarding_supervisor.why'),
    },
    verified_library: {
      label: t('planAndFeatures.features.verified_library.label'),
      why: t('planAndFeatures.features.verified_library.why'),
    },
    wisp: {
      label: t('planAndFeatures.features.wisp.label'),
      why: t('planAndFeatures.features.wisp.why'),
    },
  };

  const planLabels: Record<string, string> = {
    free: t('planAndFeatures.plans.free'),
    starter: t('planAndFeatures.plans.starter'),
    community: t('planAndFeatures.plans.community'),
    pro: t('planAndFeatures.plans.pro'),
    enterprise: t('planAndFeatures.plans.enterprise'),
    unlimited: t('planAndFeatures.plans.unlimited'),
  };

  const stateLabels: Record<ClientEntitlement['state'], string> = {
    enabled: t('planAndFeatures.state.enabled'),
    disabled: t('planAndFeatures.state.disabled'),
  };

  const sourceLabels: Record<ClientEntitlement['source'], string> = {
    plan: t('planAndFeatures.source.plan'),
    billing: t('planAndFeatures.source.billing'),
    license: t('planAndFeatures.source.license'),
    manual: t('planAndFeatures.source.manual'),
  };

  const now = Date.now();
  const byKey = new Map((snapshot?.entitlements ?? []).map((e) => [e.key, e]));

  return (
    <div className="space-y-6" data-testid="plan-features-page">
      <PageHeader
        icon={<BadgeCheck className="h-5 w-5" />}
        title={t('planAndFeatures.heading')}
        description={t('planAndFeatures.description')}
        actions={billing ? (
          <a
            href={CHANGE_PLAN_HREF}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            data-testid="plan-change-link"
          >
            {t('planAndFeatures.changePlan')}
          </a>
        ) : undefined}
      />

      {capacity?.pausedForDeviceLimit && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm"
          role="status"
          data-testid="plan-enrollment-paused"
        >
          {capacity.counts
            ? t('planAndFeatures.enrollmentPaused', {
              active: formatNumber(capacity.counts.activeCount),
              limit: formatNumber(capacity.counts.limit),
            })
            : t('planAndFeatures.enrollmentPausedNoCounts')}
          {billing && ` ${t('planAndFeatures.enrollmentPausedChangePlan')}`}
        </div>
      )}

      {failed && !snapshot ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
          role="alert"
          data-testid="plan-features-error"
        >
          <span>{t('planAndFeatures.loadError')}</span>
          <button
            type="button"
            onClick={reload}
            className="rounded-md border px-3 py-1 text-sm font-medium hover:bg-muted"
            data-testid="plan-features-retry"
          >
            {t('planAndFeatures.retry')}
          </button>
        </div>
      ) : !snapshot ? (
        <div className="space-y-2" data-testid="plan-features-loading" aria-busy={loading}>
          {ENTITLEMENT_KEYS.map((key) => (
            <div key={key} className="h-12 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('planAndFeatures.currentPlan')}</span>
            <span
              className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary"
              data-testid="plan-badge"
            >
              {planLabels[snapshot.plan] ?? snapshot.plan}
            </span>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('planAndFeatures.columns.feature')}</th>
                  <th className="px-4 py-2 font-medium">{t('planAndFeatures.columns.state')}</th>
                  <th className="px-4 py-2 font-medium">{t('planAndFeatures.columns.source')}</th>
                  <th className="px-4 py-2 font-medium">{t('planAndFeatures.columns.expires')}</th>
                  <th className="px-4 py-2 font-medium">{t('planAndFeatures.columns.limits')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {ENTITLEMENT_KEYS.map((key) => {
                  const entry = byKey.get(key);
                  // A key the API did not return (older API) is shown locked —
                  // never included by default.
                  const state: ClientEntitlement['state'] = entry?.state ?? 'disabled';
                  const pairs = limitPairs(entry?.limits, t('planAndFeatures.noLimits'));
                  const inGrace = entry ? isExpiredWithinGrace(entry, now) : false;
                  return (
                    <tr key={key} className="align-top" data-testid={`entitlement-row-${key}`}>
                      <td className="px-4 py-3">
                        <div className="font-medium">{features[key].label}</div>
                        <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{features[key].why}</p>
                        {entry?.reason && (
                          <p className="mt-1 text-xs italic text-muted-foreground" data-testid={`entitlement-reason-${key}`}>
                            {t('planAndFeatures.reason', { reason: entry.reason })}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            state === 'enabled'
                              ? 'inline-flex rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success'
                              : 'inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
                          }
                          data-testid={`entitlement-state-${key}`}
                          data-state={state}
                        >
                          {stateLabels[state]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="inline-flex rounded-md border px-2 py-0.5 text-xs"
                          data-testid={`entitlement-source-${key}`}
                        >
                          {entry ? sourceLabels[entry.source] : t('planAndFeatures.noLimits')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div>{entry?.expiresAt ? formatDate(entry.expiresAt) : t('planAndFeatures.noExpiry')}</div>
                        {inGrace && entry?.expiresAt && entry.graceUntil && (
                          <p
                            className="mt-1 text-amber-600 dark:text-amber-400"
                            data-testid={`entitlement-grace-${key}`}
                          >
                            {t('planAndFeatures.graceWarning', {
                              expiresAt: formatDate(entry.expiresAt),
                              graceUntil: formatDate(entry.graceUntil),
                            })}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {pairs.length === 0 ? (
                          <span className="text-muted-foreground">{t('planAndFeatures.noLimits')}</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {pairs.map((pair) => (
                              <li key={pair}>{pair}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
