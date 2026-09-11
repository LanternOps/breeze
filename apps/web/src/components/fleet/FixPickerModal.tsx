import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronLeft, Loader2, Power, RotateCcw, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatNumber } from '@/lib/i18n/format';
import { handleActionError } from '@/lib/runAction';
import { Dialog } from '../shared/Dialog';
import ScriptPickerModal, { type Script } from '../devices/ScriptPickerModal';
import { RunContextChip, RunContextSelect, type RunContextChoice } from '../common/RunContext';
import { remediateFinding, runIdFromFailure } from '@/services/fleetFindings';
import type {
  FleetFindingDetail, RemediateRequest, RemediateResponse,
} from '@/services/fleetFindings';
import { skipReasonLabelKey } from './findingLabels';

/** Step 1's three offers. There is deliberately NO `clear_temp_files`: it was
 *  cut in Task 7 because no single agent command primitive implements it —
 *  temp cleanup belongs in a script from the library. */
type FixKind = 'script' | 'restart_service' | 'reboot';

/** OS platform names are proper nouns, not translated strings — same
 *  precedent as `DeviceInfoTab.tsx`'s `osTypeLabels` (not an i18n key). */
const OS_NAME_LABELS: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

function osNameLabel(os: string): string {
  return OS_NAME_LABELS[os] ?? os;
}

type Step = 'action' | 'targets' | 'confirm' | 'result';

interface FixPickerModalProps {
  finding: FleetFindingDetail;
  onClose: () => void;
  /** Handoff to `RunProgressPanel`. Also fired on a 502 whose body carries a
   *  runId — that run genuinely exists (marked failed), so the operator must
   *  see it rather than a bare "something went wrong". */
  onRunStarted: (runId: string) => void;
}

