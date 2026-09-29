import { describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import { CONTACT_ROLES, CONTACT_ROLE_LABEL_KEYS } from './contactRoles';

describe('contact roles', () => {
  it('lists the API vocabulary (apps/api/src/services/contacts/types.ts CONTACT_ROLES)', () => {
    expect(CONTACT_ROLES).toEqual(['billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal']);
  });
  it('has an English label for every role in the settings namespace', () => {
    for (const role of CONTACT_ROLES) {
      expect(i18n.exists(`settings:${CONTACT_ROLE_LABEL_KEYS[role]}`), role).toBe(true);
    }
  });
});
