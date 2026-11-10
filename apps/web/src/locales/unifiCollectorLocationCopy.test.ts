import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The UniFi register form's field was renamed "Collector agent location"
// (#11520); the client-side validation message must use the same name.
const here = dirname(fileURLToPath(import.meta.url));
const locales = readdirSync(here, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

describe('integrations:unifiIntegration validation copy', () => {
  for (const locale of locales) {
    it(`${locale} names the field "collector agent location"`, () => {
      const json = JSON.parse(readFileSync(join(here, locale, 'integrations.json'), 'utf8'));
      const unifi = json.unifiIntegration;
      const message: string = unifi.pickTheSiteThisControllerServesACollector;
      expect(message.toLowerCase()).toContain(unifi.collectorAgentLocation.toLowerCase());
    });
  }
});
