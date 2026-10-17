import { useEffect, useState } from 'react';
import { portalApi, type TrustCard, type TrustPageResponse } from '@/lib/api';
import { FRAMEWORK_META, normalizeTrustPagePayload, type SupportedLocale, type TrustPagePublicControl } from '@breeze/shared';
import { pageCopy } from './copy/pageCopy';
import { TrustStatusPill } from './TrustStatusPill';
import { coverageNote, controlCopy, formatTrustDateTime, frameworkChip, groupControlsByCategory, notAssessedReasonCopy, relativeTime } from './trustPageFormat';
import { TrustLocaleContext, pickTrustCopy, type TrustSectionViewProps } from './trustCopy';
import TrustDeclaredControls from './TrustDeclaredControls';
import TrustDocumentsList from './TrustDocumentsList';
import TrustFaq from './TrustFaq';
import TrustFrameworkView from './TrustFrameworkView';
import TrustHistory from './TrustHistory';
import TrustSubprocessors from './TrustSubprocessors';

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

  // Before the payload arrives the SSR card (when present) already knows the page's frozen locale.
  const early = pickTrustCopy(pageCopy, card?.locale);
  if (loading) return <div data-testid="trust-page-loading" className="mx-auto max-w-lg p-8 text-center text-sm text-muted-foreground">{early.loading}</div>;
  if (error != null || !data) {
    return <div data-testid="trust-page-error" className="mx-auto max-w-lg p-8 text-center"><p className="text-sm text-muted-foreground">{early.unavailable}</p></div>;
  }
  const { stale, lastEvaluatedAt } = data;
  // A stored W1 (schemaVersion 1) snapshot stays renderable: English, public documents, no W2 block.
  const payload = normalizeTrustPagePayload(data.payload);
  const locale = payload.locale;
  const t = pickTrustCopy(pageCopy, locale);
  const groups = groupControlsByCategory(payload.controls, locale);
  // The W2 sections (W02b/d/e/f fill them) all take the same props.
  const section: TrustSectionViewProps = { payload, lastEvaluatedAt, preview: Boolean(previewToken || data.preview), partnerSlug, orgSlug };

  return (
    <TrustLocaleContext.Provider value={payload.locale}>
    <article className="space-y-8" data-testid="trust-page">
      {data.preview && <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">{t.previewBanner}</div>}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {payload.org.logoUrl && <img src={payload.org.logoUrl} alt={t.logoAlt(payload.org.name)} className="h-12 w-auto max-w-[200px] object-contain" />}
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{payload.org.name} <span className="text-muted-foreground">· {t.headerSuffix}</span></h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.summary(payload.summary.controlsShown, payload.summary.catalogTotal, payload.summary.controlsMet, relativeTime(lastEvaluatedAt, new Date(), locale))}
              {payload.summary.deviceCount != null && <> · {t.deviceCount(payload.summary.deviceCount)}</>}
            </p>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {payload.org.securityContactEmail && <p><a className="doc-accent-text hover:underline" href={`mailto:${payload.org.securityContactEmail}`}>{payload.org.securityContactEmail}</a></p>}
          {payload.org.websiteUrl && <p><a className="hover:underline" href={payload.org.websiteUrl} rel="noopener noreferrer">{payload.org.websiteUrl.replace(/^https:\/\//, '')}</a></p>}
        </div>
      </header>

      {stale && <div role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">{t.stale((lastEvaluatedAt && formatTrustDateTime(lastEvaluatedAt, locale)) || t.unknownTime)}</div>}

      {payload.introHtml && <section className="quote-rich-text prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: payload.introHtml }} />}

      <section data-testid="trust-controls" data-stale={stale ? 'true' : 'false'} className={stale ? 'space-y-6 opacity-60' : 'space-y-6'}>
        {groups.map((g) => (
          <div key={g.category}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</h2>
            <ul className="divide-y rounded-lg border bg-card">
              {g.controls.map((c) => <ControlRow key={c.id} control={c} coverageFloorPct={payload.methodology.coverageFloorPct} locale={locale} />)}
            </ul>
          </div>
        ))}
      </section>

      <TrustDeclaredControls {...section} />
      <TrustFrameworkView {...section} />

      <details className="rounded-lg border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-medium">{t.howVerified}</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>{t.methodCatalog(payload.methodology.catalogVersion)}</li>
          <li>{payload.methodology.eligibilityNote}</li>
          <li>{t.methodEvidence(payload.methodology.evidenceMaxAgeDays, payload.methodology.definitionsMaxAgeDays)}</li>
          <li>{t.methodFloor(payload.methodology.coverageFloorPct)}</li>
          <li>{t.methodThresholds(payload.methodology.thresholds.met, payload.methodology.thresholds.attention)}</li>
          <li>{t.methodFrameworks}</li>
        </ul>
      </details>

      <TrustDocumentsList {...section} />
      <TrustSubprocessors {...section} />
      <TrustFaq {...section} />
      <TrustHistory {...section} />

      {payload.managedBy && (
        <section className="flex items-center gap-3 rounded-lg border bg-card p-4 text-sm">
          {payload.managedBy.logoUrl && <img src={payload.managedBy.logoUrl} alt={t.logoAlt(payload.managedBy.name)} className="h-8 w-auto max-w-[140px] object-contain" />}
          <p>{t.managedBy} <strong>{payload.managedBy.name}</strong>{payload.managedBy.websiteUrl && <> · <a className="hover:underline" href={payload.managedBy.websiteUrl} rel="noopener noreferrer">{payload.managedBy.websiteUrl.replace(/^https:\/\//, '')}</a></>}</p>
        </section>
      )}

      <footer className="space-y-2 text-xs text-muted-foreground">
        {payload.footer.poweredByBreeze && <p>{t.poweredBy}</p>}
        <p>{t.notAttestation}</p>
        {payload.footer.frameworkAttributions.map((fw) => <p key={fw}>{FRAMEWORK_META[fw].attribution}</p>)}
      </footer>
    </article>
    </TrustLocaleContext.Provider>
  );
}

function ControlRow({ control, coverageFloorPct, locale }: { control: TrustPagePublicControl; coverageFloorPct: number; locale: SupportedLocale }) {
  const t = pickTrustCopy(pageCopy, locale);
  const copy = controlCopy(control.id, locale);
  const note = coverageNote(control, locale);
  return (
    <li data-testid={`trust-control-${control.id}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{copy.title} <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{t.continuouslyVerified}</span></p>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
        {control.status === 'not_assessed' && control.reason && <p className="mt-1 text-xs text-muted-foreground">{notAssessedReasonCopy(control.reason, { coverageFloorPct, unit: control.unit }, locale)}</p>}
        <p className="mt-1 flex flex-wrap gap-1">{control.frameworkRefs.map((r) => <span key={`${r.framework}:${r.ref}`} className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{frameworkChip(r, locale)}</span>)}</p>
      </div>
      <div className="text-right">
        <TrustStatusPill status={control.status} />
        {control.percent != null && <p className="mt-1 text-sm font-medium">{control.percent}%</p>}
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
    </li>
  );
}
