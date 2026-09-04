/**
 * `resolveImportPartnerId` is the shared partner gate for BOTH bulk-import
 * route families (`POST /orgs/import*` and `POST /orgs/contacts/import*`), and
 * its 400/403 copy is part of the wire contract for each. Until now it was
 * only ever exercised THROUGH those routes, so the one branch that actually
 * refuses a cross-tenant import — an org/partner token naming somebody else's
 * partner — had no test of its own on either side.
 *
 * Direct unit tests, with no Hono app and no mocks: the module is deliberately
 * free of database and schema imports precisely so this is possible.
 */
import { describe, expect, it } from 'vitest';
import { resolveImportPartnerId } from './importScope';
import type { AuthContext } from '../middleware/auth';

const PARTNER = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_PARTNER = 'bbbbbbbb-2222-4222-8222-222222222222';

/** Only the two fields the resolver reads; everything else is irrelevant here. */
function auth(scope: AuthContext['scope'], partnerId: string | null): AuthContext {
  return { scope, partnerId } as AuthContext;
}

describe('resolveImportPartnerId', () => {
  it('lets SYSTEM scope name any partner in the body', async () => {
    expect(resolveImportPartnerId(auth('system', null), OTHER_PARTNER, 'contacts'))
      .toEqual({ partnerId: OTHER_PARTNER });
  });

  it('falls back to the token partner when system scope names none', async () => {
    expect(resolveImportPartnerId(auth('system', PARTNER), undefined, 'contacts'))
      .toEqual({ partnerId: PARTNER });
  });

  it('refuses a system import with no partner anywhere as a 400', async () => {
    // Name resolution is partner-bounded, so there is no such thing as a
    // partnerless import — it would have to fall back to "every tenant".
    expect(resolveImportPartnerId(auth('system', null), undefined, 'contacts'))
      .toEqual({ error: 'partnerId is required for system scope', status: 400 });
  });

  it('refuses an ORGANIZATION token naming a different partner as a 403', async () => {
    // An organization token carries a partnerId but has no authority over its
    // siblings: honouring the body field would turn a cross-tenant write into
    // a 200.
    expect(resolveImportPartnerId(auth('organization', PARTNER), OTHER_PARTNER, 'contacts'))
      .toEqual({ error: 'Access denied to this partner', status: 403 });
  });

  it('refuses a PARTNER token naming a different partner as a 403', async () => {
    expect(resolveImportPartnerId(auth('partner', PARTNER), OTHER_PARTNER, 'organizations'))
      .toEqual({ error: 'Access denied to this partner', status: 403 });
  });

  it('pins a non-system caller to its own partner, echoed or not', async () => {
    expect(resolveImportPartnerId(auth('partner', PARTNER), undefined, 'contacts'))
      .toEqual({ partnerId: PARTNER });
    expect(resolveImportPartnerId(auth('organization', PARTNER), PARTNER, 'contacts'))
      .toEqual({ partnerId: PARTNER });
  });

  it('reports the missing partner context per subject, since the copy is the contract', async () => {
    expect(resolveImportPartnerId(auth('partner', null), undefined, 'contacts'))
      .toEqual({ error: 'Partner context required to import contacts', status: 400 });
    expect(resolveImportPartnerId(auth('partner', null), undefined, 'organizations'))
      .toEqual({ error: 'Partner context required to import organizations', status: 400 });
  });
});
