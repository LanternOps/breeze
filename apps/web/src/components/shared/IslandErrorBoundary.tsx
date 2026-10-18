import * as Sentry from '@sentry/astro';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

type Props = {
  /** Short stable name for Sentry tagging, e.g. "device-detail". */
  island: string;
  children: ReactNode;
};

type State = {
  error: Error | null;
  /** Bumped on retry so the subtree re-mounts from scratch. */
  attempt: number;
};

function IslandErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation('common');
  return (
    <div
      data-testid="island-error-fallback"
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/10 p-6"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive">{t('islandError.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('islandError.description')}</p>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-3 font-mono text-xs text-foreground">
            {error.name}: {error.message}
          </pre>
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <RotateCcw className="h-4 w-4" />
            {t('islandError.retry')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Last line of defence for a React island rendered by an Astro page.
 *
 * React 18 unmounts the whole root when a render error goes uncaught, which
 * on an island means the page's main content silently vanishes while the
 * Astro shell (sidebar, top bar) stays put — exactly what #8982 looked like on
 * the device-detail page. Wrap the island's top-level component in this so
 * the failure is (a) visible with the message on screen, (b) retryable
 * without a full reload, and (c) reported to Sentry with the component stack.
 */
export default class IslandErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      Sentry.withScope((scope) => {
        scope.setTag('island', this.props.island);
        scope.setContext('react', { componentStack: info.componentStack ?? null });
        scope.captureException(error);
      });
    } catch {
      // Telemetry must never break the fallback UI.
    }
    try {
      console.error(`[IslandErrorBoundary:${this.props.island}]`, error, info.componentStack);
    } catch {
      // ignore
    }
  }

  handleRetry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    if (this.state.error) {
      return <IslandErrorFallback error={this.state.error} onRetry={this.handleRetry} />;
    }
    // Keying on the attempt counter forces a clean re-mount on retry rather
    // than resuming a subtree whose state may be what threw in the first place.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
