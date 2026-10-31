import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const locales = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'];
describe('Wisp working-set copy', () => {
  it.each(locales)('%s supplies talk and working-set copy without retired link-button keys', (locale) => {
    const ai = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), `../../locales/${locale}/ai.json`), 'utf8'));
    for (const key of ['button', 'buttonPlain', 'draft', 'switchFocus', 'openFailed']) expect(ai.wisp.talk?.[key]).toBeTruthy();
    // wisp.links.neighbours is reserved copy: intentionally unused until W02 (W04-D1).
    for (const key of ['groupPinned', 'groupConcerns', 'groupRecent', 'pin', 'dismiss', 'more', 'neighbours']) expect(ai.wisp.links[key]).toBeTruthy();
    expect(ai.wisp.talk.openFailed).toContain('{{message}}');
    expect(ai.wisp.talk.draft).toContain('{{label}}');
    expect(ai.wisp.talk.draft.endsWith(': ')).toBe(true);
    expect(ai.wisp.talk.switchFocus).toContain('{{from}}');
    expect(ai.wisp.talk.switchFocus).toContain('{{to}}');
    expect(ai.wisp.linkButton).toBeUndefined();
  });
});
