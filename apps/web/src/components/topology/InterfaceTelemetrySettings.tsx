import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphResponse, TopologyTelemetryArm } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { handleActionError, runAction } from '../../lib/runAction';
import {
  parseTelemetryArm, telemetrySamplesPerDay, topologyOperationsApi, topologySitePath, type TopologyCredentialProfile,
} from './topologyOperationsApi';
import { useTopologyArmStepUp } from './TopologyArmStepUp';
import { formatTime } from './topologyOperationsFormat';

const INTERVALS = [30, 60, 120, 300] as const;
const TTLS = [7, 30, 90] as const;
const humanize = (reason: string) => reason.replaceAll('_', ' ');

/** Canonical ports of one node that the loaded graph knows about, labelled by what they connect to. */
export function canonicalPorts(graph: GraphResponse, nodeId: string): Array<{ interfaceId: string; peer: string }> {
  const ports = new Map<string, string>();
  for (const relationship of graph.relationships) {
    const [own, peerId] = relationship.sourceNodeId === nodeId ? [relationship.sourceInterfaceId, relationship.targetNodeId]
      : relationship.targetNodeId === nodeId ? [relationship.targetInterfaceId, relationship.sourceNodeId] : [null, null];
    if (own && !ports.has(own)) ports.set(own, graph.nodes.find((node) => node.id === peerId)?.label ?? peerId ?? '');
  }
  // Parallel cables to one peer are distinct ports: number them so each checkbox is distinguishable.
  const seen = new Map<string, number>();
  return [...ports].map(([interfaceId, peer]) => {
    const n = (seen.get(peer) ?? 0) + 1; seen.set(peer, n);
    return { interfaceId, peer: n > 1 ? `${peer} · ${n}` : peer };
  });
}

/**
 * Per-device port measurement (M3-D2/D3): a standing, site-scoped SNMP poll of
 * explicitly selected canonical ports. Nothing polls until a human previews
 * and turns it on through `POST …/telemetry-arms` behind a `topology_arm`
 * step-up; turning it off only reduces authority and needs no step-up. The
 * server re-resolves every identifier and states why an arm is blocked.
 */
