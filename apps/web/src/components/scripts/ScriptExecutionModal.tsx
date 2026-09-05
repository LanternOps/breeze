import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Play, Loader2, Clock, AlertCircle, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog } from '../shared/Dialog';
import ProgressBar from '../shared/ProgressBar';
import type { Script } from './ScriptList';
import { hasSecretParameters, runtimeParameters, secretsBlockedForRun, type ScriptParameter } from './ScriptFormSchema';
import type { FilterConditionGroup, ScriptAdmissionResult } from '@breeze/shared';
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from '../filters/FilterBuilder';
import { useFilterPreview } from '../../hooks/useFilterPreview';
import ScriptParametersForm, { validateParameters as validateParamsHelper } from './ScriptParametersForm';
import { useDeviceOptions, type UseDeviceOptionsResult } from '../../hooks/useDeviceOptions';
import { DeviceOptionPicker } from '../filters/DeviceOptionPicker';

export type Device = {
  id: string;
  hostname: string;
  os: 'windows' | 'macos' | 'linux';
  status: 'online' | 'offline' | 'maintenance';
  siteId: string;
  siteName: string;
};

export type Site = {
  id: string;
  name: string;
};

type ScriptExecutionModalProps = {
  script: Script & { parameters?: ScriptParameter[]; content?: string };
  devices?: Device[];
  sites?: Site[];
  isOpen: boolean;
  onClose: () => void;
  onExecute: (
    scriptId: string,
    deviceIds: string[],
    parameters: Record<string, string | number | boolean>,
    runAs: 'system' | 'user'
  ) => Promise<ScriptAdmissionResult>;
  // #4885 "Run again" — pre-fill the picker/form from a past execution instead
  // of opening blank. Both are read once at mount (the modal is remounted
  // fresh on every open by every caller today), so a parent re-render with a
  // new object identity does not fight the operator's in-progress edits.
  initialDeviceIds?: string[];
  initialParameters?: Record<string, string | number | boolean>;
};

type ExecutionState = 'idle' | 'submitting' | 'admitted' | 'partially_admitted' | 'rejected' | 'transport_error';

