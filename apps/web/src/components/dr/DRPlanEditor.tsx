import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Layers3,
  Loader2,
  Plus,
  Save,
  X,
} from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { useScrollToError } from '../../lib/scrollToError';
import DRPlanGroupCard, {
  DEFAULT_REBUILD_OUTPUT_DIR,
  DEFAULT_REBUILD_WAIT_TIMEOUT_MINUTES,
  REBUILD_WAIT_TIMEOUT_MAX,
  REBUILD_OUTPUT_DIR_MAX_LENGTH,
  REBUILD_WAIT_TIMEOUT_MIN,
  isDRStepType,
  type DRGroupForm,
} from './DRPlanGroupCard';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

type DRPlanDetails = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  rpoTargetMinutes: number | null;
  rtoTargetMinutes: number | null;
  groups?: Array<{
    id: string;
    name: string;
    sequence: number;
    dependsOnGroupId: string | null;
    devices: string[];
    estimatedDurationMinutes: number | null;
    restoreConfig?: Record<string, unknown> | null;
  }>;
};

type LoadedGroup = NonNullable<DRPlanDetails['groups']>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Reads a persisted `restoreConfig` into the editable step fields. Unknown
 *  command types fall back to '' so the operator has to pick one on save. */
function stepFieldsFromRestoreConfig(
  restoreConfig: unknown
): Pick<DRGroupForm, 'stepType' | 'rebuildHostDeviceId' | 'outputDir' | 'waitTimeoutMinutes' | 'restorePayload'> {
  const config = isRecord(restoreConfig) ? restoreConfig : {};
  const stepType = isDRStepType(config.commandType) ? config.commandType : '';
  return {
    stepType,
    rebuildHostDeviceId:
      typeof config.rebuildHostDeviceId === 'string' && config.rebuildHostDeviceId ? config.rebuildHostDeviceId : null,
    outputDir: typeof config.outputDir === 'string' && config.outputDir ? config.outputDir : DEFAULT_REBUILD_OUTPUT_DIR,
    waitTimeoutMinutes:
      typeof config.waitTimeoutMinutes === 'number' && Number.isFinite(config.waitTimeoutMinutes)
        ? `${config.waitTimeoutMinutes}`
        : `${DEFAULT_REBUILD_WAIT_TIMEOUT_MINUTES}`,
    restorePayload: isRecord(config.payload) ? config.payload : undefined,
  };
}

/** Serialises the step fields into the `restoreConfig` the API validates
 *  (`drBareMetalRebuildConfigSchema` for the rebuild step; `{ commandType,
 *  payload? }` for device-command steps). Caller guarantees `stepType` is set. */
function restoreConfigFromGroup(group: DRGroupForm): Record<string, unknown> {
  if (group.stepType === 'BARE_METAL_REBUILD') {
    const waitTimeoutMinutes = Number(group.waitTimeoutMinutes);
    return {
      commandType: 'BARE_METAL_REBUILD',
      snapshotSelection: 'latest_restorable',
      ...(group.rebuildHostDeviceId ? { rebuildHostDeviceId: group.rebuildHostDeviceId } : {}),
      outputDir: group.outputDir.trim() || DEFAULT_REBUILD_OUTPUT_DIR,
      waitTimeoutMinutes: Number.isFinite(waitTimeoutMinutes) && group.waitTimeoutMinutes.trim()
        ? waitTimeoutMinutes
        : DEFAULT_REBUILD_WAIT_TIMEOUT_MINUTES,
    };
  }
  return {
    commandType: group.stepType,
    ...(group.restorePayload ? { payload: group.restorePayload } : {}),
  };
}

