// THE single writer for a discovered network asset.
//
// Before W04 the same asset was mutated from four places with four different
// idioms (Discovery's AssetDetailModal, Discovery's EnableMonitoringForm,
// the monitoring dashboard's EditMonitoringModal, and the device page), so a
// fix to one never reached the others and two of them failed silently. Every
// asset-scoped write now lives here, wrapped in runAction so success and
// failure are always shown, and `lib/__tests__/network-asset-single-writer.test.ts`
// fails the build if a second caller appears.
//
// This is a hook rather than a plain module for two reasons: the cross-wave
// name is fixed, and `useTranslation('devices')` in this scope is what lets
// the i18n key-usage guard bind the namespace for the literal keys below.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { fetchWithAuth } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import type { DiscoveredAssetType } from '@/components/discovery/DiscoveredAssetList';

export type SnmpVersion = 'v1' | 'v2c' | 'v3';
export type SnmpAuthProtocol = 'md5' | 'sha' | 'sha256';
export type SnmpPrivProtocol = 'des' | 'aes' | 'aes256';

export type IdentityPatch = {
  label?: string | null;
  notes?: string | null;
  tags?: string[];
  assetType?: DiscoveredAssetType;
  /** Mutually exclusive with `assetType` (routes/discovery.ts updateAssetSchema refine). */
  resetTypeToAuto?: true;
};

export type SnmpUpsertInput = {
  snmpVersion: SnmpVersion;
  community?: string;
  username?: string;
  authProtocol?: SnmpAuthProtocol;
  authPassword?: string;
  privProtocol?: SnmpPrivProtocol;
  privPassword?: string;
  templateId?: string | null;
  pollingInterval?: number;
  port?: number;
};

export type SnmpPatchInput = Partial<SnmpUpsertInput> & { isActive?: boolean };

export type NetworkCheckInput = {
  name: string;
  monitorType: 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check';
  target: string;
  config?: Record<string, unknown>;
  pollingInterval?: number;
  timeout?: number;
};

export type TemplateSuggestion = { templateId: string; templateName: string; reason: string };

export type SnmpSaveResult = {
  snmpDevice?: { id: string; templateId: string | null } | null;
  /** W03 only. A pre-W03 API omits it; the Monitoring section feature-detects. */
  templateSuggestion?: TemplateSuggestion | null;
};

/** What `PATCH /discovery/assets/:id { siteId }` reports about the move. */
export type SiteMoveSummary = {
  unlinkedDevice: boolean;
  monitorsReattached: number;
  topologyPoliciesDisabled: number;
};

export type ChangeSiteResult = {
  siteMove: SiteMoveSummary | null;
  /** The success toast text, for the caller's live-region announcement. */
  summary: string;
};

export type NetworkAssetMutations = {
  patchIdentity(assetId: string, patch: IdentityPatch): Promise<void>;
  /** `siteName` is only used for the toast copy. */
  changeSite(assetId: string, siteId: string, siteName: string): Promise<ChangeSiteResult>;
  approve(assetId: string): Promise<void>;
  dismiss(assetId: string): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
  link(assetId: string, deviceId: string): Promise<void>;
  unlink(assetId: string): Promise<void>;
  putSnmp(assetId: string, input: SnmpUpsertInput): Promise<SnmpSaveResult>;
  patchSnmp(assetId: string, patch: SnmpPatchInput): Promise<SnmpSaveResult>;
  disableMonitoring(assetId: string): Promise<void>;
  createCheck(assetId: string, input: NetworkCheckInput): Promise<void>;
  deleteCheck(monitorId: string): Promise<void>;
};

