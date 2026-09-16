import { describe, it, expect } from 'vitest';
import {
  checklistItemCreateSchema,
  checklistItemPatchSchema,
  checklistReorderSchema,
  createChecklistTemplateSchema,
  updateChecklistTemplateSchema,
  createChecklistTemplateItemSchema,
  updateChecklistTemplateItemSchema,
  applyChecklistTemplateSchema,
} from './ticketChecklists';

const UUID = '3f2f1d8e-1111-4222-8333-444455556666';

describe('checklistItemCreateSchema', () => {
  it('accepts a label alone', () => {
    expect(checklistItemCreateSchema.parse({ label: 'Check the sign-in log' })).toEqual({
      label: 'Check the sign-in log',
    });
  });

  it('accepts a label with a detail note', () => {
    expect(checklistItemCreateSchema.parse({ label: 'Step', detail: 'Note' })).toEqual({
      label: 'Step',
      detail: 'Note',
    });
  });

  it('rejects an empty label', () => {
    expect(checklistItemCreateSchema.safeParse({ label: '' }).success).toBe(false);
  });

  it('rejects a label over 500 characters', () => {
    expect(checklistItemCreateSchema.safeParse({ label: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects unknown keys, including a forged attestation', () => {
    expect(
      checklistItemCreateSchema.safeParse({ label: 'Step', doneAt: new Date().toISOString() }).success,
    ).toBe(false);
    expect(checklistItemCreateSchema.safeParse({ label: 'Step', position: 3 }).success).toBe(false);
  });
});

describe('checklistItemPatchSchema', () => {
  it('accepts done on its own', () => {
    expect(checklistItemPatchSchema.parse({ done: true })).toEqual({ done: true });
  });

  it('accepts clearing detail to null', () => {
    expect(checklistItemPatchSchema.parse({ detail: null })).toEqual({ detail: null });
  });

  it('rejects an empty patch', () => {
    // An empty body would otherwise be a silent 200 that changed nothing.
    expect(checklistItemPatchSchema.safeParse({}).success).toBe(false);
  });

  it('REJECTS doneAt and doneByUserId from the request body', () => {
    // The attestation is computed server-side from the authenticated principal
    // and now(). Accepting either from the body would let a caller forge who
    // performed a compliance step, and when.
    expect(checklistItemPatchSchema.safeParse({ doneAt: new Date().toISOString() }).success).toBe(false);
    expect(checklistItemPatchSchema.safeParse({ doneByUserId: UUID }).success).toBe(false);
    expect(checklistItemPatchSchema.safeParse({ done: true, doneByUserId: UUID }).success).toBe(false);
  });

  it('rejects position — ordering is whole-list only', () => {
    expect(checklistItemPatchSchema.safeParse({ position: 3 }).success).toBe(false);
  });

  it('rejects an empty label on a patch too', () => {
    expect(checklistItemPatchSchema.safeParse({ label: '' }).success).toBe(false);
  });
});

describe('checklistReorderSchema', () => {
  it('accepts a non-empty id list', () => {
    expect(checklistReorderSchema.parse({ itemIds: [UUID] })).toEqual({ itemIds: [UUID] });
  });

  it('rejects an empty list', () => {
    expect(checklistReorderSchema.safeParse({ itemIds: [] }).success).toBe(false);
  });

  it('rejects a non-uuid id', () => {
    expect(checklistReorderSchema.safeParse({ itemIds: ['nope'] }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(checklistReorderSchema.safeParse({ itemIds: [UUID], ticketId: UUID }).success).toBe(false);
  });
});

describe('createChecklistTemplateSchema', () => {
  it('defaults ownerScope to organization', () => {
    expect(createChecklistTemplateSchema.parse({ name: 'Device onboarding' }).ownerScope).toBe(
      'organization',
    );
  });

  it('accepts ownerScope partner', () => {
    expect(
      createChecklistTemplateSchema.parse({ name: 'X', ownerScope: 'partner' }).ownerScope,
    ).toBe('partner');
  });

  it('rejects an unknown ownerScope', () => {
    expect(
      createChecklistTemplateSchema.safeParse({ name: 'X', ownerScope: 'global' }).success,
    ).toBe(false);
  });

  it('defaults items to an empty array', () => {
    expect(createChecklistTemplateSchema.parse({ name: 'X' }).items).toEqual([]);
  });

  it('rejects an unknown key', () => {
    expect(createChecklistTemplateSchema.safeParse({ name: 'X', partnerId: UUID }).success).toBe(
      false,
    );
  });
});

describe('updateChecklistTemplateSchema', () => {
  it('OMITS ownerScope — ownership is create-only', () => {
    // CLAUDE.md Partner-Wide First step 2: an update schema derived via
    // .partial() MUST omit ownerScope, or a PATCH could re-home a template onto
    // the other axis and silently hand one org's private procedure to every org
    // under the partner (or vice versa).
    expect(updateChecklistTemplateSchema.safeParse({ ownerScope: 'partner' }).success).toBe(false);
  });

  it('OMITS orgId and items for the same reason', () => {
    expect(updateChecklistTemplateSchema.safeParse({ orgId: UUID }).success).toBe(false);
    expect(updateChecklistTemplateSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('accepts a partial name/description/instructions/isActive patch', () => {
    expect(updateChecklistTemplateSchema.parse({ isActive: false })).toEqual({ isActive: false });
    expect(updateChecklistTemplateSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });
});

describe('createChecklistTemplateItemSchema', () => {
  it('defaults sortOrder to 0', () => {
    expect(createChecklistTemplateItemSchema.parse({ label: 'Step' }).sortOrder).toBe(0);
  });

  it('rejects an empty label', () => {
    expect(createChecklistTemplateItemSchema.safeParse({ label: '' }).success).toBe(false);
  });
});

describe('updateChecklistTemplateItemSchema', () => {
  it('does NOT reset sortOrder when only the label is patched', () => {
    // `.partial()` does not strip a `.default()`, so deriving the update shape
    // from the defaulted create fields would make PATCH { label } silently
    // reset sortOrder to 0.
    expect(updateChecklistTemplateItemSchema.parse({ label: 'Renamed' })).toEqual({
      label: 'Renamed',
    });
  });
});

describe('applyChecklistTemplateSchema', () => {
  it('defaults mode to append', () => {
    expect(applyChecklistTemplateSchema.parse({ templateId: UUID }).mode).toBe('append');
  });

  it('accepts replace_unticked', () => {
    expect(
      applyChecklistTemplateSchema.parse({ templateId: UUID, mode: 'replace_unticked' }).mode,
    ).toBe('replace_unticked');
  });

  it('rejects a destructive mode that does not exist', () => {
    // There is deliberately no 'replace_all': ticked rows are an attestation
    // record and are never dropped by applying a template (spec §3.3).
    expect(
      applyChecklistTemplateSchema.safeParse({ templateId: UUID, mode: 'replace_all' }).success,
    ).toBe(false);
  });

  it('rejects a non-uuid templateId', () => {
    expect(applyChecklistTemplateSchema.safeParse({ templateId: 'nope' }).success).toBe(false);
  });
});