function loadedGroupToForm(group: LoadedGroup): DRGroupForm {
  return {
    localId: group.id,
    id: group.id,
    name: group.name,
    deviceIds: Array.isArray(group.devices) ? group.devices : [],
    estimatedDurationMinutes:
      typeof group.estimatedDurationMinutes === 'number' ? `${group.estimatedDurationMinutes}` : '',
    dependsOnGroupKey: group.dependsOnGroupId,
    ...stepFieldsFromRestoreConfig(group.restoreConfig),
  };
}

type DRPlanEditorProps = {
  open: boolean;
  planId: string | null;
  onClose: () => void;
  onSaved: () => void;
  /**
   * #6382: a save is a plan write followed by one write per group, so a group
   * that the server rejects leaves earlier writes committed. The editor stays
   * open on the error, but the caller's list is already stale — this asks it to
   * refetch. Optional so existing callers keep their shape.
   */
  onPartialSave?: () => void;
};

function createLocalId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `group-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createEmptyGroup(): DRGroupForm {
  return {
    localId: createLocalId(),
    name: '',
    deviceIds: [],
    estimatedDurationMinutes: '',
    dependsOnGroupKey: null,
    stepType: '',
    rebuildHostDeviceId: null,
    outputDir: DEFAULT_REBUILD_OUTPUT_DIR,
    waitTimeoutMinutes: `${DEFAULT_REBUILD_WAIT_TIMEOUT_MINUTES}`,
  };
}

export default function DRPlanEditor({
  open,
  planId,
  onClose,
  onSaved,
  onPartialSave,
}: DRPlanEditorProps) {
  const { t } = useTranslation('backup');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rpoTargetMinutes, setRpoTargetMinutes] = useState('60');
  const [rtoTargetMinutes, setRtoTargetMinutes] = useState('240');
  const [status, setStatus] = useState<'draft' | 'active' | 'archived'>('draft');
  const [groups, setGroups] = useState<DRGroupForm[]>([createEmptyGroup()]);
  const [groupReadiness, setGroupReadiness] = useState<Record<string, boolean>>({});
  const [originalGroups, setOriginalGroups] = useState<DRGroupForm[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const errorRef = useScrollToError<HTMLDivElement>(error);

  const isEdit = !!planId;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        setError(undefined);

        const planPromise = planId ? fetchWithAuth(`/dr/plans/${planId}`) : null;
        const planResponse = planPromise ? await planPromise : null;

        if (planResponse) {
          if (!planResponse.ok) throw new Error('Failed to load plan details');
          const planPayload = await planResponse.json();
          const plan = (planPayload?.data ?? planPayload) as DRPlanDetails;
          const nextGroups = Array.isArray(plan.groups)
            ? plan.groups.sort((a, b) => a.sequence - b.sequence).map(loadedGroupToForm)
            : [];

          if (!cancelled) {
            setName(plan.name ?? '');
            setDescription(plan.description ?? '');
            setStatus((plan.status as 'draft' | 'active' | 'archived') ?? 'draft');
            setRpoTargetMinutes(plan.rpoTargetMinutes ? `${plan.rpoTargetMinutes}` : '');
            setRtoTargetMinutes(plan.rtoTargetMinutes ? `${plan.rtoTargetMinutes}` : '');
            setGroups(nextGroups.length > 0 ? nextGroups : [createEmptyGroup()]);
            setOriginalGroups(nextGroups);
          }
        } else if (!cancelled) {
          setName('');
          setDescription('');
          setStatus('draft');
          setRpoTargetMinutes('60');
          setRtoTargetMinutes('240');
          setGroups([createEmptyGroup()]);
          setOriginalGroups([]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load plan editor');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, planId]);

  const selectedDeviceCount = useMemo(
    () => new Set(groups.flatMap((group) => group.deviceIds)).size,
    [groups]
  );

  const updateGroup = (localId: string, updater: (group: DRGroupForm) => DRGroupForm) => {
    setGroups((prev) => prev.map((group) => (group.localId === localId ? updater(group) : group)));
  };

  const moveGroup = (index: number, direction: -1 | 1) => {
    setGroups((prev) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(nextIndex, 0, moved);
      return next.map((group, currentIndex) => {
        const priorIds = new Set(next.slice(0, currentIndex).map((item) => item.localId));
        return priorIds.has(group.dependsOnGroupKey ?? '') ? group : { ...group, dependsOnGroupKey: null };
      });
    });
  };

  const handleSave = useCallback(async () => {
    setError(undefined);

    if (!name.trim()) {
      setError('Plan name is required.');
      return;
    }
    if (groups.length === 0) {
      setError('Add at least one recovery group.');
      return;
    }
    if (groups.some((group) => !group.name.trim())) {
      setError('Each recovery group needs a name.');
      return;
    }
    if (groups.some((group) => group.deviceIds.length === 0)) {
      setError('Each recovery group must include at least one device.');
      return;
    }
    if (groups.some((group) => !group.stepType)) {
      setError(t('dRPlanEditor.chooseAStepTypeForEachGroup'));
      return;
    }
    if (
      groups.some((group) => {
        if (group.stepType !== 'BARE_METAL_REBUILD') return false;
        const minutes = Number(group.waitTimeoutMinutes);
        return (
          !group.waitTimeoutMinutes.trim() ||
          !Number.isInteger(minutes) ||
          minutes < REBUILD_WAIT_TIMEOUT_MIN ||
          minutes > REBUILD_WAIT_TIMEOUT_MAX
        );
      })
    ) {
      setError(
        t('dRPlanEditor.rebuildWaitTimeoutOutOfRange', {
          min: REBUILD_WAIT_TIMEOUT_MIN,
          max: REBUILD_WAIT_TIMEOUT_MAX,
        })
      );
      return;
    }
    // #6382: the API rejects a non-absolute (or over-long) rebuild output dir
    // with a 400 — but only on the GROUP write, which runs after the plan write
    // has already been committed. Mirroring the server's rule here means the
    // save is refused before anything is written, instead of half-applied.
    // Keep in sync with `drBareMetalRebuildConfigSchema` in
    // apps/api/src/services/drBareMetalRebuildStep.ts.
    if (
      groups.some((group) => {
        if (group.stepType !== 'BARE_METAL_REBUILD') return false;
        const outputDir = group.outputDir.trim() || DEFAULT_REBUILD_OUTPUT_DIR;
        return !outputDir.startsWith('/') || outputDir.length > REBUILD_OUTPUT_DIR_MAX_LENGTH;
      })
    ) {
      setError(
        t('dRPlanEditor.rebuildOutputDirMustBeAbsolute', { max: REBUILD_OUTPUT_DIR_MAX_LENGTH })
      );
      return;
    }
    if (groups.some((group) => groupReadiness[group.localId] !== true)) {
      setError('Device choices are not ready. Retry or finish loading devices before saving.');
      return;
    }

    // #6382: a save spans N+1 requests and cannot be rolled back from here, so
    // track whether anything landed. On a mid-sequence failure the operator is
    // told the save was partial and the caller refetches — the old code left the
    // plan list showing a stale name beside a "save failed" message.
    let wroteSomething = false;
    try {
      setSaving(true);
      let activePlanId = planId;
      const planBody = {
        name: name.trim(),
        description: description.trim() || undefined,
        rpoTargetMinutes: rpoTargetMinutes ? Number(rpoTargetMinutes) : undefined,
        rtoTargetMinutes: rtoTargetMinutes ? Number(rtoTargetMinutes) : undefined,
        ...(isEdit ? { status } : {}),
      };

      if (activePlanId) {
        const response = await fetchWithAuth(`/dr/plans/${activePlanId}`, {
          method: 'PATCH',
          body: JSON.stringify(planBody),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? 'Failed to update plan');
        }
        wroteSomething = true;
      } else {
        const response = await fetchWithAuth('/dr/plans', {
          method: 'POST',
          body: JSON.stringify(planBody),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? 'Failed to create plan');
        }
        const payload = await response.json();
        activePlanId = payload?.data?.id ?? payload?.id;
        wroteSomething = true;
      }

      if (!activePlanId) throw new Error('Plan ID was not returned by the server');

      const persistedIds = new Map<string, string>();
      originalGroups.forEach((group) => {
        if (group.id) persistedIds.set(group.localId, group.id);
      });

      for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index]!;
        const dependencyId = group.dependsOnGroupKey
          ? persistedIds.get(group.dependsOnGroupKey) ?? null
          : null;
        const body = {
          name: group.name.trim(),
          sequence: index,
          dependsOnGroupId: dependencyId ?? undefined,
          devices: group.deviceIds,
          estimatedDurationMinutes: group.estimatedDurationMinutes
            ? Number(group.estimatedDurationMinutes)
            : undefined,
          restoreConfig: restoreConfigFromGroup(group),
        };

        if (group.id) {
          const response = await fetchWithAuth(`/dr/plans/${activePlanId}/groups/${group.id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error ?? `Failed to update group "${group.name}"`);
          }
          wroteSomething = true;
          persistedIds.set(group.localId, group.id);
        } else {
          const response = await fetchWithAuth(`/dr/plans/${activePlanId}/groups`, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error ?? `Failed to create group "${group.name}"`);
          }
          wroteSomething = true;
          const payload = await response.json();
          const createdId = payload?.data?.id ?? payload?.id;
          if (createdId) persistedIds.set(group.localId, createdId);
        }
      }

      const removedGroups = originalGroups.filter(
        (group) => group.id && !groups.some((current) => current.id === group.id)
      );
      // The removals run concurrently, so `Promise.all` would report only the
      // first rejection and drop the rest — the operator would fix one group
      // and be surprised by the next. Settle them all and report every failure.
      const removalResults = await Promise.allSettled(
        removedGroups.map(async (group) => {
          const response = await fetchWithAuth(`/dr/plans/${activePlanId}/groups/${group.id}`, {
            method: 'DELETE',
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error ?? `Failed to remove group "${group.name}"`);
          }
          wroteSomething = true;
        })
      );
      const removalFailures = removalResults.flatMap((result) =>
        result.status === 'rejected'
          ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
          : []
      );
      if (removalFailures.length > 0) throw new Error(removalFailures.join(' '));

      onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save plan';
      if (wroteSomething) {
        setError(t('dRPlanEditor.partialSaveFailure', { message }));
        onPartialSave?.();
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  }, [
    description,
    groups,
    groupReadiness,
    isEdit,
    name,
    onPartialSave,
    onSaved,
    originalGroups,
    planId,
    rpoTargetMinutes,
    rtoTargetMinutes,
    status,
    t,
  ]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Recovery Plan' : 'Create Recovery Plan'}
      maxWidth="5xl"
      alignTop
      className="max-h-[92vh] overflow-hidden"
    >
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {isEdit ? 'Edit Recovery Plan' : 'Create Recovery Plan'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('dRPlanEditor.defineRecoveryObjectivesSequenceGroupsAndAssignDevices')} </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-muted">
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      <div className="space-y-6 overflow-y-auto p-6">
        {error && (
          <div
            ref={errorRef}
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-12 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            <p className="mt-3 text-sm text-muted-foreground">{t('dRPlanEditor.loadingPlanEditor')}</p>
          </div>
        ) : (
          <>
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px_180px_140px]">
              <div className="space-y-4 rounded-lg border p-4">
                <div>
                  <label htmlFor="dr-plan-name" className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('dRPlanEditor.planName')} </label>
                  <input
                    id="dr-plan-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('dRPlanEditor.branchOfficeFailover')}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="dr-plan-description" className="mb-1 block text-xs font-medium text-muted-foreground">
                    {t('dRPlanEditor.description')} </label>
                  <textarea
                    id="dr-plan-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={4}
                    placeholder={t('dRPlanEditor.whatThisPlanCoversAndWhenItShould')}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="rounded-lg border bg-muted/20 p-4">
                <label htmlFor="dr-plan-rpo" className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('dRPlanEditor.rpoTarget')} </label>
                <input
                  id="dr-plan-rpo"
                  type="number"
                  min={1}
                  value={rpoTargetMinutes}
                  onChange={(event) => setRpoTargetMinutes(event.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
                <p className="mt-2 text-xs text-muted-foreground">{t('dRPlanEditor.minutesOfAllowableDataLoss')}</p>
              </div>

              <div className="rounded-lg border bg-muted/20 p-4">
                <label htmlFor="dr-plan-rto" className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t('dRPlanEditor.rtoTarget')} </label>
                <input
                  id="dr-plan-rto"
                  type="number"
                  min={1}
                  value={rtoTargetMinutes}
                  onChange={(event) => setRtoTargetMinutes(event.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
                <p className="mt-2 text-xs text-muted-foreground">{t('dRPlanEditor.minutesToRestoreService')}</p>
              </div>

              <div className="rounded-lg border bg-muted/20 p-4">
                <p className="text-xs font-medium text-muted-foreground">{t('dRPlanEditor.coverage')}</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{selectedDeviceCount}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('dRPlanEditor.uniqueDevicesInThePlan')}</p>
                {isEdit && (
                  <div className="mt-4">
                    <label htmlFor="dr-plan-status" className="mb-1 block text-xs font-medium text-muted-foreground">
                      {t('dRPlanEditor.status')} </label>
                    <select
                      id="dr-plan-status"
                      value={status}
                      onChange={(event) => setStatus(event.target.value as 'draft' | 'active' | 'archived')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="draft">{t('dRPlanEditor.draft')}</option>
                      <option value="active">{t('dRPlanEditor.active')}</option>
                      <option value="archived">{t('dRPlanEditor.archived')}</option>
                    </select>
                  </div>
                )}
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-foreground">{t('dRPlanEditor.recoveryGroups')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t('dRPlanEditor.orderGroupsFromEarliestRestoreStepToLatest')} </p>
                </div>
                <button
                  type="button"
                  onClick={() => setGroups((prev) => [...prev, createEmptyGroup()])}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
                >
                  <Plus className="h-4 w-4" />
                  {t('dRPlanEditor.addGroup')} </button>
              </div>

              <div className="space-y-4">
                {groups.map((group, index) => {
                  return (
                    <DRPlanGroupCard
                      key={group.localId}
                      group={group}
                      index={index}
                      total={groups.length}
                      dependencyOptions={groups.slice(0, index)}
                      onChange={(updater) => updateGroup(group.localId, updater)}
                      onMove={(direction) => moveGroup(index, direction)}
                      onRemove={() =>
                        setGroups((prev) =>
                          prev.length === 1
                            ? [createEmptyGroup()]
                            : prev.filter((item) => item.localId !== group.localId)
                        )
                      }
                      onCanSubmitChange={(canSubmit) =>
                        setGroupReadiness((current) =>
                          current[group.localId] === canSubmit
                            ? current
                            : { ...current, [group.localId]: canSubmit }
                        )
                      }
                    />
                  );
                })}
              </div>
            </section>
          </>
        )}
      </div>

      <div className="flex items-center justify-between border-t px-6 py-4">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Layers3 className="h-4 w-4 text-primary" />
          {t('dRPlanEditor.groupCount', { count: groups.length })} {t('dRPlanEditor.covering')} {t('dRPlanEditor.uniqueDeviceCount', { count: selectedDeviceCount })}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {t('dRPlanEditor.cancel')} </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={loading || saving || groups.some((group) => groupReadiness[group.localId] !== true)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('dRPlanEditor.savePlan')} </button>
        </div>
      </div>
    </Dialog>
  );
}
