import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Users } from 'lucide-react';

import { asList } from '@/lib/asList';
import { executionRefusedFieldsUsed } from '@/lib/executionRefusedFields';
import { MAX_SCRIPT_RUN_GROUPS } from '@/lib/scriptExecute';
import { fetchWithAuth } from '../../stores/auth';

type GroupRow = {
  id: string;
  name: string;
  type: 'static' | 'dynamic';
  filterFieldsUsed: string[];
  deviceCount: number | null;
};

type MemberRow = { deviceId: string; hostname: string; displayName?: string | null; status: string; osType: string };

export type GroupSelectionSummary = {
  /** idle: nothing selected. error: at least one member list could not be read. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Distinct devices across the selected groups (a device in two groups counts once). */
  uniqueDevices: number;
  /** Of those, how many run an OS this script supports. */
  compatibleDevices: number;
  /** Of the compatible ones, how many are not online right now. */
  offlineCompatible: number;
  deviceLabels: ReadonlyMap<string, string>;
  groupNames: ReadonlyMap<string, string>;
};

type GroupTargetPickerProps = {
  scriptOsTypes: readonly string[];
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  onSummaryChange?: (summary: GroupSelectionSummary) => void;
  /** Pin the list to one org (device pages / org switcher). Omitted: every group the caller can see. */
  orgId?: string;
};

type ListState = 'loading' | 'ready' | 'error';

function toGroupRow(raw: unknown): GroupRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.name !== 'string') return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type === 'dynamic' ? 'dynamic' : 'static',
    filterFieldsUsed: Array.isArray(row.filterFieldsUsed)
      ? row.filterFieldsUsed.filter((f): f is string => typeof f === 'string')
      : [],
    deviceCount: typeof row.deviceCount === 'number' ? row.deviceCount : null,
  };
}

