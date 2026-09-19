import { describe, expect, it } from 'vitest';
import {
  listDocumentsQuerySchema,
  orgDocumentCategorySchema,
  replaceDocumentMetaSchema,
  updateDocumentSchema,
  uploadDocumentMetaSchema,
} from './orgDocuments';

describe('orgDocuments validators (service deliverables W03)', () => {
  it('portalVisible defaults to false — fail closed', () => {
    const r = uploadDocumentMetaSchema.parse({ title: 'Runbook' });
    expect(r.portalVisible).toBe(false);
    expect(r.category).toBe('other');
  });

  it('coerces multipart string booleans', () => {
    expect(uploadDocumentMetaSchema.parse({ title: 'x', portalVisible: 'true' }).portalVisible).toBe(true);
    expect(uploadDocumentMetaSchema.parse({ title: 'x', portalVisible: 'false' }).portalVisible).toBe(false);
    expect(uploadDocumentMetaSchema.safeParse({ title: 'x', portalVisible: 'yes' }).success).toBe(false);
  });

  it('rejects a 201-character title and an empty title', () => {
    expect(uploadDocumentMetaSchema.safeParse({ title: 'a'.repeat(201) }).success).toBe(false);
    expect(uploadDocumentMetaSchema.safeParse({ title: '' }).success).toBe(false);
    expect(uploadDocumentMetaSchema.safeParse({ title: 'a'.repeat(200) }).success).toBe(true);
  });

  it('rejects an unknown category', () => {
    expect(orgDocumentCategorySchema.safeParse('secret').success).toBe(false);
    expect(uploadDocumentMetaSchema.safeParse({ title: 'x', category: 'secret' }).success).toBe(false);
  });

  it('replace metadata is fully optional and applies no defaults (omitted fields inherit)', () => {
    const r = replaceDocumentMetaSchema.parse({});
    expect(r).toEqual({});
  });

  it('update rejects an empty patch and an unknown key', () => {
    expect(updateDocumentSchema.safeParse({}).success).toBe(false);
    expect(updateDocumentSchema.safeParse({ title: 'x', storageKey: 'org-documents/evil' }).success).toBe(false);
    expect(updateDocumentSchema.safeParse({ portalVisible: true }).success).toBe(true);
  });

  it('list query parses includeSuperseded from the query string strictly', () => {
    expect(listDocumentsQuerySchema.parse({ includeSuperseded: 'true' }).includeSuperseded).toBe(true);
    expect(listDocumentsQuerySchema.parse({ includeSuperseded: 'false' }).includeSuperseded).toBe(false);
    expect(listDocumentsQuerySchema.parse({}).includeSuperseded).toBeUndefined();
  });
});
