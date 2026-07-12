import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbSelectMock, insertValuesMock, deleteWhereMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  insertValuesMock: vi.fn(),
  deleteWhereMock: vi.fn()
}));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  // syncTicketFormOrgLinks runs on the ambient request transaction when one
  // exists (the FK-seam fix); a truthy context makes it use `db` directly,
  // which is the mocked query builder these tests assert against.
  getCurrentDbAccessContext: () => ({ scope: 'partner' }),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbSelectMock()),
          orderBy: vi.fn(() => dbSelectMock())
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        insertValuesMock(v);
        return Promise.resolve();
      })
    })),
    delete: vi.fn(() => ({
      where: vi.fn((...args: unknown[]) => {
        deleteWhereMock(...args);
        return Promise.resolve();
      })
    }))
  }
}));

import {
  applyIntakeForm,
  getTicketFormForOrg,
  getTicketFormOrgLinkMap,
  syncTicketFormOrgLinks,
  TicketFormError
} from './ticketFormService';

const form = {
  id: 'form-1',
  orgId: null,
  partnerId: 'p-1',
  name: 'New user onboarding',
  description: null,
  categoryId: 'cat-1',
  fields: [
    { key: 'affected_user', label: 'Affected user', type: 'text', required: true },
    { key: 'needs_vpn', label: 'Needs VPN', type: 'checkbox', required: false }
  ],
  titleTemplate: 'Onboard {{affected_user}}',
  descriptionIntro: 'HR request.',
  defaultPriority: 'high',
  defaultTags: ['onboarding'],
  showInPortal: true,
  isActive: true,
  sortOrder: 0,
  version: 2,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date()
} as never;

describe('applyIntakeForm', () => {
  it('validates, composes subject/description, and snapshots responses', () => {
    const r = applyIntakeForm(form, { affected_user: 'jdoe@client.example', needs_vpn: true });
    expect(r.subjectFromForm).toBe('Onboard jdoe@client.example');
    expect(r.descriptionBlock).toContain('HR request.');
    expect(r.descriptionBlock).toContain('- **Affected user:** jdoe@client.example');
    expect(r.categoryId).toBe('cat-1');
    expect(r.defaultPriority).toBe('high');
    expect(r.defaultTags).toEqual(['onboarding']);
    expect(r.intakeSnapshot).toEqual({
      intakeForm: {
        formId: 'form-1',
        formName: 'New user onboarding',
        formVersion: 2,
        responses: { affected_user: 'jdoe@client.example', needs_vpn: true }
      }
    });
  });

  it('throws TicketFormError 400 with field detail on invalid responses', () => {
    try {
      applyIntakeForm(form, { needs_vpn: 'yes' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TicketFormError);
      expect((err as TicketFormError).status).toBe(400);
      expect((err as TicketFormError).message).toContain('affected_user');
    }
  });
});

describe('getTicketFormForOrg', () => {
  beforeEach(() => vi.clearAllMocks());

  it('404 when missing', async () => {
    dbSelectMock.mockResolvedValueOnce([]);
    await expect(getTicketFormForOrg('nope', { id: 'org-1', partnerId: 'p-1' })).rejects.toMatchObject({ status: 404 });
  });

  it('400 when the form belongs to another tenant (org-owned-elsewhere AND partner-wide-elsewhere both fail)', async () => {
    dbSelectMock.mockResolvedValueOnce([{ ...(form as object), partnerId: 'p-OTHER' }]);
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).rejects.toMatchObject({ status: 400 });
    // Only the single form select ran — a tenant mismatch never reaches the
    // allowlist check.
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });

  it('org-owned forms skip the allowlist check entirely (single select)', async () => {
    const orgOwned = { ...(form as object), orgId: 'org-1', partnerId: null };
    dbSelectMock.mockResolvedValueOnce([orgOwned]);
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).resolves.toMatchObject({ id: 'form-1' });
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });

  // isOrgAllowedForPartnerWideForm now issues ONE query with two EXISTS
  // probes (anyLinks / linkForOrg) instead of fetching up to 500 link rows
  // and doing the membership check in JS — see ticketFormService.ts. The
  // second dbSelectMock resolution below stands in for that probe's row.
  it('resolves when partner-wide form has no link rows (allowlist not in effect)', async () => {
    dbSelectMock.mockResolvedValueOnce([form]); // form select
    dbSelectMock.mockResolvedValueOnce([{ anyLinks: false, linkForOrg: false }]); // probe: no links
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).resolves.toMatchObject({ id: 'form-1' });
  });

  it('resolves when partner-wide form has link rows that include this org', async () => {
    dbSelectMock.mockResolvedValueOnce([form]);
    dbSelectMock.mockResolvedValueOnce([{ anyLinks: true, linkForOrg: true }]); // probe: links exist, org included
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).resolves.toMatchObject({ id: 'form-1' });
  });

  it('400 (tenant-miss message, deliberately indistinguishable) when partner-wide form has link rows that EXCLUDE this org', async () => {
    dbSelectMock.mockResolvedValueOnce([form]);
    dbSelectMock.mockResolvedValueOnce([{ anyLinks: true, linkForOrg: false }]); // probe: links exist, org excluded
    const err = await getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(TicketFormError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Ticket form is not available for this organization');
  });

  it('400 when inactive (isActive is checked after the allowlist passes)', async () => {
    dbSelectMock.mockResolvedValueOnce([{ ...(form as object), isActive: false }]);
    dbSelectMock.mockResolvedValueOnce([{ anyLinks: false, linkForOrg: false }]); // no links — allowlist passes
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).rejects.toMatchObject({ status: 400 });
  });

  it('requirePortalVisible: 400 when showInPortal is false', async () => {
    const orgOwned = { ...(form as object), orgId: 'org-1', partnerId: null, showInPortal: false };
    dbSelectMock.mockResolvedValueOnce([orgOwned]);
    const err = await getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' }, { requirePortalVisible: true }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(TicketFormError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Ticket form is not available in the portal');
  });

  it('requirePortalVisible: resolves when showInPortal is true', async () => {
    const orgOwned = { ...(form as object), orgId: 'org-1', partnerId: null, showInPortal: true };
    dbSelectMock.mockResolvedValueOnce([orgOwned]);
    await expect(
      getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' }, { requirePortalVisible: true })
    ).resolves.toMatchObject({ id: 'form-1' });
  });

  it('requirePortalVisible absent: does not enforce portal visibility even when showInPortal is false', async () => {
    const orgOwned = { ...(form as object), orgId: 'org-1', partnerId: null, showInPortal: false };
    dbSelectMock.mockResolvedValueOnce([orgOwned]);
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).resolves.toMatchObject({ id: 'form-1' });
  });
});

