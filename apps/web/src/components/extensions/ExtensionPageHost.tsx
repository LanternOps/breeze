// Hosts one runtime-extension top-level page. Mounted by the single generic
// route `pages/extensions/[name]/[...path].astro` — there is deliberately no
// per-extension page file. Resolves the page descriptor from the registry
// client (registry.ts) and hands the extension's declared element the
// `ExtensionPageContextV1` contract (`@breeze/extension-web-sdk`).
import { useEffect, useState } from 'react';
import type { ExtensionPageContextV1 } from '@breeze/extension-web-sdk';
import { useOrgScope } from '@/hooks/useOrgScope';
import { OrgRequiredGate } from '@/components/shared/OrgRequiredGate';
import { findExtensionPage, type ResolvedExtensionPage } from '@/lib/extensions/registry';
import ExtensionElementHost from './ExtensionElementHost';

export interface ExtensionPageHostProps {
  extensionName: string;
  /** Absolute path within the extension's own web namespace, e.g. `/dashboard`. */
  path: string;
}

function ExtensionPageSkeleton() {
  return (
    <div data-testid="extension-page-skeleton" className="animate-pulse space-y-4" aria-hidden="true">
      <div className="h-8 w-48 rounded bg-muted" />
      <div className="h-64 rounded-lg bg-muted/60" />
    </div>
  );
}

/** The standard not-found state for an extension page: absent (no such
 *  extension/page in the registry) and disabled (extension omitted from a
 *  live-rechecked registry response) are indistinguishable to the client by
 *  design — same as the API's asset route, which 404s both rather than
 *  giving a probing client an oracle. */
function ExtensionPageNotFound() {
  return (
    <div
      data-testid="extension-page-not-found"
      className="flex flex-col items-center rounded-lg border border-dashed px-6 py-12 text-center"
    >
      <h1 className="text-base font-semibold">Page not found</h1>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        This extension page doesn&rsquo;t exist, or the extension isn&rsquo;t enabled.
      </p>
    </div>
  );
}

type ResolutionState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'ready'; resolved: ResolvedExtensionPage };

function ExtensionPageHostContent({
  extensionName,
  path,
  organizationId,
}: {
  extensionName: string;
  path: string;
  organizationId: string;
}) {
  const [state, setState] = useState<ResolutionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    findExtensionPage(extensionName, path)
      .then((resolved) => {
        if (cancelled) return;
        setState(resolved ? { status: 'ready', resolved } : { status: 'not-found' });
      })
      .catch(() => {
        // A registry fetch failure (401, shape mismatch, network error) is
        // not distinguishable from "doesn't exist" to this page — same
        // no-oracle posture as the rest of the extension surface.
        if (!cancelled) setState({ status: 'not-found' });
      });

    return () => {
      cancelled = true;
    };
  }, [extensionName, path]);

  if (state.status === 'loading') return <ExtensionPageSkeleton />;
  if (state.status === 'not-found') return <ExtensionPageNotFound />;

  const context: ExtensionPageContextV1 = {
    contractVersion: 1,
    extensionName: state.resolved.extension.name,
    path,
    organizationId,
  };

  return (
    <ExtensionElementHost
      extensionName={state.resolved.extension.name}
      moduleUrl={state.resolved.extension.moduleUrl}
      elementName={state.resolved.page.element}
      context={context}
    />
  );
}

/** Bridges the resolved `useOrgScope()` value into `ExtensionPageHostContent`
 *  — `OrgRequiredGate` (below) guarantees `scope === 'org'` by the time this
 *  renders, so `organizationId` is a concrete string, never a query-string
 *  value or `null` (the page context contract requires a non-empty org id). */
function ExtensionPageHostOrgBridge({ extensionName, path }: ExtensionPageHostProps) {
  const scope = useOrgScope();
  if (scope.status !== 'resolved' || scope.scope !== 'org') {
    // Unreachable in practice: OrgRequiredGate only renders its children once
    // scope has resolved to a concrete org. Defensive, not a real UI state.
    return null;
  }
  return (
    <ExtensionPageHostContent extensionName={extensionName} path={path} organizationId={scope.orgId} />
  );
}

export default function ExtensionPageHost({ extensionName, path }: ExtensionPageHostProps) {
  return (
    <OrgRequiredGate description="This extension page is scoped to one organization.">
      <ExtensionPageHostOrgBridge extensionName={extensionName} path={path} />
    </OrgRequiredGate>
  );
}
