import type { DocumentHostComponents } from '@breeze/document-ui';
import { catalogItemImagePath } from '../../lib/api/catalog';
import { useAuthedImage } from './quotes/useQuoteImage';

/** Authed fetch → object URL, as the quote document's DocLineThumb does (a bare
 *  `img src` would 401 on the staff API). Renders nothing on a miss. */
function AuthedImage({ path, alt, className }: { path: string | null; alt: string; className?: string }) {
  const { url } = useAuthedImage(path);
  if (!url) return null;
  return <img src={url} alt={alt} className={className} />;
}

/** Web host components. Invoices carry only URL logos today; a line thumbnail
 *  resolves to its catalog item image. Uploaded agreement files arrive with the
 *  quote document (W2b), so `AgreementFile` renders nothing until then. */
export const webHostComponents: DocumentHostComponents = {
  Image: ({ asset, alt, className }) => (
    <AuthedImage path={asset.kind === 'line_thumb' ? catalogItemImagePath(asset.id) : null} alt={alt} className={className} />
  ),
  AgreementFile: () => null,
};
