import { describe, it, expect } from 'vitest';
import {
  createContractTemplateSchema,
  updateContractTemplateSchema,
  createTemplateVersionSchema,
  contractVariableSchema,
  AUTO_CONTRACT_VARIABLES,
} from './contractTemplates';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

describe('createContractTemplateSchema', () => {
  it('accepts an organization-owned template with orgId', () => {
    const parsed = createContractTemplateSchema.parse({
      name: 'MSA Template', ownerScope: 'organization', orgId: ORG_ID,
    });
    expect(parsed.orgId).toBe(ORG_ID);
  });

  it('accepts a partner-owned template with no orgId', () => {
    const parsed = createContractTemplateSchema.parse({
      name: 'Partner-wide MSA', ownerScope: 'partner',
    });
    expect(parsed.orgId).toBeUndefined();
  });

  it('rejects ownerScope=organization without an orgId', () => {
    expect(createContractTemplateSchema.safeParse({
      name: 'MSA Template', ownerScope: 'organization',
    }).success).toBe(false);
  });

  it('rejects ownerScope=partner with an orgId set', () => {
    expect(createContractTemplateSchema.safeParse({
      name: 'MSA Template', ownerScope: 'partner', orgId: ORG_ID,
    }).success).toBe(false);
  });

  it('rejects a missing/empty name and an oversized description', () => {
    expect(createContractTemplateSchema.safeParse({
      name: '', ownerScope: 'partner',
    }).success).toBe(false);
    expect(createContractTemplateSchema.safeParse({
      name: 'x'.repeat(256), ownerScope: 'partner',
    }).success).toBe(false);
    expect(createContractTemplateSchema.safeParse({
      name: 'MSA', ownerScope: 'partner', description: 'y'.repeat(2001),
    }).success).toBe(false);
  });
});

describe('updateContractTemplateSchema', () => {
  it('accepts a partial name/description patch', () => {
    expect(updateContractTemplateSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(updateContractTemplateSchema.parse({}).name).toBeUndefined();
  });

  it('does not carry an ownership axis (immutable-by-omission)', () => {
    const parsed = updateContractTemplateSchema.parse({ name: 'x', ownerScope: 'partner', orgId: ORG_ID } as never);
    expect('ownerScope' in parsed).toBe(false);
    expect('orgId' in parsed).toBe(false);
  });
});

describe('createTemplateVersionSchema', () => {
  it('accepts non-empty bodyHtml within bounds', () => {
    expect(createTemplateVersionSchema.parse({ bodyHtml: '<p>Hi</p>' }).bodyHtml).toBe('<p>Hi</p>');
  });

  it('rejects empty bodyHtml', () => {
    expect(createTemplateVersionSchema.safeParse({ bodyHtml: '' }).success).toBe(false);
  });

  it('rejects bodyHtml over 200,000 chars', () => {
    expect(createTemplateVersionSchema.safeParse({ bodyHtml: 'x'.repeat(200_001) }).success).toBe(false);
    expect(createTemplateVersionSchema.safeParse({ bodyHtml: 'x'.repeat(200_000) }).success).toBe(true);
  });
});

describe('contractVariableSchema', () => {
  it('accepts a well-formed dotted lowercase variable name', () => {
    const parsed = contractVariableSchema.parse({ name: 'client.name', kind: 'auto' });
    expect(parsed.name).toBe('client.name');
  });

  it('accepts a manual variable with a label', () => {
    const parsed = contractVariableSchema.parse({ name: 'renewal_notice_days', kind: 'manual', label: 'Renewal notice (days)' });
    expect(parsed.kind).toBe('manual');
  });

  it('rejects uppercase names', () => {
    expect(contractVariableSchema.safeParse({ name: 'Client.Name', kind: 'auto' }).success).toBe(false);
  });

  it('rejects names with spaces or template-brace syntax', () => {
    expect(contractVariableSchema.safeParse({ name: 'client name', kind: 'auto' }).success).toBe(false);
    expect(contractVariableSchema.safeParse({ name: '{{client.name}}', kind: 'auto' }).success).toBe(false);
  });

  it('rejects a name starting with a digit or underscore', () => {
    expect(contractVariableSchema.safeParse({ name: '1name', kind: 'auto' }).success).toBe(false);
    expect(contractVariableSchema.safeParse({ name: '_name', kind: 'auto' }).success).toBe(false);
  });

  it('rejects an invalid kind', () => {
    expect(contractVariableSchema.safeParse({ name: 'client.name', kind: 'computed' }).success).toBe(false);
  });

  it('rejects a name over 64 chars', () => {
    expect(contractVariableSchema.safeParse({ name: 'a'.repeat(65), kind: 'auto' }).success).toBe(false);
    expect(contractVariableSchema.safeParse({ name: 'a'.repeat(64), kind: 'auto' }).success).toBe(true);
  });
});

describe('AUTO_CONTRACT_VARIABLES', () => {
  it('lists the documented auto-resolved variable names', () => {
    expect(AUTO_CONTRACT_VARIABLES).toEqual([
      'client.name', 'client.address', 'seller.name', 'quote.number', 'quote.title',
      'totals.one_time', 'totals.monthly', 'totals.annual', 'totals.total',
      'dates.effective', 'dates.expiry',
    ]);
  });

  it('every auto variable name satisfies contractVariableSchema\'s name regex', () => {
    for (const name of AUTO_CONTRACT_VARIABLES) {
      expect(contractVariableSchema.safeParse({ name, kind: 'auto' }).success).toBe(true);
    }
  });
});
