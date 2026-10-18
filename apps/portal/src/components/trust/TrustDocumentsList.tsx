// Owner: W02d (gated documents and the request flow) after W02a extracted it verbatim from TrustPageView.
// A public document links to the anonymous download; a gated one lists its title with "Available on request"
// and no link. When the page offers access (payload.access), one button opens the inline request form.
import { useState } from 'react';
import { trustDocumentPath } from '@/lib/api';
import { formatTrustDate, pickTrustCopy, useTrustLocale, type TrustSectionViewProps } from './trustCopy';
import { accessCopy } from './access/accessCopy';
import RequestAccessForm from './access/RequestAccessForm';

export default function TrustDocumentsList({ payload, preview, partnerSlug, orgSlug }: TrustSectionViewProps) {
  const locale = useTrustLocale();
  const t = pickTrustCopy(accessCopy, locale);
  const [formOpen, setFormOpen] = useState(false);
  if (payload.documents.length === 0) return null;
  // Published pages link documents (org page or partner-home page); a preview never does.
  const docHref = (id: string) => (!preview && partnerSlug ? trustDocumentPath(partnerSlug, orgSlug, id) : undefined);
  const canRequest = payload.access != null && !preview && !!partnerSlug && payload.documents.some((d) => d.visibility === 'gated');
  return (
    <section data-testid="trust-documents">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t.documentsHeading}</h2>
      <ul className="divide-y rounded-lg border bg-card">
        {payload.documents.map((d) => {
          const href = d.visibility === 'public' ? docHref(d.id) : undefined;
          return (
            <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm" data-testid={`trust-document-${d.id}`}>
              <div>{href ? <a className="font-medium hover:underline" href={href}>{d.title}</a> : <span className="font-medium">{d.title}</span>}<p className="text-xs text-muted-foreground">{d.category} · {(d.byteSize / 1024).toFixed(0)} KB · {formatTrustDate(d.updatedAt, locale)}</p></div>
              {href && <a className="text-xs doc-accent-text hover:underline" href={href}>{t.download}</a>}
              {d.visibility === 'gated' && <span className="text-xs text-muted-foreground" data-testid={`trust-document-on-request-${d.id}`}>{t.availableOnRequest}</span>}
            </li>
          );
        })}
      </ul>
      {canRequest && !formOpen && (
        <button type="button" className="mt-3 text-sm font-medium doc-accent-text hover:underline" data-testid="trust-request-access" onClick={() => setFormOpen(true)}>{t.requestAccess}</button>
      )}
      {canRequest && formOpen && (
        <RequestAccessForm partnerSlug={partnerSlug!} orgSlug={orgSlug} ndaText={payload.access!.ndaText} onCancel={() => setFormOpen(false)} />
      )}
    </section>
  );
}
