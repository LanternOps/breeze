// Owner: W02d (gated documents and the request flow) after W02a extracted it verbatim from TrustPageView.
// A public document links to the anonymous download; a gated one lists its title with "Available on request"
// and no link (W02d adds the request form). Strings stay English until W02h.
import { trustDocumentPath } from '@/lib/api';
import type { TrustSectionViewProps } from './trustCopy';

export default function TrustDocumentsList({ payload, preview, partnerSlug, orgSlug }: TrustSectionViewProps) {
  if (payload.documents.length === 0) return null;
  // Published pages link documents (org page or partner-home page); a preview never does.
  const docHref = (id: string) => (!preview && partnerSlug ? trustDocumentPath(partnerSlug, orgSlug, id) : undefined);
  return (
    <section data-testid="trust-documents">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Documents</h2>
      <ul className="divide-y rounded-lg border bg-card">
        {payload.documents.map((d) => {
          const href = d.visibility === 'public' ? docHref(d.id) : undefined;
          return (
            <li key={d.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm" data-testid={`trust-document-${d.id}`}>
              <div>{href ? <a className="font-medium hover:underline" href={href}>{d.title}</a> : <span className="font-medium">{d.title}</span>}<p className="text-xs text-muted-foreground">{d.category} · {(d.byteSize / 1024).toFixed(0)} KB · {new Date(d.updatedAt).toLocaleDateString('en-US')}</p></div>
              {href && <a className="text-xs doc-accent-text hover:underline" href={href}>Download</a>}
              {d.visibility === 'gated' && <span className="text-xs text-muted-foreground" data-testid={`trust-document-on-request-${d.id}`}>Available on request</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
