import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { AlertTriangle, GripVertical, Plus } from 'lucide-react';
import type { TicketRoutingRule } from '@breeze/shared';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useDefaultOwnerScope } from '../../hooks/useDefaultOwnerScope';
import { getJwtClaims, loginPathWithNext } from '../../lib/authScope';
import { handleActionError, runAction } from '../../lib/runAction';
import { useHashState } from '../../lib/useHashState';
import { navigateTo } from '@/lib/navigation';
import { useStableT } from '@/lib/i18n/useStableT';
import TicketRoutingRuleDrawer, { type OrgOption } from './TicketRoutingRuleDrawer';
import TicketRoutingTestPanel from './TicketRoutingTestPanel';
import InboundFallbackAssigneeEditor from './InboundFallbackAssigneeEditor';
import { useTicketRoutingLookups } from './useTicketRoutingLookups';
import { groupRules, hasActions, hasConditions, moveBefore, moveStep } from './ticketRoutingModel';

const HASH_PREFIX = 'routing/';
const NEW_ID = 'new';
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

/**
 * Create-time ticket routing rules (#8883). Dual-ownership like the checklist
 * templates: every scope sees the tab and this component gates internally — an
 * org-scoped user manages only their org's rules (partner-wide rules are listed
 * read-only); the owner selector, the org-links picker and the inbound fallback
 * assignee editor render only for a partner-scope user who may author
 * partner-wide config.
 */