export default function InterfaceTelemetrySettings({ siteId, nodeId, graph, canConfigure }: {
  siteId: string; nodeId: string; graph: GraphResponse; canConfigure: boolean;
}) {
  const { t } = useTranslation('topology');
  const ports = useMemo(() => canonicalPorts(graph, nodeId), [graph.relationships, nodeId]);
  const [arms, setArms] = useState<TopologyTelemetryArm[] | null>(null);
  const [collectors, setCollectors] = useState<Array<{ deviceId: string; label: string }> | null>(null);
  const [profiles, setProfiles] = useState<TopologyCredentialProfile[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [collector, setCollector] = useState(''), [profile, setProfile] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(60), [ttlDays, setTtlDays] = useState(30);
  const [previewed, setPreviewed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [reload, setReload] = useState(0);
  const { arm, prompt } = useTopologyArmStepUp();
  useEffect(() => {
    const abort = new AbortController();
    void topologyOperationsApi.monitoring(siteId, abort.signal).then((status) => { if (!abort.signal.aborted) setArms(status.telemetryArms.filter((item) => item.targetNodeId === nodeId)); })
      .catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : t('operations.loadFailed')); });
    return () => abort.abort();
  }, [siteId, nodeId, reload]);
  useEffect(() => {
    if (!canConfigure) return;
    const abort = new AbortController();
    void topologyOperationsApi.siteAgents(siteId, abort.signal).then((list) => { if (!abort.signal.aborted) setCollectors(list); })
      .catch(() => { if (!abort.signal.aborted) setCollectors([]); });
    void topologyOperationsApi.credentialProfiles(siteId, abort.signal).then((list) => { if (!abort.signal.aborted) setProfiles(list); })
      .catch(() => { if (!abort.signal.aborted) setProfiles([]); });
    return () => abort.abort();
  }, [siteId, nodeId, canConfigure]);
  useEffect(() => { setPreviewed(false); }, [selected, collector, profile, intervalSeconds, ttlDays]);
  const ready = selected.length > 0 && !!collector && !!profile;
  const enable = () => arm({
    resource: { siteId, action: 'arm_telemetry', subjectId: nodeId }, fallback: t('operations.telemetry.enableFailed'),
    submit: async (grantId) => {
      setBusy(true);
      try {
        await runAction({
          request: () => fetchWithAuth(`${topologySitePath(siteId)}/telemetry-arms`, { method: 'POST', body: JSON.stringify({
            targetNodeId: nodeId, collectorDeviceId: collector, credentialProfileId: profile, interfaceIds: selected, intervalSeconds, ttlDays,
            ...(grantId ? { stepUpGrantId: grantId } : {}) }) }),
          errorFallback: t('operations.telemetry.enableFailed'), parseSuccess: parseTelemetryArm,
          successMessage: (result) => result.state === 'armed' ? t('operations.telemetry.enabled') : t('operations.telemetry.blocked', { reason: humanize(result.blockedReason ?? result.state) }),
          friendly: (code) => code === 'step_up_required' ? t('operations.stepUp.intro') : undefined,
        });
        setPreviewed(false); setSelected([]); setReload((n) => n + 1);
      } finally { setBusy(false); }
    },
  });
  const revoke = async (item: TopologyTelemetryArm) => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`${topologySitePath(siteId)}/telemetry-arms/${encodeURIComponent(item.id)}`, { method: 'DELETE' }),
        errorFallback: t('operations.telemetry.revokeFailed'), successMessage: t('operations.telemetry.revoked'), parseSuccess: parseTelemetryArm,
      });
      setReload((n) => n + 1);
    } catch (cause) { handleActionError(cause, t('operations.telemetry.revokeFailed')); }
    finally { setBusy(false); }
  };
  const collectorLabel = collectors?.find((item) => item.deviceId === collector)?.label ?? collector;
  const profileLabel = profiles?.find((item) => item.id === profile)?.name ?? profile;
  return <section data-testid="topology-telemetry" aria-labelledby="topology-telemetry-heading" className="space-y-3 border-t pt-3 text-sm">
    <h4 id="topology-telemetry-heading" className="font-medium">{t('operations.telemetry.heading')}</h4>
    <p className="text-muted-foreground">{t('operations.telemetry.intro')}</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {arms?.map((item) => <div key={item.id} data-testid={`topology-telemetry-arm-${item.id}`} className="space-y-1 rounded border p-2">
      <p className="font-medium">{t(/* i18n-dynamic */ `operations.telemetry.armState.${item.state}`)}{item.blockedReason ? ` · ${humanize(item.blockedReason)}` : ''}</p>
      <p className="text-muted-foreground">{t('operations.telemetry.armSummary', { count: item.interfaceCount, interval: item.intervalSeconds, expires: formatTime(item.expiresAt) })}</p>
      {canConfigure && item.state === 'armed' && <button data-testid="topology-telemetry-revoke" className="rounded border px-2 py-1 disabled:opacity-50" disabled={busy} onClick={() => void revoke(item)}>{t('operations.telemetry.revoke')}</button>}
    </div>)}
    {!ports.length && <p data-testid="topology-telemetry-no-ports" className="text-muted-foreground">{t('operations.telemetry.noPorts')}</p>}
    {canConfigure && ports.length > 0 && <>
      <fieldset className="space-y-1"><legend className="font-medium">{t('operations.telemetry.ports')}</legend>
        {ports.map((port) => <label key={port.interfaceId} className="flex items-center gap-2 break-words">
          <input type="checkbox" data-testid={`topology-telemetry-port-${port.interfaceId}`} checked={selected.includes(port.interfaceId)}
            onChange={(event) => setSelected((current) => event.target.checked ? [...current, port.interfaceId] : current.filter((id) => id !== port.interfaceId))} />
          {t('operations.telemetry.portTo', { peer: port.peer })}</label>)}
      </fieldset>
      <label className="block">{t('operations.telemetry.collector')}<select data-testid="topology-telemetry-collector" className="mt-1 block w-full rounded border bg-background p-2" value={collector} onChange={(event) => setCollector(event.target.value)}>
        <option value="">{t('operations.telemetry.chooseCollector')}</option>{collectors?.map((item) => <option key={item.deviceId} value={item.deviceId}>{item.label}</option>)}</select></label>
      {collectors?.length === 0 && <p className="text-muted-foreground">{t('operations.telemetry.noCollector')}</p>}
      <label className="block">{t('operations.telemetry.credential')}<select data-testid="topology-telemetry-credential" className="mt-1 block w-full rounded border bg-background p-2" value={profile} onChange={(event) => setProfile(event.target.value)}>
        <option value="">{t('operations.telemetry.chooseCredential')}</option>{profiles?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {profiles?.length === 0 && <p className="text-muted-foreground">{t('operations.telemetry.noCredential')}</p>}
      <div className="flex flex-wrap gap-3">
        <label>{t('operations.telemetry.interval')}<select data-testid="topology-telemetry-interval" className="ml-1 rounded border bg-background p-1" value={intervalSeconds} onChange={(event) => setIntervalSeconds(Number(event.target.value))}>
          {INTERVALS.map((value) => <option key={value} value={value}>{value} s</option>)}</select></label>
        <label>{t('operations.telemetry.ttl')}<select data-testid="topology-telemetry-ttl" className="ml-1 rounded border bg-background p-1" value={ttlDays} onChange={(event) => setTtlDays(Number(event.target.value))}>
          {TTLS.map((value) => <option key={value} value={value}>{t('operations.telemetry.days', { count: value })}</option>)}</select></label>
      </div>
      <button data-testid="topology-telemetry-preview" className="rounded border px-3 py-1 disabled:opacity-50" disabled={!ready} onClick={() => setPreviewed(true)}>{t('operations.telemetry.preview')}</button>
      {previewed && ready && <div data-testid="topology-telemetry-preview-panel" className="space-y-1 rounded bg-muted/40 p-2">
        <p data-testid="topology-telemetry-volume">{t('operations.telemetry.volume', { samples: telemetrySamplesPerDay(selected.length, intervalSeconds) })}</p>
        <p>{t('operations.telemetry.mapping', { count: selected.length, collector: collectorLabel, profile: profileLabel })}</p>
        <button data-testid="topology-telemetry-enable" className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" disabled={busy} onClick={() => void enable()}>{t('operations.telemetry.enable')}</button>
      </div>}
      {prompt}
    </>}
  </section>;
}
