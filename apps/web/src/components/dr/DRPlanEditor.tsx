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
import DRPlanGroupCard, { type DRGroupForm, type DRPlanDevice as Device } from './DRPlanGroupCard';

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
  }>;
};

type DRPlanEditorProps = {
  open: boolean;
  planId: string | null;
  onClose: () => void;
  onSaved: () => void;
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
  };
}

export default function DRPlanEditor({
  open,
  planId,
  onClose,
  onSaved,
}: DRPlanEditorProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rpoTargetMinutes, setRpoTargetMinutes] = useState('60');
  const [rtoTargetMinutes, setRtoTargetMinutes] = useState('240');
  const [status, setStatus] = useState<'draft' | 'active' | 'archived'>('draft');
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<DRGroupForm[]>([createEmptyGroup()]);
  const [originalGroups, setOriginalGroups] = useState<DRGroupForm[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const isEdit = !!planId;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const load = async () => {
      try {
        setLoading(true);
        setError(undefined);

        const devicesPromise = fetchWithAuth('/devices?limit=500');
        const planPromise = planId ? fetchWithAuth(`/dr/plans/${planId}`) : null;
        const [devicesResponse, planResponse] = await Promise.all([devicesPromise, planPromise]);

        if (!devicesResponse.ok) throw new Error('Failed to load devices');
        const devicesPayload = await devicesResponse.json();
        const nextDevices = devicesPayload?.data ?? devicesPayload?.devices ?? devicesPayload ?? [];
        if (!cancelled) {
          setDevices(Array.isArray(nextDevices) ? nextDevices : []);
        }

        if (planResponse) {
          if (!planResponse.ok) throw new Error('Failed to load plan details');
          const planPayload = await planResponse.json();
          const plan = (planPayload?.data ?? planPayload) as DRPlanDetails;
          const nextGroups = Array.isArray(plan.groups)
            ? plan.groups
                .sort((a, b) => a.sequence - b.sequence)
                .map((group) => ({
                  localId: group.id,
                  id: group.id,
                  name: group.name,
                  deviceIds: Array.isArray(group.devices) ? group.devices : [],
                  estimatedDurationMinutes:
                    typeof group.estimatedDurationMinutes === 'number'
                      ? `${group.estimatedDurationMinutes}`
                      : '',
                  dependsOnGroupKey: group.dependsOnGroupId,
                }))
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
          const payload = await response.json();
          const createdId = payload?.data?.id ?? payload?.id;
          if (createdId) persistedIds.set(group.localId, createdId);
        }
      }

      const removedGroups = originalGroups.filter(
        (group) => group.id && !groups.some((current) => current.id === group.id)
      );
      await Promise.all(
        removedGroups.map(async (group) => {
          const response = await fetchWithAuth(`/dr/plans/${activePlanId}/groups/${group.id}`, {
            method: 'DELETE',
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => null);
            throw new Error(payload?.error ?? `Failed to remove group "${group.name}"`);
          }
        })
      );

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save plan');
    } finally {
      setSaving(false);
    }
  }, [
    description,
    groups,
    isEdit,
    name,
    onSaved,
    originalGroups,
    planId,
    rpoTargetMinutes,
    rtoTargetMinutes,
    status,
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
            Define recovery objectives, sequence groups, and assign devices in restore order.
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-muted">
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      <div className="space-y-6 overflow-y-auto p-6">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="py-12 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            <p className="mt-3 text-sm text-muted-foreground">Loading plan editor...</p>
          </div>
        ) : (
          <>
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px_180px_140px]">
              <div className="space-y-4 rounded-lg border p-4">
                <div>
                  <label htmlFor="dr-plan-name" className="mb-1 block text-xs font-medium text-muted-foreground">
                    Plan name
                  </label>
                  <input
                    id="dr-plan-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Branch office failover"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="dr-plan-description" className="mb-1 block text-xs font-medium text-muted-foreground">
                    Description
                  </label>
                  <textarea
                    id="dr-plan-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={4}
                    placeholder="What this plan covers and when it should be used."
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="rounded-lg border bg-muted/20 p-4">
                <label htmlFor="dr-plan-rpo" className="mb-1 block text-xs font-medium text-muted-foreground">
                  RPO target
                </label>
                <input
                  id="dr-plan-rpo"
                  type="number"
                  min={1}
                  value={rpoTargetMinutes}
                  onChange={(event) => setRpoTargetMinutes(event.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
                <p className="mt-2 text-xs text-muted-foreground">Minutes of allowable data loss.</p>
              </div>

              <div className="rounded-lg border bg-muted/20 p-4">
                <label htmlFor="dr-plan-rto" className="mb-1 block text-xs font-medium text-muted-foreground">
                  RTO target
                </label>
                <input
                  id="dr-plan-rto"
                  type="number"
                  min={1}
                  value={rtoTargetMinutes}
                  onChange={(event) => setRtoTargetMinutes(event.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
                <p className="mt-2 text-xs text-muted-foreground">Minutes to restore service.</p>
              </div>

              <div className="rounded-lg border bg-muted/20 p-4">
                <p className="text-xs font-medium text-muted-foreground">Coverage</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{selectedDeviceCount}</p>
                <p className="mt-1 text-xs text-muted-foreground">Unique devices in the plan</p>
                {isEdit && (
                  <div className="mt-4">
                    <label htmlFor="dr-plan-status" className="mb-1 block text-xs font-medium text-muted-foreground">
                      Status
                    </label>
                    <select
                      id="dr-plan-status"
                      value={status}
                      onChange={(event) => setStatus(event.target.value as 'draft' | 'active' | 'archived')}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="draft">Draft</option>
                      <option value="active">Active</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>
                )}
              </div>
            </section>

            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-foreground">Recovery groups</h3>
                  <p className="text-sm text-muted-foreground">
                    Order groups from earliest restore step to latest dependency.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setGroups((prev) => [...prev, createEmptyGroup()])}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
                >
                  <Plus className="h-4 w-4" />
                  Add group
                </button>
              </div>

              <div className="space-y-4">
                {groups.map((group, index) => {
                  return (
                    <DRPlanGroupCard
                      key={group.localId}
                      group={group}
                      index={index}
                      total={groups.length}
                      devices={devices}
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
          {groups.length} group{groups.length !== 1 ? 's' : ''} covering {selectedDeviceCount} unique device
          {selectedDeviceCount !== 1 ? 's' : ''}
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={loading || saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save plan
          </button>
        </div>
      </div>
    </Dialog>
  );
}
