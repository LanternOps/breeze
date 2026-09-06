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
  /** True while the catalog fetch is in flight — independent of the (secondary, org-only) ceiling fetch. */
  loading: boolean;
  /** True once the ceiling question is settled: a partner draft (no ceiling
   *  applies), or an org draft whose fetch has resolved — success OR failure.
   *  While false, `ceiling === null` means "not known yet", not "no
   *  baseline", and a caller must not treat the draft as unconstrained
   *  (#5063 review: the drawer over-reported authorized scripts otherwise). */
  ceilingResolved: boolean;
  /** True when an org draft's ceiling fetch settled in FAILURE. `ceiling`
   *  is `null` then, which must read as "unknown", never as "no baseline":
   *  a caller offering an unrestricted choice on it would let the operator
   *  build a save the server 422s (#5089 review). */
  ceilingFailed: boolean;
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
/**
 * `null` for an explicit "no baseline" body, the projection for a
 * well-formed one, `undefined` for anything else — an unrecognised body is
 * a FAILED fetch, never a ceiling (#5089 review: reading `.toolAllowlist`
 * off an arbitrary payload crashed the drawer). `supervisedActionKeys` and
 * `scriptIds` default to empty for an older API build that omits them.
 */
function parseCeilingBody(data: unknown): AgentCeilingDto | null | undefined {
  if (data === null || data === undefined) return null;
  if (typeof data !== 'object' || Array.isArray(data)) return undefined;
  const body = data as Partial<AgentCeilingDto>;
  if (!Array.isArray(body.toolAllowlist)) return undefined;
  return {
    toolAllowlist: body.toolAllowlist,
    supervisedActionKeys: Array.isArray(body.supervisedActionKeys) ? body.supervisedActionKeys : [],
    scriptIds: Array.isArray(body.scriptIds) ? body.scriptIds : [],
  };
}

export function useAgentToolCatalog({ kind, ownerScope }: UseAgentToolCatalogOptions): UseAgentToolCatalogResult {
  const [catalog, setCatalog] = useState<AgentToolCatalogDto | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [ceiling, setCeiling] = useState<AgentCeilingDto | null>(null);
  const [ceilingError, setCeilingError] = useState(false);
  const [ceilingSettled, setCeilingSettled] = useState(false);

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
      setCeilingSettled(true);
      return;
    }
    // Nothing carries over between kinds: the previous kind's ceiling must
    // not stand in for this one while the fetch is in flight (#5089 review).
    setCeiling(null);
    setCeilingError(false);
    setCeilingSettled(false);
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchWithAuth(`/ai/agents/ceiling?kind=${kind}`);
        if (!response.ok) throw new Error(`GET /ai/agents/ceiling ${response.status}`);
        const body = (await response.json()) as { data?: unknown };
        if (cancelled) return;
        const parsed = parseCeilingBody(body.data);
        if (parsed === undefined) throw new Error('GET /ai/agents/ceiling returned an unrecognized body');
        setCeiling(parsed);
        setCeilingError(false);
        setCeilingSettled(true);
      } catch (err) {
        console.error('[useAgentToolCatalog] could not load agent ceiling', err);
        if (!cancelled) {
          setCeiling(null);
          setCeilingError(true);
          setCeilingSettled(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, ownerScope]);

  return {
    catalog,
    ceiling,
    error: catalogError || ceilingError,
    loading: catalog === null && !catalogError,
    ceilingResolved: ceilingSettled,
    ceilingFailed: ceilingError,
  };
}
