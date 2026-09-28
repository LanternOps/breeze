import { useTranslation } from 'react-i18next';
import type { GraphRelationship, RelationshipDetailResponse, RelationshipEvidenceResponse } from '@breeze/shared';

type Detail = RelationshipDetailResponse;
type Endpoint = Detail['endpoints']['source'];
type PortRole = NonNullable<Detail['physical']>['portRole'];
const KNOWN_METHODS = new Set(['lldp', 'cdp', 'fdb', 'unifi', 'manual', 'legacy']);

/** Without detail, derive the port role conservatively from the graph edge alone. */
function portRoleOf(relationship: GraphRelationship, detail?: Detail | null): PortRole | null {
  if (detail?.physical) return detail.physical.portRole;
  if (relationship.kind !== 'physical_link' && relationship.kind !== 'attachment') return null;
  if (!relationship.sourceInterfaceId) return 'unresolved';
  return relationship.evidence.methods.includes('fdb') ? 'learned' : 'identified';
}
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : null;

/**
 * Truthful physical evidence for one relationship (M2 D11). Meaning, directness
 * and port role never promote an inference: an FDB row is "learned through this
 * port", not a cable. Port rates/utilization are not measured in M2 and are not
 * shown at all.
 */
export default function PhysicalEvidencePanel({ relationship, detail, evidence, onLoadMoreEvidence }: {
  relationship: GraphRelationship;
  detail?: Detail | null;
  evidence?: RelationshipEvidenceResponse | null;
  onLoadMoreEvidence?: () => void;
}) {
  const { t } = useTranslation('topology');
  const method = detail?.physical?.method ?? relationship.evidence.methods[0] ?? null;
  const role = portRoleOf(relationship, detail);
  const association = detail?.physical?.association ?? null;
  const port = (endpoint: Endpoint) => {
    const name = endpoint.port ? `${endpoint.port.name ?? endpoint.port.key}${endpoint.port.alias ? ` (${endpoint.port.alias})` : ''}${endpoint.port.retired ? ` ${t('physicalView.retiredPort')}` : ''}`
      : t('physicalView.portNotIdentified');
    return <>
      <span className="break-words">{endpoint.label} · {name}</span>
      {!endpoint.port && endpoint.reportedPort && <span className="block text-xs text-muted-foreground">{t('physicalView.reportedPort', endpoint.reportedPort)}</span>}
    </>;
  };
  const expires = evidence?.confirmations.reduce<string | null>((latest, c) => !latest || c.freshUntil > latest ? c.freshUntil : latest, null);
  return <section data-testid="topology-physical-evidence" className="space-y-3 text-sm">
    <dl className="space-y-2">
      <div><dt className="font-medium">{t('physicalView.meaningLabel')}</dt>
        <dd data-testid="topology-relationship-meaning">{t(/* i18n-dynamic */ `physicalView.meaning.${relationship.kind}`)}</dd></div>
      <div><dt className="font-medium">{t('physicalView.directnessLabel')}</dt>
        <dd data-testid="topology-directness">{t(/* i18n-dynamic */ `physicalView.directness.${relationship.directness ?? 'unknown'}`)}</dd></div>
      {role && <div><dt className="font-medium">{t('physicalView.portRoleLabel')}</dt>
        <dd data-testid="topology-port-role">{t(/* i18n-dynamic */ `physicalView.portRole.${role}`)}</dd></div>}
      {detail && <>
        <div><dt className="font-medium">{t('physicalView.sourcePort')}</dt><dd data-testid="topology-source-port">{port(detail.endpoints.source)}</dd></div>
        <div><dt className="font-medium">{t('physicalView.targetPort')}</dt><dd data-testid="topology-target-port">{port(detail.endpoints.target)}</dd></div>
      </>}
      {association && <div><dt className="font-medium">{t('physicalView.associationLabel')}</dt>
        <dd data-testid="topology-association">{t(/* i18n-dynamic */ `physicalView.association.${association}`)}</dd></div>}
      {method && <div><dt className="font-medium">{t('physicalView.methodLabel')}</dt>
        <dd data-testid="topology-evidence-method">{t(/* i18n-dynamic */ `physicalView.method.${KNOWN_METHODS.has(method) ? method : 'other'}`)}</dd></div>}
      <div><dt className="font-medium">{t('confidence')}</dt><dd data-testid="topology-confidence">{t(/* i18n-dynamic */ `physicalView.confidence.${relationship.confidence}`)}</dd></div>
      <div><dt className="font-medium">{t('freshness')}</dt><dd data-testid="topology-freshness">{t(/* i18n-dynamic */ `physicalView.freshness.${relationship.freshness}`)}</dd></div>
      <div><dt className="font-medium">{t('physicalView.lastConfirmed')}</dt><dd>{time(relationship.evidence.lastObservedAt) ?? t('notObserved')}</dd></div>
      {expires && <div><dt className="font-medium">{t('physicalView.evidenceExpires')}</dt><dd>{time(expires)}</dd></div>}
    </dl>
    {detail && detail.exclusions.length > 0 && <p data-testid="topology-excluded" className="rounded border px-3 py-2">
      {t('physicalView.hiddenFrom', { views: detail.exclusions.map((e) => t(/* i18n-dynamic */ e.view)).join(', ') })}</p>}
    {detail && detail.alternatives.length > 0 && <div data-testid="topology-alternatives">
      <h4 className="font-medium">{t('physicalView.alternatives')}</h4>
      <ul className="list-inside list-disc">{detail.alternatives.map((a) => <li key={a.relationshipId} className="break-words">
        {a.sourceNodeLabel} · {a.port ? a.port.name ?? a.port.key : t('physicalView.portNotIdentified')} · {t(/* i18n-dynamic */ `physicalView.confidence.${a.confidence}`)}</li>)}</ul>
    </div>}
    {evidence && <div>
      <h4 className="font-medium">{t('physicalView.observations')}</h4>
      {evidence.details.state !== 'available' && <p data-testid="topology-evidence-details" className="text-muted-foreground">
        {t(/* i18n-dynamic */ `physicalView.details.${evidence.details.state === 'expired' ? 'expired' : 'unavailable'}`)}</p>}
      <ul className="space-y-1">{evidence.observations.map((o) => <li key={o.id} data-testid={`topology-observation-${o.id}`}>
        {t(/* i18n-dynamic */ `physicalView.method.${KNOWN_METHODS.has(o.method) ? o.method : 'other'}`)} · {time(o.receivedAt)} · {t(/* i18n-dynamic */ `physicalView.observationStatus.${o.status}`)}</li>)}</ul>
      {evidence.cursor && onLoadMoreEvidence && <button data-testid="topology-evidence-more" className="mt-2 rounded border px-3 py-1" onClick={onLoadMoreEvidence}>{t('physicalView.moreEvidence')}</button>}
    </div>}
  </section>;
}
