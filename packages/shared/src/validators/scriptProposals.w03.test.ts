import { describe, expect, it } from 'vitest';
import {
  scriptProposalRequestChangesSchema,
  scriptProposalPromoteSchema,
  acknowledgedPatternsSchema,
  MAX_ACKNOWLEDGED_PATTERNS,
} from './scriptProposals';

describe('scriptProposalRequestChangesSchema', () => {
  it('requires a non-empty trimmed note', () => {
    expect(scriptProposalRequestChangesSchema.safeParse({ note: '   ' }).success).toBe(false);
    expect(scriptProposalRequestChangesSchema.safeParse({}).success).toBe(false);
  });
  it('caps the note at 2000 characters', () => {
    expect(scriptProposalRequestChangesSchema.safeParse({ note: 'x'.repeat(2001) }).success).toBe(false);
    expect(scriptProposalRequestChangesSchema.parse({ note: '  fix the path  ' })).toEqual({ note: 'fix the path' });
  });
});

describe('scriptProposalPromoteSchema', () => {
  it('accepts both owner scopes and trims the name', () => {
    expect(scriptProposalPromoteSchema.parse({ name: ' Restart spooler ', ownerScope: 'partner' }))
      .toEqual({ name: 'Restart spooler', ownerScope: 'partner' });
    expect(scriptProposalPromoteSchema.parse({ name: 'A', ownerScope: 'organization', description: 'd' }).description)
      .toBe('d');
  });
  it('rejects an unknown owner scope and an empty name', () => {
    expect(scriptProposalPromoteSchema.safeParse({ name: 'A', ownerScope: 'site' }).success).toBe(false);
    expect(scriptProposalPromoteSchema.safeParse({ name: '', ownerScope: 'organization' }).success).toBe(false);
  });
});

describe('acknowledgedPatternsSchema', () => {
  it('defaults to an empty array and caps the length', () => {
    expect(acknowledgedPatternsSchema.parse(undefined)).toEqual([]);
    expect(acknowledgedPatternsSchema.safeParse(new Array(MAX_ACKNOWLEDGED_PATTERNS + 1).fill('x')).success).toBe(false);
  });
});
