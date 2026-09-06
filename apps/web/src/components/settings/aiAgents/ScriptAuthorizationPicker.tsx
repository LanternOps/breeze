import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentCeilingDto } from '@breeze/shared';
import type { OwnerScope } from '@/hooks/useDefaultOwnerScope';
import { fetchAllScripts } from '@/lib/scriptsFetch';
import { isWithinCeiling } from './capabilityModel';
import { badgeClass } from '../../aiAgents/statusBadge';
import { ScopeBadge } from '../../shared/ScopeBadge';

/** The subset of a `GET /scripts` row this picker reads. */
export interface ScriptOption {
  id: string;
  name: string;
  orgId?: string | null;
  partnerId?: string | null;
  isSystem?: boolean;
}

export interface ScriptAuthorizationPickerProps {
  ownerScope: OwnerScope;
  /** The org an ORGANIZATION draft belongs to: the library is loaded for
   *  THAT org — never the switcher's, which differs when the drawer opens
   *  another org's agent — and filtered to what its row may list (#5089
   *  review). `null` on a partner draft. */
  ownerOrgId: string | null;
  /** The partner baseline's projection for an org draft; `null` for a partner draft or when no baseline exists. */
  ceiling: AgentCeilingDto | null;
  /** False while an org draft's ceiling is still being fetched: `ceiling ===
   *  null` then means "unknown", so nothing new may be ticked yet (#5089
   *  review). Irrelevant on a partner draft. */
  ceilingResolved: boolean;
  /** The ceiling could not be loaded (org drafts only): `ceiling === null`
   *  then means "unknown", so nothing new may be ticked — an unrestricted
   *  choice here is a save the server 422s (#5089 review). */
  ceilingUnavailable?: boolean;
  /** Whether the draft's tool allowlist admits `run_script` — scripts can be
   *  ticked only once it does. Never auto-added here: that would silently
   *  widen a separate control (#5065 quorum). */
  runScriptAllowed: boolean;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Override fetcher for tests. Receives the owner org to load for, if any. */
  loadScripts?: (opts: { orgId?: string }) => Promise<ScriptOption[]>;
}

const SEARCH_THRESHOLD = 8;

/**
 * "Scripts allowed to run unattended" (#5065): the form control for
 * `actAssets.scriptIds`. The list is what the ROW's owner may list — the
 * same rule `scriptAuthorization.ts` applies at save: a partner row picks
 * from partner-wide and system scripts; an organization row from its own
 * org's, partner-wide and system scripts (loaded for the owner org, not the
 * switcher's). Everything locks — nothing new ticks, whatever the scope —
 * while the draft's own allowlist or the partner ceiling's allowlist does
 * not admit `run_script`, or while the ceiling is unknown (still loading,
 * or failed). On top of that, on an ORGANIZATION draft with a live partner
 * baseline, scripts the baseline does not list render disabled with the
 * same "Not in partner baseline" badge the capability picker uses — the
 * effective policy is `partner ∩ org`, so ticking one would authorize
 * nothing. A selection the rules would hide or disable stays listed and
 * enabled just long enough to be unticked. The server re-validates every
 * addition, so this is a guide, not the boundary.
 */
