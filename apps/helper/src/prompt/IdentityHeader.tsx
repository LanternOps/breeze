import type { CSSProperties } from 'react';

import { identityDisplayName, type PromptIdentity } from './identity';
import { brandAccentFor, useCardTheme, type CardTheme } from './theme';

/*
 * "Who is asking" (#10190, spec section 3.6): the MSP logo (if any) and name
 * above every prompt card. The name is plain text, never markup. The brand
 * colour becomes the header accent only when it is readable in the ACTIVE
 * theme (theme.ts, W04); otherwise the default Assist palette is used.
 * High contrast (forced-colors, prefers-contrast: more) and the OS text size
 * always win: see theme.ts and prompt.css (`.prompt-identity`, rem/em sizes,
 * the forced-colors and prefers-contrast blocks).
 */

/** The brand accent to use in `theme`, or null for the default palette. */
export function brandAccent(identity: PromptIdentity | null, theme: CardTheme): string | null {
  return brandAccentFor(identity?.primaryColor, theme);
}

export function IdentityHeader({
  identity,
  logoUrl,
  locale,
  theme,
}: {
  identity: PromptIdentity | null;
  /** A local `blob:` object URL from usePromptIdentity; anything else is ignored. */
  logoUrl: string | null;
  /** Locale for the generic name when no identity is synced. */
  locale: string | null | undefined;
  /** Tests pin it; in a window it follows the active theme. */
  theme?: CardTheme;
}) {
  const live = useCardTheme();
  const accent = brandAccent(identity, theme ?? live);
  const style = accent ? ({ '--prompt-brand-accent': accent } as CSSProperties) : undefined;
  const logo = identity && logoUrl && logoUrl.startsWith('blob:') ? logoUrl : null;
  return (
    <div className="prompt-identity" data-testid="prompt-identity" data-accent={accent ? 'brand' : 'default'} style={style}>
      {logo && <img className="prompt-identity-logo" src={logo} alt="" draggable={false} />}
      <span className="prompt-identity-name">{identityDisplayName(identity, locale)}</span>
    </div>
  );
}
