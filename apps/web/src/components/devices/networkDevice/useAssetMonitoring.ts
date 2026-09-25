// The Monitoring tab's data layer. Four reads in parallel, each allowed to fail
// on its own: a broken thresholds call must degrade ONE panel, not blank a tab
// whose main job is telling the operator what is and isn't being collected.
//
// The template NAME needs the fourth call because /monitoring/assets/:id
// returns templateId only (serializeSnmpDevice) — and a bare uuid where a
// template name belongs is the same failure as a raw sysObjectID in Model.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { asList } from '@/lib/asList';
import type { Collection } from './types';
import { useStableT } from '@/lib/i18n/useStableT';

export type SnmpDeviceSummary = {
  id: string;
  templateId: string | null;
  pollingInterval: number;
  port: number;
  snmpVersion: string;
  isActive: boolean;
  lastPolled: string | null;
  lastStatus: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
};

export type NetworkCheckSummary = {
  id: string;
  name: string;
  monitorType: string;
  target: string;
  isActive: boolean;
  lastStatus: string | null;
  lastChecked: string | null;
  lastResponseMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export type ThresholdSummary = {
  id: string;
  oid: string;
  operator: string | null;
  threshold: string | null;
  severity: string;
  message: string | null;
  isActive: boolean;
};

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function useAssetMonitoring(assetId: string) {
  const { t } = useTranslation('devices');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [collection, setCollection] = useState<Collection | null>(null);
  const [snmpDevice, setSnmpDevice] = useState<SnmpDeviceSummary | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [checks, setChecks] = useState<NetworkCheckSummary[]>([]);
  const [thresholds, setThresholds] = useState<ThresholdSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [checksError, setChecksError] = useState(false);
  const [thresholdsError, setThresholdsError] = useState(false);
  const [templateError, setTemplateError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setChecksError(false);
    setThresholdsError(false);
    setTemplateError(false);

    const [assetResult, monitorsResult, thresholdsResult, templatesResult] = await Promise.allSettled([
      fetchWithAuth(`/monitoring/assets/${assetId}`),
      fetchWithAuth(`/monitors?assetId=${encodeURIComponent(assetId)}`),
      fetchWithAuth(`/monitoring/assets/${assetId}/thresholds`),
      fetchWithAuth('/snmp/templates'),
    ]);

    // The asset call is the only one whose failure means the tab has nothing
    // to say — the other three each own a single panel.
    if (assetResult.status !== 'fulfilled' || !assetResult.value.ok) {
      setError(stableT('networkDeviceDetailPage.errors.monitoringLoad'));
      setCollection(null);
      setSnmpDevice(null);
      setTemplateName(null);
      setChecks([]);
      setThresholds([]);
      setLoading(false);
      return;
    }

    const assetBody = (await readJson(assetResult.value)) as {
      collection?: Collection | null;
      snmpDevice?: SnmpDeviceSummary | null;
    } | null;
    // A pre-W01 API has no `collection`; null means "we don't know", which the
    // cards render as such. Never substitute an empty Collection — that would
    // read as "a template with no OIDs".
    const nextCollection = assetBody?.collection ?? null;
    const nextDevice = assetBody?.snmpDevice ?? null;
    setCollection(nextCollection);
    setSnmpDevice(nextDevice);

    setChecksError(monitorsResult.status !== 'fulfilled' || !monitorsResult.value.ok);
    setThresholdsError(thresholdsResult.status !== 'fulfilled' || !thresholdsResult.value.ok);
    setTemplateError(templatesResult.status !== 'fulfilled' || !templatesResult.value.ok);

    if (monitorsResult.status === 'fulfilled' && monitorsResult.value.ok) {
      const body = await readJson(monitorsResult.value);
      setChecksError(body === null);
      setChecks(asList(body, 'monitors') as NetworkCheckSummary[]);
    } else {
      setChecks([]);
    }

    if (thresholdsResult.status === 'fulfilled' && thresholdsResult.value.ok) {
      const body = await readJson(thresholdsResult.value);
      setThresholdsError(body === null);
      setThresholds(asList(body, 'thresholds') as ThresholdSummary[]);
    } else {
      setThresholds([]);
    }

    const templateId = nextCollection?.templateId ?? nextDevice?.templateId ?? null;
    if (templatesResult.status === 'fulfilled' && templatesResult.value.ok) {
      const body = await readJson(templatesResult.value);
      setTemplateError(body === null);
      const templates = asList(body, 'templates') as Array<{ id: string; name: string }>;
      setTemplateName(templates.find((entry) => entry.id === templateId)?.name ?? null);
    } else {
      setTemplateName(null);
    }

    setLoading(false);
  }, [assetId, stableT]);

  useEffect(() => {
    void load();
  }, [load]);

  return { collection, snmpDevice, templateName, checks, thresholds, checksError, thresholdsError, templateError, loading, error, reload: load };
}
