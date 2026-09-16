import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { topologySiteSettingsSchema, topologyConfigurationSchema } from '@breeze/shared/validators/topologyConfiguration';
import type { TopologySiteSettings, TopologyTemplateVersionList, TopologyConfigurationPayload as Configuration } from '@breeze/shared';
import { ActionError, handleActionError, runAction } from '../../lib/runAction';
import { topologyConfigurationApi } from './topologyConfigurationApi';
import { useOrgStore } from '../../stores/orgStore';
import TopologyTemplateApply from './TopologyTemplateApply';
export default function TopologyConfiguration({ siteId }: { siteId: string }) {
  const { t } = useTranslation('topology');
  const authorizedSites = useOrgStore((state) => state.sites);
  const [selectedSites, setSelectedSites] = useState([siteId]);
  const [siteSettings, setSiteSettings] = useState<Record<string, TopologySiteSettings>>({});
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(selectedSites.filter((id) => id !== siteId).map((id) => topologyConfigurationApi.settings(id, controller.signal))).then((values) => {
      if (!controller.signal.aborted) setSiteSettings(Object.fromEntries(values.map((value) => [value.siteId, value])));
    }).catch((cause) => { if (!controller.signal.aborted) { setSiteSettings({}); handleActionError(cause, t('loadFailed')); } });
    return () => controller.abort();
  }, [selectedSites, siteId]);
  const [settings, setSettings] = useState<TopologySiteSettings>(), [options, setOptions] = useState<TopologyTemplateVersionList>(), [error, setError] = useState<string>(), [revision, setRevision] = useState(0);
  const [partnerVersion, setPartnerVersion] = useState<string | null>(null), [orgVersion, setOrgVersion] = useState<string | null>(null);
  const [draft, setDraft] = useState<Configuration>(), [dirty, setDirty] = useState(false), [conflict, setConflict] = useState(false), [saving, setSaving] = useState(false);
  const [target, setTarget] = useState({ key: '', hostname: '', port: '443', path: '/', status: '200', family: 'ipv4' as 'ipv4' | 'ipv6', kind: 'https' as 'https' | 'dns_name', expectedAddresses: '' });
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([topologyConfigurationApi.settings(siteId, controller.signal), topologyConfigurationApi.options(siteId, undefined, controller.signal)]).then(([value, choices]) => {
      if (controller.signal.aborted) return;
      setSettings(value); setOptions(choices); setError(undefined);
      if (!dirty) { setDraft(value.binding.overrides); setPartnerVersion(value.binding.partnerVersionId); setOrgVersion(value.binding.orgVersionId); }
    }).catch((cause) => { if (!controller.signal.aborted) { setSettings(undefined); setOptions(undefined); setError(cause instanceof Error ? cause.message : t('loadFailed')); } });
    return () => controller.abort();
  }, [siteId, revision]);
  const save = async () => {
    if (!settings || !draft) return; setSaving(true);
    try {
      const result = await runAction({ request: () => topologyConfigurationApi.saveResponse(siteId, { expectedRevision: settings.settingsRevision, overrides: draft }), errorFallback: t('configurationFailed'), successMessage: t('configurationSaved'), parseSuccess: (data) => topologySiteSettingsSchema.parse(data) });
      setSettings(result); setDraft(result.binding.overrides); setDirty(false); setConflict(false);
    } catch (cause) { if (cause instanceof ActionError && cause.status === 409) setConflict(true); handleActionError(cause, t('loadFailed'));  }
    finally { setSaving(false); }
  };
  const addTarget = () => {
    if (!draft) return;
    const common = { label: target.key, enabled: true, families: [target.family], provider: null, independenceLabel: null };
    const next = topologyConfigurationSchema.safeParse({ ...draft, targets: { ...draft.targets, [target.key]: target.kind === 'https'
      ? { ...common, kind: 'https', hostname: target.hostname, port: Number(target.port), path: target.path, method: 'HEAD', expectedStatus: Number(target.status), maxRedirects: 0, proxyMode: 'direct' }
      : { ...common, kind: 'dns_name', hostname: target.hostname, expectedAddresses: target.expectedAddresses.split(',').map((value) => value.trim()).filter(Boolean), resolver: 'configured_dns' } } });
    if (!next.success) { setError(next.error.issues[0]?.message ?? t('invalidTarget')); return; }
    setDraft(next.data); setDirty(true); setError(undefined);
  };
  const canEdit = settings?.permissions.canEdit === true, canTargets = settings?.permissions.canConfigureMonitoring === true;
  return <section data-testid="topology-configuration" className="space-y-4 rounded border bg-card p-4">
    <h3 className="text-lg font-semibold">{t('configuration')}</h3>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {!settings && !error && <p role="status">{t('loading')}</p>}
    {settings && draft && <>
      <p className="text-sm">{t('pinnedVersions')}: {settings.binding.partnerVersionId ?? t('none')} / {settings.binding.orgVersionId ?? t('none')}</p>
      <details><summary className="cursor-pointer text-sm">{t('fieldProvenance')}</summary><dl className="space-y-1 pt-2 text-sm">{Object.entries(settings.resolved.provenance).map(([field, value]) => <div key={field}><dt className="inline font-medium">{field}: </dt><dd className="inline">{value.layer} {value.versionId}</dd></div>)}</dl></details>
      <div className="flex flex-wrap gap-3">{(['partner', 'organization'] as const).map((owner) => <label key={owner} className="text-sm">{t(/* i18n-dynamic */ owner)}<select data-testid={`topology-template-${owner}`} disabled={!canEdit} className="ml-2 max-w-full rounded border bg-background p-2" value={(owner === 'partner' ? partnerVersion : orgVersion) ?? ''} onChange={(event) => { (owner === 'partner' ? setPartnerVersion : setOrgVersion)(event.target.value || null); }}><option value="">{t('inheritWithoutTemplate')}</option>{options?.items.filter((option) => option.ownerScope === owner).map((option) => <option key={option.id} value={option.id}>{option.name} · v{option.version}</option>)}</select></label>)}</div>
      {options?.nextCursor && <button className="text-primary underline" onClick={() => void topologyConfigurationApi.options(siteId, options.nextCursor!).then((next) => setOptions({ ...next, items: [...options.items, ...next.items] })).catch((cause) => handleActionError(cause, t('loadFailed')))}>{t('moreVersions')}</button>}
      {authorizedSites.length > 1 && <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('applyToSites')}</legend>{authorizedSites.map((site) => <label className="mr-4 inline-flex items-center gap-2 text-sm" key={site.id}><input type="checkbox" disabled={!canEdit || site.id === siteId} checked={selectedSites.includes(site.id)} onChange={(event) => setSelectedSites((current) => event.target.checked ? [...current, site.id] : current.filter((id) => id !== site.id))} />{site.name}</label>)}</fieldset>}
      <TopologyTemplateApply request={{ partnerVersionId: partnerVersion, orgVersionId: orgVersion, sites: selectedSites.map((id) => ({ siteId: id, expectedBindingRevision: (id === siteId ? settings : siteSettings[id])?.binding.bindingRevision ?? '0', ...(id === siteId ? { overrides: draft } : {}), enableRecurring: false })) }} canApply={canEdit && (!dirty || canTargets) && selectedSites.every((id) => id === siteId || siteSettings[id]?.permissions.canEdit)} onComplete={() => { setDirty(false); setRevision((n) => n + 1); }} />
      <fieldset disabled={!canEdit} className="space-y-3 border-t pt-4"><legend className="font-medium">{t('siteOverrides')}</legend>
        <label className="block text-sm">{t('passiveInterval')}<input type="number" min={60} max={86400} className="ml-2 w-32 rounded border bg-background p-2" value={draft.passive?.intervalSeconds ?? ''} onChange={(event) => { setDraft({ ...draft, passive: { ...draft.passive, intervalSeconds: Number(event.target.value) } }); setDirty(true); }} /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.outboundEnabled ?? settings.resolved.settings.outboundEnabled ?? false} disabled={!canTargets} onChange={(event) => { setDraft({ ...draft, outboundEnabled: event.target.checked }); setDirty(true); }} />{t('outboundEnabled')}</label>
      </fieldset>
      <div className="space-y-2"><h4 className="font-medium">{t('explicitTargets')}</h4><p className="text-sm text-muted-foreground">{t('noDefaultTargets')}</p>
        <ul className="space-y-2 text-sm">{Object.entries({ ...settings.resolved.settings.targets, ...draft.targets }).map(([key, value]) => <li key={key}>{key}: {value.kind}{value.kind !== 'tombstone' && ` · ${value.families.join(', ')}`} {canTargets && <button className="ml-2 underline" onClick={() => { setDraft({ ...draft, targets: { ...draft.targets, [key]: { kind: 'tombstone' } } }); setDirty(true); }}>{t('removeTarget')}</button>}</li>)}</ul>
        <fieldset disabled={!canTargets} className="flex flex-wrap gap-3">
          <label className="text-sm">{t('targetKind')}<select className="block rounded border bg-background p-2" value={target.kind} onChange={(e) => setTarget({ ...target, kind: e.target.value as typeof target.kind })}><option value="https">HTTPS</option><option value="dns_name">DNS</option></select></label>
          {(['key', 'hostname', ...(target.kind === 'https' ? ['port', 'path', 'status'] : ['expectedAddresses'])] as const).map((field) => <label className="text-sm" key={field}>{t(/* i18n-dynamic */ `targetFields.${field}`)}<input data-testid={`topology-target-${field}`} className="block max-w-full rounded border bg-background p-2" value={target[field as keyof typeof target]} onChange={(e) => setTarget({ ...target, [field]: e.target.value })} /></label>)}
          <label className="text-sm">{t('family')}<select className="block rounded border bg-background p-2" value={target.family} onChange={(e) => setTarget({ ...target, family: e.target.value as typeof target.family })}><option value="ipv4">IPv4</option><option value="ipv6">IPv6</option></select></label>
          <button className="self-end rounded border px-3 py-2" onClick={addTarget}>{t('addTargetDraft')}</button>
        </fieldset>
      </div>
      {dirty && <p role="status" className="text-sm">{t('unsavedConfiguration')}</p>}
      {conflict && <div role="alert"><p>{t('configurationConflict')}</p><button className="mt-2 underline" onClick={() => { setDirty(false); setConflict(false); setRevision((n) => n + 1); }}>{t('reloadConfiguration')}</button></div>}
      <button data-testid="topology-configuration-save" disabled={!dirty || saving || !canEdit || conflict} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => void save()}>{t('saveConfiguration')}</button>
    </>}
  </section>;
}
