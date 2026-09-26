import { runAction, ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { i18n } from '@/lib/i18n';
import { useState, useCallback } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';
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

        return await runAction<FeatureLink>({
          request: () => fetchWithAuth(url, { method, body: JSON.stringify(body) }),
          parseSuccess: (value) => (value as { data: FeatureLink }).data ?? value as FeatureLink,
          errorFallback: i18n.t('common:states.error'),
          successMessage: i18n.t('common:states.saved'),
          onUnauthorized: () => void navigateTo('/login', { replace: true }),
        });
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return null;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: i18n.t('common:states.error') });
        setError(err instanceof Error ? err.message : i18n.t('common:states.error'));
        return null;
      } finally {
        setSaving(false);
      }
    },
    [policyId]
  );

  /**
   * Remove / Revert to Parent confirm with a "Saved" toast by default (#5313 —
   * a 200 with no feedback was indistinguishable from a no-op). Tabs that toast
   * their own, more specific outcome (PatchTab) pass `successMessage: null`.
   */
  const remove = useCallback(
    async (linkId: string, opts: { successMessage?: string | null } = {}): Promise<boolean> => {
      setSaving(true);
      setError(undefined);
      try {
        await runAction({
          request: () => fetchWithAuth(`/configuration-policies/${policyId}/features/${linkId}`, { method: 'DELETE' }),
          ...(opts.successMessage === null
            ? {}
            : { successMessage: opts.successMessage ?? i18n.t('common:states.saved') }),
          errorFallback: i18n.t('common:states.error'),
          onUnauthorized: () => void navigateTo('/login', { replace: true }),
        });
        return true;
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return false;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: i18n.t('common:states.error') });
        setError(err instanceof Error ? err.message : i18n.t('common:states.error'));
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
