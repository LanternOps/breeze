import { runAction, ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { i18n } from '@/lib/i18n';
import { useState, useCallback } from 'react';
import { usePolicyCreate } from './policyCreateContext';
import { YARA_MAX_RULE_SETS_PER_POLICY } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';
import type { FeatureType, FeatureLink } from './types';

type SavePayload = {
  featureType: FeatureType;
  featurePolicyId?: string | null;
  inlineSettings?: Record<string, unknown> | null;
};

/** Structured failure of the last save/remove, for tabs that render code-specific UI. */
export type FeatureLinkErrorDetail = { status: number; code?: string; body?: unknown };

export function useFeatureLink(policyId: string) {
  // On the create page there is no policy yet: the first Save asks the page to
  // create it (inactive), then saves the feature on the new id (W03d C1).
  const create = usePolicyCreate();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [errorDetail, setErrorDetail] = useState<FeatureLinkErrorDetail>();

  const save = useCallback(
    async (
      existingLinkId: string | null,
      payload: SavePayload,
      opts: { successMessage?: string | null } = {},
    ): Promise<FeatureLink | null> => {
      setSaving(true);
      setError(undefined);
      setErrorDetail(undefined);
      let targetId = policyId;
      let createdNow = false;
      if (!targetId) {
        // Never a request to `/configuration-policies//features`.
        const ensured = create ? await create.ensurePolicy() : null;
        if (!ensured || !ensured.ok) {
          if (ensured?.message) setError(ensured.message);
          else if (!ensured) setError(i18n.t('common:states.error'));
          setSaving(false);
          return null;
        }
        targetId = ensured.id;
        createdNow = ensured.created;
      }
      let ok = false;
      try {
        const url = existingLinkId
          ? `/configuration-policies/${targetId}/features/${existingLinkId}`
          : `/configuration-policies/${targetId}/features`;
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

        const link = await runAction<FeatureLink>({
          request: () => fetchWithAuth(url, { method, body: JSON.stringify(body) }),
          parseSuccess: (value) => (value as { data: FeatureLink }).data ?? value as FeatureLink,
          errorFallback: i18n.t('common:states.error'),
          friendly: (code) => {
            if (code === 'MONITOR_NOT_ATTACHABLE') {
              return i18n.t('policies:configurationPolicies.featureTabs.monitorsTab.notAttachable');
            }
            // Security link rule-set gate (#6263 W03 securityRuleSetGate.ts, #6267).
            if (code === 'TOO_MANY_RULE_SETS') {
              return i18n.t('policies:configurationPolicies.featureTabs.securityTab.ruleSets.errors.tooMany', { max: YARA_MAX_RULE_SETS_PER_POLICY });
            }
            if (code === 'INVALID_RULE_SET_IDS') {
              return i18n.t('policies:configurationPolicies.featureTabs.securityTab.ruleSets.errors.invalidIds');
            }
            if (code === 'YARA_RULE_SET_NOT_ATTACHABLE') {
              return i18n.t('policies:configurationPolicies.featureTabs.securityTab.ruleSets.errors.notAttachable');
            }
            return undefined;
          },
          ...(opts.successMessage === null
            ? {}
            : { successMessage: opts.successMessage ?? i18n.t('common:states.saved') }),
          onUnauthorized: () => void navigateTo('/login', { replace: true }),
        });
        ok = true;
        return link;
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return null;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: i18n.t('common:states.error') });
        setError(err instanceof Error ? err.message : i18n.t('common:states.error'));
        setErrorDetail(
          err instanceof ActionError ? { status: err.status, code: err.code, body: err.body } : undefined,
        );
        return null;
      } finally {
        setSaving(false);
        if (createdNow && create) create.reportFirstFeatureSave({ featureType: payload.featureType, ok });
      }
    },
    [policyId, create]
  );

  /**
   * Remove / Revert to Parent confirm with a "Saved" toast by default (#5313 —
   * a 200 with no feedback was indistinguishable from a no-op). Tabs that toast
   * their own, more specific outcome (PatchTab) pass `successMessage: null`.
   */
  const remove = useCallback(
    async (linkId: string, opts: { successMessage?: string | null } = {}): Promise<boolean> => {
      // A policy that does not exist yet has no link to remove.
      if (!policyId) return false;
      setSaving(true);
      setError(undefined);
      setErrorDetail(undefined);
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
        setErrorDetail(
          err instanceof ActionError ? { status: err.status, code: err.code, body: err.body } : undefined,
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [policyId]
  );

  const clearError = useCallback(() => {
    setError(undefined);
    setErrorDetail(undefined);
  }, []);

  return { save, remove, saving, error, errorDetail, clearError };
}
