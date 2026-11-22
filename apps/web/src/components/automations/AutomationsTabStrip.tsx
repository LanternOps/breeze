import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { useFlowsGate } from '../../stores/featuresStore';

interface AutomationsTabStripProps {
  // SSR-correct current path supplied by the rendering page so the server and
  // client first paint agree on the active tab (no hydration mismatch).
  currentPath?: string;
}

// The one field this strip reads from GET /automations. Declared locally and
// optional: an API without it simply shows no count.
type JobCountsResponse = { jobCounts?: { notMoved?: unknown } };

// Seed from the prop (SSR-stable) and update after mount so the active tab
// stays correct across Astro View Transitions and back/forward navigation.
function useCurrentPath(initialPath: string): string {
  const [path, setPath] = useState(initialPath);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    document.addEventListener('astro:after-swap', update);
    window.addEventListener('popstate', update);
    return () => {
      document.removeEventListener('astro:after-swap', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

// Standalone Jobs that have not moved to Flows. `null` = unknown (request
// failed or the API predates the field): the tab then renders no count.
function useNotMovedJobCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth('/automations?limit=1');
        if (!response.ok) return;
        const body = (await response.json()) as JobCountsResponse;
        const value = body?.jobCounts?.notMoved;
        if (!cancelled && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          setCount(value);
        }
      } catch {
        // A missing count is cosmetic; the tabs still navigate.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return count;
}

const tabClass = (isActive: boolean) =>
  'inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap px-4 -mb-px border-b-2 transition ' +
  (isActive
    ? 'border-primary font-semibold text-foreground'
    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/40');

export default function AutomationsTabStrip({ currentPath = '/jobs' }: AutomationsTabStripProps) {
  const { t } = useTranslation('common');
  const { enabled: flowsEnabled } = useFlowsGate();
  const path = useCurrentPath(currentPath);
  const notMoved = useNotMovedJobCount();
  const onFlows = path === '/flows' || path.startsWith('/flows/');

  // Real `<a href>` navigation between two Astro pages, not client-side tab
  // switching. The row scrolls horizontally rather than clipping at narrow
  // widths (same reasoning as AlertsTabStrip).
  return (
    <nav className="flex gap-1 overflow-x-auto border-b text-sm" aria-label={t('nav.automationsSections')}>
      {flowsEnabled && (
        <a
          href="/flows"
          data-testid="automations-tab-flows"
          className={tabClass(onFlows)}
          aria-current={onFlows ? 'page' : undefined}
        >
          {t('nav.flows')}
          <span
            data-testid="automations-tab-preview"
            className="shrink-0 rounded border border-current px-1.5 chart-legend-xs font-medium opacity-80"
          >
            {t('nav.previewTag')}
          </span>
        </a>
      )}
      <a
        href="/jobs"
        data-testid="automations-tab-jobs"
        className={tabClass(!onFlows)}
        aria-current={!onFlows ? 'page' : undefined}
      >
        {t('nav.jobs')}
        {notMoved !== null && (
          <span
            data-testid="automations-tab-jobs-count"
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 chart-legend-xs font-semibold text-muted-foreground"
          >
            {notMoved}
          </span>
        )}
      </a>
    </nav>
  );
}
