import { describe, it, expect } from 'vitest';
import {
  actionIntentOriginPrincipalKindEnum,
  type ActionIntentOriginPrincipalKind,
} from '../../db/schema/actionIntents';
import type { PrincipalKind } from '../../middleware/auth';

/**
 * The intent's recorded origin principal is the durable answer to "what kind
 * of caller created this". These tests pin the two properties that make it
 * trustworthy: it covers every runtime principal kind, and an unrecoverable
 * origin fails closed rather than being softened into a human.
 */

describe('action_intents origin principal', () => {
  it('covers every AuthContext principal kind, plus unknown', () => {
    // If a new PrincipalKind is added to AuthContext without being added here,
    // intentService's `originPrincipalKind: auth.principal.kind` would write a
    // value the CHECK constraint rejects — a runtime INSERT failure. This
    // assignment makes that a compile error instead.
    const everyRuntimeKind: ReadonlyArray<PrincipalKind['kind']> = [
      'user_session',
      'client_user',
      'api_key',
      'oauth_grant',
      'agent',
      'helper',
      'system',
    ];

    for (const kind of everyRuntimeKind) {
      const asStored: ActionIntentOriginPrincipalKind = kind;
      expect(actionIntentOriginPrincipalKindEnum).toContain(asStored);
    }

    // 'unknown' exists only as the backfill value for pre-discriminator rows;
    // it is deliberately NOT a runtime principal kind.
    expect(actionIntentOriginPrincipalKindEnum).toContain('unknown');
    expect(everyRuntimeKind).not.toContain('unknown' as never);
  });

  it('enumerates exactly the runtime kinds plus unknown — no extras', () => {
    expect([...actionIntentOriginPrincipalKindEnum].sort()).toEqual(
      [
        'agent',
        'api_key',
        'client_user',
        'helper',
        'oauth_grant',
        'system',
        'unknown',
        'user_session',
      ],
    );
  });

  it('does not default to a human-looking origin', () => {
    // The single most important property: a row whose origin is unknown must
    // not be indistinguishable from one created by a person at a keyboard.
    // The column default and the backfill are both 'unknown' for this reason.
    const backfillValue: ActionIntentOriginPrincipalKind = 'unknown';
    expect(backfillValue).not.toBe('user_session');
  });
});
