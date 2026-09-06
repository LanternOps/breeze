import { useEffect, useState } from 'react';
import type { AgentCeilingDto, AgentToolCatalogDto, AiAgentKind } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';

export interface UseAgentToolCatalogOptions {
  kind: AiAgentKind;
  ownerScope: 'organization' | 'partner';
}

export interface UseAgentToolCatalogResult {
  catalog: AgentToolCatalogDto | null;
  ceiling: AgentCeilingDto | null;
  error: boolean;
}

/**
 * Loads the agent-reachable tool catalog once per mount, and — only for an
 * organization-owned draft, where a partner-wide baseline can narrow what the
 * picker may offer — the live ceiling for the current `kind`. Re-fetches the
 * ceiling whenever `kind` changes; the catalog is static per process
 * (`buildAgentToolCatalog` is memoised server-side) so it is fetched exactly
 * once.
 *
 * Mirrors the cancelled-flag fetch pattern used for the policy-decidable-keys
 * registry in AiAgentForm.tsx (~line 605): a failed or malformed response
 * degrades to `error: true` and a `null` value for that piece — this hook
 * never throws, so the form is never obligated to catch it.
 */
export function useAgentToolCatalog({ kind, ownerScope }: UseAgentToolCatalogOptions): UseAgentToolCatalogResult {
  const [catalog, setCatalog] = useState<AgentToolCatalogDto | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [ceiling, setCeiling] = useState<AgentCeilingDto | null>(null);
  const [ceilingError, setCeilingError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth('/ai/agents/tool-catalog');
        if (!response.ok) throw new Error(`GET /ai/agents/tool-catalog ${response.status}`);
        const body = (await response.json()) as { data?: AgentToolCatalogDto };
        if (cancelled) return;
        if (body.data) setCatalog(body.data);
        else setCatalogError(true);
      } catch (err) {
        console.error('[useAgentToolCatalog] could not load tool catalog', err);
        if (!cancelled) setCatalogError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (ownerScope !== 'organization') {
      setCeiling(null);
      setCeilingError(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth(`/ai/agents/ceiling?kind=${kind}`);
        if (!response.ok) throw new Error(`GET /ai/agents/ceiling ${response.status}`);
        const body = (await response.json()) as { data?: AgentCeilingDto | null };
        if (cancelled) return;
        setCeiling(body.data ?? null);
        setCeilingError(false);
      } catch (err) {
        console.error('[useAgentToolCatalog] could not load agent ceiling', err);
        if (!cancelled) setCeilingError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, ownerScope]);

  return { catalog, ceiling, error: catalogError || ceilingError };
}
