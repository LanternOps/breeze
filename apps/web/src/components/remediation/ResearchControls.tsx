import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, SearchCheck, Sparkles } from 'lucide-react';
import type { ResearchPanelState } from './suggestionGroups';

type ResearchControlsProps = {
  state: ResearchPanelState;
  /** Feature flag off: both buttons are inert. */
  disabled: boolean;
  disabledTitle?: string;
  generateLabel: string;
  /** A request is in flight. */
  busy: boolean;
  /** Polling gave up after the 5-minute cap without a terminal status. */
  stalled: boolean;
  onGenerate: () => void;
  onResearchDeeper: () => void;
  onRetry: () => void;
};

/** Generate / Research deeper buttons plus the explicit research state (never a silent empty panel). */
export default function ResearchControls(props: ResearchControlsProps) {
  const { t } = useTranslation('common');
  const { state } = props;
  const inert = props.disabled || props.busy || state.kind === 'running';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="suggestions-generate"
          disabled={props.disabled || props.busy}
          title={props.disabled ? props.disabledTitle : undefined}
          onClick={props.onGenerate}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Sparkles className="h-4 w-4" />
          {props.generateLabel}
        </button>
        <button
          type="button"
          data-testid="research-deeper"
          disabled={inert}
          onClick={props.onResearchDeeper}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <SearchCheck className="h-4 w-4" />
          {t('longTail.remediation.RemediationSuggestionsPanel.research.deeper')}
        </button>
      </div>
      {state.kind === 'running' && (
        <p data-testid="research-state-running" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {props.stalled
            ? t('longTail.remediation.RemediationSuggestionsPanel.research.stalled')
            : state.depth === 'deep' ? t('longTail.remediation.RemediationSuggestionsPanel.research.runningDeep') : t('longTail.remediation.RemediationSuggestionsPanel.research.running')}
        </p>
      )}
      {state.kind === 'failed' && (
        <div data-testid="research-state-failed" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm">
          {t('longTail.remediation.RemediationSuggestionsPanel.research.failed')}
          <button type="button" data-testid="research-retry" disabled={props.busy} onClick={props.onRetry} className="inline-flex items-center gap-1 underline disabled:opacity-60">
            <RefreshCw className="h-3 w-3" />
            {t('longTail.remediation.RemediationSuggestionsPanel.research.retry')}
          </button>
        </div>
      )}
      {state.kind === 'no_safe_fix' && (
        <p data-testid="research-state-no-safe-fix" className="text-sm text-muted-foreground">{t('longTail.remediation.RemediationSuggestionsPanel.research.noSafeFix')}</p>
      )}
      {state.kind === 'credits' && (
        <p data-testid="research-state-credits" className="text-sm">
          {state.message}{' '}
          <a href="/settings/ai-usage" className="underline">{t('longTail.remediation.RemediationSuggestionsPanel.research.checkBudget')}</a>
        </p>
      )}
      {state.kind === 'denied' && (
        <p data-testid="research-state-denied" data-code={state.code} className="text-sm text-muted-foreground">{state.message}</p>
      )}
    </div>
  );
}
