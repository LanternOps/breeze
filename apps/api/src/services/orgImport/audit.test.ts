import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeRouteAudit } from '../auditEvents';
import { DEFAULT_IMPORT_SYSTEM } from './index';
import { AUDIT_FALLBACK_IMPORT_SYSTEM, writeOrgImportAudits } from './audit';
import type { OrgImportSummary } from './types';

vi.mock('../auditEvents', () => ({ writeRouteAudit: vi.fn() }));

const writeRouteAuditMock = vi.mocked(writeRouteAudit);

// The helper only ever reads `c` to hand it straight to writeRouteAudit.
const ctx = {} as Parameters<typeof writeOrgImportAudits>[0];

const emptySummary = (): OrgImportSummary => ({
  imported: [],
  updated: [],
  skipped: [],
  errors: []
});

/** Every (action, details.source) pair emitted, in order. */
function emitted() {
  return writeRouteAuditMock.mock.calls.map(([, event]) => ({
    action: event.action,
    orgId: event.orgId,
    resourceType: event.resourceType,
    details: event.details
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

it('keeps its duplicated fallback in step with the pipeline constant', () => {
  // audit.ts deliberately does not import the pipeline barrel (route suites
  // mock it wholesale), so this is the guard against the copies drifting.
  expect(AUDIT_FALLBACK_IMPORT_SYSTEM).toBe(DEFAULT_IMPORT_SYSTEM);
});

describe('writeOrgImportAudits — created rows', () => {
  it('emits organization, link, and site events for a created org', () => {
    const summary = emptySummary();
    summary.imported = [
      {
        index: 0,
        organization: 'Acme',
        organizationId: 'org-1',
        siteId: 'site-1',
        siteName: 'Acme HQ',
        createdOrganization: true,
        createdLink: true,
        slug: 'acme'
      }
    ];

    writeOrgImportAudits(ctx, {
      summary,
      rows: [{ externalSystem: 'connectwise', externalId: 'CW-1' }],
      partnerId: 'partner-1',
      source: 'psa_import'
    });

    expect(emitted()).toEqual([
      {
        action: 'organization.create',
        orgId: 'org-1',
        resourceType: 'organization',
        details: { partnerId: 'partner-1', source: 'psa_import', slug: 'acme' }
      },
      {
        action: 'organization.external_link.create',
        orgId: 'org-1',
        resourceType: 'organization_external_link',
        details: { system: 'connectwise', externalId: 'CW-1', source: 'psa_import' }
      },
      {
        action: 'site.create',
        orgId: 'org-1',
        resourceType: 'site',
        details: { source: 'psa_import' }
      }
    ]);
  });

  it('does not emit an organization.create for a group follow-up row', () => {
    const summary = emptySummary();
    summary.imported = [
      {
        index: 1,
        organization: 'Acme',
        organizationId: 'org-1',
        siteId: 'site-2',
        siteName: 'Acme Depot',
        createdOrganization: false,
        createdLink: false,
        slug: null
      }
    ];

    writeOrgImportAudits(ctx, { summary, rows: [], partnerId: 'p', source: 'org_import' });

    expect(emitted().map((e) => e.action)).toEqual(['site.create']);
  });

  it('falls back to the default system when the row carries none', () => {
    const summary = emptySummary();
    summary.imported = [
      {
        index: 0,
        organization: 'Acme',
        organizationId: 'org-1',
        siteId: null,
        siteName: null,
        createdOrganization: false,
        createdLink: true,
        slug: null
      }
    ];

    writeOrgImportAudits(ctx, { summary, rows: [{}], partnerId: 'p', source: 'org_import' });

    expect(emitted()[0]!.details).toEqual({
      system: DEFAULT_IMPORT_SYSTEM,
      externalId: undefined,
      source: 'org_import'
    });
  });
});

describe('writeOrgImportAudits — updated rows', () => {
  const updatedRow = (over: Partial<OrgImportSummary['updated'][number]> = {}) => ({
    index: 0,
    organization: 'Acme',
    organizationId: 'org-1',
    siteId: null,
    siteName: null,
    createdSite: false,
    createdLink: false,
    reactivated: false,
    ...over
  });

  it('emits a reactivate event', () => {
    const summary = emptySummary();
    summary.updated = [updatedRow({ reactivated: true })];

    writeOrgImportAudits(ctx, { summary, rows: [{}], partnerId: 'p', source: 'psa_import' });

    expect(emitted().map((e) => e.action)).toEqual(['organization.reactivate']);
  });

  it('emits site.create only when a site was actually created', () => {
    const summary = emptySummary();
    summary.updated = [updatedRow({ siteId: 'site-9', siteName: 'Branch', createdSite: true })];

    writeOrgImportAudits(ctx, { summary, rows: [{}], partnerId: 'p', source: 'psa_import' });

    expect(emitted().map((e) => e.action)).toEqual(['site.create']);
  });

  it('falls back to a plain organization.update when nothing else happened', () => {
    const summary = emptySummary();
    summary.updated = [updatedRow()];

    writeOrgImportAudits(ctx, { summary, rows: [{}], partnerId: 'p', source: 'psa_import' });

    expect(emitted().map((e) => e.action)).toEqual(['organization.update']);
  });

  it('does NOT emit organization.update when a link was created', () => {
    const summary = emptySummary();
    summary.updated = [updatedRow({ createdLink: true })];

    writeOrgImportAudits(ctx, {
      summary,
      rows: [{ externalSystem: 'zendesk', externalId: '7' }],
      partnerId: 'p',
      source: 'psa_import'
    });

    expect(emitted().map((e) => e.action)).toEqual(['organization.external_link.create']);
  });
});

it('emits nothing for a summary that only skipped or errored', () => {
  const summary = emptySummary();
  summary.skipped = [
    { index: 0, organization: 'Acme', organizationId: 'org-1', reason: 'already_linked', createdLink: false }
  ];
  summary.errors = [{ index: 1, organization: 'Globex', error: 'nope', code: 'row-conflict' }];

  writeOrgImportAudits(ctx, { summary, rows: [{}, {}], partnerId: 'p', source: 'psa_import' });

  expect(writeRouteAuditMock).not.toHaveBeenCalled();
});