export default function TicketRoutingTab() {
  const { t } = useTranslation('settings');
  const stableT = useStableT(t);

  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  // TWO flags (see TicketChecklistTemplatesPage): partner scope alone is not
  // permission to author partner-wide state.
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const showOwnerScope = isPartnerScope && canManagePartnerWide;
  const claims = getJwtClaims();
  const forcedOrgId = claims.scope === 'organization' ? claims.orgId ?? null : null;
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const storeOrgs = useOrgStore((s) => s.organizations);
  const defaultOrgId = forcedOrgId ?? currentOrgId ?? '';
  const listOrgId = forcedOrgId ?? currentOrgId ?? null;

  const orgs: OrgOption[] = useMemo(() => {
    const list = storeOrgs.map((o) => ({ id: o.id, name: o.name }));
    if (defaultOrgId && !list.some((o) => o.id === defaultOrgId)) {
      list.push({ id: defaultOrgId, name: stableT('ticketRouting.thisOrganization') });
    }
    return list;
  }, [storeOrgs, defaultOrgId, stableT]);
  const orgName = useMemo(() => new Map(orgs.map((o) => [o.id, o.name])), [orgs]);

  const lookups = useTicketRoutingLookups();

  const [rules, setRules] = useState<TicketRoutingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Selected rule lives in the URL hash (`#routing/<ruleId>`; `#routing/new` = create form).
  const [selectedId, setSelectedId] = useHashState<string | null>(null, (hash) =>
    hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) || undefined : undefined,
  );

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const qs = listOrgId ? `?orgId=${encodeURIComponent(listOrgId)}` : '';
      const res = await fetchWithAuth(`/ticket-routing-rules${qs}`);
      if (!res.ok) throw new Error(`routing rules load failed: ${res.status}`);
      const body = (await res.json()) as { data: TicketRoutingRule[] };
      setRules(body.data ?? []);
    } catch (err) {
      console.warn('[TicketRoutingTab] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [listOrgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const select = (id: string | null) => {
    window.location.hash = id ? `${HASH_PREFIX}${id}` : 'routing';
    setSelectedId(id);
  };

  /** A partner-wide rule is visible to everyone but editable only by a partner-wide author. */
  // The API refuses every routing-rule write from an organization-scope session,
  // so org scope is a read-only list; a partner user without canManagePartnerWide
  // edits org-owned rules only.
  const canEdit = useCallback(
    (r: TicketRoutingRule) => isPartnerScope && (r.orgId !== null || canManagePartnerWide),
    [isPartnerScope, canManagePartnerWide],
  );

  const groups = useMemo(() => groupRules(rules), [rules]);

  const toggleEnabled = async (r: TicketRoutingRule) => {
    const enabled = !r.enabled;
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/ticket-routing-rules/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
        errorFallback: t('ticketRouting.saveFailed'),
        successMessage: enabled ? t('ticketRouting.enabledOn') : t('ticketRouting.enabledOff'),
        onUnauthorized: UNAUTHORIZED,
      });
      setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, enabled } : x)));
    } catch (err) {
      handleActionError(err, t('ticketRouting.saveFailed'));
      void load();
    }
  };

  const reorder = async (ids: string[]) => {
    const rank = new Map(ids.map((id, i) => [id, i]));
    // Optimistic: apply the new positions locally, reload on failure.
    setRules((prev) => prev.map((x) => (rank.has(x.id) ? { ...x, position: rank.get(x.id)! } : x)));
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/ticket-routing-rules/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
        errorFallback: t('ticketRouting.reorderFailed'),
        onUnauthorized: UNAUTHORIZED,
      });
    } catch (err) {
      handleActionError(err, t('ticketRouting.reorderFailed'));
      void load();
    }
  };

  // Drag state: the dragged rule and the group it belongs to. A drop on a row of
  // another group is ignored — the reorder endpoint takes ONE owner's rules.
  const dragRef = useRef<{ id: string; groupKey: string } | null>(null);

  const selectedRule = selectedId && selectedId !== NEW_ID ? rules.find((r) => r.id === selectedId) ?? null : null;
  const drawerOpen = selectedId === NEW_ID || (selectedId !== null && selectedRule !== null);

  return (
    <div className="space-y-6" data-testid="ticket-routing-tab">
      <section className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="max-w-2xl">
            <h2 className="text-sm font-semibold">{t('ticketRouting.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('ticketRouting.description')}</p>
          </div>
          {isPartnerScope && (
            <button
              type="button"
              data-testid="routing-rule-create"
              onClick={() => select(NEW_ID)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Plus className="h-4 w-4" />
              {t('ticketRouting.createRule')}
            </button>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground" data-testid="routing-loading">
            {t('common:states.loading')}
          </p>
        ) : loadError ? (
          <p className="text-sm text-muted-foreground" data-testid="routing-error">
            {t('ticketRouting.loadFailed')}{' '}
            <button
              type="button"
              className="underline hover:text-foreground"
              data-testid="routing-retry"
              onClick={() => {
                setLoading(true);
                void load();
              }}
            >
              {t('common:actions.retry')}
            </button>
          </p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="routing-empty">
            {t('ticketRouting.empty')}
          </p>
        ) : (
          groups.map((g) => {
            const ids = g.rules.map((r) => r.id);
            return (
              <div key={g.key} className="space-y-1" data-testid={`routing-group-${g.key}`}>
                <h3 className="text-xs font-medium uppercase text-muted-foreground">
                  {g.orgId
                    ? t('ticketRouting.groupOrg', { org: orgName.get(g.orgId) ?? t('ticketRouting.thisOrganization') })
                    : t('ticketRouting.groupPartner')}
                </h3>
                <ul className="divide-y rounded-md border">
                  {g.rules.map((r) => {
                    const editable = canEdit(r);
                    return (
                      <li
                        key={r.id}
                        data-testid={`routing-rule-row-${r.id}`}
                        draggable={editable}
                        onDragStart={(e) => {
                          dragRef.current = { id: r.id, groupKey: g.key };
                          if (e.dataTransfer) {
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData?.('text/plain', r.id);
                          }
                        }}
                        onDragOver={(e) => {
                          if (dragRef.current?.groupKey === g.key) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          const drag = dragRef.current;
                          dragRef.current = null;
                          if (!drag || drag.groupKey !== g.key) return;
                          e.preventDefault();
                          const next = moveBefore(ids, drag.id, r.id);
                          if (next) void reorder(next);
                        }}
                        onDragEnd={() => {
                          dragRef.current = null;
                        }}
                        className={`flex flex-wrap items-center gap-3 px-3 py-2 ${selectedId === r.id ? 'bg-muted/50' : ''}`}
                      >
                        <button
                          type="button"
                          data-testid={`routing-rule-drag-${r.id}`}
                          disabled={!editable}
                          aria-label={t('ticketRouting.dragHandle', { name: r.name })}
                          title={t('ticketRouting.dragHandle', { name: r.name })}
                          onKeyDown={(e) => {
                            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                            e.preventDefault();
                            const next = moveStep(ids, r.id, e.key === 'ArrowUp' ? -1 : 1);
                            if (next) void reorder(next);
                          }}
                          className="cursor-grab text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <GripVertical className="h-4 w-4" />
                        </button>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={r.enabled}
                          disabled={!editable}
                          aria-label={t('ticketRouting.enabledLabel', { name: r.name })}
                          data-testid={`routing-rule-enabled-${r.id}`}
                          onChange={() => void toggleEnabled(r)}
                        />
                        <button
                          type="button"
                          data-testid={`routing-rule-open-${r.id}`}
                          onClick={() => select(r.id)}
                          className={`min-w-0 grow truncate text-left text-sm hover:underline ${r.enabled ? '' : 'text-muted-foreground'}`}
                        >
                          {r.name}
                        </button>
                        {r.orgId === null && r.orgIds === null && (
                          <span
                            data-testid={`routing-rule-all-orgs-${r.id}`}
                            className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                          >
                            {t('ticketRouting.allOrgs')}
                          </span>
                        )}
                        {r.orgId === null && r.orgIds !== null && (
                          <span
                            data-testid={`routing-rule-org-count-${r.id}`}
                            className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                          >
                            {t('ticketRouting.limitedOrgs', { count: r.orgIds.length })}
                          </span>
                        )}
                        {!hasConditions(r) && (
                          <span
                            data-testid={`routing-rule-catch-all-${r.id}`}
                            className="inline-flex items-center gap-1 text-xs text-amber-600"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {t('ticketRouting.catchAll')}
                          </span>
                        )}
                        {!hasActions(r) && (
                          <span
                            data-testid={`routing-rule-no-actions-${r.id}`}
                            className="inline-flex items-center gap-1 text-xs text-amber-600"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {t('ticketRouting.noActions')}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
        )}
      </section>

      {drawerOpen && (selectedId !== NEW_ID || isPartnerScope) && (
        <TicketRoutingRuleDrawer
          key={selectedId}
          rule={selectedRule}
          readOnly={selectedRule !== null && !canEdit(selectedRule)}
          showOwnerScope={showOwnerScope}
          defaultOwnerScope={defaultOwnerScope}
          defaultOrgId={defaultOrgId}
          canPickOrg={isPartnerScope}
          orgs={orgs}
          lookups={lookups}
          onClose={() => select(null)}
          onChanged={(opts) => {
            void load();
            if (opts?.closed) select(null);
          }}
        />
      )}

      <TicketRoutingTestPanel orgs={orgs} defaultOrgId={defaultOrgId} lookups={lookups} />

      {isPartnerScope && <InboundFallbackAssigneeEditor />}
    </div>
  );
}
