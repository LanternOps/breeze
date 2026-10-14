import { useEffect, useState } from 'react';
import { portalApi, trustDocumentPath, type TrustCard, type TrustPageResponse } from '@/lib/api';
import { FRAMEWORK_META, type TrustPagePublicControl } from '@breeze/shared';
import { TrustStatusPill } from './TrustStatusPill';
import { coverageNote, controlCopy, frameworkChip, groupControlsByCategory, NOT_ASSESSED_REASON_COPY, relativeTime } from './trustPageFormat';

interface Props { partnerSlug: string | null; orgSlug: string | null; card: TrustCard | null; previewToken?: string; initial?: TrustPageResponse | null }

export default function TrustPageView({ partnerSlug, orgSlug, card, previewToken, initial = null }: Props) {
  const [data, setData] = useState<TrustPageResponse | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initial == null);

  useEffect(() => {
    if (data || error) return;
    let cancelled = false;
    const req = previewToken ? portalApi.getTrustPreview(previewToken) : portalApi.getTrustPage(partnerSlug!, orgSlug);
    void req.then((res) => {
      if (cancelled) return;
      if (res.data?.data) setData(res.data.data); else setError('');
      setLoading(false);
    }).catch(() => { if (!cancelled) { setError(''); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerSlug, orgSlug, previewToken]);

  if (loading) return <div data-testid="trust-page-loading" className="mx-auto max-w-lg p-8 text-center text-sm text-muted-foreground">Loading security posture…</div>;
  if (error != null || !data) {
    return <div data-testid="trust-page-error" className="mx-auto max-w-lg p-8 text-center"><p className="text-sm text-muted-foreground">This page isn’t available. The organization may not have published a trust page, or the link may have changed.</p></div>;
  }
  const { payload, stale, lastEvaluatedAt } = data;
  const groups = groupControlsByCategory(payload.controls);
  const docHref = (id: string) => (partnerSlug && orgSlug ? trustDocumentPath(partnerSlug, orgSlug, id) : undefined);

  return (
    <article className="space-y-8" data-testid="trust-page">
      {data.preview && <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">Preview of the unpublished draft. Expires in 15 minutes.</div>}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {payload.org.logoUrl && <img src={payload.org.logoUrl} alt={`${payload.org.name} logo`} className="h-12 w-auto max-w-[200px] object-contain" />}
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{payload.org.name} <span className="text-muted-foreground">· Security posture</span></h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Showing {payload.summary.controlsShown} of {payload.summary.catalogTotal} Breeze-verifiable controls (publisher-selected) · {payload.summary.controlsMet} met · last verified {relativeTime(lastEvaluatedAt)}
              {payload.summary.deviceCount != null && <> · {payload.summary.deviceCount} devices</>}
            </p>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {payload.org.securityContactEmail && <p><a className="doc-accent-text hover:underline" href={`mailto:${payload.org.securityContactEmail}`}>{payload.org.securityContactEmail}</a></p>}
          {payload.org.websiteUrl && <p><a className="hover:underline" href={payload.org.websiteUrl} rel="noopener noreferrer">{payload.org.websiteUrl.replace(/^https:\/\//, '')}</a></p>}
        </div>
      </header>

      {stale && <div role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">Verification paused since {lastEvaluatedAt ? new Date(lastEvaluatedAt).toLocaleString('en-US') : 'an unknown time'}. Statuses below are the last known values.</div>}

      {payload.introHtml && <section className="quote-rich-text prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: payload.introHtml }} />}

      <section data-testid="trust-controls" data-stale={stale ? 'true' : 'false'} className={stale ? 'space-y-6 opacity-60' : 'space-y-6'}>
        {groups.map((g) => (
          <div key={g.category}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h2>
            <ul className="divide-y rounded-lg border bg-card">
              {g.controls.map((c) => <ControlRow key={c.id} control={c} />)}
            </ul>
          </div>
        ))}
      </section>

      <details className="rounded-lg border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-medium">How this page is verified</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>Control catalog version {payload.methodology.catalogVersion}; evaluated from Breeze RMM telemetry. This is an evidence summary, <strong>not a certification</strong>.</li>
          <li>{payload.methodology.eligibilityNote}</li>
          <li>Evidence older than {payload.methodology.evidenceMaxAgeDays} days is not counted; anti-malware definitions older than {payload.methodology.definitionsMaxAgeDays} days count as stale.</li>
          <li>A control is evaluated only when at least {payload.methodology.coverageFloorPct}% of eligible units were assessed; otherwise it reads “Not assessed”.</li>
          <li>Met at ≥ {payload.methodology.thresholds.met}%, needs attention at ≥ {payload.methodology.thresholds.attention}%, otherwise not met.</li>
          <li>Framework references are indicative mappings to safeguard identifiers, never a statement of compliance.</li>
        </ul>
      </details>

      {payload.documents.length > 0 && (
        <section data-testid="trust-documents">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Documents</h2>
          <ul className="divide-y rounded-lg border bg-card">
            {payload.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <div><a className="font-medium hover:underline" href={docHref(d.id)}>{d.title}</a><p className="text-xs text-muted-foreground">{d.category} · {(d.byteSize / 1024).toFixed(0)} KB · {new Date(d.updatedAt).toLocaleDateString('en-US')}</p></div>
                <a className="text-xs doc-accent-text hover:underline" href={docHref(d.id)}>Download</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {payload.managedBy && (
        <section className="flex items-center gap-3 rounded-lg border bg-card p-4 text-sm">
          {payload.managedBy.logoUrl && <img src={payload.managedBy.logoUrl} alt={`${payload.managedBy.name} logo`} className="h-8 w-auto max-w-[140px] object-contain" />}
          <p>Managed by <strong>{payload.managedBy.name}</strong>{payload.managedBy.websiteUrl && <> · <a className="hover:underline" href={payload.managedBy.websiteUrl} rel="noopener noreferrer">{payload.managedBy.websiteUrl.replace(/^https:\/\//, '')}</a></>}</p>
        </section>
      )}

      <footer className="space-y-2 text-xs text-muted-foreground">
        {payload.footer.poweredByBreeze && <p>Powered by Breeze RMM · continuously verified telemetry. Not a SOC 2, ISO or CIS attestation.</p>}
        {payload.footer.frameworkAttributions.map((fw) => <p key={fw}>{FRAMEWORK_META[fw].attribution}</p>)}
      </footer>
    </article>
  );
}

function ControlRow({ control }: { control: TrustPagePublicControl }) {
  const copy = controlCopy(control.id);
  const note = coverageNote(control);
  return (
    <li data-testid={`trust-control-${control.id}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{copy.title} <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Continuously verified</span></p>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
        {control.status === 'not_assessed' && control.reason && <p className="mt-1 text-xs text-muted-foreground">{NOT_ASSESSED_REASON_COPY[control.reason]}</p>}
        <p className="mt-1 flex flex-wrap gap-1">{control.frameworkRefs.map((r) => <span key={`${r.framework}:${r.ref}`} className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{frameworkChip(r)}</span>)}</p>
      </div>
      <div className="text-right">
        <TrustStatusPill status={control.status} />
        {control.percent != null && <p className="mt-1 text-sm font-medium">{control.percent}%</p>}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
    </li>
  );
}
