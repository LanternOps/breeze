import type { ReactElement } from 'react';
import type { DocumentBranding } from '@breeze/shared/documents';
import type { DocumentHostComponents } from './hostComponents';

const LOGO = 'h-11 w-auto max-w-[220px] object-contain';

/** True when the branding has something to draw: an uploaded logo or a wordmark. */
export function hasBrandMark(branding: Pick<DocumentBranding, 'logo' | 'wordmark'>): boolean {
  return branding.logo !== null || !!branding.wordmark;
}

/** The partner's logo, else its wordmark — the mark the document header and the
 *  proposal cover both lead with (the quote PDF draws it on its cover too). */
export function DocumentBrandMark({ branding, components }: {
  branding: Pick<DocumentBranding, 'logo' | 'wordmark' | 'logoAlt'>;
  components: DocumentHostComponents;
}): ReactElement | null {
  const { logo, wordmark, logoAlt } = branding;
  if (logo?.kind === 'asset') return <components.Image asset={logo.ref} alt={logoAlt} className={LOGO} />;
  if (logo?.kind === 'url') return <img src={logo.url} alt={logoAlt} className={LOGO} />;
  if (wordmark) return <p className="text-xl font-semibold tracking-tight text-foreground">{wordmark}</p>;
  return null;
}
