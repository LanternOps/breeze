import { useEffect, useState } from 'react';
import { Container } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  WORKLOAD_INVENTORY_DEFAULTS,
  WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES,
  WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES,
  workloadInventoryInlineSettingsSchema,
  type WorkloadInventoryInlineSettings,
} from '@breeze/shared';
import { type FeatureTabProps } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import '@/lib/i18n';

type RuntimeToggle = 'dockerEnabled' | 'podmanEnabled' | 'hypervEnabled' | 'proxmoxEnabled';

/** Per-runtime toggles, in display order; the testid suffix is the runtime name. */
const RUNTIME_TOGGLES: { key: RuntimeToggle; runtime: 'docker' | 'podman' | 'hyperv' | 'proxmox' }[] = [
  { key: 'dockerEnabled', runtime: 'docker' },
  { key: 'podmanEnabled', runtime: 'podman' },
  { key: 'hypervEnabled', runtime: 'hyperv' },
  { key: 'proxmoxEnabled', runtime: 'proxmox' },
];

function readSettings(value: unknown): WorkloadInventoryInlineSettings {
  const parsed = workloadInventoryInlineSettingsSchema.safeParse(value ?? WORKLOAD_INVENTORY_DEFAULTS);
  return parsed.success ? parsed.data : { ...WORKLOAD_INVENTORY_DEFAULTS };
}

/**
 * Inline settings for the `workload_inventory` feature (spec §7.1, #8193).
 * Same save pattern as TimeSyncTab: one form, page-level Save through
 * useFeatureLink (which wraps runAction). Validation is the shared camelCase
 * schema — never a second hand-rolled one.
 */
export default function WorkloadInventoryTab({
  policyId,
  existingLink,
  parentLink,
  linkedPolicyId,
  onLinkChanged,
}: FeatureTabProps) {
  const { t } = useTranslation('devices');
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const initial = readSettings((existingLink ?? parentLink)?.inlineSettings);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [toggles, setToggles] = useState<Record<RuntimeToggle, boolean>>({
    dockerEnabled: initial.dockerEnabled,
    podmanEnabled: initial.podmanEnabled,
    hypervEnabled: initial.hypervEnabled,
    proxmoxEnabled: initial.proxmoxEnabled,
  });
  const [interval, setIntervalValue] = useState(String(initial.intervalMinutes));
  useEffect(() => {
    const next = readSettings((existingLink ?? parentLink)?.inlineSettings);
    setEnabled(next.enabled);
    setToggles({
      dockerEnabled: next.dockerEnabled,
      podmanEnabled: next.podmanEnabled,
      hypervEnabled: next.hypervEnabled,
      proxmoxEnabled: next.proxmoxEnabled,
    });
    setIntervalValue(String(next.intervalMinutes));
  }, [existingLink, parentLink]);

  const parsed = workloadInventoryInlineSettingsSchema.safeParse({
    enabled,
    ...toggles,
    intervalMinutes: interval.trim() === '' ? NaN : Number(interval),
  });
  const inherited = !!parentLink && !existingLink;

  const persist = async (id: string | null) => {
    if (!parsed.success) return;
    clearError();
    const result = await save(id, {
      featureType: 'workload_inventory',
      featurePolicyId: null,
      inlineSettings: { ...parsed.data },
    });
    if (result) onLinkChanged(result, 'workload_inventory');
  };
  const discard = async () => {
    if (existingLink && (await remove(existingLink.id))) onLinkChanged(null, 'workload_inventory');
  };

  return (
    <FeatureTabShell
      title={t('workloads.policy.title')}
      description={t('workloads.policy.description')}
      icon={<Container className="h-5 w-5" />}
      isConfigured={!!existingLink || inherited}
      saving={saving}
      saveDisabled={!parsed.success}
      error={error}
      onSave={() => void persist(existingLink?.id ?? null)}
      onRemove={existingLink && !linkedPolicyId ? discard : undefined}
      isInherited={inherited}
      onOverride={inherited ? () => void persist(null) : undefined}
      onRevert={!inherited && !!linkedPolicyId && !!existingLink ? discard : undefined}
    >
      <p className="mb-4 text-sm text-muted-foreground">{t('workloads.policy.offNote')}</p>
      <fieldset disabled={inherited || saving} className="space-y-4">
        <label className="flex items-center gap-2">
          <input
            data-testid="workload-inventory-enabled"
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          {t('workloads.policy.enabled')}
        </label>
        <div>
          <p className="text-sm font-medium">{t('workloads.policy.runtimesHeading')}</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {RUNTIME_TOGGLES.map(({ key, runtime }) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  data-testid={`workload-inventory-${runtime}`}
                  type="checkbox"
                  checked={toggles[key]}
                  onChange={(e) => setToggles((prev) => ({ ...prev, [key]: e.target.checked }))}
                />
                {t(/* i18n-dynamic */ `workloads.runtimes.${runtime}`)}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('workloads.policy.laterRelease')}</p>
        </div>
        <label className="block text-sm">
          {t('workloads.policy.interval')}
          <input
            data-testid="workload-inventory-interval"
            type="number"
            min={WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES}
            max={WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES}
            step={1}
            value={interval}
            onChange={(e) => setIntervalValue(e.target.value)}
            className="mt-2 block h-10 w-full rounded-md border bg-background px-3"
          />
        </label>
        {!parsed.success && (
          <p role="alert" className="text-sm text-destructive">
            {t('workloads.policy.invalidInterval', {
              min: WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES,
              max: WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES,
            })}
          </p>
        )}
      </fieldset>
    </FeatureTabShell>
  );
}