export function useNetworkAssetMutations(): NetworkAssetMutations {
  const { t } = useTranslation('devices');

  return useMemo<NetworkAssetMutations>(() => {
    const toVoid = (promise: Promise<unknown>) => promise.then(() => undefined);

    return {
      patchIdentity: (assetId, patch) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
          }),
          successMessage: patch.resetTypeToAuto
            ? t('networkDeviceDetailPage.toasts.typeReset')
            : t('networkDeviceDetailPage.settings.toasts.identitySaved'),
          errorFallback: patch.resetTypeToAuto
            ? t('networkDeviceDetailPage.toasts.typeResetFailed')
            : t('networkDeviceDetailPage.settings.toasts.identitySaveFailed'),
        })),

      changeSite: async (assetId, siteId, siteName) => {
        // The server undoes two things a site move cannot keep — a link to a
        // device in another site, and topology policies that derived their
        // authority from the asset — so the toast says so rather than just
        // "Moved".
        const describe = (data: { siteMove?: SiteMoveSummary | null }) => {
          const parts = [t('networkDeviceDetailPage.settings.toasts.siteChanged', { site: siteName })];
          if (data.siteMove?.unlinkedDevice) {
            parts.push(t('networkDeviceDetailPage.settings.toasts.siteChangedUnlinked'));
          }
          if (data.siteMove && data.siteMove.topologyPoliciesDisabled > 0) {
            parts.push(t('networkDeviceDetailPage.settings.toasts.siteChangedPolicies', {
              count: data.siteMove.topologyPoliciesDisabled,
            }));
          }
          return parts.join(' ');
        };
        const data = await runAction<{ siteMove?: SiteMoveSummary | null }>({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}`, {
            method: 'PATCH',
            body: JSON.stringify({ siteId }),
          }),
          successMessage: describe,
          errorFallback: t('networkDeviceDetailPage.settings.toasts.siteChangeFailed'),
        });
        return { siteMove: data.siteMove ?? null, summary: describe(data) };
      },

      approve: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}/approve`, { method: 'PATCH' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.approved'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.approveFailed'),
        })),

      dismiss: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}/dismiss`, { method: 'PATCH' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.dismissed'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.dismissFailed'),
        })),

      deleteAsset: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}`, { method: 'DELETE' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.assetDeleted'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.assetDeleteFailed'),
        })),

      link: (assetId, deviceId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}/link`, {
            method: 'POST',
            body: JSON.stringify({ deviceId }),
          }),
          successMessage: t('networkDeviceDetailPage.toasts.linked'),
          errorFallback: t('networkDeviceDetailPage.toasts.linkFailed'),
        })),

      unlink: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}/link`, { method: 'DELETE' }),
          successMessage: t('networkDeviceDetailPage.toasts.unlinked'),
          errorFallback: t('networkDeviceDetailPage.toasts.unlinkFailed'),
        })),

      putSnmp: (assetId, input) =>
        runAction<SnmpSaveResult>({
          request: () => fetchWithAuth(`/monitoring/assets/${assetId}/snmp`, {
            method: 'PUT',
            body: JSON.stringify(input),
          }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.snmpSaved'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.snmpSaveFailed'),
        }),

      patchSnmp: (assetId, patch) =>
        runAction<SnmpSaveResult>({
          request: () => fetchWithAuth(`/monitoring/assets/${assetId}/snmp`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
          }),
          successMessage: patch.isActive === false
            ? t('networkDeviceDetailPage.settings.toasts.pollingPaused')
            : patch.isActive === true
              ? t('networkDeviceDetailPage.settings.toasts.pollingResumed')
              : t('networkDeviceDetailPage.settings.toasts.snmpSaved'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.snmpSaveFailed'),
        }),

      disableMonitoring: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/monitoring/assets/${assetId}`, { method: 'DELETE' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.monitoringDisabled'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.monitoringDisableFailed'),
        })),

      createCheck: (assetId, input) =>
        toVoid(runAction({
          request: () => fetchWithAuth('/monitors', {
            method: 'POST',
            body: JSON.stringify({ ...input, assetId }),
          }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.checkCreated'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.checkCreateFailed'),
        })),

      deleteCheck: (monitorId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/monitors/${monitorId}`, { method: 'DELETE' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.checkRemoved'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.checkRemoveFailed'),
        })),
    };
  }, [t]);
}
