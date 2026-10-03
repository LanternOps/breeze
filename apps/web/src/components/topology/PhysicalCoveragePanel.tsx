import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import type { GraphResponse } from '@breeze/shared';
import { TOPOLOGY_COVERAGE_REASON_CODES } from '@breeze/shared/validators/topology';

const KNOWN = new Set<string>(TOPOLOGY_COVERAGE_REASON_CODES);

/**
 * Graph coverage with one localized line per distinct server reason (M2 D11).
 * A complete-empty scope, a timeout and an unmapped controller site never read
 * alike. A reason code this build does not know falls back to the server text.
 * Compact (2026-10-03): the state is one inline status; the reasons sit behind a disclosure
 * button (keyboard-operable, Escape closes and returns focus) so the toolbar stays one row.
 */
export default function PhysicalCoveragePanel({ coverage }: { coverage: GraphResponse['coverage'] }) {
  const { t } = useTranslation('topology');
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); toggle.current?.focus(); };
  return <span data-testid="topology-coverage-panel" className="relative inline-flex items-center gap-1" onKeyDown={(event) => { if (open && event.key === 'Escape') close(); }}>
    <span role="status" data-testid="topology-coverage">{t('coverage', { state: t(/* i18n-dynamic */ `coveragePanel.state.${coverage.state}`) })}</span>
    {coverage.reasons.length > 0 && <>
      <button ref={toggle} type="button" aria-expanded={open} aria-controls="topology-coverage-reasons" aria-label={t('coveragePanel.title')} title={t('coveragePanel.title')}
        onClick={() => setOpen(!open)} className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
      <ul id="topology-coverage-reasons" data-testid="topology-coverage-reasons" hidden={!open} aria-label={t('coveragePanel.title')} tabIndex={-1}
        className="absolute left-0 top-full z-30 mt-1 w-[26rem] max-w-[calc(100vw-2rem)] list-inside list-disc space-y-1 rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
        {coverage.reasons.map((reason) => <li key={reason.code} data-testid={`topology-coverage-reason-${reason.code}`} className="break-words">
          {KNOWN.has(reason.code) ? t(/* i18n-dynamic */ `coveragePanel.reasons.${reason.code}`) : reason.message}
          {reason.count !== undefined && <> {t('coveragePanel.scopeCount', { count: reason.count })}</>}
        </li>)}
      </ul>
    </>}
  </span>;
}
