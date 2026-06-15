import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Last-resort render guard. Without it, ANY uncaught error during render/commit
 * (a host adapter throwing, a malformed server payload, a bad effect) unmounts
 * the whole React tree and the Office task pane goes silently BLANK — the worst
 * possible failure mode in-host, because there's nothing to read and no console
 * unless the user knows to open the WebView inspector. This catches the error,
 * keeps the pane populated, and surfaces the message so the failure is
 * diagnosable from the pane itself. Host-neutral; wraps the App on every host.
 */
type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also log so it shows in the WebView console when one is attached.
    console.error('[breeze-client-ai] render error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 p-4 text-center">
        <div className="text-sm font-semibold text-gray-700">Breeze hit a snag</div>
        <p className="text-xs text-gray-500">
          The assistant failed to render. This is a bug — please report it.
        </p>
        <pre
          className="max-h-40 w-full overflow-auto rounded bg-gray-50 p-2 text-left text-[10px] text-red-600"
          data-testid="error-boundary-message"
        >
          {error.message}
        </pre>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded bg-blue-600 px-3 py-1 text-xs text-white"
        >
          Try again
        </button>
      </div>
    );
  }
}
