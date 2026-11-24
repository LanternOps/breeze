import { describe, expect, it } from 'vitest';
import {
  flowDraftCreateRequestSchema,
  flowDraftDeleteRequestSchema,
  flowDraftUpdateRequestSchema,
  flowDraftValidateRequestSchema,
} from './flowDrafts';
import * as barrel from './index';

const DOC = { version: 1, name: 'F', trigger: { type: 'manual' }, steps: [] };
const ORG = '33333333-3333-4333-8333-333333333333';

describe('flowDraftCreateRequestSchema', () => {
  it('accepts a document with an optional owner and slug', () => {
    expect(flowDraftCreateRequestSchema.parse({ document: DOC })).toEqual({ document: DOC });
    expect(flowDraftCreateRequestSchema.safeParse({ document: DOC, ownerScope: 'partner' }).success).toBe(true);
    expect(flowDraftCreateRequestSchema.safeParse({ document: DOC, ownerScope: 'organization', orgId: ORG, slug: 'my_flow' }).success).toBe(true);
  });

  it('requires the document to be an object', () => {
    expect(flowDraftCreateRequestSchema.safeParse({}).success).toBe(false);
    expect(flowDraftCreateRequestSchema.safeParse({ document: [] }).success).toBe(false);
    expect(flowDraftCreateRequestSchema.safeParse({ document: 'x' }).success).toBe(false);
  });

  it('rejects an unknown owner scope and a non-uuid orgId', () => {
    expect(flowDraftCreateRequestSchema.safeParse({ document: DOC, ownerScope: 'system' }).success).toBe(false);
    expect(flowDraftCreateRequestSchema.safeParse({ document: DOC, orgId: 'nope' }).success).toBe(false);
  });

  it('leaves slug rules to the service (invalid_slug), but bounds its length', () => {
    expect(flowDraftCreateRequestSchema.safeParse({ document: DOC, slug: 'Not A Slug' }).success).toBe(true);
    expect(flowDraftCreateRequestSchema.safeParse({ document: DOC, slug: '' }).success).toBe(false);
    expect(flowDraftCreateRequestSchema.safeParse({ document: DOC, slug: 'a'.repeat(201) }).success).toBe(false);
  });

  it('is strict: a flowId or expectedVersion on create is refused', () => {
    expect(flowDraftCreateRequestSchema.safeParse({ document: DOC, flowId: ORG }).success).toBe(false);
    expect(flowDraftCreateRequestSchema.safeParse({ document: DOC, expectedVersion: 1 }).success).toBe(false);
  });
});

describe('flowDraftUpdateRequestSchema', () => {
  it('requires expectedVersion', () => {
    expect(flowDraftUpdateRequestSchema.safeParse({ document: DOC }).success).toBe(false);
    expect(flowDraftUpdateRequestSchema.parse({ document: DOC, expectedVersion: 3 })).toEqual({ document: DOC, expectedVersion: 3 });
  });

  it('rejects expectedVersion < 1 or fractional', () => {
    expect(flowDraftUpdateRequestSchema.safeParse({ document: DOC, expectedVersion: 0 }).success).toBe(false);
    expect(flowDraftUpdateRequestSchema.safeParse({ document: DOC, expectedVersion: 1.5 }).success).toBe(false);
  });

  it('is strict: the owner never changes on update', () => {
    expect(flowDraftUpdateRequestSchema.safeParse({ document: DOC, expectedVersion: 1, ownerScope: 'partner' }).success).toBe(false);
    expect(flowDraftUpdateRequestSchema.safeParse({ document: DOC, expectedVersion: 1, orgId: ORG }).success).toBe(false);
    expect(flowDraftUpdateRequestSchema.safeParse({ document: DOC, expectedVersion: 1, slug: 'x_y' }).success).toBe(false);
  });
});

describe('flowDraftDeleteRequestSchema', () => {
  it('requires expectedVersion ≥ 1 and nothing else', () => {
    expect(flowDraftDeleteRequestSchema.safeParse({}).success).toBe(false);
    expect(flowDraftDeleteRequestSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
    expect(flowDraftDeleteRequestSchema.parse({ expectedVersion: 2 })).toEqual({ expectedVersion: 2 });
    expect(flowDraftDeleteRequestSchema.safeParse({ expectedVersion: 2, force: true }).success).toBe(false);
  });
});

describe('flowDraftValidateRequestSchema', () => {
  it('accepts a document with an optional owner or flowId', () => {
    expect(flowDraftValidateRequestSchema.safeParse({ document: DOC }).success).toBe(true);
    expect(flowDraftValidateRequestSchema.safeParse({ document: DOC, flowId: ORG }).success).toBe(true);
    expect(flowDraftValidateRequestSchema.safeParse({ document: DOC, ownerScope: 'organization', orgId: ORG }).success).toBe(true);
  });

  it('rejects a non-uuid flowId and unknown keys', () => {
    expect(flowDraftValidateRequestSchema.safeParse({ document: DOC, flowId: 'nope' }).success).toBe(false);
    expect(flowDraftValidateRequestSchema.safeParse({ document: DOC, expectedVersion: 1 }).success).toBe(false);
  });
});

describe('validators barrel', () => {
  it('exports the four draft request schemas', () => {
    expect(barrel.flowDraftCreateRequestSchema).toBe(flowDraftCreateRequestSchema);
    expect(barrel.flowDraftUpdateRequestSchema).toBe(flowDraftUpdateRequestSchema);
    expect(barrel.flowDraftDeleteRequestSchema).toBe(flowDraftDeleteRequestSchema);
    expect(barrel.flowDraftValidateRequestSchema).toBe(flowDraftValidateRequestSchema);
  });
});