export default function GroupTargetPicker({
  scriptOsTypes,
  selectedIds,
  onSelectedIdsChange,
  onSummaryChange,
  orgId,
}: GroupTargetPickerProps) {
  const { t } = useTranslation('scripts');
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [listState, setListState] = useState<ListState>('loading');
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState('');
  // groupId -> members, or 'error' when that group's member list failed.
  const [members, setMembers] = useState<Record<string, MemberRow[] | 'error'>>({});
  const requested = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    setListState('loading');
    const url = orgId ? `/device-groups?orgId=${encodeURIComponent(orgId)}` : '/device-groups';
    fetchWithAuth(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (cancelled) return;
        setGroups(asList(data, 'groups').map(toGroupRow).filter((row): row is GroupRow => row !== null));
        setListState('ready');
      })
      .catch(() => {
        if (!cancelled) setListState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, reloadKey]);

  // Membership of every selected group, read once per group. This is what the
  // Groups page shows (dynamic groups: the last materialised evaluation), and
  // it is site-scoped server-side, so the counts here match what a run will see.
  useEffect(() => {
    for (const id of selectedIds) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      fetchWithAuth(`/device-groups/${encodeURIComponent(id)}/devices`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          const rows = asList(data, 'devices').filter(
            (row): row is MemberRow => !!row && typeof (row as MemberRow).deviceId === 'string',
          );
          setMembers((prev) => ({ ...prev, [id]: rows }));
        })
        .catch(() => {
          setMembers((prev) => ({ ...prev, [id]: 'error' }));
        });
    }
  }, [selectedIds]);

  const retryMembers = useCallback(() => {
    for (const id of selectedIds) {
      if (members[id] === 'error') requested.current.delete(id);
    }
    setMembers((prev) => Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== 'error')));
  }, [members, selectedIds]);

  const groupNames = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  const summary = useMemo<GroupSelectionSummary>(() => {
    const empty = { uniqueDevices: 0, compatibleDevices: 0, offlineCompatible: 0 };
    const labels = new Map<string, string>();
    if (selectedIds.length === 0) {
      return { status: 'idle', ...empty, deviceLabels: labels, groupNames };
    }
    const loaded = selectedIds.map((id) => members[id]);
    if (loaded.some((entry) => entry === 'error')) {
      return { status: 'error', ...empty, deviceLabels: labels, groupNames };
    }
    if (loaded.some((entry) => entry === undefined)) {
      return { status: 'loading', ...empty, deviceLabels: labels, groupNames };
    }
    const unique = new Map<string, MemberRow>();
    for (const entry of loaded as MemberRow[][]) {
      for (const row of entry) unique.set(row.deviceId, row);
    }
    let compatible = 0;
    let offline = 0;
    for (const row of unique.values()) {
      labels.set(row.deviceId, row.displayName || row.hostname);
      if (scriptOsTypes.includes(row.osType)) {
        compatible += 1;
        if (row.status !== 'online') offline += 1;
      }
    }
    return {
      status: 'ready',
      uniqueDevices: unique.size,
      compatibleDevices: compatible,
      offlineCompatible: offline,
      deviceLabels: labels,
      groupNames,
    };
  }, [groupNames, members, scriptOsTypes, selectedIds]);

  const onSummaryRef = useRef(onSummaryChange);
  onSummaryRef.current = onSummaryChange;
  useEffect(() => {
    onSummaryRef.current?.(summary);
  }, [summary]);

  const toggle = (id: string, checked: boolean) => {
    if (checked) {
      // Belt and braces for the disabled checkbox: never select a refused group
      // or go past the per-run group limit, whatever dispatched the event.
      const group = groups.find((g) => g.id === id);
      if (!group || executionRefusedFieldsUsed(group.filterFieldsUsed).length > 0) return;
      if (selectedIds.length >= MAX_SCRIPT_RUN_GROUPS) return;
    }
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedIdsChange([...next]);
  };

  const needle = search.trim().toLowerCase();
  const visible = needle ? groups.filter((g) => g.name.toLowerCase().includes(needle) || selectedIds.includes(g.id)) : groups;
  const atGroupLimit = selectedIds.length >= MAX_SCRIPT_RUN_GROUPS;

  return (
    <div className="space-y-3" data-testid="group-target-picker">
      <div className="flex items-center justify-between gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('scriptExecutionModal.groups.searchPlaceholder')}
          data-testid="group-search"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-72"
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('scriptExecutionModal.groups.selectedCount', { count: selectedIds.length })}
        </span>
      </div>

      {listState === 'loading' && (
        <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('scriptExecutionModal.groups.loading')}
        </p>
      )}

      {listState === 'error' && (
        <div
          role="alert"
          data-testid="group-list-error"
          className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <span>{t('scriptExecutionModal.groups.loadFailed')}</span>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="text-xs font-medium underline">
            {t('scriptExecutionModal.groups.retry')}
          </button>
        </div>
      )}

      {listState === 'ready' && groups.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('scriptExecutionModal.groups.empty')}</p>
      )}

      {listState === 'ready' && groups.length > 0 && (
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {visible.map((group) => {
            const checked = selectedIds.includes(group.id);
            const refusedFields = executionRefusedFieldsUsed(group.filterFieldsUsed);
            const refused = refusedFields.length > 0;
            const disabled = !checked && (refused || atGroupLimit);
            return (
              <label
                key={group.id}
                className={`flex items-start gap-3 rounded-md border bg-background px-3 py-2 text-sm transition ${
                  disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/40'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => toggle(group.id, e.target.checked)}
                  data-testid={`group-checkbox-${group.id}`}
                  className="mt-0.5 h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-medium">{group.name}</span>
                    {group.type === 'dynamic' && (
                      <span
                        data-testid={`group-dynamic-${group.id}`}
                        className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                      >
                        {t('scriptExecutionModal.groups.dynamic')}
                      </span>
                    )}
                    {group.deviceCount !== null && (
                      <span className="text-xs text-muted-foreground">
                        {t('scriptExecutionModal.groups.deviceCount', { count: group.deviceCount })}
                      </span>
                    )}
                  </div>
                  {refused && (
                    <p data-testid={`group-refused-${group.id}`} className="mt-1 text-xs text-amber-700 dark:text-amber-500">
                      {t('scriptExecutionModal.groups.refusedReason', { fields: refusedFields.join(', ') })}
                    </p>
                  )}
                </div>
              </label>
            );
          })}
        </div>
      )}

      {atGroupLimit && (
        <p className="text-xs text-muted-foreground">
          {t('scriptExecutionModal.groups.tooManyGroups', { max: MAX_SCRIPT_RUN_GROUPS })}
        </p>
      )}

      {summary.status === 'loading' && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('scriptExecutionModal.groups.countingMembers')}
        </p>
      )}

      {summary.status === 'error' && (
        <div
          role="alert"
          data-testid="group-summary-error"
          className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-400"
        >
          <span>{t('scriptExecutionModal.groups.countFailed')}</span>
          <button type="button" onClick={retryMembers} className="font-medium underline">
            {t('scriptExecutionModal.groups.retry')}
          </button>
        </div>
      )}

      {summary.status === 'ready' && (
        <div data-testid="group-summary" className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">
            {t('scriptExecutionModal.groups.summaryUnique', { count: summary.uniqueDevices })}
          </p>
          <p>{t('scriptExecutionModal.groups.summaryCompatible', { count: summary.compatibleDevices })}</p>
          {summary.offlineCompatible > 0 && (
            <p>{t('scriptExecutionModal.groups.summaryOffline', { count: summary.offlineCompatible })}</p>
          )}
          <p className="mt-1">{t('scriptExecutionModal.groups.membershipNote')}</p>
        </div>
      )}
    </div>
  );
}