export default function FixPickerModal({ finding, onClose, onRunStarted }: FixPickerModalProps) {
  const { t } = useTranslation('common');

  const [step, setStep] = useState<Step>('action');
  const [kind, setKind] = useState<FixKind | null>(null);
  const [script, setScript] = useState<Script | null>(null);
  // Mirrors `ScriptPickerModal`'s own default — that picker always resets to
  // 'system' on open (it has no "script default" option), so a fresh pick
  // that never touches the run-as select still carries an explicit 'system'
  // choice, not an absent one.
  // #4888 — `null` means "leave the script's saved default alone", and it has
  // to be the initial value. The launch-time enum has no 'elevated', so a
  // control that always sent a concrete value would silently downgrade an
  // elevated remediation script to `system` — a quieter bug than the one this
  // issue is about (a select whose value was discarded), and a worse one.
  const [scriptRunAs, setScriptRunAs] = useState<RunContextChoice | null>(null);
  const [scriptParameters, setScriptParameters] = useState<Record<string, unknown>>({});
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);
  const [serviceName, setServiceName] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(finding.members.map((m) => m.deviceId))
  );
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RemediateResponse | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const hostnameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of finding.members) map.set(m.deviceId, m.displayName || m.hostname);
    return map;
  }, [finding.members]);

  // A script's `os_types` is the only fix kind that declares OS
  // compatibility today — restart_service/reboot have no such constraint.
  // The API dispatches to every requested device regardless of OS (see
  // dispatch.ts's RemediationSkipReason: site_denied/not_member/
  // decommissioned only, nothing OS-related), so an incompatible dispatch
  // would otherwise only surface per-device at agent execution time. This
  // must be enforced client-side.
  const osIncompatibility = useMemo(() => {
    const requiredOsTypes = kind === 'script' ? script?.osTypes : undefined;
    const deviceIds = new Set<string>();
    if (!requiredOsTypes || requiredOsTypes.length === 0) {
      return { deviceIds, requiredLabel: '' };
    }
    const allowed = new Set<string>(requiredOsTypes);
    for (const m of finding.members) {
      if (!allowed.has(m.osType)) deviceIds.add(m.deviceId);
    }
    return { deviceIds, requiredLabel: requiredOsTypes.map(osNameLabel).join(', ') };
  }, [kind, script, finding.members]);

  // Devices pruned by OS incompatibility rather than by the operator. Tracked
  // separately so the pruning can be undone: previously, switching from a
  // Windows-only script back to `reboot` cleared `osIncompatibility.deviceIds`,
  // and the pruned devices rendered as enabled-but-unchecked with no hint they
  // had ever been selected — so the operator dispatched to fewer devices than
  // they thought. A system-pruned device is restored the moment it becomes
  // compatible again; a manually deselected one is never re-added.
  const autoPrunedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const incompatible = osIncompatibility.deviceIds;

    setSelectedIds((prev) => {
      const next = new Set(prev);
      let changed = false;

      for (const id of incompatible) {
        if (next.delete(id)) {
          autoPrunedIds.current.add(id);
          changed = true;
        }
      }

      // Restore anything we pruned that the current fix kind can reach again.
      for (const id of [...autoPrunedIds.current]) {
        if (!incompatible.has(id)) {
          autoPrunedIds.current.delete(id);
          next.add(id);
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [osIncompatibility.deviceIds]);

  // ── Step gating ───────────────────────────────────────────────────────
  const actionReady =
    kind === 'reboot' ||
    (kind === 'script' && script !== null) ||
    (kind === 'restart_service' && serviceName.trim().length > 0);

  const targetsReady = selectedIds.size > 0;

  const canAdvance = step === 'action' ? actionReady : step === 'targets' ? targetsReady : false;

  const toggleTarget = (deviceId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  const handleScriptSelect = useCallback(
    (selected: Script, _runAs: unknown, parameters?: Record<string, unknown>) => {
      // The picker's own run-as select is HIDDEN here (`showRunAsSelector={false}`
      // below), so its argument carries no operator intent and is ignored on
      // purpose — this modal owns the control instead, because only it can
      // offer "script default". The choice made there IS honoured: it is
      // persisted on the run (`fleet_remediation_runs.run_as`) and read back
      // by `services/fleetFindings/dispatch.ts` at dispatch (#4888).
      setScript(selected);
      // A fresh script means a fresh default to inherit.
      setScriptRunAs(null);
      setScriptParameters(parameters ?? {});
      setScriptPickerOpen(false);
    },
    []
  );

  const buildRequest = (): RemediateRequest => {
    // Send the explicit id list rather than relying on "absent = all members":
    // membership can change between the drawer load and the POST, and the
    // operator confirmed THIS list. Never `[]` — the API 400s on it, and
    // `targetsReady` gates confirm on a non-empty selection.
    const deviceIds = finding.members
      .map((m) => m.deviceId)
      .filter((id) => selectedIds.has(id));

    if (kind === 'script') {
      return {
        actionKind: 'script',
        scriptId: script!.id,
        // Only ever sent on the `script` branch — the `command` branch's
        // schema is `.strict()` and 400s on an unrecognised `runAs` field.
        // Omitted entirely when the operator left it on "Script default", so
        // the dispatcher keeps resolving `scripts.run_as` (including
        // 'elevated', which this control cannot express).
        ...(scriptRunAs ? { runAs: scriptRunAs } : {}),
        parameters: scriptParameters,
        deviceIds,
      };
    }
    if (kind === 'restart_service') {
      // The agent's RestartService handler reads `name` from the payload
      // (agent/internal/remote/tools/services.go) and the single-device route
      // sends the same key — a `serviceName` key would restart nothing.
      return {
        actionKind: 'command',
        commandType: 'restart_service',
        parameters: { name: serviceName.trim() },
        deviceIds,
      };
    }
    return { actionKind: 'command', commandType: 'reboot', parameters: {}, deviceIds };
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const response = await remediateFinding(finding.id, buildRequest());
      if (!mounted.current) return;
      if (response.skipped.length === 0) {
        onRunStarted(response.runId);
        return;
      }
      // Per-device skip reasons are the whole point of the API's `skipped`
      // list; hand off only after the operator has had a chance to read them.
      setResult(response);
      setStep('result');
    } catch (err) {
      const runId = runIdFromFailure(err);
      if (runId) {
        // 502: the run was committed and then marked failed because dispatch
        // could not be enqueued. Land on it — a toast alone would leave the
        // operator believing nothing happened.
        onRunStarted(runId);
        return;
      }
      handleActionError(err, t('longTail.fleet.FixPicker.errors.dispatchFailed'));
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  const selectedCount = selectedIds.size;

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={t('longTail.fleet.FixPicker.title')}
        maxWidth="2xl"
        className="flex max-h-[85vh] flex-col"
      >
        <div data-testid="fix-picker" className="flex min-h-0 flex-col">
          <div className="border-b px-6 py-4">
            <h2 className="text-lg font-semibold">{t('longTail.fleet.FixPicker.title')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{finding.title}</p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {step === 'action' && (
              <div
                className="space-y-3"
                role="radiogroup"
                aria-label={t('longTail.fleet.FixPicker.title')}
              >
                <FixOption
                  kind="script"
                  active={kind === 'script'}
                  icon={Terminal}
                  label={t('longTail.fleet.FixPicker.actions.script')}
                  hint={t('longTail.fleet.FixPicker.actions.scriptHint')}
                  onSelect={() => setKind('script')}
                />
                {kind === 'script' && (
                  <div className="ml-8 space-y-2">
                    <button
                      type="button"
                      data-testid="fix-picker-choose-script"
                      onClick={() => setScriptPickerOpen(true)}
                      className="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
                    >
                      {script
                        ? t('longTail.fleet.FixPicker.changeScript')
                        : t('longTail.fleet.FixPicker.chooseScript')}
                    </button>
                    {script && (
                      <>
                        <p data-testid="fix-picker-selected-script" className="text-sm">
                          {t('longTail.fleet.FixPicker.selectedScript', { name: script.name })}
                        </p>
                        {/* #4888 — the run context the operator is choosing,
                            honoured all the way to the agent payload. No
                            session-target control: session ids are per-device
                            and a fleet fix fans out to many. */}
                        <RunContextSelect
                          value={scriptRunAs}
                          onChange={setScriptRunAs}
                          allowScriptDefault
                          scriptDefault={script.runAs ?? null}
                          showLabel
                          id="fix-picker-run-context"
                          testId="fix-picker-run-as"
                        />
                      </>
                    )}
                  </div>
                )}

                <FixOption
                  kind="restart_service"
                  active={kind === 'restart_service'}
                  icon={RotateCcw}
                  label={t('longTail.fleet.FixPicker.actions.restartService')}
                  hint={t('longTail.fleet.FixPicker.actions.restartServiceHint')}
                  onSelect={() => setKind('restart_service')}
                />
                {kind === 'restart_service' && (
                  <div className="ml-8">
                    <label
                      htmlFor="fix-picker-service-name"
                      className="mb-1 block text-xs font-medium"
                    >
                      {t('longTail.fleet.FixPicker.serviceNameLabel')}
                    </label>
                    <input
                      id="fix-picker-service-name"
                      data-testid="fix-picker-service-name"
                      value={serviceName}
                      onChange={(e) => setServiceName(e.target.value)}
                      maxLength={200}
                      placeholder={t('longTail.fleet.FixPicker.serviceNamePlaceholder')}
                      className="h-9 w-full max-w-sm rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                )}

                <FixOption
                  kind="reboot"
                  active={kind === 'reboot'}
                  icon={Power}
                  label={t('longTail.fleet.FixPicker.actions.reboot')}
                  hint={t('longTail.fleet.FixPicker.actions.rebootHint')}
                  onSelect={() => setKind('reboot')}
                />
                {kind === 'reboot' && (
                  <div
                    data-testid="fix-picker-reboot-warning"
                    className="ml-8 flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-800 dark:text-yellow-400"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{t('longTail.fleet.FixPicker.rebootWarning')}</span>
                  </div>
                )}
              </div>
            )}

            {step === 'targets' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">
                    {t('longTail.fleet.FixPicker.targetsHeading')}
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="fix-picker-select-all"
                      onClick={() =>
                        setSelectedIds(
                          new Set(
                            finding.members
                              .filter((m) => !osIncompatibility.deviceIds.has(m.deviceId))
                              .map((m) => m.deviceId)
                          )
                        )
                      }
                      className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted"
                    >
                      {t('longTail.fleet.FixPicker.selectAll')}
                    </button>
                    <button
                      type="button"
                      data-testid="fix-picker-select-none"
                      onClick={() => setSelectedIds(new Set())}
                      className="rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted"
                    >
                      {t('longTail.fleet.FixPicker.selectNone')}
                    </button>
                  </div>
                </div>

                <p data-testid="fix-picker-target-count" className="text-xs text-muted-foreground">
                  {t('longTail.fleet.FixPicker.selectedCount', {
                    selected: formatNumber(selectedCount),
                    total: formatNumber(finding.members.length),
                  })}
                </p>

                {osIncompatibility.deviceIds.size > 0 && (
                  <p
                    data-testid="fix-picker-os-incompatible-notice"
                    className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-800 dark:text-yellow-400"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {t('longTail.fleet.FixPicker.osIncompatibleNotice', {
                        count: osIncompatibility.deviceIds.size,
                        os: osIncompatibility.requiredLabel,
                      })}
                    </span>
                  </p>
                )}

                <ul className="divide-y rounded-md border">
                  {finding.members.map((m) => {
                    const incompatible = osIncompatibility.deviceIds.has(m.deviceId);
                    return (
                      <li
                        key={m.deviceId}
                        className={cn('flex items-center gap-3 p-2 text-sm', incompatible && 'opacity-60')}
                      >
                        <input
                          type="checkbox"
                          id={`fix-picker-target-${m.deviceId}`}
                          data-testid={`fix-picker-target-${m.deviceId}`}
                          checked={selectedIds.has(m.deviceId) && !incompatible}
                          disabled={incompatible}
                          onChange={() => { if (!incompatible) toggleTarget(m.deviceId); }}
                          className="h-4 w-4 rounded border-border disabled:cursor-not-allowed"
                        />
                        <label htmlFor={`fix-picker-target-${m.deviceId}`} className="min-w-0 flex-1 truncate">
                          {m.displayName || m.hostname}
                        </label>
                        {incompatible && (
                          <span
                            data-testid={`fix-picker-target-incompatible-${m.deviceId}`}
                            className="shrink-0 text-xs text-muted-foreground"
                          >
                            {t('longTail.fleet.FixPicker.osIncompatibleReason', {
                              os: osIncompatibility.requiredLabel,
                            })}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {selectedCount === 0 && (
                  <p data-testid="fix-picker-no-targets" className="text-xs text-destructive">
                    {t('longTail.fleet.FixPicker.noTargets')}
                  </p>
                )}
              </div>
            )}

            {step === 'confirm' && (
              <div className="space-y-4 text-sm">
                <div>
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('longTail.fleet.FixPicker.confirmAction')}
                  </span>
                  <p data-testid="fix-picker-confirm-action">{describeAction(kind, script, serviceName, t)}</p>
                  {kind === 'script' && (
                    <div className="mt-1">
                      {/* The EFFECTIVE context, so the confirm step never
                          leaves the operator guessing what "Script default"
                          resolved to. */}
                      <RunContextChip
                        runAs={scriptRunAs ?? script?.runAs ?? null}
                        withLabel
                        testId="fix-picker-confirm-run-as"
                      />
                    </div>
                  )}
                </div>
                <div>
                  <span className="text-xs font-medium text-muted-foreground">
                    {t('longTail.fleet.FixPicker.confirmTargets')}
                  </span>
                  <p>
                    {t('longTail.fleet.FixPicker.selectedCount', {
                      selected: formatNumber(selectedCount),
                      total: formatNumber(finding.members.length),
                    })}
                  </p>
                </div>
                {kind === 'reboot' && (
                  <div
                    data-testid="fix-picker-confirm-reboot"
                    className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {t('longTail.fleet.FixPicker.confirmRebootNotice', { count: selectedCount })}
                    </span>
                  </div>
                )}
              </div>
            )}

            {step === 'result' && result && (
              <div className="space-y-4 text-sm">
                <p>
                  {t('longTail.fleet.FixPicker.dispatchedSummary', {
                    count: result.targetCount,
                  })}
                </p>
                <div data-testid="fix-picker-skipped">
                  <h3 className="mb-2 text-sm font-semibold">
                    {t('longTail.fleet.FixPicker.skippedHeading')}
                  </h3>
                  <ul className="divide-y rounded-md border">
                    {result.skipped.map((s) => {
                      const key = skipReasonLabelKey(s.reason);
                      return (
                        <li
                          key={s.deviceId}
                          data-testid={`fix-picker-skipped-${s.deviceId}`}
                          className="flex items-center justify-between gap-3 p-2 text-xs"
                        >
                          <span className="min-w-0 truncate">
                            {hostnameById.get(s.deviceId) ?? s.deviceId}
                          </span>
                          {/* Falls back to the raw token so a reason the API
                              adds later is visible, not blank. */}
                          <span
                            data-testid={`fix-picker-skipped-reason-${s.deviceId}`}
                            className="shrink-0 text-muted-foreground"
                          >
                            {key ? t(/* i18n-dynamic */ key) : s.reason}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t px-6 py-4">
            <button
              type="button"
              data-testid="fix-picker-cancel"
              onClick={onClose}
              className="rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted"
            >
              {step === 'result' ? t('actions.close') : t('actions.cancel')}
            </button>

            <div className="flex items-center gap-2">
              {(step === 'targets' || step === 'confirm') && (
                <button
                  type="button"
                  data-testid="fix-picker-back"
                  onClick={() => setStep(step === 'confirm' ? 'targets' : 'action')}
                  className="flex items-center gap-1 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted"
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t('actions.back')}
                </button>
              )}

              {(step === 'action' || step === 'targets') && (
                <button
                  type="button"
                  data-testid="fix-picker-next"
                  disabled={!canAdvance}
                  onClick={() => setStep(step === 'action' ? 'targets' : 'confirm')}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('actions.next')}
                </button>
              )}

              {step === 'confirm' && (
                <button
                  type="button"
                  data-testid="fix-picker-confirm"
                  disabled={submitting || selectedCount === 0}
                  onClick={submit}
                  className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('longTail.fleet.FixPicker.confirm')}
                </button>
              )}

              {step === 'result' && result && (
                <button
                  type="button"
                  data-testid="fix-picker-view-progress"
                  onClick={() => onRunStarted(result.runId)}
                  className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  {t('longTail.fleet.FixPicker.viewProgress')}
                </button>
              )}
            </div>
          </div>
        </div>
      </Dialog>

      {/* The device bulk run-script picker, reused verbatim: it already owns
          the library fetch, the OS/category filters and the parameter form.
          Deliberately opened WITHOUT `deviceId` — its RDS session-target
          dropdown only makes sense for a single on-demand device, and a
          fleet fix fans out to many devices with independent session ids,
          so `targetSessionId` is never produced here. */}
      {scriptPickerOpen && (
        <ScriptPickerModal
          isOpen
          onClose={() => setScriptPickerOpen(false)}
          onSelect={handleScriptSelect}
          // #4888 — this modal renders its own run-context control (with a
          // "Script default" option the picker's has no concept of), so the
          // picker's would be a second, contradictory answer to the same
          // question.
          showRunAsSelector={false}
        />
      )}
    </>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function FixOption({
  kind, active, icon: Icon, label, hint, onSelect,
}: {
  kind: FixKind;
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-testid={`fix-picker-action-${kind}`}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors hover:bg-muted/50',
        active && 'border-primary bg-primary/5'
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function describeAction(
  kind: FixKind | null,
  script: Script | null,
  serviceName: string,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  if (kind === 'script') return t('longTail.fleet.FixPicker.selectedScript', { name: script?.name ?? '' });
  if (kind === 'restart_service') {
    return t('longTail.fleet.FixPicker.confirmRestartService', { name: serviceName.trim() });
  }
  return t('longTail.fleet.FixPicker.actions.reboot');
}
