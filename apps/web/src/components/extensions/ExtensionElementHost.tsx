// The app's first Web Component host. Framework-independent by necessity:
// there is no prior custom-element integration to copy (see plan03-seams.md
// "Custom Elements / dynamic import / CSP"). An extension's web entry module
// is expected to call `customElements.define(elementName, ...)` as an import
// side effect; this host imports the module via the validated loader
// (registry.ts — the actual trust boundary), then imperatively creates and
// mounts the declared element outside of React's reconciliation so a
// misbehaving extension element can't corrupt React's owned tree.
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Sentry from '@sentry/astro';
import {
  EXTENSION_HOST_EVENT_NAME,
  parseExtensionHostEventV1,
} from '@breeze/extension-web-sdk';
import { loadExtensionModule } from '@/lib/extensions/registry';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '@/components/shared/Toast';

export interface ExtensionElementHostProps {
  /** The extension this element belongs to — the namespace `navigate` events must stay within. */
  extensionName: string;
  /** Same-origin, digest-addressed asset URL resolved from the registry (never caller-supplied). */
  moduleUrl: string;
  /** The custom-element tag name this extension's manifest declares for this page/slot. */
  elementName: string;
  /** Frozen and assigned to the element's `context` property; never mutated after creation. */
  context: Record<string, unknown>;
}

/** Shared fallback for "this extension's UI didn't come up" — deliberately
 *  carries only the extension/element names, never `error.message` or a
 *  stack trace, regardless of which failure mode produced it (rejected
 *  import, element never registered, or an unexpected render/lifecycle
 *  throw — the boundary below is the ONE path all of them funnel through). */
function ExtensionUnavailable({
  extensionName,
  elementName,
}: {
  extensionName: string;
  elementName: string;
}) {
  return (
    <div
      data-testid="extension-element-unavailable"
      role="alert"
      className="rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-4 py-6 text-center text-sm text-muted-foreground"
    >
      <p>This extension is unavailable right now.</p>
      <p className="mt-1 text-xs text-muted-foreground/80">
        {extensionName} / {elementName}
      </p>
    </div>
  );
}

interface BoundaryProps {
  extensionName: string;
  elementName: string;
  children: ReactNode;
}
interface BoundaryState {
  hasError: boolean;
}

/**
 * The one place that reports + attributes an extension-element failure.
 * `ExtensionElementHostInner` funnels EVERY failure mode (rejected module
 * promise, element never registered, or a genuinely unexpected
 * render/lifecycle throw) into a `throw` during render, so this boundary is
 * the single mechanism that both reports (tagged by extension + element,
 * full error to Sentry) and renders the fallback (names only, no
 * message/stack — the fallback component never receives the `error` value).
 */
class ExtensionElementErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    try {
      Sentry.withScope((scope) => {
        scope.setTag('extension.name', this.props.extensionName);
        scope.setTag('extension.element', this.props.elementName);
        scope.captureException(error);
      });
    } catch {
      // Telemetry must never break the fallback UI.
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <ExtensionUnavailable
          extensionName={this.props.extensionName}
          elementName={this.props.elementName}
        />
      );
    }
    return this.props.children;
  }
}

/** Toast has no neutral 'info' variant — falls back to the 'success' visual
 *  treatment (neutral checkmark), the closest match. */
function toastTypeForTone(tone: 'success' | 'info' | 'warning' | 'error'): 'success' | 'error' | 'warning' {
  if (tone === 'error') return 'error';
  if (tone === 'warning') return 'warning';
  return 'success';
}

function ExtensionElementHostInner({
  extensionName,
  moduleUrl,
  elementName,
  context,
}: ExtensionElementHostProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // `context` is a plain-data object literal built fresh by the caller on
  // every render; keying the mount effect off its reference would re-mount
  // the element every render. Key off its serialized content instead — it's
  // small (contractVersion/extensionName/path/orgId-shaped) and frozen.
  const contextKey = useMemo(() => JSON.stringify(context), [context]);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    (async () => {
      try {
        await loadExtensionModule(moduleUrl);
        if (cancelled) return;

        if (!customElements.get(elementName)) {
          throw new Error('extension element did not register the declared tag name');
        }

        const el = document.createElement(elementName) as HTMLElement & { context?: unknown };
        el.context = Object.freeze(context);

        if (cancelled) return;
        hostRef.current?.appendChild(el);
        elementRef.current = el;
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return () => {
      cancelled = true;
      if (elementRef.current?.parentNode) {
        elementRef.current.parentNode.removeChild(elementRef.current);
      }
      elementRef.current = null;
    };
    // deps note: contextKey stands in for `context`
  }, [moduleUrl, elementName, extensionName, contextKey]);

  // Scoped event bridge: attached to THIS host's container, not `window`, so
  // one extension instance never observes another's events even though the
  // underlying DOM event bubbles/composes past shadow boundaries.
  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      let parsed;
      try {
        parsed = parseExtensionHostEventV1(detail, { extensionName });
      } catch {
        // Malformed or out-of-namespace: rejected — swallowed, not routed.
        return;
      }

      if (parsed.type === 'navigate') {
        void navigateTo(parsed.path);
      } else if (parsed.type === 'toast') {
        showToast({ message: parsed.message, type: toastTypeForTone(parsed.tone) });
      }
      // 'refresh-registry' is intentionally not handled here — it keeps
      // bubbling to `window`, where registry.ts's own listener invalidates
      // the registry cache.
    };

    container.addEventListener(EXTENSION_HOST_EVENT_NAME, handler);
    return () => container.removeEventListener(EXTENSION_HOST_EVENT_NAME, handler);
  }, [extensionName]);

  // Funnel every failure mode through the error boundary above (see its
  // docstring): a throw during render is the ONE thing every failure
  // (rejected import, unregistered element, or a genuinely unexpected error)
  // has in common, so there is exactly one reporting + fallback path.
  if (error) throw error;

  return <div data-testid="extension-element-host" ref={hostRef} />;
}

export default function ExtensionElementHost(props: ExtensionElementHostProps) {
  return (
    <ExtensionElementErrorBoundary extensionName={props.extensionName} elementName={props.elementName}>
      <ExtensionElementHostInner {...props} />
    </ExtensionElementErrorBoundary>
  );
}
