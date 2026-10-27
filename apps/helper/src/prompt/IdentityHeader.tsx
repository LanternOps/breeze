import type { CSSProperties } from 'react';

import { isReadableBrandColor } from '@breeze-brand-contrast';
import { identityDisplayName, type PromptIdentity } from './identity';

/*
 * "Who is asking" (#10190, spec section 3.6): the MSP logo (if any) and name
 * above every prompt card. The name is plain text, never markup. The brand
 * colour becomes the header accent only when it passes the shared contrast
 * rule (brandContrast.ts); otherwise the default Assist palette is used.
 * High contrast (forced-colors) and the OS text size always win: see
 * prompt.css (`.prompt-identity`, rem/em sizes, the forced-colors block).
 */

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** The brand accent to use, or null for the default palette. */
export function brandAccent(identity: PromptIdentity | null): string | null {
  const c = identity?.primaryColor;
  return c && HEX_COLOR.test(c) && isReadableBrandColor(c) ? c : null;
}

export function IdentityHeader({
  identity,
  logoUrl,
  locale,
}: {
  identity: PromptIdentity | null;
  /** A local `blob:` object URL from usePromptIdentity; anything else is ignored. */
  logoUrl: string | null;
  /** Locale for the generic name when no identity is synced. */
  locale: string | null | undefined;
}) {
  const accent = brandAccent(identity);
  const style = accent ? ({ '--prompt-brand-accent': accent } as CSSProperties) : undefined;
  const logo = identity && logoUrl && logoUrl.startsWith('blob:') ? logoUrl : null;
  return (
    <div className="prompt-identity" data-testid="prompt-identity" data-accent={accent ? 'brand' : 'default'} style={style}>
      {logo && <img className="prompt-identity-logo" src={logo} alt="" draggable={false} />}
      <span className="prompt-identity-name">{identityDisplayName(identity, locale)}</span>
    </div>
  );
}
