import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbSelectMock()),
          orderBy: vi.fn(() => dbSelectMock())
        }))
      }))
    }))
  }
}));

import { applyIntakeForm, getTicketFormForOrg, TicketFormError } from './ticketFormService';

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
    dbSelectMock.mockResolvedValue([]);
    await expect(getTicketFormForOrg('nope', { id: 'org-1', partnerId: 'p-1' })).rejects.toMatchObject({ status: 404 });
  });

  it('400 when the form belongs to another tenant', async () => {
    dbSelectMock.mockResolvedValue([{ ...(form as object), partnerId: 'p-OTHER' }]);
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).rejects.toMatchObject({ status: 400 });
  });

  it('400 when inactive; resolves when partner-wide matches the org partner', async () => {
    dbSelectMock.mockResolvedValue([{ ...(form as object), isActive: false }]);
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).rejects.toMatchObject({ status: 400 });
    dbSelectMock.mockResolvedValue([form]);
    await expect(getTicketFormForOrg('form-1', { id: 'org-1', partnerId: 'p-1' })).resolves.toMatchObject({ id: 'form-1' });
  });
});
