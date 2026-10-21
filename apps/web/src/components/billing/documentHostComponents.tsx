import type { DocumentHostComponents } from '@breeze/document-ui';
import type { CustomerQuoteDocument } from '@breeze/shared/documents';
import { quoteImageUrl } from '../../lib/api/quotes';
import { useAuthedImage } from './quotes/useQuoteImage';

/** Authed fetch → object URL (a bare `img src` would 401 on the staff API). Renders
 *  `fallback` on a failed fetch and nothing while loading or when there is no path. */
function AuthedImage({ path, alt, className, width, fallback }: {
  path: string | null; alt: string; className?: string; width?: number; fallback?: string;
}) {
  const { url, failed } = useAuthedImage(path);
  if (failed && fallback) {
    return <div className="rounded-lg border border-dashed bg-muted/40 px-4 py-8 text-center text-xs text-muted-foreground">{fallback}</div>;
  }
  if (!url) return null;
  return <img src={url} alt={alt} width={width} className={className} />;
}

/** An uploaded agreement's PDF: the authed bytes in an iframe plus a download link.
 *  Mounted only while its row is open (the package's lazy agreement body). */
function AgreementFrame({ path, title, downloadLabel, unavailableText }: { path: string; title: string; downloadLabel: string; unavailableText: string }) {
  const { url, failed } = useAuthedImage(path);
  if (failed) {
    return <div className="rounded-lg border border-dashed bg-muted/40 px-4 py-8 text-center text-xs text-muted-foreground">{unavailableText}</div>;
  }
  if (!url) return <div className="h-64 animate-pulse rounded-lg bg-muted/60" aria-hidden />;
  return (
    <div className="space-y-2">
      <iframe src={url} title={title} className="h-[32rem] w-full rounded-lg border" />
      <a
        href={url}
        download
        data-testid="quote-contract-download"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        {downloadLabel}
      </a>
    </div>
  );
}

/** Invoices carry URL logos only (the builder emits `{kind:'url'}`), so no asset is ever requested. */
export const webHostComponents: DocumentHostComponents = {
  Image: () => null,
  AgreementFile: () => null,
};

/** Quote host components. The model holds ids; the staff customer-view payload holds the
 *  authenticated routes (a line's image or its catalog item's, a contract block's file), so
 *  they are read from the payload the Preview already fetched. Block and cover images use
 *  the quote's own image route. */
export function webQuoteHostComponents(dto: CustomerQuoteDocument): DocumentHostComponents {
  const quoteId = dto.quote.id;
  const lineImagePaths = new Map<string, string>();
  for (const l of dto.lines) if (l.imageUrl) lineImagePaths.set(l.id, l.imageUrl);
  const contractFilePaths = new Map<string, string>();
  for (const b of dto.blocks) {
    if (b.blockType === 'contract' && b.content?.fileUrl) contractFilePaths.set(b.id, b.content.fileUrl);
  }
  return {
    Image: ({ asset, alt, className, width, unavailableText }) => {
      if (asset.kind === 'line_thumb') return <AuthedImage path={lineImagePaths.get(asset.id) ?? null} alt={alt} className={className} />;
      if (asset.kind === 'cover' || asset.kind === 'block_image') {
        return <AuthedImage path={quoteImageUrl(quoteId, asset.id)} alt={alt} className={className} width={width} fallback={unavailableText} />;
      }
      return null;
    },
    AgreementFile: ({ asset, title, downloadLabel, unavailableText }) => {
      const path = contractFilePaths.get(asset.id);
      if (!path) {
        return <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">{unavailableText}</div>;
      }
      return <AgreementFrame path={path} title={title} downloadLabel={downloadLabel} unavailableText={unavailableText} />;
    },
  };
}
