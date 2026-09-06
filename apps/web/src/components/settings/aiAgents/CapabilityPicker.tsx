import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AgentCeilingDto, AgentToolCatalogDto, AiAgentKind } from '@breeze/shared';
import { badgeClass } from '../../aiAgents/statusBadge';
import {
  capabilityState,
  entriesToSelection,
  isWithinCeiling,
  outcomeFor,
  selectionToEntries,
  summarise,
  type AgentModeLike,
} from './capabilityModel';
import OperationRow from './OperationRow';

export interface CapabilityPickerProps {
  catalog: AgentToolCatalogDto;
  /** null when the row has no partner-wide ceiling to respect (partner-owned rows, or the ceiling fetch is off for this draft). */
  ceiling: AgentCeilingDto | null;
  kind: AiAgentKind;
  mode: AgentModeLike;
  entries: string[];
  onChange: (entries: string[]) => void;
  /** Seeds the initially-uncontrolled "Show tool names" switch; the switch always manages its own state after mount. */
  showToolNames?: boolean;
}

/** `manage_startup_items` -> "Manage startup items". Last-resort label for a
 *  tool/action/capability this catalog has no translation for yet — mirrors
 *  AiAgentForm.tsx's `sentenceCase` so a server-shipped-ahead-of-web-catalog
 *  name still reads as words. */
