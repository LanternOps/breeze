import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('browser binding key rotation documentation contract', () => {
  it('requires staged activation and retention while C1 cookies or transition rows can exist', () => {
    const guide = readFileSync(
      new URL('../../../../docs/SECRET_ROTATION.md', import.meta.url),
      'utf8',
    );

    expect(guide).toContain('### Browser authentication binding key rotation');
    expect(guide).toContain('auth_browser_transitions');
    expect(guide).toContain('APP_ENCRYPTION_KEYRING');
    expect(guide).toMatch(/never remove a retained binding key while.*C1 cookies/is);
    expect(guide).toMatch(/deploy.*old and new keys.*every API replica/is);
    expect(guide).toMatch(/only then switch.*APP_ENCRYPTION_KEY_ID/is);
  });
});
