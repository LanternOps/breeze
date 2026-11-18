import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * #9674: Settings > Partner > Branding help copy must describe what the
 * product does.
 * - The logo encoder (lib/logoDataUrl.ts, LOGO_MAX_SIDES) keeps up to 800 px on
 *   the long side; "resized to fit 256×256" was never true.
 * - The partner Custom CSS reaches every child org's portal ahead of the org's
 *   own CSS (apps/api/src/routes/portal/portalCustomCss.ts), and the write path
 *   rejects @import and non-HTTPS url(), so the help names both.
 */

const localesDir = dirname(fileURLToPath(import.meta.url));
const LOCALES = ['de-DE', 'en', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'] as const;

function partnerBranding(locale: string): Record<string, string> {
  const json = JSON.parse(readFileSync(join(localesDir, locale, 'settings.json'), 'utf8'));
  return json.partnerBranding;
}

describe('partnerBranding help copy (#9674)', () => {
  it.each(LOCALES)('%s: logo help states the 800 px encoder limit, not 256×256', (locale) => {
    const { imageHelp } = partnerBranding(locale);
    expect(imageHelp).toContain('800');
    expect(imageHelp).toContain('400');
    expect(imageHelp).not.toMatch(/256/);
  });

  it.each(LOCALES)('%s: Custom CSS help names the rejected @import and url() patterns', (locale) => {
    const { customCssHelp } = partnerBranding(locale);
    expect(customCssHelp).toContain('@import');
    expect(customCssHelp).toContain('url()');
  });
});
