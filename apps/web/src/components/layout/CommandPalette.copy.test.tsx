import { describe, expect, it } from 'vitest';
import { i18n } from '../../lib/i18n';

describe('command palette copy', () => {
  it('does not promise user search (GET /search returns devices, scripts, alerts only)', async () => {
    await i18n.changeLanguage('en');
    for (const key of ['layout.search.placeholder', 'layout.search.startTyping']) {
      expect(i18n.t(key, { ns: 'common' })).not.toMatch(/users/i);
    }
  });
});