export default function ScriptAuthorizationPicker({
  ownerScope,
  ownerOrgId,
  ceiling,
  ceilingResolved,
  ceilingUnavailable = false,
  runScriptAllowed,
  selectedIds,
  onChange,
  loadScripts,
}: ScriptAuthorizationPickerProps) {
  const { t } = useTranslation('settings');
  const searchId = useId();
  const [scripts, setScripts] = useState<ScriptOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = loadScripts
      ?? (async (opts: { orgId?: string }) => (await fetchAllScripts<ScriptOption>({ includeSystem: true, ...opts })).data);
    void (async () => {
      try {
        const rows = await load(ownerOrgId ? { orgId: ownerOrgId } : {});
        if (cancelled) return;
        const wellFormed = rows.filter((row) => typeof row?.id === 'string' && typeof row?.name === 'string');
        if (wellFormed.length < rows.length) {
          // Never silently: a script the operator expects and cannot find is
          // a support call, so the gap is at least on the console.
          console.error('[ScriptAuthorizationPicker] dropped malformed script rows', { dropped: rows.length - wellFormed.length });
        }
        setScripts(wellFormed);
      } catch (err) {
        console.error('[ScriptAuthorizationPicker] could not load scripts', err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadScripts, ownerOrgId]);

  // What the ROW may list (scriptAuthorization.ts's visibility rule): system
  // and partner-wide scripts always; an org's private script only on that
  // org's own draft. A selected id the rule would hide stays listed so it
  // can be unticked.
  const ownerMayList = (script: ScriptOption) => {
    if (script.isSystem || !script.orgId) return true;
    return ownerScope === 'organization' && script.orgId === ownerOrgId;
  };
  const withinCeiling = (id: string) => ceiling === null || ceiling.scriptIds.includes(id);
  const ceilingPending = ownerScope === 'organization' && !ceilingResolved && !ceilingUnavailable;
  // Effective policy intersects the ALLOWLISTS first, so a baseline that
  // bars run_script itself leaves every script here inert whatever the
  // draft's own allowlist says (#5089 review) — read off the ceiling here
  // rather than handed in, so no caller can forget it.
  const runScriptInCeiling = isWithinCeiling('run_script', ceiling);
  const searchLower = search.trim().toLowerCase();
  const visible = useMemo(
    () => (scripts ?? [])
      .filter((script) => ownerMayList(script) || selectedIds.includes(script.id))
      .filter((script) => !searchLower || script.name.toLowerCase().includes(searchLower)),
    // ownerMayList closes over ownerScope/ownerOrgId, both listed here.
    [scripts, searchLower, selectedIds, ownerScope, ownerOrgId],
  );

  const toggle = (id: string) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter((entry) => entry !== id) : [...selectedIds, id]);
  };

  return (
    <fieldset className="space-y-2 rounded-md border p-3" data-testid="ai-agent-scripts">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
        {t('aiAgentsPage.scripts.legend')}
      </legend>
      <p className="text-xs text-muted-foreground">{t('aiAgentsPage.scripts.hint')}</p>
      {ownerScope === 'partner' && (
        <p className="text-xs text-muted-foreground" data-testid="ai-agent-scripts-ceiling-hint">
          {t('aiAgentsPage.scripts.ceilingHint')}
        </p>
      )}
      {!runScriptAllowed && (
        <p className="text-xs text-warning-strong" data-testid="ai-agent-scripts-run-script-required">
          {t('aiAgentsPage.scripts.runScriptRequired')}
        </p>
      )}
      {!runScriptInCeiling && (
        <p className="text-xs text-warning-strong" data-testid="ai-agent-scripts-run-script-not-in-ceiling">
          {t('aiAgentsPage.scripts.runScriptNotInBaseline')}
        </p>
      )}
      {ceilingUnavailable && (
        <p className="text-sm text-destructive" data-testid="ai-agent-scripts-ceiling-unavailable">
          {t('aiAgentsPage.scripts.ceilingUnavailable')}
        </p>
      )}
      {ceilingPending && (
        <p className="text-xs text-muted-foreground" data-testid="ai-agent-scripts-ceiling-loading">
          {t('aiAgentsPage.scripts.ceilingLoading')}
        </p>
      )}

      {failed ? (
        <p className="text-sm text-destructive" data-testid="ai-agent-scripts-failed">
          {t('aiAgentsPage.scripts.failed')}
        </p>
      ) : scripts === null ? (
        <p className="text-xs text-muted-foreground" data-testid="ai-agent-scripts-loading">
          {t('aiAgentsPage.scripts.loading')}
        </p>
      ) : scripts.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="ai-agent-scripts-empty">
          {t('aiAgentsPage.scripts.empty')}
        </p>
      ) : (
        <>
          {scripts.length > SEARCH_THRESHOLD && (
            <div>
              <label htmlFor={searchId} className="sr-only">
                {t('aiAgentsPage.scripts.searchPlaceholder')}
              </label>
              <input
                id={searchId}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('aiAgentsPage.scripts.searchPlaceholder')}
                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="ai-agent-scripts-search"
              />
            </div>
          )}
          <ul className="max-h-64 space-y-1 overflow-y-auto" data-testid="ai-agent-scripts-list">
            {visible.map((script) => {
              const checked = selectedIds.includes(script.id);
              const inCeiling = withinCeiling(script.id);
              // Same rule as OperationRow: a stale selection outside the
              // ceiling stays enabled only so it can be unticked. Locked
              // outright (nothing new ticks) while the draft or the baseline
              // bars run_script, or the baseline is unknown.
              const locked = !runScriptAllowed || !runScriptInCeiling || ceilingUnavailable || ceilingPending;
              const disabled = locked ? !checked : !inCeiling && !checked;
              return (
                <li key={script.id}>
                  <label className="flex flex-wrap items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(script.id)}
                      data-testid={`ai-agent-script-${script.id}`}
                    />
                    <span>{script.name}</span>
                    <ScopeBadge orgId={script.orgId ?? null} partnerId={script.partnerId ?? null} isSystem={script.isSystem ?? false} />
                    {!inCeiling && (
                      <span className={badgeClass('muted', { size: 'sm' })} data-testid={`ai-agent-script-${script.id}-not-in-ceiling`}>
                        {t('aiAgentsPage.catalog.notInCeiling')}
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground" data-testid="ai-agent-scripts-count">
            {t('aiAgentsPage.scripts.selectedCount', { count: selectedIds.length })}
          </p>
        </>
      )}
    </fieldset>
  );
}
