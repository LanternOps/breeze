import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'];
// Payload templates were removed (#9691): the form edits URL, events, auth and
// headers, and a test sends a sample payload. Copy must not mention templates
// or "payload behavior".
const STALE = /template|modelo|plantilla|modèle|vorlage|şablon|behavior|comportamento|comportamiento|comportement|verhalten|davranış/i;

describe('webhook copy has no stale payload-template wording (#9691)', () => {
  for (const locale of LOCALES) {
    it(locale, () => {
      const d = JSON.parse(
        readFileSync(resolve(__dirname, `../../locales/${locale}/common.json`), 'utf8'),
      ).longTail.webhooks;
      expect(d.WebhookForm.subtitle).not.toMatch(STALE);
      expect(d.WebhooksPage.details.testEventHelp).not.toMatch(STALE);
    });
  }
});
