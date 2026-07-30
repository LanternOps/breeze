import { getM365PermissionProfile } from '@breeze/shared/m365';
import { describe, expect, it } from 'vitest';
import { reconcileCommunicationsDelegated } from './reconcile';

describe('reconcileCommunicationsDelegated', () => {
  it('accepts the complete set in bare form', () => {
    expect(reconcileCommunicationsDelegated(['User.Read', 'Mail.ReadWrite', 'Mail.Send']))
      .toEqual({ complete: true, missingScopes: [] });
  });

  it('accepts the complete set in resource-qualified form', () => {
    expect(reconcileCommunicationsDelegated([
      'https://graph.microsoft.com/User.Read',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
    ])).toEqual({ complete: true, missingScopes: [] });
  });

  it('reports a missing Mail.Send (decision 5: fail the consent closed)', () => {
    expect(reconcileCommunicationsDelegated(['User.Read', 'Mail.ReadWrite']))
      .toEqual({ complete: false, missingScopes: ['Mail.Send'] });
  });

  it('ignores extra scopes from pre-existing consents', () => {
    expect(reconcileCommunicationsDelegated([
      'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'openid', 'profile',
    ])).toEqual({ complete: true, missingScopes: [] });
  });

  it('compares case-insensitively', () => {
    expect(reconcileCommunicationsDelegated(['user.read', 'MAIL.READWRITE', 'mail.send']))
      .toEqual({ complete: true, missingScopes: [] });
  });

  it('derives its requirements from the real profile — a v3 profile changes this loudly', () => {
    const required = getM365PermissionProfile('communications-delegated')
      .delegatedPermissions
      .filter((scope) => !['openid', 'profile', 'offline_access'].includes(scope));
    expect(required).toEqual(['User.Read', 'Mail.ReadWrite', 'Mail.Send']);
    expect(reconcileCommunicationsDelegated(required)).toEqual({ complete: true, missingScopes: [] });
    // Dropping ANY required scope fails closed.
    for (const dropped of required) {
      const partial = required.filter((scope) => scope !== dropped);
      expect(reconcileCommunicationsDelegated(partial))
        .toEqual({ complete: false, missingScopes: [dropped] });
    }
  });
});
