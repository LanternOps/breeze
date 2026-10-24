import type { DocumentHostComponents } from '@breeze/document-ui';
import { publicApiPath } from '@/lib/api';

/** Invoice host components: plain elements. Invoices carry URL logos only (the builder
 *  emits `{kind:'url'}`), so asset-backed images are never requested. */
export const portalHostComponents: DocumentHostComponents = {
  Image: () => null,
  AgreementFile: () => null,
};

interface QuoteAssetSource {
  /** Builds the (token-scoped or session-authed) URL for a quote image by id: block images and the cover. */
  imageUrl(imageId: string): string;
  /** The server-built relative thumbnail route each line carries, by line id. */
  lineImagePaths: ReadonlyMap<string, string>;
  /** The server-built relative route of each uploaded contract file, by contract block id. */
  contractFilePaths: ReadonlyMap<string, string>;
}

/** Index a quote envelope's asset routes (the model holds ids; the payload holds the routes). */
export function quoteAssetSource(
  env: { lines: { id: string; imageUrl?: string | null }[]; blocks: { id: string; blockType: string; content: Record<string, unknown> | null }[] },
  imageUrl: (imageId: string) => string,
): QuoteAssetSource {
  const lineImagePaths = new Map<string, string>();
  for (const l of env.lines) if (l.imageUrl) lineImagePaths.set(l.id, l.imageUrl);
  const contractFilePaths = new Map<string, string>();
  for (const b of env.blocks) {
    const fileUrl = b.blockType === 'contract' ? b.content?.fileUrl : null;
    if (typeof fileUrl === 'string' && fileUrl) contractFilePaths.set(b.id, fileUrl);
  }
  return { imageUrl, lineImagePaths, contractFilePaths };
}

/** Quote host components: images are plain `<img>` against the page's own image routes. */
export function portalQuoteHostComponents(src: QuoteAssetSource): DocumentHostComponents {
  return {
    Image: ({ asset, alt, className, width, unavailableText }) => {
      if (asset.kind === 'line_thumb') {
        const path = src.lineImagePaths.get(asset.id);
        if (!path) return null;
        return (
          // A line whose catalog item happens to have no image 404s; hide the broken thumbnail.
          <img
            src={publicApiPath(path)}
            alt={alt}
            loading="lazy"
            data-testid={`quote-line-image-${asset.id}`}
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
            className={className}
          />
        );
      }
      if (asset.kind === 'cover' || asset.kind === 'block_image') {
        return (
          <img
            src={src.imageUrl(asset.id)}
            alt={alt}
            width={width}
            className={className}
            onError={(e) => {
              // Say so instead of leaving a broken-image icon (or a blank cover band) on a customer document.
              console.warn('[portal] quote image failed to load', asset.kind, asset.id);
              const img = e.currentTarget;
              if (unavailableText && asset.kind === 'block_image') {
                const note = document.createElement('div');
                note.className = 'rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground';
                note.textContent = unavailableText;
                img.replaceWith(note);
              } else {
                img.style.display = 'none';
              }
            }}
          />
        );
      }
      return null;
    },
    AgreementFile: ({ asset, title, downloadLabel, unavailableText }) => {
      const path = src.contractFilePaths.get(asset.id);
      if (!path) return <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground">{unavailableText}</div>;
      const url = publicApiPath(path);
      return (
        <div className="space-y-3">
          <iframe src={url} title={title} className="h-[32rem] w-full rounded-lg border" />
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            data-testid="contract-block-download"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            {downloadLabel}
          </a>
        </div>
      );
    },
  };
}
