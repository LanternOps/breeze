// #3205 W06: "who pays for this box?" as an Overview CARD, beside warranty and
// reliability — not a tab (the bar already carries 28 behind OverflowTabs, the
// panel is at most a handful of rows, and a card does not fetch while the user
// is on Software/Patches). Read-only, so no runAction; the loading/error/retry
// triad is the read convention (DeviceWarrantyCard.tsx:101-110, ContractDetail.tsx:336-341).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { usePermissions } from '@/lib/permissions';
import { getDeviceRoleIcon, getDeviceRoleLabel } from '@/lib/deviceRoles';
import { getDeviceBilling, type DeviceBillingCoverage, type DeviceCoverageLine } from '../../lib/api/devices';
import { CONTRACT_STATUS_ROLES } from '../../lib/api/contracts';
import { StatusPill } from '../billing/shared/StatusPill';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type CardError = { code?: string; groupName?: string };

export default function DeviceBillingCard({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('devices');
  const { can } = usePermissions();
  // Decision 8: the gate is checked BEFORE the component fetches, so a tech
  // without billing access sees no card and issues no request — rather than a
  // request that 403s and an error state for a permission they never had.
  const allowed = can('contracts', 'read');

  const [data, setData] = useState<DeviceBillingCoverage | null>(null);
  const [error, setError] = useState<CardError | null>(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const requestGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    setHidden(false);
    try {
      const res = await getDeviceBilling(deviceId);
      if (generation !== requestGeneration.current) return;
      if (res.status === 401 || res.status === 403) {
        setHidden(true);
        setData(null);
        if (res.status === 401) UNAUTHORIZED();
        return;
      }
      const body = await res.json().catch(() => null) as { data?: DeviceBillingCoverage; code?: string; details?: { groupName?: string } } | null;
      if (generation !== requestGeneration.current) return;
      if (!res.ok || !body?.data) {
        setError({ code: body?.code, groupName: body?.details?.groupName });
        setData(null);
        return;
      }
      setData(body.data);
    } catch {
      if (generation !== requestGeneration.current) return;
      setError({});
      setData(null);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    if (allowed) void load();
    return () => { requestGeneration.current += 1; };
  }, [allowed, load]);

  if (!allowed || hidden) return null;

  const shell = (children: ReactNode) => (
    <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="device-billing-card">
      <h3 className="flex items-center gap-2 text-sm text-muted-foreground">
        <Receipt className="h-4 w-4" aria-hidden="true" />
        {t('deviceBillingCard.title')}
      </h3>
      {children}
    </div>
  );

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-xs animate-pulse" data-testid="device-billing-card">
        <div role="status" data-testid="device-billing-loading">
          <span className="sr-only">{t('deviceBillingCard.title')}</span>
          <div className="h-4 w-24 rounded bg-muted" />
          <div className="mt-3 h-6 w-48 rounded bg-muted" />
        </div>
      </div>
    );
  }

  // The error branch returns BEFORE the uncovered branch, so the card can never
  // render "not billed" for a coverage failure (Decision 6, structurally).
  if (error || !data) {
    return shell(
      <p className="mt-2 text-sm text-muted-foreground" data-testid="device-billing-error" aria-live="polite">
        {error?.code === 'GROUP_EVALUATION_FAILED'
          ? t('deviceBillingCard.error.groupEvaluation', { group: error.groupName ?? '' })
          : t('deviceBillingCard.error.generic')}{' '}
        <button
          type="button"
          onClick={() => void load()}
          data-testid="device-billing-retry"
          className="font-medium text-primary hover:underline"
        >
          {t('common:actions.retry')}
        </button>
      </p>,
    );
  }

  if (data.notBillable) {
    const key = data.notBillableReason ?? 'not_billable';
    return shell(
      <p className="mt-2 text-sm text-muted-foreground" data-testid="device-billing-not-billable">
        {t(/* i18n-dynamic */ `deviceBillingCard.notBillable.${key}`)}
      </p>,
    );
  }

  if (data.uncovered) {
    const RoleIcon = getDeviceRoleIcon(data.deviceRole);
    return shell(
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="device-billing-uncovered">
        <span>{t('deviceBillingCard.uncovered')}</span>
        <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
          <RoleIcon className="h-3 w-3" />
          {getDeviceRoleLabel(data.deviceRole)}
        </span>
        <a href="/contracts" className="font-medium text-primary hover:underline">
          {t('deviceBillingCard.viewContracts')}
        </a>
      </p>,
    );
  }

  return shell(
    <ul className="mt-2 space-y-2">
      {data.lines.map((line) => (
        <li key={line.lineId} className="flex flex-wrap items-center gap-2 text-sm" data-testid="device-billing-line">
          <a href={`/contracts/${line.contractId}`} className="font-medium text-primary hover:underline">
            {line.contractName}
          </a>
          <StatusPill
            role={CONTRACT_STATUS_ROLES[line.contractStatus].role}
            label={t(/* i18n-dynamic */ `billing:contracts.shared.status.${line.contractStatus}`)}
            className={CONTRACT_STATUS_ROLES[line.contractStatus].className}
            testId="device-billing-contract-status"
          />
          <span className="text-muted-foreground">{line.description}</span>
          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {matchedByLabel(t, line)}
          </span>
        </li>
      ))}
    </ul>,
  );
}

/** Overlap is legal and visible: two lines from two contracts both render. */
function matchedByLabel(t: (k: string, o?: Record<string, unknown>) => string, line: DeviceCoverageLine): string {
  switch (line.matchedBy) {
    case 'org': return t('deviceBillingCard.matchedBy.org');
    case 'site': return t('deviceBillingCard.matchedBy.site');
    case 'role': return t('deviceBillingCard.matchedBy.role', { role: (line.deviceRoles ?? []).map(getDeviceRoleLabel).join(', ') });
    case 'group': return t('deviceBillingCard.matchedBy.group', { group: line.deviceGroup?.name ?? '' });
  }
}
