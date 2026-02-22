import { useState, useEffect } from 'react';
import { Package } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import PolicyLinkSelector from './PolicyLinkSelector';

type PolicySummary = {
  name: string;
  mode: string;
  rules?: {
    software?: Array<{ name: string; vendor?: string }>;
  };
};

export default function SoftwarePolicyTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;

  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(
    effectiveLink?.featurePolicyId ?? null
  );
  const [linkedPolicySummary, setLinkedPolicySummary] = useState<PolicySummary | null>(null);

  const meta = FEATURE_META.software_policy;

  // Fetch linked policy summary for read-only display
  useEffect(() => {
    if (!selectedPolicyId || !meta.fetchUrl) {
      setLinkedPolicySummary(null);
      return;
    }
    let cancelled = false;

    import('../../../stores/auth').then(({ fetchWithAuth }) => {
      fetchWithAuth(`${meta.fetchUrl}/${selectedPolicyId}`).then(async (res) => {
        if (!res.ok || cancelled) return;
        const json = await res.json();
        const data = json.data ?? json;
        if (!cancelled) {
          setLinkedPolicySummary({
            name: data.name,
            mode: data.mode,
            rules: data.rules,
          });
        }
      }).catch((err) => {
        console.warn(`[SoftwarePolicyTab] Failed to load linked policy ${selectedPolicyId}:`, err);
      });
    });

    return () => { cancelled = true; };
  }, [selectedPolicyId, meta.fetchUrl]);

  const handleSave = async () => {
    if (!selectedPolicyId) return;
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'software_policy',
      featurePolicyId: selectedPolicyId,
    });
    if (result) onLinkChanged(result, 'software_policy');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) {
      onLinkChanged(null, 'software_policy');
      setSelectedPolicyId(null);
      setLinkedPolicySummary(null);
    }
  };

  const handleOverride = async () => {
    if (!parentLink?.featurePolicyId) return;
    clearError();
    const result = await save(null, {
      featureType: 'software_policy',
      featurePolicyId: parentLink.featurePolicyId,
    });
    if (result) {
      onLinkChanged(result, 'software_policy');
      setSelectedPolicyId(parentLink.featurePolicyId);
    }
  };

  const handleRevert = async () => {
    if (!existingLink || !parentLink) return;
    const ok = await remove(existingLink.id);
    if (ok) {
      onLinkChanged(null, 'software_policy');
      setSelectedPolicyId(parentLink.featurePolicyId ?? null);
    }
  };

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Package className="h-5 w-5" />}
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
          <label className="text-sm font-medium">Link Software Policy</label>
          <p className="mb-2 text-xs text-muted-foreground">
            Select an existing software policy (allowlist/blocklist) to associate with this configuration policy.
          </p>
          {meta.fetchUrl && (
            <PolicyLinkSelector
              fetchUrl={meta.fetchUrl}
              selectedId={selectedPolicyId}
              onSelect={setSelectedPolicyId}
            />
          )}
        </div>

        {/* Read-only summary of linked policy */}
        {linkedPolicySummary && (
          <div className="rounded-md border bg-muted/20 p-4">
            <h4 className="text-sm font-medium">{linkedPolicySummary.name}</h4>
            <p className="mt-1 text-xs text-muted-foreground capitalize">
              Mode: {linkedPolicySummary.mode}
            </p>
            {linkedPolicySummary.rules?.software && linkedPolicySummary.rules.software.length > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Rules ({linkedPolicySummary.rules.software.length}):
                </p>
                <ul className="mt-1 space-y-1">
                  {linkedPolicySummary.rules.software.slice(0, 5).map((rule, i) => (
                    <li key={i} className="text-xs text-muted-foreground">
                      {rule.name}
                      {rule.vendor ? ` (${rule.vendor})` : ''}
                    </li>
                  ))}
                  {linkedPolicySummary.rules.software.length > 5 && (
                    <li className="text-xs text-muted-foreground">
                      ...and {linkedPolicySummary.rules.software.length - 5} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </FeatureTabShell>
  );
}
