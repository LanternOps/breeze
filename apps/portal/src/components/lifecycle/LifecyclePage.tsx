import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { portalApi, type HardwareLifecyclePortalLatestDto } from '@/lib/api';
import {
  HARDWARE_LIFECYCLE_DEFAULT_REPLACE_AGE_YEARS,
  HARDWARE_LIFECYCLE_DEFAULT_SERVER_REPLACE_AGE_YEARS,
  type HardwareLifecycleDeviceRow,
  type HardwareLifecycleSummary,
} from '@breeze/shared';
import { retryHintFrom } from '../portal/ReportRunList';
import { BTN_PRIMARY, BTN_SECONDARY, EmptyState, ErrorNotice, PageHeader } from '../portal/ui';
import { LifecycleStatusBar } from './LifecycleStatusBar';
import { LifecycleSchedule } from './LifecycleSchedule';
import { LifecyclePlanTable } from './LifecyclePlanTable';
import { LifecycleRecommendations } from './LifecycleRecommendations';
import { LifecycleClosing } from './LifecycleClosing';

type LifecycleRun = { id: string; generatedAt: string };

/** Small, page-local echo of ReportRunList's own message formatter: that
 *  function is not exported (private to its file), and this one-line "add a
 *  period, append a wait hint" shape is not worth promoting to a shared
 *  module for a single second caller. */
function withRetryHint(message: string, seconds: number | null): string {
  const base = /[.!?]$/.test(message) ? message : `${message}.`;
  if (seconds === null) return base;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${base} Try again in about ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`;
}

/** PageHeader at page level; an h2 with the same lede/action slots when
 *  embedded under another page's H1. */
function LifecycleHeader({
  embedded,
  lede,
  action,
}: {
  embedded: boolean;
  lede?: string;
  action?: React.ReactNode;
}) {
  if (!embedded) return <PageHeader title="Hardware lifecycle" lede={lede} action={action} />;
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="font-display text-xl font-semibold tracking-tight text-foreground">Hardware lifecycle</h2>
        {lede && <p className="mt-1 text-sm text-muted-foreground">{lede}</p>}
      </div>
      {action}
    </div>
  );
}

export function LifecyclePage({
  initialRun,
  initialSummary,
  initialContact = null,
  // Defaults true (matching LifecyclePlanTable's own default) so an omitted
  // prop keeps the pre-#5880 link behavior for any caller that hasn't
  // threaded the flag through yet.
  enableSelfService = true,
  embedded = false,
}: {
  initialRun: LifecycleRun | null;
  initialSummary: HardwareLifecycleSummary | null;
  initialContact?: HardwareLifecyclePortalLatestDto['contact'];
  enableSelfService?: boolean;
  /** Rendered as a tab panel under DevicesPage's H1: the page header
   *  steps down to a section heading so the page keeps one title. */
  embedded?: boolean;
}) {
  const [run, setRun] = useState<LifecycleRun | null>(initialRun);
  const [summary, setSummary] = useState<HardwareLifecycleSummary | null>(initialSummary);
  const [contact, setContact] = useState(initialContact);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const rows: HardwareLifecycleDeviceRow[] = summary?.rows ?? [];
  const hasEverGeneratedARun = run !== null || rows.length > 0;

  async function refresh() {
    setBusy(true);
    setMessage(null);
    const generated = await portalApi.generateReport('hardware_lifecycle');
    if (!generated.data) {
      setMessage(
        withRetryHint(
          generated.error ?? 'Could not generate your hardware lifecycle plan.',
          generated.statusCode === 429
            ? retryHintFrom(generated.headers, generated.errorData)
            : null,
        ),
      );
      setBusy(false);
      return;
    }

    const latest = await portalApi.getHardwareLifecycleLatest();
    if (latest.data) {
      const payload = latest.data as HardwareLifecyclePortalLatestDto;
      setRun(payload.run);
      setSummary(payload.summary);
      setContact(payload.contact ?? null);
    } else {
      setMessage(latest.error ?? 'Could not load your hardware lifecycle plan.');
    }
    setBusy(false);
  }

  const refreshButton = (
    <button
      type="button"
      data-testid="lifecycle-refresh"
      onClick={refresh}
      disabled={busy}
      className={hasEverGeneratedARun ? BTN_SECONDARY : BTN_PRIMARY}
    >
      <RefreshCw className={busy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden="true" />
      {busy ? 'Refreshing…' : 'Refresh'}
    </button>
  );

  if (!hasEverGeneratedARun) {
    return (
      <div>
        <LifecycleHeader
          embedded={embedded}
          lede="A replacement plan for the machines we manage for you."
        />
        {message && <ErrorNotice>{message}</ErrorNotice>}
        <EmptyState title="No hardware lifecycle plan yet">
          <p className="mb-4">We have not generated your hardware lifecycle plan yet.</p>
          {refreshButton}
        </EmptyState>
      </div>
    );
  }

  const servers = rows.filter((r) => r.deviceKind === 'server');
  const workstations = rows.filter((r) => r.deviceKind !== 'server');
  const replaceAgeYears = summary?.replaceAgeYears ?? HARDWARE_LIFECYCLE_DEFAULT_REPLACE_AGE_YEARS;
  const serverReplaceAgeYears = summary?.serverReplaceAgeYears ?? HARDWARE_LIFECYCLE_DEFAULT_SERVER_REPLACE_AGE_YEARS;
  const workstationsHeading = servers.length > 0 ? 'Workstations and laptops' : 'Device replacement plan';

  return (
    <div>
      <LifecycleHeader
        embedded={embedded}
        lede={run ? `As of ${run.generatedAt}` : undefined}
        action={refreshButton}
      />
      {message && <ErrorNotice>{message}</ErrorNotice>}

      <LifecycleStatusBar rows={rows} />
      <LifecycleSchedule rows={rows} />

      <LifecyclePlanTable
        sectionId="workstations"
        title={workstationsHeading}
        ruleSentence={`We plan to replace a computer ${replaceAgeYears} years after purchase, or when its warranty ends if it is still covered past that point.`}
        rows={workstations}
        enableSelfService={enableSelfService}
      />
      {servers.length > 0 && (
        <LifecyclePlanTable
          sectionId="servers"
          title="Servers"
          ruleSentence={`We plan to replace a server ${serverReplaceAgeYears} years after purchase, or when its warranty ends if it is still covered past that point. Server replacements are scheduled outside your business hours.`}
          rows={servers}
          enableSelfService={enableSelfService}
        />
      )}

      <LifecycleRecommendations summary={{ recommendations: summary?.recommendations, other: summary?.other }} />
      <LifecycleClosing contactEmail={contact?.email} contactName={contact?.name} />
    </div>
  );
}