function sentenceCase(token: string): string {
  const words = token.replace(/[_:-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `manage_services:restart` -> `manage_services-restart`, safe to splice into a data-testid/DOM id. */
function idSafe(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]+/g, '-');
}

/** Capabilities touched by `kind`'s recommended preset — these are shown first, un-collapsed. */
function presetCapabilityIds(catalog: AgentToolCatalogDto, kind: AiAgentKind): Set<string> {
  const preset = catalog.presets[kind] ?? [];
  const byName = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const ids = new Set<string>();
  for (const entry of preset) {
    const toolName = entry.includes(':') ? entry.slice(0, entry.indexOf(':')) : entry;
    const tool = byName.get(toolName);
    if (tool) ids.add(tool.capability);
  }
  return ids;
}

/**
 * Replaces the free-text tool-allowlist textarea (spec §4.5). Fetches nothing
 * itself — the caller wires `useAgentToolCatalog` and passes the catalog and
 * ceiling down — so this stays a pure, controlled selection view: `entries`
 * in, `onChange(entries)` out, every time.
 */
export default function CapabilityPicker({
  catalog,
  ceiling,
  kind,
  mode,
  entries,
  onChange,
  showToolNames,
}: CapabilityPickerProps) {
  const { t } = useTranslation('settings');
  const [search, setSearch] = useState('');
  // Uncontrolled: `showToolNames` only seeds the initial value. There is no
  // callback prop to report changes back up, by design — this is a per-viewer
  // display preference, not part of the persisted selection.
  const [showNames, setShowNames] = useState(showToolNames ?? false);
  const touchedIds = useMemo(() => presetCapabilityIds(catalog, kind), [catalog, kind]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(touchedIds));
  const [moreOpen, setMoreOpen] = useState(false);

  const { selected, unrecognised } = useMemo(() => entriesToSelection(entries, catalog), [entries, catalog]);

  const toolLabel = (name: string) =>
    t(/* i18n-dynamic */ `aiAgentsPage.catalog.tools.${name}`, { defaultValue: sentenceCase(name) });
  const actionLabel = (toolName: string, action: string | null) =>
    action === null
      ? toolLabel(toolName)
      : t(/* i18n-dynamic */ `aiAgentsPage.catalog.actions.${toolName}.${action}`, { defaultValue: sentenceCase(action) });
  const capabilityLabel = (id: string) =>
    t(/* i18n-dynamic */ `aiAgentsPage.catalog.capabilities.${id}.label`, { defaultValue: sentenceCase(id) });
  const capabilityDescription = (id: string) =>
    t(/* i18n-dynamic */ `aiAgentsPage.catalog.capabilities.${id}.description`, { defaultValue: '' });

  /**
   * Persistence rule (spec §4.3): every change is written through the
   * SELECTION, never the raw entries the draft happened to arrive with. A
   * bare multi-op entry (`bare_multi_op`) already folded its operations into
   * `selected` when `entries` was parsed, so round-tripping through
   * `selectionToEntries` normalises it away on the very next change. Entries
   * the catalog could never represent at all (`unknown_tool`,
   * `unreachable_tool`) are carried over verbatim so an unrelated checkbox
   * click never silently drops them — only the explicit Remove button does.
   */
  const commit = (next: Set<string>) => {
    const preserved = unrecognised.filter((u) => u.reason !== 'bare_multi_op').map((u) => u.entry);
    onChange([...selectionToEntries(next, catalog), ...preserved]);
  };

  const toggleOperation = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commit(next);
  };

  const mutatingOpsFor = (capabilityId: string) =>
    catalog.tools.filter((tool) => tool.capability === capabilityId).flatMap((tool) => tool.operations.filter((op) => !op.readOnly));

  const toggleCapability = (capabilityId: string) => {
    const ops = mutatingOpsFor(capabilityId);
    const state = capabilityState(capabilityId, selected, catalog);
    const next = new Set(selected);
    if (state.checked === 'all') {
      for (const op of ops) next.delete(op.key);
    } else {
      for (const op of ops) if (isWithinCeiling(op.key, ceiling)) next.add(op.key);
    }
    commit(next);
  };

  const toggleExpanded = (capabilityId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(capabilityId)) next.delete(capabilityId);
      else next.add(capabilityId);
      return next;
    });
  };

  const removeUnrecognised = (entry: string) => {
    onChange(entries.filter((e) => e !== entry));
  };

  const preset = catalog.presets[kind] ?? [];
  const presetApplied = preset.length > 0 && preset.every((key) => selected.has(key));
  const applyRecommended = () => {
    const next = new Set(selected);
    for (const key of preset) if (isWithinCeiling(key, ceiling)) next.add(key);
    commit(next);
  };

  const searchLower = search.trim().toLowerCase();
  const capabilityMatchesSearch = (capabilityId: string): boolean => {
    if (!searchLower) return true;
    if (capabilityLabel(capabilityId).toLowerCase().includes(searchLower)) return true;
    for (const tool of catalog.tools) {
      if (tool.capability !== capabilityId) continue;
      if (tool.name.toLowerCase().includes(searchLower)) return true;
      if (toolLabel(tool.name).toLowerCase().includes(searchLower)) return true;
      for (const op of tool.operations) {
        if (op.key.toLowerCase().includes(searchLower)) return true;
        if (actionLabel(tool.name, op.action).toLowerCase().includes(searchLower)) return true;
      }
    }
    return false;
  };

  const readOnlyTools = catalog.tools.filter((tool) => tool.readOnly);
  const withOperations = catalog.capabilities.filter((cap) => mutatingOpsFor(cap.id).length > 0);
  const visible = withOperations.filter((cap) => capabilityMatchesSearch(cap.id));
  const primaryCapabilities = searchLower ? visible : visible.filter((cap) => touchedIds.has(cap.id));
  const moreCapabilities = searchLower ? [] : visible.filter((cap) => !touchedIds.has(cap.id));

  const summary = summarise(selected, catalog, mode);
  const searchInputId = useId();
  const showNamesLabelId = useId();

  const renderCapability = (capabilityId: string) => {
    const cap = catalog.capabilities.find((c) => c.id === capabilityId);
    if (!cap) return null;
    const state = capabilityState(capabilityId, selected, catalog);
    const isOpen = expanded.has(capabilityId) || searchLower !== '';
    const enabledOps = mutatingOpsFor(capabilityId);
    const capDisabled = enabledOps.length > 0 && enabledOps.every((op) => !isWithinCeiling(op.key, ceiling));
    const capTools = catalog.tools.filter((tool) => tool.capability === capabilityId && tool.operations.some((op) => !op.readOnly));

    return (
      <li key={capabilityId} data-testid={`capability-row-${capabilityId}`}>
        <div className="flex items-start gap-2 px-3 py-2.5">
          <input
            ref={(el) => {
              if (el) el.indeterminate = state.checked === 'some';
            }}
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0 rounded border focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            checked={state.checked === 'all'}
            aria-checked={state.checked === 'some' ? 'mixed' : state.checked === 'all'}
            disabled={capDisabled}
            onChange={() => toggleCapability(capabilityId)}
            data-testid={`capability-checkbox-${capabilityId}`}
          />
          <button
            type="button"
            className="flex flex-1 items-start gap-2 rounded-md text-left focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={isOpen}
            onClick={() => toggleExpanded(capabilityId)}
            data-testid={`capability-toggle-${capabilityId}`}
          >
            {isOpen ? (
              <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">{capabilityLabel(capabilityId)}</span>
                {cap.tone === 'high' && (
                  <span className={badgeClass('accent', { size: 'sm' })}>{t('aiAgentsPage.catalog.highImpact')}</span>
                )}
                {capDisabled && (
                  <span className={badgeClass('muted', { size: 'sm' })}>{t('aiAgentsPage.catalog.notInCeiling')}</span>
                )}
              </span>
              <span className="block text-xs text-muted-foreground">{capabilityDescription(capabilityId)}</span>
              <span className="block text-xs text-muted-foreground">
                {t('aiAgentsPage.catalog.operationsCount', { selected: state.selectedCount, total: state.totalCount })}
              </span>
            </span>
          </button>
        </div>
        {isOpen && (
          <div className="space-y-2 border-t bg-muted/20 px-3 py-2">
            {capTools.map((tool) => {
              const mutating = tool.operations.filter((op) => !op.readOnly);
              return (
                <div key={tool.name}>
                  {mutating.length > 1 && <p className="pl-6 text-xs font-semibold text-muted-foreground">{toolLabel(tool.name)}</p>}
                  <ul>
                    {mutating.map((op) => {
                      const outcome = outcomeFor(op, mode);
                      return (
                        <OperationRow
                          key={op.key}
                          op={op}
                          label={actionLabel(tool.name, op.action)}
                          checked={selected.has(op.key)}
                          withinCeiling={isWithinCeiling(op.key, ceiling)}
                          outcome={outcome}
                          outcomeLabel={t(/* i18n-dynamic */ `aiAgentsPage.catalog.outcome.${outcome}`)}
                          showKey={showNames}
                          policyDecidableTitle={t('aiAgentsPage.catalog.preauthorizable')}
                          notInCeilingLabel={t('aiAgentsPage.catalog.notInCeiling')}
                          onToggle={toggleOperation}
                        />
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-3" data-testid="capability-picker">
      <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `aiAgentsPage.catalog.modeLine.${mode}`)}</p>

      {preset.length > 0 && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3"
          data-testid="capability-picker-recommended"
        >
          <div>
            <p className="text-sm font-medium">
              {t('aiAgentsPage.catalog.recommendedTitle', { kind: t(/* i18n-dynamic */ `aiAgentsPage.kinds.${kind}`) })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('aiAgentsPage.catalog.recommendedDescription', { kind: t(/* i18n-dynamic */ `aiAgentsPage.kinds.${kind}`) })}
            </p>
          </div>
          <button
            type="button"
            onClick={applyRecommended}
            disabled={presetApplied}
            className="rounded-md border px-3 py-1.5 text-sm font-medium focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="capability-picker-recommended-apply"
          >
            {presetApplied ? t('aiAgentsPage.catalog.recommendedApplied') : t('aiAgentsPage.catalog.recommendedApply')}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-48 flex-1">
          <label htmlFor={searchInputId} className="sr-only">
            {t('aiAgentsPage.catalog.searchPlaceholder')}
          </label>
          <input
            id={searchInputId}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('aiAgentsPage.catalog.searchPlaceholder')}
            className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="capability-picker-search"
          />
        </div>
        <div className="flex items-center gap-2">
          <span id={showNamesLabelId} className="text-xs font-medium">
            {t('aiAgentsPage.catalog.showToolNames')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={showNames}
            aria-labelledby={showNamesLabelId}
            onClick={() => setShowNames((v) => !v)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${
              showNames ? 'bg-emerald-500/80' : 'bg-muted'
            }`}
            data-testid="capability-picker-show-names"
          >
            <span
              aria-hidden="true"
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                showNames ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {readOnlyTools.length > 0 && (
        <details className="rounded-md border p-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground" data-testid="capability-picker-always-on">
            {t('aiAgentsPage.catalog.alwaysOnCount', { count: readOnlyTools.length })}
          </summary>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {readOnlyTools.map((tool) => (
              <li key={tool.name}>{toolLabel(tool.name)}</li>
            ))}
          </ul>
        </details>
      )}

      <ul className="divide-y rounded-lg border" data-testid="capability-picker-list">
        {primaryCapabilities.map((cap) => renderCapability(cap.id))}
      </ul>

      {moreCapabilities.length > 0 && (
        <details className="rounded-md border p-2" open={moreOpen} onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer text-sm font-medium" data-testid="capability-picker-more">
            {t('aiAgentsPage.catalog.moreCapabilities', { count: moreCapabilities.length })}
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">{t('aiAgentsPage.catalog.moreCapabilitiesHint')}</p>
          <ul className="mt-2 divide-y rounded-lg border">{moreCapabilities.map((cap) => renderCapability(cap.id))}</ul>
        </details>
      )}

      {unrecognised.length > 0 && (
        <div className="rounded-md border border-destructive/40 p-3" data-testid="capability-picker-unrecognised">
          <p className="text-xs font-medium">{t('aiAgentsPage.catalog.unrecognisedTitle')}</p>
          <ul className="mt-1.5 space-y-1.5">
            {unrecognised.map((entry) => (
              <li key={entry.entry} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>
                  <span className="font-mono">{entry.entry}</span>
                  {' — '}
                  {t(/* i18n-dynamic */ `aiAgentsPage.catalog.unrecognised.${entry.reason}`)}
                </span>
                <button
                  type="button"
                  onClick={() => removeUnrecognised(entry.entry)}
                  className="rounded-md border px-2 py-0.5 font-medium focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`capability-picker-unrecognised-remove-${idSafe(entry.entry)}`}
                >
                  {t('aiAgentsPage.catalog.remove')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground" data-testid="capability-picker-summary">
        {t(/* i18n-dynamic */ `aiAgentsPage.catalog.summary.${mode}`, {
          operations: summary.operations,
          capabilities: summary.capabilities,
          approvalRequests: summary.approvalRequests,
          loggedProposals: summary.loggedProposals,
        })}
      </p>
    </div>
  );
}
