import { useState, useCallback } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import type { FeatureType, FeatureLink } from './types';

type SavePayload = {
  featureType: FeatureType;
  featurePolicyId?: string | null;
  inlineSettings?: Record<string, unknown> | null;
};

export function useFeatureLink(policyId: string) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const save = useCallback(
    async (existingLinkId: string | null, payload: SavePayload): Promise<FeatureLink | null> => {
      setSaving(true);
      setError(undefined);
      try {
        const url = existingLinkId
          ? `/configuration-policies/${policyId}/features/${existingLinkId}`
          : `/configuration-policies/${policyId}/features`;
        const method = existingLinkId ? 'PATCH' : 'POST';

        const body: Record<string, unknown> = { featureType: payload.featureType };
        if (existingLinkId) {
          // PATCH — include featurePolicyId if key exists in payload (even if null, for unlinking)
          if ('featurePolicyId' in payload) body.featurePolicyId = payload.featurePolicyId ?? null;
        } else {
          // POST — only include if truthy
          if (payload.featurePolicyId) body.featurePolicyId = payload.featurePolicyId;
        }
        if (payload.inlineSettings) body.inlineSettings = payload.inlineSettings;

        const response = await fetchWithAuth(url, {
          method,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `Failed to ${existingLinkId ? 'update' : 'create'} feature link`);
        }

        const result = await response.json();
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        return null;
      } finally {
        setSaving(false);
      }
    },
    [policyId]
  );

  const remove = useCallback(
    async (linkId: string): Promise<boolean> => {
      setSaving(true);
      setError(undefined);
      try {
        const response = await fetchWithAuth(
          `/configuration-policies/${policyId}/features/${linkId}`,
          { method: 'DELETE' }
        );
        if (!response.ok) throw new Error('Failed to remove feature link');
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        return false;
      } finally {
        setSaving(false);
      }
    },
    [policyId]
  );

  const clearError = useCallback(() => setError(undefined), []);

  return { save, remove, saving, error, clearError };
}