export default function ScriptExecutionModal({
  script,
  devices,
  sites = [],
  isOpen,
  onClose,
  onExecute,
  initialDeviceIds,
  initialParameters
}: ScriptExecutionModalProps) {
  const { t } = useTranslation('scripts');
  const [query, setQuery] = useState('');
  const [siteFilter, setSiteFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('online');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(
    () => new Set(initialDeviceIds ?? [])
  );
  const [parameters, setParameters] = useState<Record<string, string | number | boolean>>({});
  const [runAs, setRunAs] = useState<'system' | 'user'>('system');
  const [executionState, setExecutionState] = useState<ExecutionState>('idle');
  const [admissionResult, setAdmissionResult] = useState<ScriptAdmissionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false);
  const [advancedFilter, setAdvancedFilter] = useState<FilterConditionGroup>({
    operator: 'AND',
    conditions: [{ field: 'hostname', operator: 'contains', value: '' }]
  });

  const { preview: filterPreview } = useFilterPreview(
    showAdvancedFilter ? advancedFilter : null,
    { enabled: showAdvancedFilter }
  );
  const advancedFilterIds = useMemo(() => {
    if (!showAdvancedFilter || !filterPreview) return null;
    return new Set(filterPreview.devices.map(d => d.id));
  }, [showAdvancedFilter, filterPreview]);

  const fetchedDeviceOptions = useDeviceOptions({
    search: query,
    status: statusFilter === 'all' ? undefined : statusFilter,
    siteId: siteFilter === 'all' ? undefined : siteFilter,
    osType: script.osTypes.length === 1 ? script.osTypes[0] : undefined,
    includeIds: [...selectedDeviceIds],
    enabled: devices === undefined && isOpen,
    limit: 100,
  });

  const providedDeviceOptions = useMemo<UseDeviceOptionsResult | null>(() => {
    if (!devices) return null;
    const normalizedQuery = query.trim().toLowerCase();
    const options = devices
      .filter((device) => script.osTypes.includes(device.os))
      .filter((device) => advancedFilterIds === null || advancedFilterIds.has(device.id) || selectedDeviceIds.has(device.id))
      .filter((device) => !normalizedQuery || device.hostname.toLowerCase().includes(normalizedQuery) || selectedDeviceIds.has(device.id))
      .filter((device) => siteFilter === 'all' || device.siteId === siteFilter || selectedDeviceIds.has(device.id))
      .filter((device) => statusFilter === 'all' || device.status === statusFilter || selectedDeviceIds.has(device.id))
      .map((device) => ({
        id: device.id,
        hostname: device.hostname,
        displayName: null,
        osType: device.os,
        status: device.status,
        siteId: device.siteId || null,
        siteName: device.siteName || null,
      }));
    const resolved = new Set(options.map((option) => option.id));
    const unresolved = [...selectedDeviceIds].some((id) => !resolved.has(id));
    return {
      options,
      page: { nextCursor: null, returned: options.length, total: options.length, hasMore: false, observedAt: '' },
      state: unresolved ? 'truncated' : options.length > 0 ? 'ready' : 'empty',
      error: null,
      canSubmit: !unresolved,
      loadMore: async () => {},
      retry: () => {},
    };
  }, [advancedFilterIds, devices, query, script.osTypes, selectedDeviceIds, siteFilter, statusFilter]);

  const deviceOptions = useMemo<UseDeviceOptionsResult>(() => {
    const source = providedDeviceOptions ?? fetchedDeviceOptions;
    if (providedDeviceOptions || script.osTypes.length === 1) return source;
    const allowed = new Set(script.osTypes);
    return {
      ...source,
      options: source.options.filter((option) => allowed.has(option.osType as Device['os']) || selectedDeviceIds.has(option.id)),
    };
  }, [fetchedDeviceOptions, providedDeviceOptions, script.osTypes, selectedDeviceIds]);

  // #4172 re-port (spec D4): the status filter defaults to 'online', so a fleet
  // of OS-compatible-but-offline devices renders an empty picker. Saying "no
  // compatible devices — this script requires Windows" there sends the tech off
  // to check OS compatibility for no reason. When the picker is empty ONLY
  // because the status filter hid compatible devices, blame the filter and
  // offer the reset instead.
  const statusFilterActive = statusFilter !== 'all';
  const pickerEmpty = deviceOptions.state === 'empty';

  // Legacy `devices`-prop path: main's exact computation — the OS-compatible
  // devices, and how many of them survive the status filter alone (ignoring the
  // query/site/advanced filters).
  const legacyCompatible = useMemo(() => {
    if (!devices) return null;
    const compatible = devices.filter(device => script.osTypes.includes(device.os));
    const afterStatus = statusFilter === 'all'
      ? compatible.length
      : compatible.filter(device => device.status === statusFilter).length;
    return { count: compatible.length, hiddenByStatus: compatible.length > 0 && afterStatus === 0 };
  }, [devices, script.osTypes, statusFilter]);

  // Server-options path: an exact count from a one-row probe with the status
  // filter lifted. `page.total` is the full match count, so limit 1 is enough,
  // and `enabled` keeps this to a single extra request on the empty+filtered
  // path only.
  //
  // The endpoint takes one `osType`, so a MULTI-OS script cannot narrow the
  // probe (neither can the primary query above, which filters OS client-side
  // after fetching). An un-narrowed total would let us claim N hidden
  // "compatible" devices when none of them can run this script, and the reset
  // would then land the operator on a blank pane. Over-fetching is survivable;
  // over-asserting is not — so a multi-OS script does not probe at all and
  // says nothing, leaving the picker's own neutral empty text.
  const probeEnabled = devices === undefined
    && isOpen
    && pickerEmpty
    && statusFilterActive
    && script.osTypes.length === 1;
  const unfilteredProbe = useDeviceOptions({
    search: query,
    status: undefined,
    siteId: siteFilter === 'all' ? undefined : siteFilter,
    osType: script.osTypes.length === 1 ? script.osTypes[0] : undefined,
    enabled: probeEnabled,
    limit: 1,
  });

  // Settled evidence only. `page` is null while the probe is in flight and
  // stays null when it fails, and a disabled hook also reports state 'empty' —
  // so "no answer yet" and "answered zero" must not collapse into one value.
  // `null` here means: assert nothing about this fleet.
  const probeTotal = probeEnabled
    && (unfilteredProbe.state === 'ready' || unfilteredProbe.state === 'empty')
    && unfilteredProbe.page
      ? unfilteredProbe.page.total
      : null;

  // Which empty-state message the evidence supports: blame the status filter,
  // blame the OS, or — while the probe is unsettled, failed, or unavailable —
  // neither.
  const emptyBlame: 'statusFilter' | 'osMismatch' | null = !pickerEmpty
    ? null
    : legacyCompatible
      ? (statusFilterActive && legacyCompatible.hiddenByStatus ? 'statusFilter' : 'osMismatch')
      : probeTotal === null
        ? null
        : probeTotal > 0 ? 'statusFilter' : 'osMismatch';
  const hiddenCompatibleCount = legacyCompatible ? legacyCompatible.count : probeTotal ?? 0;

  // Initialize parameters with defaults. Runtime parameters only (#3409 PR3):
  // a bound parameter is resolved per target device by the server, so it is
  // neither prompted for nor seeded — a value supplied for one is ignored and
  // reported in `ignoredParameters`.
  //
  // #4885 "Run again": `initialParameters` (the previous execution's runtime
  // values) wins over the definition's own default when both are present for
  // the same name. A key in `initialParameters` that no longer matches a
  // runtime parameter (the script was edited since that run) is silently
  // dropped rather than smuggled into the submitted payload.
  useEffect(() => {
    if (script.parameters) {
      const defaults: Record<string, string | number | boolean> = {};
      runtimeParameters(script.parameters).forEach(param => {
        const carriedOver = initialParameters?.[param.name];
        if (carriedOver !== undefined) {
          defaults[param.name] = carriedOver;
        } else if (param.defaultValue !== undefined) {
          if (param.type === 'number') {
            defaults[param.name] = Number(param.defaultValue) || 0;
          } else if (param.type === 'boolean') {
            defaults[param.name] = param.defaultValue === 'true';
          } else {
            defaults[param.name] = param.defaultValue;
          }
        } else {
          defaults[param.name] = param.type === 'boolean' ? false : param.type === 'number' ? 0 : '';
        }
      });
      setParameters(defaults);
    }
    // `initialParameters` is deliberately NOT a dep — it is read once at mount
    // (see the prop doc comment) so a parent re-render never resets an
    // in-progress edit. Only a script.parameters change re-derives defaults.
  }, [script.parameters]);

  useEffect(() => {
    setRunAs(script.runAs === 'user' ? 'user' : 'system');
  }, [script.id, script.runAs, isOpen]);

  const handleClearSelection = () => {
    setSelectedDeviceIds(new Set());
  };

  const handleParameterChange = (name: string, value: string | number | boolean) => {
    setParameters(prev => ({ ...prev, [name]: value }));
  };

  const validateParameters = (): boolean => {
    if (!script.parameters) return true;
    const error = validateParamsHelper(script.parameters, parameters, t);
    if (error) {
      setErrorMessage(error);
      return false;
    }
    return true;
  };

  const handleExecute = async () => {
    if (!showConfirm) {
      if (!validateParameters()) return;
      if (selectedDeviceIds.size === 0) {
        setErrorMessage(t('scriptExecutionModal.errors.selectDevice'));
        return;
      }
      setShowConfirm(true);
      return;
    }

    setExecutionState('submitting');
    setErrorMessage(undefined);
    setAdmissionResult(null);

    try {
      const result = await onExecute(script.id, Array.from(selectedDeviceIds), parameters, runAs);
      setAdmissionResult(result);
      const admittedCount = result.targets.filter(target => target.admission === 'admitted').length;
      const presentationState: ExecutionState = admittedCount === result.targets.length && admittedCount > 0
        ? 'admitted'
        : admittedCount > 0
          ? 'partially_admitted'
          : 'rejected';
      setExecutionState(presentationState);
      setShowConfirm(false);
      if (presentationState === 'admitted') {
        setTimeout(() => {
          onClose();
          setExecutionState('idle');
          setAdmissionResult(null);
          setSelectedDeviceIds(new Set());
        }, 1500);
      }
    } catch (err) {
      setExecutionState('transport_error');
      setErrorMessage(err instanceof Error ? err.message : t('scriptExecutionModal.errors.executionFailed'));
      setShowConfirm(false);
    }
  };

  const handleClose = () => {
    if (executionState === 'submitting') return;
    onClose();
    setExecutionState('idle');
    setShowConfirm(false);
    setErrorMessage(undefined);
    setAdmissionResult(null);
  };

  return (
    <Dialog open={isOpen} onClose={handleClose} title={t('scriptExecutionModal.title')} maxWidth="3xl" className="max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">{t('scriptExecutionModal.title')}</h2>
            <p className="text-sm text-muted-foreground">{script.name}</p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={executionState === 'submitting'}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Script Info */}
          <div className="rounded-md border bg-muted/20 p-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('scriptExecutionModal.fields.language')}</p>
                <p className="text-sm font-medium">{t(/* i18n-dynamic */ `scriptExecutionModal.languages.${script.language}`)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('scriptExecutionModal.fields.category')}</p>
                <p className="text-sm font-medium">{script.category}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('scriptExecutionModal.fields.targetOs')}</p>
                <p className="text-sm font-medium">{script.osTypes.map(os => t(/* i18n-dynamic */ `scriptExecutionModal.os.${os}`)).join(', ')}</p>
              </div>
            </div>
            {script.description && (
              <p className="mt-3 text-sm text-muted-foreground">{script.description}</p>
            )}
          </div>

          {/* Execution Context */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">{t('scriptExecutionModal.fields.runAs')}</h3>
            <select
              value={runAs}
              onChange={e => setRunAs(e.target.value as 'system' | 'user')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-80"
            >
              <option value="system">{t('scriptExecutionModal.runAs.system')}</option>
              <option value="user">{t('scriptExecutionModal.runAs.user')}</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {runAs === 'system'
                ? t('scriptExecutionModal.runAs.systemDescription')
                : t('scriptExecutionModal.runAs.userDescription')}
            </p>
            {/* Secrets ride an environment variable in the sealed command
                envelope, which the user-context helper IPC cannot carry, so the
                server refuses the run per device (#3409 PR4c-2). The full rule
                lives in `secretsBlockedForRun` — this surface targets no
                session today, but reading the shared predicate is what keeps
                the wording honest if it ever gains one. Advisory only: the
                operator may still submit and get that same message back per
                device — this just says it before the round trip. */}
            {hasSecretParameters(script.parameters) && secretsBlockedForRun({ runAs }) && (
              <p
                data-testid="script-secrets-require-system"
                className="text-xs text-amber-600 dark:text-amber-500"
              >
                {t('secretParameters.requiresSystemContext')}
              </p>
            )}
          </div>

          {/* Parameters — shown whenever the script HAS parameters, bound or
              not. The form prompts only for the runtime ones; an all-bound
              script still shows its read-only chips so the operator can see
              what will be injected into a run on customer machines. */}
          {script.parameters && script.parameters.length > 0 && (
            <ScriptParametersForm
              parameters={script.parameters}
              values={parameters}
              onChange={(name, value) => handleParameterChange(name, value as string | number | boolean)}
            />
          )}

          {/* Device Selection */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{t('scriptExecutionModal.sections.selectDevices')}</h3>
              <div className="flex items-center gap-2">
                {selectedDeviceIds.size > 0 && (
                  <button
                    type="button"
                    onClick={handleClearSelection}
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    {t('scriptExecutionModal.actions.clear', { count: selectedDeviceIds.size })}
                  </button>
                )}
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {sites.length > 0 && (
                <select
                  value={siteFilter}
                  onChange={e => setSiteFilter(e.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="all">{t('scriptExecutionModal.filters.allSites')}</option>
                  {sites.map(site => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              )}
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="all">{t('scriptExecutionModal.filters.allStatus')}</option>
                <option value="online">{t('common:states.online')}</option>
                <option value="offline">{t('common:states.offline')}</option>
                <option value="maintenance">{t('scriptExecutionModal.status.maintenance')}</option>
              </select>
            </div>

            {/* Advanced Filter Toggle */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvancedFilter(!showAdvancedFilter)}
                className={cn(
                  'inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium transition',
                  showAdvancedFilter ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
                )}
              >
                <Filter className="h-3 w-3" />
                {t('scriptExecutionModal.actions.advancedFilters')}
                {showAdvancedFilter && advancedFilterIds && (
                  <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px]">
                    {t('scriptExecutionModal.matchCount', { count: advancedFilterIds.size })}
                  </span>
                )}
              </button>
              {showAdvancedFilter && (
                <div className="mt-3">
                  <FilterBuilder
                    value={advancedFilter}
                    onChange={setAdvancedFilter}
                    filterFields={DEFAULT_FILTER_FIELDS}
                    showPreview={false}
                  />
                </div>
              )}
            </div>

            <DeviceOptionPicker
              result={deviceOptions}
              selectedIds={[...selectedDeviceIds]}
              onSelectedIdsChange={(ids) => setSelectedDeviceIds(new Set(ids))}
              search={query}
              onSearchChange={setQuery}
              showSelectAll
            />

            {/* #4172: offline-vs-OS disambiguation for the empty picker, shown
                only where the evidence supports it (`emptyBlame`). The picker
                keeps its own neutral "No devices found." line — it has no
                empty-state slot, and that line is all the operator sees while
                the evidence is still missing. */}
            {emptyBlame === 'statusFilter' ? (
              <div className="p-4 text-center text-sm text-muted-foreground space-y-2">
                <p>
                  {t('scriptExecutionModal.empty.offlineFiltered', {
                    count: hiddenCompatibleCount,
                    status: statusFilter === 'maintenance'
                      ? t('scriptExecutionModal.status.maintenance')
                      : t(/* i18n-dynamic */ `common:states.${statusFilter}`)
                  })}
                </p>
                <button
                  type="button"
                  onClick={() => setStatusFilter('all')}
                  className="text-xs text-primary hover:underline"
                >
                  {t('scriptExecutionModal.empty.showAllDevices')}
                </button>
              </div>
            ) : emptyBlame === 'osMismatch' ? (
              <p className="p-4 text-center text-sm text-muted-foreground">
                {t('scriptExecutionModal.empty.noCompatibleDevices', {
                  os: script.osTypes.map(os => t(/* i18n-dynamic */ `scriptExecutionModal.os.${os}`)).join(t('scriptExecutionModal.orSeparator'))
                })}
              </p>
            ) : null}
          </div>

          {/* Execution Progress */}
          {(executionState === 'submitting' || admissionResult) && (
            <div className="rounded-md border bg-muted/20 p-4 space-y-3">
              {admissionResult && (
                <p className="text-sm font-medium">
                  {executionState === 'admitted'
                    ? t('scriptExecutionModal.admission.allAdmitted')
                    : executionState === 'partially_admitted'
                      ? t('scriptExecutionModal.admission.partiallyAdmitted')
                      : t('scriptExecutionModal.admission.rejected')}
                </p>
              )}
              <ProgressBar
                current={admissionResult?.targets.filter(target => target.admission === 'admitted').length ?? 0}
                total={selectedDeviceIds.size}
                label={executionState === 'submitting'
                  ? t('scriptExecutionModal.progress.submitting', { count: selectedDeviceIds.size })
                  : t('scriptExecutionModal.progress.admitted', {
                    admitted: admissionResult?.targets.filter(target => target.admission === 'admitted').length ?? 0,
                    count: admissionResult?.targets.length ?? selectedDeviceIds.size,
                  })}
                variant={executionState === 'rejected' ? 'error' : executionState === 'partially_admitted' ? 'warning' : 'default'}
              />
              <div className="space-y-1">
                {(admissionResult?.targets ?? Array.from(selectedDeviceIds).map(requestedDeviceId => ({
                  requestedDeviceId,
                  admission: 'admitted' as const,
                  reasonCode: undefined,
                }))).map((target) => {
                  const device = deviceOptions.options.find(d => d.id === target.requestedDeviceId);
                  const label = device?.displayName ?? device?.hostname ?? target.requestedDeviceId;
                  const targetState = executionState === 'submitting'
                    ? t('scriptExecutionModal.progress.submittingTarget')
                    : target.admission === 'admitted'
                      ? t('scriptExecutionModal.admission.queued')
                      : target.admission;
                  return (
                    <div key={target.requestedDeviceId} className="flex items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm">
                      <span className="truncate font-medium">{label}</span>
                      <span className="shrink-0 text-right text-xs text-muted-foreground">
                        <span className="font-medium">{targetState}</span>
                        {executionState !== 'submitting' && target.reasonCode && (
                          <span className="ml-2 font-mono">{target.reasonCode}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Error Message */}
          {errorMessage && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {errorMessage}
            </div>
          )}

          {/* Confirmation */}
          {showConfirm && executionState === 'idle' && (
            <div className="rounded-md border border-warning/30 bg-warning/10 px-4 py-3">
              <p className="text-sm font-medium text-warning">
                {t('scriptExecutionModal.confirm.title')}
              </p>
              <p className="text-sm text-warning/80 mt-1">
                {t('scriptExecutionModal.confirm.description', {
                  name: script.name,
                  count: selectedDeviceIds.size,
                  runAs: runAs === 'system' ? t('scriptExecutionModal.runAs.system') : t('scriptExecutionModal.runAs.user')
                })}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-6 py-4">
          <p className="text-sm text-muted-foreground">
            {t('scriptExecutionModal.selectedCount', { count: selectedDeviceIds.size })}
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={executionState === 'submitting'}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="button"
              onClick={handleExecute}
              disabled={executionState !== 'idle' || selectedDeviceIds.size === 0 || !deviceOptions.canSubmit}
              className={cn(
                'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60',
                showConfirm
                    ? 'bg-warning text-white hover:bg-warning/90'
                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              {executionState === 'submitting' && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {executionState === 'admitted' && (
                <Clock className="h-4 w-4" />
              )}
              {(executionState === 'partially_admitted' || executionState === 'rejected' || executionState === 'transport_error') && (
                <AlertCircle className="h-4 w-4" />
              )}
              {executionState === 'idle' && !showConfirm && (
                <Play className="h-4 w-4" />
              )}
              {executionState === 'submitting'
                ? t('scriptExecutionModal.actions.executing')
                : executionState === 'admitted'
                  ? t('scriptExecutionModal.actions.queued')
                  : executionState === 'partially_admitted' || executionState === 'rejected'
                    ? t('scriptExecutionModal.actions.reviewResult')
                  : showConfirm
                    ? t('scriptExecutionModal.actions.confirmExecute')
                    : t('scriptExecutionModal.actions.execute')}
            </button>
          </div>
        </div>
    </Dialog>
  );
}
