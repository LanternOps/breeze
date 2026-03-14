import { useState, useEffect } from 'react';
import { Usb } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import PolicyLinkSelector from './PolicyLinkSelector';
import { fetchWithAuth } from '../../../stores/auth';

type PolicySummary = {
  name: string;
  deviceClass: string;
  action: string;
  targetType: string;
  isActive: boolean;
  exceptions?: Array<{ vendor?: string; product?: string; serialNumber?: string }>;
};

const deviceClassBadge: Record<string, string> = {
  storage: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  all_usb: 'bg-purple-500/20 text-purple-700 border-purple-500/40',
  bluetooth: 'bg-indigo-500/20 text-indigo-700 border-indigo-500/40',
  thunderbolt: 'bg-amber-500/20 text-amber-700 border-amber-500/40',
};

const actionBadge: Record<string, string> = {
  allow: 'bg-green-500/20 text-green-700 border-green-500/40',
  block: 'bg-red-500/20 text-red-700 border-red-500/40',
  read_only: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  alert: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
};

export default function PeripheralControlTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;

  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(
    effectiveLink?.featurePolicyId ?? null
  );
  const [linkedPolicySummary, setLinkedPolicySummary] = useState<PolicySummary | null>(null);

  const meta = FEATURE_META.peripheral_control;

  useEffect(() => {
    if (!selectedPolicyId || !meta.fetchUrl) {
      setLinkedPolicySummary(null);
      return;
    }
    let cancelled = false;

    fetchWithAuth(`${meta.fetchUrl}/${selectedPolicyId}`).then(async (res) => {
      if (!res.ok || cancelled) return;
      const json = await res.json();
      const data = json.data ?? json;
      if (!cancelled) {
        setLinkedPolicySummary({
          name: data.name,
          deviceClass: data.deviceClass,
          action: data.action,
          targetType: data.targetType,
          isActive: data.isActive,
          exceptions: data.exceptions,
        });
      }
    }).catch((err) => {
      if (!cancelled) {
        console.warn(`[PeripheralControlTab] Failed to load linked policy ${selectedPolicyId}:`, err);
      }
    });

    return () => { cancelled = true; };
  }, [selectedPolicyId, meta.fetchUrl]);

  const handleSave = async () => {
    if (!selectedPolicyId) return;
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'peripheral_control',
      featurePolicyId: selectedPolicyId,
    });
    if (result) onLinkChanged(result, 'peripheral_control');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) {
      onLinkChanged(null, 'peripheral_control');
      setSelectedPolicyId(null);
      setLinkedPolicySummary(null);
    }
  };

  const handleOverride = async () => {
    if (!parentLink?.featurePolicyId) return;
    clearError();
    const result = await save(null, {
      featureType: 'peripheral_control',
      featurePolicyId: parentLink.featurePolicyId,
    });
    if (result) {
      onLinkChanged(result, 'peripheral_control');
      setSelectedPolicyId(parentLink.featurePolicyId);
    }
  };

  const handleRevert = async () => {
    if (!existingLink || !parentLink) return;
    const ok = await remove(existingLink.id);
    if (ok) {
      onLinkChanged(null, 'peripheral_control');
      setSelectedPolicyId(parentLink.featurePolicyId ?? null);
    }
  };

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Usb className="h-5 w-5" />}
      isConfigured={!!effectiveLink}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={existingLink && parentLink ? handleRevert : undefined}
    >
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium">Link Peripheral Policy</label>
          <p className="mb-2 text-xs text-muted-foreground">
            Select an existing peripheral control policy to associate with this configuration policy.
          </p>
          {meta.fetchUrl && (
            <PolicyLinkSelector
              fetchUrl={meta.fetchUrl}
              selectedId={selectedPolicyId}
              onSelect={setSelectedPolicyId}
            />
          )}
        </div>

        {linkedPolicySummary && (
          <div className="rounded-md border bg-muted/20 p-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">{linkedPolicySummary.name}</h4>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${linkedPolicySummary.isActive ? 'bg-green-500/20 text-green-700 border-green-500/40' : 'bg-gray-500/20 text-gray-700 border-gray-500/40'}`}>
                {linkedPolicySummary.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${deviceClassBadge[linkedPolicySummary.deviceClass] ?? 'bg-muted text-muted-foreground'}`}>
                {linkedPolicySummary.deviceClass.replace('_', ' ')}
              </span>
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${actionBadge[linkedPolicySummary.action] ?? 'bg-muted text-muted-foreground'}`}>
                {linkedPolicySummary.action.replace('_', ' ')}
              </span>
              <span className="inline-flex items-center rounded-full border bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground capitalize">
                {linkedPolicySummary.targetType}
              </span>
            </div>
            {linkedPolicySummary.exceptions && linkedPolicySummary.exceptions.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {linkedPolicySummary.exceptions.length} exception{linkedPolicySummary.exceptions.length !== 1 ? 's' : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </FeatureTabShell>
  );
}
