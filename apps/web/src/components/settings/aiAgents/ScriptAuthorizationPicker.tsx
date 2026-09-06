import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentCeilingDto } from '@breeze/shared';
import type { OwnerScope } from '@/hooks/useDefaultOwnerScope';
import { fetchAllScripts } from '@/lib/scriptsFetch';
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
  /** The partner baseline's projection for an org draft; `null` for a partner draft or when no baseline exists. */
  ceiling: AgentCeilingDto | null;
  /** Whether the draft's tool allowlist admits `run_script` — scripts can be
   *  ticked only once it does. Never auto-added here: that would silently
   *  widen a separate control (#5065 quorum). */
  runScriptAllowed: boolean;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Override fetcher for tests. */
  loadScripts?: () => Promise<ScriptOption[]>;
}

const SEARCH_THRESHOLD = 8;

/**
 * "Scripts allowed to run unattended" (#5065): the form control for
 * `actAssets.scriptIds`. The list is the owner's visible script library
 * (own org, partner-wide, system). On an ORGANIZATION draft with a live
 * partner baseline, scripts the baseline does not list render disabled with
 * the same "Not in partner baseline" badge the capability picker uses —
 * the effective policy is `partner ∩ org`, so ticking one would authorize
 * nothing. A stale selection outside the ceiling stays enabled just long
 * enough to be unticked. The server re-validates every addition
 * (`scriptAuthorization.ts`), so this is a guide, not the boundary.
 */
export default function ScriptAuthorizationPicker({
  ownerScope,
  ceiling,
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
    const load = loadScripts ?? (async () => (await fetchAllScripts<ScriptOption>({ includeSystem: true })).data);
    void (async () => {
      try {
        const rows = await load();
        if (!cancelled) setScripts(rows.filter((row) => typeof row?.id === 'string' && typeof row?.name === 'string'));
      } catch (err) {
        console.error('[ScriptAuthorizationPicker] could not load scripts', err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadScripts]);

  const withinCeiling = (id: string) => ceiling === null || ceiling.scriptIds.includes(id);
  const searchLower = search.trim().toLowerCase();
  const visible = useMemo(
    () => (scripts ?? []).filter((script) => !searchLower || script.name.toLowerCase().includes(searchLower)),
    [scripts, searchLower],
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
              // ceiling stays enabled only so it can be unticked.
              const disabled = !runScriptAllowed ? !checked : !inCeiling && !checked;
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
