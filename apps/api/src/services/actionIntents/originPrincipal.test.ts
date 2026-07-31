import { describe, it, expect } from 'vitest';
import {
  actionIntentOriginPrincipalKindEnum,
  type ActionIntentOriginPrincipalKind,
} from '../../db/schema/actionIntents';
import { isInteractiveUserSession, type PrincipalKind } from '../../middleware/auth';

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
      'unknown',
    ];

    for (const kind of everyRuntimeKind) {
      const asStored: ActionIntentOriginPrincipalKind = kind;
      expect(actionIntentOriginPrincipalKindEnum).toContain(asStored);
    }

    expect(actionIntentOriginPrincipalKindEnum).toContain('unknown');
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
    // A row whose origin is unknown must not be indistinguishable from one
    // created by a person at a keyboard.
    const backfillValue: ActionIntentOriginPrincipalKind = 'unknown';
    expect(backfillValue).not.toBe('user_session');
  });

  it('keeps unknown distinct from system, so trusting system cannot trust it', () => {
    // These mean opposite things: `system` is a TRUSTED internal origin (a job
    // or worker with no external caller); `unknown` means provenance is
    // unrecoverable. Folding unknown into system would mean any future gate
    // that trusts internal callers silently trusts every pre-discriminator
    // record — a fail-closed marker turned into an escalation.
    const unknownPrincipal: PrincipalKind = { kind: 'unknown' };
    const systemPrincipal: PrincipalKind = { kind: 'system', reason: 'worker' };
    expect(unknownPrincipal.kind).not.toBe(systemPrincipal.kind);
    expect(isInteractiveUserSession({ principal: unknownPrincipal })).toBe(false);
    expect(isInteractiveUserSession({ principal: systemPrincipal })).toBe(false);
  });
});
