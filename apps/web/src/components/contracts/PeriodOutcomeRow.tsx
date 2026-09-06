import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { useHashState } from '@/lib/useHashState';
import {
  fetchPeriodOutcome,
  type ContractBillingPeriod,
  type PeriodOutcome,
} from '../../lib/api/contracts';
import DeviceCoverageNotice from './DeviceCoverageNotice';
import { OverageNotice } from './AllowanceCell';

type LoadState =
  | { status: 'idle' | 'loading' | 'error'; outcome: null }
  | { status: 'ready'; outcome: PeriodOutcome | null };

// See InvoiceLineDevices.tsx for the full rationale (#3205 W07 review): every
// mounted row's open/closed state is membership in a SET of ids carried in one
// `periodOutcomes=` hash segment, composed with — never replacing — whatever
// else is already in the hash, so expanding period B never force-closes
// period A. Read via `useHashState`, not a raw `useState(() =>
// …location.hash…)` initializer, to stay clear of the #2421 SSR-hydration
// guard (`src/lib/__tests__/no-hash-in-usestate.test.ts`).
const HASH_SEGMENT_KEY = 'periodOutcomes';

function parseOpenIds(rawHash: string): Set<string> {
  const ids = new Set<string>();
  for (const segment of rawHash.split('&')) {
    if (!segment.startsWith(`${HASH_SEGMENT_KEY}=`)) continue;
    for (const id of segment.slice(HASH_SEGMENT_KEY.length + 1).split(',')) {
      if (id) ids.add(id);
    }
  }
  return ids;
}

function writeOpenIds(ids: Set<string>): void {
  const raw = window.location.hash.replace(/^#/, '');
  const otherSegments = raw.split('&').filter((s) => s && !s.startsWith(`${HASH_SEGMENT_KEY}=`));
  const ownSegment = ids.size > 0 ? [`${HASH_SEGMENT_KEY}=${[...ids].sort().join(',')}`] : [];
  window.location.hash = [...otherSegments, ...ownSegment].join('&');
}

/** Summary from the detail response; persisted jsonb digests load on demand. */
export default function PeriodOutcomeRow({
  contractId,
  orgId,
  period,
}: {
  contractId: string;
  orgId: string;
  period: ContractBillingPeriod;
}) {
  const { t } = useTranslation('billing');
  const notRecorded = period.snapshotDeviceTotal === null
    && period.uncoveredTotal === null
    && period.flaggedTotal === null
    && period.billedOverageTotal === null;
  const [openIds, setOpenIds] = useHashState<Set<string>>(new Set(), parseOpenIds);
  const open = !notRecorded && openIds.has(period.id);
  const [state, setState] = useState<LoadState>({ status: 'idle', outcome: null });

  const load = useCallback(async () => {
    if (state.status !== 'idle') return;
    setState({ status: 'loading', outcome: null });
    try {
      const result = await fetchPeriodOutcome(contractId, period.id);
      setState({ status: 'ready', outcome: result.recorded ? result.outcome : null });
    } catch {
      setState({ status: 'error', outcome: null });
    }
  }, [contractId, period.id, state.status]);

  useEffect(() => {
    if (open && state.status === 'idle') void load();
  }, [load, open, state.status]);

  let summary: string;
  if (notRecorded) summary = t('contracts.contractDetail.billingHistory.outcomeNotRecorded');
  else if (period.snapshotDeviceTotal === 0) summary = t('contracts.contractDetail.billingHistory.outcomeNoDeviceLines');
  else {
    const bits: string[] = [];
    if ((period.uncoveredTotal ?? 0) > 0) {
      bits.push(t('contracts.contractDetail.billingHistory.outcomeUncovered', { count: period.uncoveredTotal }));
    }
    if ((period.flaggedTotal ?? 0) > 0) {
      bits.push(t('contracts.contractDetail.billingHistory.outcomeFlagged', { count: period.flaggedTotal }));
    }
    summary = bits.length > 0
      ? bits.join(t('common:lists.separator'))
      : t('contracts.contractDetail.billingHistory.outcomeAllBilled');
  }

  const toggle = () => {
    const next = new Set(openIds);
    if (next.has(period.id)) next.delete(period.id);
    else next.add(period.id);
    writeOpenIds(next);
    setOpenIds(next);
  };

  return (
    <td className="px-3 py-2 align-top">
      <div className="flex items-center gap-2">
        <span data-testid={`period-outcome-summary-${period.id}`}>{summary}</span>
        {!notRecorded && (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('contracts.contractDetail.billingHistory.outcomeToggle')}
            data-testid={`period-outcome-toggle-${period.id}`}
            className="text-xs text-primary hover:underline"
          >
            {open ? '−' : '+'}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 min-w-64 rounded-md border bg-background p-2" data-testid={`period-outcome-${period.id}`}>
          {state.status === 'loading' && <p className="text-xs text-muted-foreground">…</p>}
          {state.status === 'error' && (
            <p className="text-xs text-destructive" data-testid={`period-outcome-error-${period.id}`}>
              {t('invoiceDetail.devices.loadError')}
            </p>
          )}
          {state.status === 'ready' && state.outcome && (
            <>
              <p className="text-xs text-muted-foreground">
                {t('contracts.contractDetail.billingHistory.outcomeDevicesEvaluated', { count: state.outcome.snapshotDeviceTotal })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('contracts.contractDetail.billingHistory.outcomeBilledOverage', { count: state.outcome.billedOverageTotal })}
              </p>
              <DeviceCoverageNotice
                uncovered={{ total: state.outcome.uncoveredTotal, byRole: state.outcome.uncoveredByRole }}
                orgId={orgId}
              />
              <OverageNotice overages={state.outcome.overages} />
            </>
          )}
          {/* Summary scalars persisted but the detail row is missing
              (`recorded: false` from the API, billingEvidence.ts) — an
              explicit notice so the panel never renders blank (#3205 W07
              review). */}
          {state.status === 'ready' && !state.outcome && (
            <p className="text-xs text-muted-foreground" data-testid={`period-outcome-not-recorded-${period.id}`}>
              {t('contracts.contractDetail.billingHistory.outcomeNotRecorded')}
            </p>
          )}
        </div>
      )}
    </td>
  );
}