describe('syncTicketFormOrgLinks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('null orgIds deletes all links and never validates orgs or inserts', async () => {
    await syncTicketFormOrgLinks('form-1', null, 'p-1');
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
    expect(dbSelectMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  // Not a distinct "allowlist nobody" state (routes normalize [] -> null
  // before calling this) — an empty array converges on the exact same
  // zero-row result as null, since both delete all links and insert nothing.
  it('empty array converges on the same zero-row result as null: deletes all, skips org validation and insert', async () => {
    await syncTicketFormOrgLinks('form-1', [], 'p-1');
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
    expect(dbSelectMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('non-empty array: validates every org belongs to partnerId, dedupes, then replaces (delete + insert)', async () => {
    dbSelectMock.mockResolvedValueOnce([
      { id: 'org-a', partnerId: 'p-1' },
      { id: 'org-b', partnerId: 'p-1' }
    ]);
    await syncTicketFormOrgLinks('form-1', ['org-a', 'org-b', 'org-a'], 'p-1');
    expect(deleteWhereMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const inserted = insertValuesMock.mock.calls[0]![0] as Array<{ formId: string; orgId: string }>;
    expect(inserted).toHaveLength(2); // deduped
    expect(inserted.map((r) => r.orgId).sort()).toEqual(['org-a', 'org-b']);
    expect(inserted.every((r) => r.formId === 'form-1')).toBe(true);
  });

  it('throws when an org belongs to a different partner (write aborted before delete/insert)', async () => {
    dbSelectMock.mockResolvedValueOnce([{ id: 'org-a', partnerId: 'p-OTHER' }]);
    const err = await syncTicketFormOrgLinks('form-1', ['org-a'], 'p-1').catch((e) => e);
    expect(err).toBeInstanceOf(TicketFormError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('visibleOrgIds must reference organizations of the owning partner');
    expect(deleteWhereMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('throws when an org id does not exist at all', async () => {
    dbSelectMock.mockResolvedValueOnce([]); // org-a not found
    const err = await syncTicketFormOrgLinks('form-1', ['org-a'], 'p-1').catch((e) => e);
    expect(err).toBeInstanceOf(TicketFormError);
    expect(err.status).toBe(400);
    expect(deleteWhereMock).not.toHaveBeenCalled();
  });
});

describe('getTicketFormOrgLinkMap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns an empty map without querying when formIds is empty', async () => {
    const map = await getTicketFormOrgLinkMap([]);
    expect(map.size).toBe(0);
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('returns a map keyed only by forms that have link rows', async () => {
    dbSelectMock.mockResolvedValueOnce([
      { formId: 'f1', orgId: 'o1' },
      { formId: 'f1', orgId: 'o2' },
      { formId: 'f2', orgId: 'o3' }
    ]);
    const map = await getTicketFormOrgLinkMap(['f1', 'f2', 'f3']);
    expect(map.get('f1')).toEqual(['o1', 'o2']);
    expect(map.get('f2')).toEqual(['o3']);
    expect(map.has('f3')).toBe(false);
  });
});
