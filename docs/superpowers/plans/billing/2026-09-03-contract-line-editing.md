---
tracking_issue: LanternOps/breeze#3205
---

# Contract Line Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a contract line a `PATCH` route so its description, price, tax flag, quantity, site, roles, device group and catalog link can be changed **in place**, keeping the line's id and therefore its invoice lineage — and audit all three line mutations while doing it.

**Architecture:** No migration. One hand-written strict Zod patch schema with a tri-state `catalogItemId`, plus one two-mode invariant helper (`create` reproduces today's add-schema behaviour byte for byte; `persisted` is the merged-row rule set) and a pure `mergeContractLinePatch`, all in `@breeze/shared` so the web editor can run the identical check. `updateContractLine` opens on the same `contracts.id FOR UPDATE` every other line writer takes, applies the catalog transition table, re-checks site/group ownership, writes one UPDATE and diffs the persisted row before/after for the audit payload. One `withLineRefs` mapper decorates every line read with `site` and W02's `deviceGroup`, and all three line reads become deterministically ordered. `update_line` lands in all four AI registration sites.

**Tech Stack:** Postgres 16, Drizzle ORM, Hono, Zod 4.4.3 (`z.string().guid()`, `.strict()` key-absence semantics), Vitest (unit + `vitest.integration.config.ts` real-DB suites), React + react-i18next (8 locales), Astro.

**Spec:** `docs/superpowers/specs/billing/2026-09-03-contract-line-editing-design.md`

**Wave:** #3205 W03 (wave sub-issue #4652). Branch from `main` **after W02 (sub-issue #4648) merges**: `feature/3205-line-editing/wave-4652`.

## Global Constraints

- Every W02 symbol this wave builds on comes from the W02 plan (`docs/superpowers/plans/billing/2026-09-02-contract-lines-per-device-group.md`, Tasks 1–6), not from this worktree's code; if W02 shipped any of them under a different name, re-point — nothing here depends on the spelling.
- **No migration.** Every column W03 writes exists after W02, so there is **no `CORE_TENANT_EXPORT_POLICY` change** (that contract fires on new columns and new tables, and W03 has neither), no cascade-list change and no RLS allowlist change.
- `lineType` is not accepted — `.strict()` makes it a 400, not a silent drop. Message, verified against Zod 4.4.3 in this repo: `Unrecognized key: "lineType"`, issue `code: 'unrecognized_keys'`, `path: []`.
- **The invariant helper has two modes, and it is not the CHECK's twin.** Neither mode is a transcription of the DB CHECKs — three matrix rows have the helper as the only guard, two have the CHECK as the only guard, and the whole matrix is tested on both sides.
- **`create` reproduces today's add-schema behaviour *exactly*.** The refactor is behaviour-preserving by construction; the existing W01/W02 validator describes are the parity proof and must pass **unedited**.
- `catalogItemId` is tri-state by key presence, re-linking never repeats work, and a price refresh is an explicit request: sending the *same* item id is idempotent and does **not** reprice; only a *different* id relinks and re-resolves; `refreshCatalogPrice: true` is the only way to reprice an unchanged link.
- Unlinking (`null` on a linked line) requires `unitPrice` **and** `taxable` in the same patch; `null` on an already-unlinked line is link-idempotent, **does not** trigger that requirement, and the patch's other fields still apply.
- A patch may re-point an orphaned group line, and may never orphan one: `deviceGroupId` accepts a GUID and not `null`; re-pointing re-stamps `device_group_name` from the newly resolved group.
- **Edit vs generation is solved by the contract row lock. Edit vs edit is last-writer-wins, accepted:** no `If-Match`, no version column, no migration this wave.
- **Three audit actions, no free text, computed from the persisted diff.** Payloads carry **only** the line id, the `lineType`, `changedFields` (column **names**), and for a price change a numeric `oldUnitPrice`/`newUnitPrice`. No description, no site name, no group name, no free text of any kind.
- `changedFields` is diffed from the row **before** and **after** the UPDATE, not from the patch keys, so an ignored client price never claims to have applied; a patch that changes nothing returns 200 and writes no audit row.
- `removeContractLine` must SELECT `(id, lineType)` before deleting and must return **404 `LINE_NOT_FOUND`** when nothing matched — its silent permissiveness is exactly what would make the audit lie.
- `ITEM_NOT_FOUND` from the catalog becomes a typed 400 `CATALOG_ITEM_NOT_FOUND` on **both** the add and the update path, with a non-enumerating message: missing, foreign and RLS-invisible are one answer.
- Money gains a 10-integer-digit bound and `sortOrder` an int32 bound in the shared schemas, on **both** create and update, so oversize input is a typed 400 instead of a Postgres `22003` surfacing as a 500.
- **Web: one row in edit mode at a time, gated on status as well as permission, over deterministically ordered lines.** Every line read orders by `(sortOrder, createdAt, id)`.
- Line reads gain `site: { id, name } | null` beside W02's `deviceGroup`, through one mapper, so the PATCH body is shape-identical to a subsequent GET.
- `update_line` must land in **all four** AI registration sites or it is dead or fail-closed denied (`Unknown action "update_line" for tool "manage_contracts"`).
- Run one test file with `cd <pkg> && npx vitest run <path>` (never `pnpm --filter … test -- --run`). Integration suites: `cd apps/api && DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test npx vitest run --config vitest.integration.config.ts <path>`.
- API typecheck is `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`.

---

## File map

| File | Change |
|---|---|
| `packages/shared/src/validators/contracts.ts` (+ `.test.ts`) | money/`sortOrder` bounds, `contractLineInvariantIssues`, `mergeContractLinePatch`, `patchHasKey`, `updateContractLineSchema`; `contractLineInputSchema` re-expressed through the helper |
| `apps/api/src/services/contractTypes.ts` | `INVALID_LINE_PATCH`, `CATALOG_ITEM_NOT_FOUND`, `ContractLineAudit` |
| `apps/api/src/services/contractService.ts` (+ `.test.ts`) | `updateContractLine`, `removeContractLine` pre-read + 404, `withLineRefs`, deterministic ordering, `mapCatalogResolveError` on both paths, `diffLineAudit` |
| `apps/api/src/__tests__/integration/contractLineEditing.integration.test.ts` (new) | asymmetry matrix vs the real CHECKs, lineage, edit-vs-generation, edit-vs-edit, ordering, cross-tenant |
| `apps/api/src/routes/contracts/lines.ts` (+ `routes/contracts/contracts.test.ts`) | `PATCH /:id/lines/:lineId`, `writeLineAudit` on all three line routes |
| `apps/api/src/services/aiToolsContracts.ts` (+ `aiToolsContracts.manageContracts.test.ts`, `aiToolsContracts.test.ts`) | `update_line`, `auditContractLineToolEvent`, `serviceErrorToJson` carries `details`, tool prose |
| `apps/api/src/services/aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `aiGuardrails.ts` | `update_line` in the other three registries |
| `apps/api/src/services/aiToolsContracts.registryParity.contract.test.ts` (new) | table-driven four-site parity over every `manage_contracts` action |
| `apps/web/src/lib/api/contracts.ts` | `site` on `ContractLine`, `UpdateContractLinePatch`, `updateContractLine` |
| `apps/web/src/components/contracts/ContractEditor.tsx` (+ new `ContractEditor.editline.test.tsx`) | `linesEditable`, inline edit row, minimal-patch builder, `runAction` + `friendly` map |
| `apps/web/src/components/contracts/ContractDetail.tsx` (+ new `ContractDetail.site.test.tsx`) | site sub-label from `line.site` |
| `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json` | 18 new keys in 8 locales |
| `apps/docs/src/content/docs/features/contracts.mdx` | "Editing a line" paragraph |
| `docs/release-notes/next-release-draft.md` | W03 section under the existing #3205 heading |

---

### Task 1: Shared validators — bounds, the two-mode invariant helper, the patch schema

**Files:**
- Modify: `packages/shared/src/validators/contracts.ts:6` (`money`), `:9-49` (`contractLineInputSchema` after W02), `:118` (type exports)
- Test: `packages/shared/src/validators/contracts.test.ts` — import line 2, and append after the `per_device_group` describe W02 added (the file ends at the `changeContractCurrencySchema` describe)

**Interfaces:**
- Consumes: `CONTRACT_LINE_TYPES` incl. `'per_device_group'` and the `deviceGroupId` field (W02 plan Task 1).
- Produces:

```ts
export interface ContractLineShape {
  lineType: ContractLineType;
  manualQuantity?: string | null;
  siteId?: string | null;
  deviceRoles?: readonly string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
}
export interface PersistedContractLine extends ContractLineShape {
  description: string; unitPrice: string; taxable: boolean; catalogItemId: string | null;
  manualQuantity: string | null; siteId: string | null; deviceRoles: readonly string[] | null;
  deviceGroupId: string | null; deviceGroupName: string | null; sortOrder: number;
}
export type MergedContractLine = PersistedContractLine;
export interface ContractLineInvariantIssue { path: keyof ContractLineShape; message: string }
export function contractLineInvariantIssues(l: ContractLineShape, opts: { mode: 'create' | 'persisted' }): ContractLineInvariantIssue[];
export const updateContractLineSchema: z.ZodType;  // strict object + 2 refines
export type UpdateContractLineInput = z.infer<typeof updateContractLineSchema>;
export function patchHasKey(patch: UpdateContractLineInput, key: keyof UpdateContractLineInput): boolean;
export function mergeContractLinePatch(
  current: PersistedContractLine, patch: UpdateContractLineInput,
  resolved?: { unitPrice: string; taxable: boolean; catalogItemId: string | null },
): MergedContractLine;
```

- [ ] **Step 1: Write the failing tests**

Change the import on line 2 of `packages/shared/src/validators/contracts.test.ts` to:

```ts
import {
  createContractSchema, contractLineInputSchema, updateContractSchema, changeContractCurrencySchema,
  updateContractLineSchema, contractLineInvariantIssues, mergeContractLinePatch, patchHasKey,
  type PersistedContractLine,
} from './contracts';
```

Append to the end of the file:

```ts
// ---------------------------------------------------------------------------
// #3205 W03 — contract line editing.
// ---------------------------------------------------------------------------

// The create-path bounds tighten too (decision 10): unbounded money and
// sortOrder reached Postgres as a raw 22003 and surfaced as a 500.
describe('contractLineInputSchema — numeric bounds (#3205 W03)', () => {
  const base = { lineType: 'flat' as const, description: 'Fee', taxable: true };
  const parse = (v: unknown) => contractLineInputSchema.safeParse(v).success;

  it('accepts the largest numeric(12,2) unitPrice and rejects an 11-digit one', () => {
    expect(parse({ ...base, unitPrice: '9999999999.99' })).toBe(true);
    expect(parse({ ...base, unitPrice: '99999999999.00' })).toBe(false);
  });

  it('applies the same bound to manualQuantity', () => {
    const manual = { lineType: 'manual' as const, description: 'Hours', unitPrice: '1.00', taxable: false };
    expect(parse({ ...manual, manualQuantity: '9999999999.99' })).toBe(true);
    expect(parse({ ...manual, manualQuantity: '99999999999.00' })).toBe(false);
  });

  it('bounds sortOrder at int32', () => {
    expect(parse({ ...base, unitPrice: '1.00', sortOrder: 2147483647 })).toBe(true);
    expect(parse({ ...base, unitPrice: '1.00', sortOrder: 2147483648 })).toBe(false);
  });
});

describe('updateContractLineSchema (#3205 W03)', () => {
  const GUID = '33333333-3333-4333-8333-333333333333';
  const parse = (v: unknown) => updateContractLineSchema.safeParse(v);

  // Decision 3's anchor. A NON-strict schema would ACCEPT {lineType:'flat'} and
  // silently drop it, changing nothing while reporting success.
  it('rejects lineType with the exact unrecognized-key message', () => {
    const r = parse({ description: 'x', lineType: 'flat' });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toContain('Unrecognized key: "lineType"');
  });

  it('rejects any unknown key and an empty patch', () => {
    expect(parse({ nope: 1 }).success).toBe(false);
    const empty = parse({});
    expect(empty.success).toBe(false);
    expect(empty.error!.issues.map((i) => i.message)).toContain('patch must change at least one field');
  });

  it('rejects a non-GUID catalogItemId, empty/duplicate deviceRoles and an over-long description', () => {
    expect(parse({ catalogItemId: 'nope' }).success).toBe(false);
    expect(parse({ deviceRoles: [] }).success).toBe(false);
    expect(parse({ deviceRoles: ['server', 'server'] }).success).toBe(false);
    expect(parse({ description: 'x'.repeat(2001) }).success).toBe(false);
    expect(parse({ description: '' }).success).toBe(false);
  });

  it('applies the same money and sortOrder bounds as the create schema', () => {
    expect(parse({ unitPrice: '9999999999.99' }).success).toBe(true);
    expect(parse({ unitPrice: '99999999999.00' }).success).toBe(false);
    expect(parse({ manualQuantity: '99999999999.00' }).success).toBe(false);
    expect(parse({ sortOrder: 2147483647 }).success).toBe(true);
    expect(parse({ sortOrder: 2147483648 }).success).toBe(false);
  });

  // TRI-STATE PIN. This is what catches a Zod upgrade changing absence
  // semantics — the whole catalog transition table rests on it.
  it('preserves key absence and an explicit null on catalogItemId', () => {
    const absent = updateContractLineSchema.parse({ description: 'x' }) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(absent, 'catalogItemId')).toBe(false);
    const explicit = updateContractLineSchema.parse({ catalogItemId: null }) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(explicit, 'catalogItemId')).toBe(true);
    expect(explicit.catalogItemId).toBeNull();
    expect(patchHasKey(absent as never, 'catalogItemId')).toBe(false);
    expect(patchHasKey(explicit as never, 'catalogItemId')).toBe(true);
  });

  // siteId: null widens a site-scoped line to the whole org — legitimate.
  // deviceRoles/deviceGroupId: null would leave a row the DB rejects, or an
  // orphan nobody asked for (decision 7).
  it('accepts siteId null, rejects deviceRoles null and deviceGroupId null', () => {
    expect(parse({ siteId: null }).success).toBe(true);
    expect(parse({ siteId: GUID }).success).toBe(true);
    expect(parse({ deviceRoles: null }).success).toBe(false);
    expect(parse({ deviceGroupId: null }).success).toBe(false);
    expect(parse({ deviceGroupId: GUID }).success).toBe(true);
  });

  it('accepts refreshCatalogPrice alone', () => {
    expect(parse({ refreshCatalogPrice: true }).success).toBe(true);
    expect(parse({ refreshCatalogPrice: false }).success).toBe(true);
  });
});

// The whole asymmetry matrix of the spec's § Validators, both modes. Every case
// carries a comment naming which side is the sole guard, so nobody deletes one
// as redundant with "the CHECK already does it".
describe('contractLineInvariantIssues (#3205 W03)', () => {
  const GUID = '33333333-3333-4333-8333-333333333333';
  const paths = (l: Parameters<typeof contractLineInvariantIssues>[0], mode: 'create' | 'persisted') =>
    contractLineInvariantIssues(l, { mode }).map((i) => i.path);

  it('manual lines require manualQuantity in both modes', () => {
    expect(paths({ lineType: 'manual' }, 'create')).toEqual(['manualQuantity']);
    expect(paths({ lineType: 'manual', manualQuantity: null }, 'persisted')).toEqual(['manualQuantity']);
    expect(paths({ lineType: 'manual', manualQuantity: '2' }, 'create')).toEqual([]);
    expect(paths({ lineType: 'manual', manualQuantity: '2' }, 'persisted')).toEqual([]);
  });

  // THE MODE DIFFERENCE that keeps add behaviour intact: the add writer nulls
  // manualQuantity on every non-manual type (contractService.ts:904), so create
  // TOLERATES it; a stored row carrying it is a real defect. NO DB CHECK exists
  // on manual_quantity at all — the helper is the only guard on both sides.
  it('tolerates manualQuantity on a flat line in create and rejects it in persisted', () => {
    expect(paths({ lineType: 'flat', manualQuantity: '5' }, 'create')).toEqual([]);
    expect(paths({ lineType: 'flat', manualQuantity: '5' }, 'persisted')).toEqual(['manualQuantity']);
  });

  // The DB constrains site_id only on per_device_group (W02's CHECK). For
  // flat / manual / per_seat the helper is the ONLY guard.
  it('allows siteId only on per_device and per_device_role, in both modes', () => {
    for (const mode of ['create', 'persisted'] as const) {
      expect(paths({ lineType: 'per_device', siteId: GUID }, mode)).toEqual([]);
      expect(paths({ lineType: 'per_device_role', siteId: GUID, deviceRoles: ['server'] }, mode)).toEqual([]);
      for (const lineType of ['flat', 'per_seat'] as const) {
        expect(paths({ lineType, siteId: GUID }, mode)).toEqual(['siteId']);
      }
      expect(paths({ lineType: 'manual', manualQuantity: '1', siteId: GUID }, mode)).toEqual(['siteId']);
    }
  });

  it('rejects a siteId on a per_device_group line in both modes', () => {
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GUID, siteId: GUID }, 'create')).toEqual(['siteId']);
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GUID, deviceGroupName: 'VIP', siteId: GUID }, 'persisted')).toEqual(['siteId']);
  });

  it('keeps deviceRoles two-way and non-empty in both modes', () => {
    for (const mode of ['create', 'persisted'] as const) {
      expect(paths({ lineType: 'per_device_role' }, mode)).toEqual(['deviceRoles']);
      expect(paths({ lineType: 'per_device_role', deviceRoles: [] }, mode)).toEqual(['deviceRoles']);
      expect(paths({ lineType: 'per_device', deviceRoles: ['server'] }, mode)).toEqual(['deviceRoles']);
      expect(paths({ lineType: 'per_device_role', deviceRoles: ['server'] }, mode)).toEqual([]);
    }
  });

  // contract_lines_device_roles_chk uses `<@` — CONTAINMENT, not set equality —
  // so {'server','server'} PASSES the database. The helper is the only guard.
  it('rejects duplicate deviceRoles in both modes (the DB CHECK accepts them)', () => {
    expect(paths({ lineType: 'per_device_role', deviceRoles: ['server', 'server'] }, 'create')).toEqual(['deviceRoles']);
    expect(paths({ lineType: 'per_device_role', deviceRoles: ['server', 'server'] }, 'persisted')).toEqual(['deviceRoles']);
  });

  it('requires deviceGroupId on a group line in create but allows the orphan state in persisted', () => {
    expect(paths({ lineType: 'per_device_group' }, 'create')).toEqual(['deviceGroupId']);
    // The orphaned state the FK produces (ON DELETE SET NULL on device_group_id):
    // legal, and repairable in place by a patch (decision 7).
    expect(paths({ lineType: 'per_device_group', deviceGroupId: null, deviceGroupName: 'Retired' }, 'persisted')).toEqual([]);
  });

  it('rejects deviceGroupId on a non-group line in both modes', () => {
    expect(paths({ lineType: 'flat', deviceGroupId: GUID }, 'create')).toEqual(['deviceGroupId']);
    expect(paths({ lineType: 'flat', deviceGroupId: GUID }, 'persisted')).toEqual(['deviceGroupId']);
  });

  it('ignores deviceGroupName in create and makes it two-way in persisted', () => {
    // deviceGroupName is not a field of the add schema — the writer stamps it.
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GUID, deviceGroupName: 'VIP' }, 'create')).toEqual([]);
    expect(paths({ lineType: 'flat', deviceGroupName: 'VIP' }, 'create')).toEqual([]);
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GUID }, 'persisted')).toEqual(['deviceGroupName']);
    expect(paths({ lineType: 'flat', deviceGroupName: 'VIP' }, 'persisted')).toEqual(['deviceGroupName']);
  });

  it('carries a human message on every issue', () => {
    const issues = contractLineInvariantIssues({ lineType: 'manual' }, { mode: 'create' });
    expect(issues[0]!.message.length).toBeGreaterThan(0);
  });
});

describe('mergeContractLinePatch (#3205 W03)', () => {
  const GUID_A = '33333333-3333-4333-8333-333333333333';
  const GUID_B = '44444444-4444-4444-8444-444444444444';
  const current: PersistedContractLine = {
    lineType: 'per_device', description: 'Managed device', unitPrice: '10.00', taxable: true,
    catalogItemId: null, manualQuantity: null, siteId: GUID_A, deviceRoles: null,
    deviceGroupId: null, deviceGroupName: null, sortOrder: 3,
  };

  it('preserves every field an omitted key does not touch', () => {
    expect(mergeContractLinePatch(current, updateContractLineSchema.parse({ description: 'Renamed' }) as never))
      .toEqual({ ...current, description: 'Renamed' });
  });

  it('clears siteId on an explicit null and leaves it alone when the key is absent', () => {
    expect(mergeContractLinePatch(current, updateContractLineSchema.parse({ siteId: null }) as never).siteId).toBeNull();
    expect(mergeContractLinePatch(current, updateContractLineSchema.parse({ description: 'x' }) as never).siteId).toBe(GUID_A);
  });

  it('applies a client price on an unlinked line', () => {
    const m = mergeContractLinePatch(current, updateContractLineSchema.parse({ unitPrice: '12.50', taxable: false }) as never);
    expect(m).toMatchObject({ unitPrice: '12.50', taxable: false, catalogItemId: null });
  });

  // Transition rows 2 and 4: the resolver is authoritative on a linked line, so
  // a client price is dropped rather than written.
  it('ignores a client price while the merged row stays catalog-linked', () => {
    const linked: PersistedContractLine = { ...current, catalogItemId: GUID_B, unitPrice: '20.00', taxable: false };
    const m = mergeContractLinePatch(linked, updateContractLineSchema.parse({ unitPrice: '1.00', taxable: true }) as never);
    expect(m).toMatchObject({ unitPrice: '20.00', taxable: false, catalogItemId: GUID_B });
  });

  it('lets `resolved` override unitPrice, taxable and catalogItemId', () => {
    const m = mergeContractLinePatch(
      current, updateContractLineSchema.parse({ catalogItemId: GUID_B }) as never,
      { unitPrice: '7.25', taxable: false, catalogItemId: GUID_B },
    );
    expect(m).toMatchObject({ unitPrice: '7.25', taxable: false, catalogItemId: GUID_B });
  });

  // Transition row 6: after an unlink nothing re-resolves the number ever again,
  // so the patch's own price is what lands.
  it('applies the patch price when the patch unlinks the catalog item', () => {
    const linked: PersistedContractLine = { ...current, catalogItemId: GUID_B, unitPrice: '20.00' };
    const m = mergeContractLinePatch(linked, updateContractLineSchema.parse({ catalogItemId: null, unitPrice: '3.00', taxable: false }) as never);
    expect(m).toMatchObject({ catalogItemId: null, unitPrice: '3.00', taxable: false });
  });

  it('never moves lineType or deviceGroupName', () => {
    const group: PersistedContractLine = {
      ...current, lineType: 'per_device_group', siteId: null, deviceGroupId: GUID_A, deviceGroupName: 'VIP',
    };
    const m = mergeContractLinePatch(group, updateContractLineSchema.parse({ deviceGroupId: GUID_B }) as never);
    expect(m).toMatchObject({ lineType: 'per_device_group', deviceGroupId: GUID_B, deviceGroupName: 'VIP' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts`
Expected: FAIL — the import of `updateContractLineSchema` / `contractLineInvariantIssues` / `mergeContractLinePatch` / `patchHasKey` does not resolve, so the whole file errors (`No "updateContractLineSchema" export is defined on the "./contracts" mock` style resolution error). The bounds describe would also fail on its own.

- [ ] **Step 3: Implement the bounds and the invariant helper**

In `packages/shared/src/validators/contracts.ts`, replace line 6 and add the int32 constant:

```ts
// numeric(12,2): ten digits before the point, two after. Unbounded before
// (#3205 W03); an oversize value reached Postgres as a raw 22003 -> 500.
// String-length, not Number(), so no float rounding decides a boundary.
// Sibling validators already bound money (quotes.ts:8, catalog.ts:15).
const money = z.string()
  .regex(/^\d+(\.\d{1,2})?$/, 'must be a 2-decimal money string')
  .refine((v) => v.split('.')[0]!.length <= 10, 'must be at most 10 digits before the decimal point');

const INT32_MAX = 2_147_483_647;  // sort_order is int4
```

Immediately after `export type ContractLineType = ...` (line 10), add the helper:

```ts
/** Read layers use null for not-applicable, write layers omit the key (see the
 *  note on deviceRoles below). One predicate set has to serve both. */
const present = (v: unknown): boolean => v !== undefined && v !== null;

const SITE_SCOPABLE_LINE_TYPES = new Set<ContractLineType>(['per_device', 'per_device_role']);

export interface ContractLineShape {
  lineType: ContractLineType;
  manualQuantity?: string | null;
  siteId?: string | null;
  deviceRoles?: readonly string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
}

export interface ContractLineInvariantIssue {
  path: keyof ContractLineShape;
  message: string;
}

/**
 * #3205 W03. The contract-line invariants, once, in two modes.
 *
 * 'create'    — a NEW line, from contractLineInputSchema. Reproduces the
 *               pre-W03 add-schema behaviour byte for byte.
 * 'persisted' — a line that already exists, or a merged (current ⊕ patch) row.
 *               Differs only where the persisted world legitimately allows
 *               something a new line may not (a group line orphaned by the FK),
 *               or requires something only a stored row has (the stamped
 *               device_group_name).
 *
 * NOT a transcription of the DB CHECKs. Three rules here have NO database
 * counterpart (duplicate roles — `<@` is containment, not set equality;
 * manualQuantity — there is no CHECK on the column at all; siteId on
 * flat/manual/per_seat — W02's CHECK covers per_device_group only), and two DB
 * rules are not expressible here (role-set membership, 1-D array shape). Both
 * sides are load-bearing; see the asymmetry matrix in the spec.
 */
export function contractLineInvariantIssues(
  l: ContractLineShape, opts: { mode: 'create' | 'persisted' },
): ContractLineInvariantIssue[] {
  const issues: ContractLineInvariantIssue[] = [];
  const isManual = l.lineType === 'manual';
  const isRoleLine = l.lineType === 'per_device_role';
  const isGroupLine = l.lineType === 'per_device_group';

  if (isManual && !present(l.manualQuantity)) {
    issues.push({ path: 'manualQuantity', message: 'manualQuantity is required for manual lines' });
  } else if (!isManual && opts.mode === 'persisted' && present(l.manualQuantity)) {
    // create TOLERATES this: the add writer nulls the column on every other
    // type (contractService.ts:904), so rejecting it would change add behaviour.
    issues.push({ path: 'manualQuantity', message: 'manualQuantity is only valid on manual lines' });
  }

  if (present(l.siteId) && !SITE_SCOPABLE_LINE_TYPES.has(l.lineType)) {
    issues.push({ path: 'siteId', message: 'siteId is only valid on per_device and per_device_role lines' });
  }

  if (isRoleLine !== present(l.deviceRoles)) {
    issues.push({ path: 'deviceRoles', message: 'deviceRoles is required on per_device_role lines and not allowed on other line types' });
  } else if (present(l.deviceRoles)) {
    const roles = l.deviceRoles!;
    if (roles.length === 0) {
      issues.push({ path: 'deviceRoles', message: 'deviceRoles must not be empty' });
    } else if (new Set(roles).size !== roles.length) {
      issues.push({ path: 'deviceRoles', message: 'deviceRoles must not contain duplicates' });
    }
  }

  if (opts.mode === 'create') {
    // W02's two-way refine: a NEW group line must name its group.
    if (isGroupLine !== present(l.deviceGroupId)) {
      issues.push({ path: 'deviceGroupId', message: 'deviceGroupId is required on per_device_group lines and not allowed on other line types' });
    }
  } else {
    // A stored group line may carry a NULL device_group_id: the composite FK is
    // ON DELETE SET NULL (device_group_id), so deleting the group orphans the
    // line rather than blocking. That state is legal and repairable in place.
    if (!isGroupLine && present(l.deviceGroupId)) {
      issues.push({ path: 'deviceGroupId', message: 'deviceGroupId is not allowed on this line type' });
    }
    if (isGroupLine !== present(l.deviceGroupName)) {
      issues.push({ path: 'deviceGroupName', message: 'deviceGroupName is required on per_device_group lines and not allowed on other line types' });
    }
  }

  return issues;
}
```

- [ ] **Step 4: Re-express `contractLineInputSchema` through the helper (no behaviour change)**

Replace the refine chain of `contractLineInputSchema` (`:29-49` plus W02's group refine) so that **only** the two pricing refines remain as `.refine`, and the four shape refines become one `superRefine`. `sortOrder` gains its bound in the same edit:

```ts
  sortOrder: z.number().int().min(0).max(INT32_MAX).optional()
}).superRefine((l, ctx) => {
  // #3205 W03: the shape invariants live in contractLineInvariantIssues so the
  // update path can run the SAME rules over a merged row. 'create' mode is
  // byte-for-byte the pre-W03 refine set — the wave 1 / wave 2 describes in
  // contracts.test.ts are the parity proof and must pass unedited.
  for (const issue of contractLineInvariantIssues(l, { mode: 'create' })) {
    ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
  }
}).refine(
  (l) => l.unitPrice !== undefined || l.catalogItemId !== undefined,
  { message: 'unitPrice is required unless catalogItemId is set', path: ['unitPrice'] }
).refine(
  (l) => l.taxable !== undefined || l.catalogItemId !== undefined,
  { message: 'taxable is required unless catalogItemId is set', path: ['taxable'] }
);
```

The field declarations above (`lineType`, `description`, `unitPrice: money.optional()`, `taxable`, `catalogItemId`, `manualQuantity: money.optional()`, `siteId`, `deviceRoles`, `deviceGroupId`) are unchanged. Because those field types are `.optional()` and never `.nullable()`, a `null` still fails at the type layer before any invariant runs, so `present()` and `!== undefined` coincide there.

- [ ] **Step 5: Implement the patch schema, `patchHasKey` and `mergeContractLinePatch`**

Append after `contractLineInputSchema`:

```ts
/**
 * PATCH /contracts/:id/lines/:lineId (#3205 W03). Hand-written rather than
 * contractLineInputSchema.partial(): partial() cannot express the tri-state
 * catalogItemId, and on this schema it is not even callable — Zod 4.4.3 throws
 * ".partial() cannot be used on object schemas containing refinements"
 * (verified), and contractLineInputSchema carries refinements.
 *
 * STRICT on purpose. lineType is not editable — changing it crosses
 * contract_lines_device_roles_chk, contract_lines_device_group_chk and the site
 * rule at once — and a non-strict schema would ACCEPT {lineType:'flat'} and
 * silently drop it. Strict also turns a misspelled key into a 400 rather than a
 * silent no-op patch. Message: Unrecognized key: "lineType".
 *
 * catalogItemId is TRI-STATE by key presence (Zod 4 preserves absence, verified
 * by execution); see the transition table in the spec. refreshCatalogPrice is
 * the ONLY way to reprice an unchanged link, so a price never moves as a side
 * effect of another edit.
 */
export const updateContractLineSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  catalogItemId: z.string().guid().nullable().optional(),
  refreshCatalogPrice: z.boolean().optional(),      // default false
  manualQuantity: money.optional(),
  // null clears the site narrowing on a per_device / per_device_role line.
  siteId: z.string().guid().nullable().optional(),
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  // No null: a group line is never deliberately orphaned (decision 7).
  deviceGroupId: z.string().guid().optional(),
  sortOrder: z.number().int().min(0).max(INT32_MAX).optional(),
}).strict().refine(
  (p) => Object.keys(p).length > 0,
  { message: 'patch must change at least one field' },
).refine(
  (p) => p.deviceRoles === undefined || new Set(p.deviceRoles).size === p.deviceRoles.length,
  { message: 'deviceRoles must not contain duplicates', path: ['deviceRoles'] },
);

export type UpdateContractLineInput = z.infer<typeof updateContractLineSchema>;

/** Key-presence test for a tri-state patch field. `patch.siteId === undefined`
 *  cannot tell "leave it alone" from "clear it"; key presence can. */
export function patchHasKey(patch: UpdateContractLineInput, key: keyof UpdateContractLineInput): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

/** A contract_lines row in read-layer shape (null = not applicable). */
export interface PersistedContractLine extends ContractLineShape {
  description: string;
  unitPrice: string;
  taxable: boolean;
  catalogItemId: string | null;
  manualQuantity: string | null;
  siteId: string | null;
  deviceRoles: readonly string[] | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  sortOrder: number;
}

export type MergedContractLine = PersistedContractLine;

/**
 * Current persisted line ⊕ patch (#3205 W03). PURE — the service resolves the
 * catalog price/taxable BEFORE calling this and passes the result in `resolved`,
 * so the whole rule set can also run in the web editor to disable Save before a
 * round-trip, with no second copy of the rules.
 *
 * Price precedence implements the transition table: a `resolved` wins outright
 * (rows 3/5 and a refresh); otherwise a merged row that stays LINKED keeps its
 * stamped price and ignores any client value (rows 2/4), and an UNLINKED merged
 * row takes the patch's value (rows 1/6/7).
 *
 * lineType and deviceGroupName are never merged: the type is not patchable, and
 * the group name is re-stamped by the service from the resolved group AFTER the
 * invariants run.
 */
export function mergeContractLinePatch(
  current: PersistedContractLine,
  patch: UpdateContractLineInput,
  resolved?: { unitPrice: string; taxable: boolean; catalogItemId: string | null },
): MergedContractLine {
  const catalogItemId = resolved
    ? resolved.catalogItemId
    : (patchHasKey(patch, 'catalogItemId') ? (patch.catalogItemId ?? null) : current.catalogItemId);
  const stillLinked = catalogItemId !== null;
  return {
    lineType: current.lineType,
    description: patch.description ?? current.description,
    unitPrice: resolved ? resolved.unitPrice : (stillLinked ? current.unitPrice : (patch.unitPrice ?? current.unitPrice)),
    taxable: resolved ? resolved.taxable : (stillLinked ? current.taxable : (patch.taxable ?? current.taxable)),
    catalogItemId,
    manualQuantity: patch.manualQuantity ?? current.manualQuantity,
    siteId: patchHasKey(patch, 'siteId') ? (patch.siteId ?? null) : current.siteId,
    deviceRoles: patch.deviceRoles ?? current.deviceRoles,
    deviceGroupId: patch.deviceGroupId ?? current.deviceGroupId,
    deviceGroupName: current.deviceGroupName,
    sortOrder: patch.sortOrder ?? current.sortOrder,
  };
}
```

Add `UpdateContractLineInput` beside the existing type exports at `:118` (it is already exported inline above; no second declaration).

- [ ] **Step 6: Run to verify it passes**

Run: `cd packages/shared && npx vitest run src/validators/contracts.test.ts`
Expected: PASS — including the **unedited** wave 1 `per_device_role` describe and wave 2 `per_device_group` describe. If either of those needed an edit, the `create` mode is not behaviour-preserving: fix the helper, not the test.

- [ ] **Step 7: Typecheck and commit**

Run:
```bash
cd packages/shared && npx tsc --noEmit -p tsconfig.json
cd ../../apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
```
Expected: `packages/shared` clean; `apps/api` clean too (nothing consumes the new exports yet).

```bash
git add packages/shared/src/validators/contracts.ts packages/shared/src/validators/contracts.test.ts
git commit -m "feat(shared): contract line patch schema + two-mode invariant helper + numeric bounds (#3205 W03)"
```

---

### Task 2: Service — `updateContractLine`, `removeContractLine` 404, `withLineRefs`, deterministic ordering

**Files:**
- Modify: `apps/api/src/services/contractTypes.ts:32-74` (error codes) and the end of the file (`ContractLineAudit`)
- Modify: `apps/api/src/services/contractService.ts` — imports (`:1-37`), `getContract` (`:136-138`), `computeContractEstimate` (`:264-266`), `assertRepresentable` (`:857-865`), `addContractLineToContract` (`:866-913`), `removeContractLine` (`:915-921`), `generateDueInvoice` line read (`:1093-1094`)
- Test: `apps/api/src/services/contractService.test.ts` (append)
- Create: `apps/api/src/__tests__/integration/contractLineEditing.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `updateContractLineSchema` / `UpdateContractLineInput`, `contractLineInvariantIssues`, `mergeContractLinePatch`, `patchHasKey`, `PersistedContractLine`; W02's `assertGroupInOrg(tx, groupId, orgId) → { id, name, type, siteId }` and `isGroupFkViolation(err)` (W02 plan Task 5 Step 7); existing `lockContract`, `assertEditable`, `assertSiteInOrg`, `assertRepresentable`, `resolvePrice`, `CatalogServiceError`.
- Produces:

```ts
// contractTypes.ts
// two members appended to the existing union (which ends at 'BROKEN_CONTRACT_LINEAGE')
export type ContractServiceErrorCode = /* existing members */ | 'INVALID_LINE_PATCH' | 'CATALOG_ITEM_NOT_FOUND';
export interface ContractLineAudit {
  orgId: string; contractId: string; contractName?: string;
  contractLineId: string; lineType: ContractLineType;
  changedFields?: string[]; oldUnitPrice?: string; newUnitPrice?: string;
}
// contractService.ts
export type DecoratedContractLine = typeof contractLines.$inferSelect & {
  site: { id: string; name: string } | null;
  deviceGroup: { id: string; name: string; type: 'static' | 'dynamic' } | null;
};
export async function updateContractLine(
  contractId: string, lineId: string, patch: UpdateContractLineInput, actor: ContractActor,
): Promise<{ line: DecoratedContractLine; audit: ContractLineAudit }>;
export async function removeContractLine(
  contractId: string, lineId: string, actor: ContractActor,
): Promise<ContractLineAudit>;   // was Promise<void>
```

- [ ] **Step 1: Write the failing unit tests**

Append to `apps/api/src/services/contractService.test.ts`:

```ts
// ---------------------------------------------------------------------------
// #3205 W03 — contract line editing.
// The db mock is a single chain whose `then` shifts the next queued result, so
// every awaited query consumes one queueResult() in call order. updateContractLine
// issues, in order: lockContract SELECT, the line SELECT, [resolvePrice is mocked,
// not queued], [assertSiteInOrg / assertGroupInOrg SELECTs when reached], UPDATE.
// ---------------------------------------------------------------------------
describe('updateContractLine (#3205 W03)', () => {
  const CONTRACT = { id: 'c1', orgId: 'org1', partnerId: 'p1', name: 'Acme MSA', status: 'draft', currencyCode: 'USD' };
  const CATALOG_A = '55555555-5555-4555-8555-555555555555';
  const CATALOG_B = '66666666-6666-4666-8666-666666666666';
  const SITE_B = '77777777-7777-4777-8777-777777777777';
  const GROUP_B = '88888888-8888-4888-8888-888888888888';
  const line = (over: Record<string, unknown> = {}) => ({
    id: 'l1', contractId: 'c1', orgId: 'org1', lineType: 'per_device', description: 'Managed device',
    catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: null, deviceRoles: null,
    deviceGroupId: null, deviceGroupName: null, taxable: true, sortOrder: 0,
    createdAt: new Date('2026-06-01T00:00:00Z'), ...over,
  });
  const setArgs = () => (db as unknown as Chain).set.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;

  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('locks the contract before reading the line', async () => {
    // The line has no siteId and no deviceGroupId, so withLineRefs issues no
    // extra query and three queued results are exactly what is consumed.
    queueResult([CONTRACT]); queueResult([line()]); queueResult([line({ description: 'Renamed' })]);
    await svc.updateContractLine('c1', 'l1', { description: 'Renamed' } as never, actor);
    expect((db as unknown as Chain).for.mock.calls[0]).toEqual(['update']);
  });

  it.each(['paused', 'cancelled', 'expired'])('rejects a %s contract with INVALID_STATE (409)', async (status) => {
    queueResult([{ ...CONTRACT, status }]);
    await expect(svc.updateContractLine('c1', 'l1', { description: 'x' } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('throws LINE_NOT_FOUND (404) when the line is not on this contract', async () => {
    queueResult([CONTRACT]); queueResult([]);
    await expect(svc.updateContractLine('c1', 'l1', { description: 'x' } as never, actor))
      .rejects.toMatchObject({ code: 'LINE_NOT_FOUND', status: 404 });
  });

  it('throws ORG_DENIED (403) for an inaccessible org', async () => {
    queueResult([{ ...CONTRACT, orgId: 'other-org' }]);
    await expect(svc.updateContractLine('c1', 'l1', { description: 'x' } as never, actor))
      .rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });

  // ---- catalog transition table, one test per row -------------------------
  it('row 1: unlinked, link untouched — the client price is written', async () => {
    queueResult([CONTRACT]); queueResult([line()]); queueResult([line({ unitPrice: '12.50' })]);
    await svc.updateContractLine('c1', 'l1', { unitPrice: '12.50' } as never, actor);
    expect(resolvePriceMock).not.toHaveBeenCalled();
    expect(setArgs()).toMatchObject({ unitPrice: '12.50', catalogItemId: null });
  });

  it('row 2: linked, link untouched — no reprice and the client price is ignored', async () => {
    queueResult([CONTRACT]); queueResult([line({ catalogItemId: CATALOG_A, unitPrice: '20.00' })]);
    queueResult([line({ catalogItemId: CATALOG_A, unitPrice: '20.00', description: 'Renamed' })]);
    await svc.updateContractLine('c1', 'l1', { description: 'Renamed', unitPrice: '1.00' } as never, actor);
    expect(resolvePriceMock).not.toHaveBeenCalled();
    expect(setArgs()).toMatchObject({ unitPrice: '20.00', description: 'Renamed' });
  });

  it('row 3: manual -> catalog re-resolves and ignores a client price in the same patch', async () => {
    resolvePriceMock.mockResolvedValueOnce({ unitPrice: '7.25', taxable: false } as never);
    queueResult([CONTRACT]); queueResult([line()]); queueResult([line({ catalogItemId: CATALOG_A, unitPrice: '7.25' })]);
    await svc.updateContractLine('c1', 'l1', { catalogItemId: CATALOG_A, unitPrice: '1.00' } as never, actor);
    expect(resolvePriceMock).toHaveBeenCalledWith(
      CATALOG_A, 'USD', 'org1',
      { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] },
      expect.anything(),
    );
    expect(setArgs()).toMatchObject({ unitPrice: '7.25', taxable: false, catalogItemId: CATALOG_A });
  });

  it('row 4: the SAME catalog id is idempotent — no resolve, no price move', async () => {
    queueResult([CONTRACT]); queueResult([line({ catalogItemId: CATALOG_A, unitPrice: '20.00' })]);
    queueResult([line({ catalogItemId: CATALOG_A, unitPrice: '20.00' })]);
    await svc.updateContractLine('c1', 'l1', { catalogItemId: CATALOG_A } as never, actor);
    expect(resolvePriceMock).not.toHaveBeenCalled();
    expect(setArgs()).toMatchObject({ unitPrice: '20.00', catalogItemId: CATALOG_A });
  });

  it('row 5: a DIFFERENT catalog id re-resolves against the new item', async () => {
    resolvePriceMock.mockResolvedValueOnce({ unitPrice: '9.00', taxable: true } as never);
    queueResult([CONTRACT]); queueResult([line({ catalogItemId: CATALOG_A, unitPrice: '20.00' })]);
    queueResult([line({ catalogItemId: CATALOG_B, unitPrice: '9.00' })]);
    await svc.updateContractLine('c1', 'l1', { catalogItemId: CATALOG_B } as never, actor);
    expect(resolvePriceMock).toHaveBeenCalledWith(CATALOG_B, 'USD', 'org1', expect.anything(), expect.anything());
    expect(setArgs()).toMatchObject({ unitPrice: '9.00', catalogItemId: CATALOG_B });
  });

  it('row 6a: unlink without unitPrice is 400 INVALID_LINE_PATCH', async () => {
    queueResult([CONTRACT]); queueResult([line({ catalogItemId: CATALOG_A })]);
    await expect(svc.updateContractLine('c1', 'l1', { catalogItemId: null, taxable: true } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
  });

  it('row 6b: unlink without taxable is 400 INVALID_LINE_PATCH', async () => {
    queueResult([CONTRACT]); queueResult([line({ catalogItemId: CATALOG_A })]);
    await expect(svc.updateContractLine('c1', 'l1', { catalogItemId: null, unitPrice: '3.00' } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
  });

  it('row 6c: unlink with both writes the hand-entered price and clears the link', async () => {
    queueResult([CONTRACT]); queueResult([line({ catalogItemId: CATALOG_A, unitPrice: '20.00' })]);
    queueResult([line({ catalogItemId: null, unitPrice: '3.00' })]);
    await svc.updateContractLine('c1', 'l1', { catalogItemId: null, unitPrice: '3.00', taxable: false } as never, actor);
    expect(setArgs()).toMatchObject({ catalogItemId: null, unitPrice: '3.00', taxable: false });
  });

  it('row 7: null on an already-unlinked line imposes no price requirement and still applies siblings', async () => {
    queueResult([CONTRACT]); queueResult([line()]); queueResult([line({ description: 'Renamed' })]);
    await svc.updateContractLine('c1', 'l1', { catalogItemId: null, description: 'Renamed' } as never, actor);
    expect(setArgs()).toMatchObject({ catalogItemId: null, description: 'Renamed' });
  });

  it('refreshCatalogPrice re-resolves a linked row and is 400 on an unlinked one', async () => {
    resolvePriceMock.mockResolvedValueOnce({ unitPrice: '11.00', taxable: true } as never);
    queueResult([CONTRACT]); queueResult([line({ catalogItemId: CATALOG_A, unitPrice: '20.00' })]);
    queueResult([line({ catalogItemId: CATALOG_A, unitPrice: '11.00' })]);
    await svc.updateContractLine('c1', 'l1', { refreshCatalogPrice: true } as never, actor);
    expect(setArgs()).toMatchObject({ unitPrice: '11.00' });

    results.length = 0;
    queueResult([CONTRACT]); queueResult([line()]);
    await expect(svc.updateContractLine('c1', 'l1', { refreshCatalogPrice: true } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400, details: { issues: [{ path: 'refreshCatalogPrice' }] } });
  });

  it('refreshCatalogPrice combined with catalogItemId null is the same 400', async () => {
    queueResult([CONTRACT]); queueResult([line({ catalogItemId: CATALOG_A })]);
    await expect(svc.updateContractLine('c1', 'l1', { catalogItemId: null, refreshCatalogPrice: true, unitPrice: '1.00', taxable: false } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
  });

  // ---- catalog error mapping ---------------------------------------------
  it.each([
    ['NO_PRICE_FOR_CURRENCY'],
    ['PRICE_NOT_REPRESENTABLE'],
  ])('maps CatalogServiceError %s to 409 with the code preserved', async (code) => {
    resolvePriceMock.mockRejectedValueOnce(new CatalogServiceError('nope', 409, code as never));
    queueResult([CONTRACT]); queueResult([line()]);
    await expect(svc.updateContractLine('c1', 'l1', { catalogItemId: CATALOG_A } as never, actor))
      .rejects.toMatchObject({ code, status: 409 });
  });

  // Non-enumerating on purpose: missing, foreign and RLS-invisible are ONE answer.
  it('maps ITEM_NOT_FOUND to 400 CATALOG_ITEM_NOT_FOUND with a non-enumerating message', async () => {
    resolvePriceMock.mockRejectedValueOnce(new CatalogServiceError('Catalog item not found', 404, 'ITEM_NOT_FOUND'));
    queueResult([CONTRACT]); queueResult([line()]);
    await expect(svc.updateContractLine('c1', 'l1', { catalogItemId: CATALOG_A } as never, actor))
      .rejects.toMatchObject({
        code: 'CATALOG_ITEM_NOT_FOUND', status: 400,
        message: 'That catalog item is not available on this contract',
      });
  });

  it('assertRepresentable fires for a hand-entered price on a non-catalog line', async () => {
    queueResult([{ ...CONTRACT, currencyCode: 'JPY' }]); queueResult([line()]);
    await expect(svc.updateContractLine('c1', 'l1', { unitPrice: '10.50' } as never, actor))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
  });

  // ---- merged-row invariants ---------------------------------------------
  it('rejects roles onto a per_device line with INVALID_LINE_PATCH and the failing path', async () => {
    queueResult([CONTRACT]); queueResult([line()]);
    await expect(svc.updateContractLine('c1', 'l1', { deviceRoles: ['server'] } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400, details: { issues: [{ path: 'deviceRoles' }] } });
  });

  it('rejects a siteId onto a per_device_group line', async () => {
    queueResult([CONTRACT]);
    queueResult([line({ lineType: 'per_device_group', deviceGroupId: GROUP_B, deviceGroupName: 'VIP' })]);
    await expect(svc.updateContractLine('c1', 'l1', { siteId: SITE_B } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400, details: { issues: [{ path: 'siteId' }] } });
  });

  // ---- ownership re-checks ------------------------------------------------
  // lockContract and the line read each use .limit(1); assertSiteInOrg would be
  // a third. Counting limit() calls is what distinguishes "checked" from "not".
  it('does NOT re-check the site when the patch does not move it', async () => {
    queueResult([CONTRACT]); queueResult([line({ siteId: SITE_B })]);
    queueResult([line({ siteId: SITE_B, description: 'Renamed' })]);
    queueResult([{ id: SITE_B, orgId: 'org1', name: 'HQ' }]);        // withLineRefs sites
    await svc.updateContractLine('c1', 'l1', { description: 'Renamed' } as never, actor);
    expect((db as unknown as Chain).limit.mock.calls).toHaveLength(2);
  });

  it('re-checks the site when the patch moves it', async () => {
    queueResult([CONTRACT]); queueResult([line()]);
    queueResult([{ id: SITE_B }]);                                   // assertSiteInOrg
    queueResult([line({ siteId: SITE_B })]);
    queueResult([{ id: SITE_B, orgId: 'org1', name: 'HQ' }]);        // withLineRefs sites
    await svc.updateContractLine('c1', 'l1', { siteId: SITE_B } as never, actor);
    expect((db as unknown as Chain).limit.mock.calls).toHaveLength(3);
    expect(setArgs()).toMatchObject({ siteId: SITE_B });
  });

  it('re-stamps device_group_name from the resolved group', async () => {
    queueResult([CONTRACT]);
    queueResult([line({ lineType: 'per_device_group', deviceGroupId: GROUP_B, deviceGroupName: 'Old name' })]);
    queueResult([{ id: GROUP_B, name: 'New name', type: 'static', siteId: null }]);  // assertGroupInOrg
    queueResult([line({ lineType: 'per_device_group', deviceGroupId: GROUP_B, deviceGroupName: 'New name' })]);
    queueResult([{ id: GROUP_B, orgId: 'org1', name: 'New name', type: 'static' }]); // withLineRefs groups
    await svc.updateContractLine('c1', 'l1', { deviceGroupId: GROUP_B } as never, actor);
    expect(setArgs()).toMatchObject({ deviceGroupId: GROUP_B, deviceGroupName: 'New name' });
  });

  it('maps a 23503 on contract_lines_device_group_org_fk to 400 GROUP_NOT_IN_ORG', async () => {
    queueResult([CONTRACT]);
    queueResult([line({ lineType: 'per_device_group', deviceGroupId: GROUP_B, deviceGroupName: 'VIP' })]);
    queueResult([{ id: GROUP_B, name: 'VIP', type: 'static', siteId: null }]);
    const chain = db as unknown as Chain & { update: ReturnType<typeof vi.fn> };
    chain.update.mockImplementationOnce(() => { throw Object.assign(new Error('fk'), { code: '23503', constraint_name: 'contract_lines_device_group_org_fk' }); });
    await expect(svc.updateContractLine('c1', 'l1', { deviceGroupId: GROUP_B } as never, actor))
      .rejects.toMatchObject({ code: 'GROUP_NOT_IN_ORG', status: 400 });
  });

  // ---- audit diff ---------------------------------------------------------
  it('lists only genuinely changed columns and carries old/new price only on a price change', async () => {
    queueResult([CONTRACT]); queueResult([line()]); queueResult([line({ unitPrice: '12.50', description: 'Renamed' })]);
    const { audit } = await svc.updateContractLine('c1', 'l1', { unitPrice: '12.50', description: 'Renamed' } as never, actor);
    expect(audit.changedFields!.sort()).toEqual(['description', 'unitPrice']);
    expect(audit).toMatchObject({ oldUnitPrice: '10.00', newUnitPrice: '12.50', lineType: 'per_device', contractLineId: 'l1' });
  });

  it('does not treat a deviceRoles reorder as a change, and returns changedFields [] for a no-op patch', async () => {
    const roleLine = line({ lineType: 'per_device_role', deviceRoles: ['server', 'switch'] });
    queueResult([CONTRACT]); queueResult([roleLine]);
    queueResult([line({ lineType: 'per_device_role', deviceRoles: ['switch', 'server'] })]);
    const { audit } = await svc.updateContractLine('c1', 'l1', { deviceRoles: ['switch', 'server'] } as never, actor);
    expect(audit.changedFields).toEqual([]);
  });

  // The no-free-text rule (decision 6): assert the KEY SET, so a future field
  // cannot leak a description, a site name or a group name into the audit log.
  it('never carries a value of any string column', async () => {
    queueResult([CONTRACT]);
    queueResult([line({ lineType: 'per_device_group', deviceGroupId: GROUP_B, deviceGroupName: 'VIP laptops', description: 'Secret' })]);
    queueResult([{ id: GROUP_B, name: 'VIP laptops', type: 'static', siteId: null }]);
    queueResult([line({ lineType: 'per_device_group', deviceGroupId: GROUP_B, deviceGroupName: 'VIP laptops', description: 'Also secret' })]);
    const { audit } = await svc.updateContractLine('c1', 'l1', { deviceGroupId: GROUP_B, description: 'Also secret' } as never, actor);
    expect(Object.keys(audit).sort()).toEqual(
      ['changedFields', 'contractId', 'contractLineId', 'contractName', 'lineType', 'orgId'].sort(),
    );
    expect(JSON.stringify(audit)).not.toContain('VIP laptops');
    expect(JSON.stringify(audit)).not.toContain('Also secret');
  });

  it('returns the line decorated with site and deviceGroup', async () => {
    queueResult([CONTRACT]); queueResult([line({ siteId: SITE_B })]);
    queueResult([line({ siteId: SITE_B, description: 'Renamed' })]);
    queueResult([{ id: SITE_B, orgId: 'org1', name: 'HQ' }]);   // withLineRefs sites
    const { line: decorated } = await svc.updateContractLine('c1', 'l1', { description: 'Renamed' } as never, actor);
    expect(decorated).toMatchObject({ site: { id: SITE_B, name: 'HQ' }, deviceGroup: null });
  });
});

describe('removeContractLine pre-read (#3205 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('returns the lineType read BEFORE the delete', async () => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1', name: 'Acme MSA', status: 'active', currencyCode: 'USD' }]);
    queueResult([{ id: 'l1', lineType: 'per_seat' }]);
    queueResult([]);
    const audit = await svc.removeContractLine('c1', 'l1', actor);
    expect(audit).toMatchObject({ orgId: 'org1', contractId: 'c1', contractName: 'Acme MSA', contractLineId: 'l1', lineType: 'per_seat' });
    expect(audit.changedFields).toBeUndefined();
  });

  // Deliberate behaviour change: a DELETE for a line that does not exist was a
  // silent 200. Its permissiveness is what would make the removal audit lie.
  it('throws LINE_NOT_FOUND (404) when nothing matched, and never issues the delete', async () => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1', name: 'Acme MSA', status: 'active', currencyCode: 'USD' }]);
    queueResult([]);
    await expect(svc.removeContractLine('c1', 'missing', actor)).rejects.toMatchObject({ code: 'LINE_NOT_FOUND', status: 404 });
    expect((db as unknown as Chain).delete.mock.calls).toHaveLength(0);
  });
});

describe('deterministic line ordering (#3205 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  // generateDueInvoice's third read is covered behaviourally in
  // contractLineEditing.integration.test.ts (its invoice lines come back in
  // (sortOrder, createdAt, id) order) — mocking its whole transaction here
  // would assert the mock, not the order.
  it.each([
    ['getContract', () => svc.getContract('c1', actor)],
    ['computeContractEstimate', () => svc.computeContractEstimate('c1', actor)],
  ])('%s orders by (sortOrder, createdAt, id)', async (_name, run) => {
    queueResult([{ id: 'c1', orgId: 'org1', partnerId: 'p1', name: 'C', status: 'active', currencyCode: 'USD' }]);
    queueResult([]); queueResult([]); queueResult([]);
    await run();
    const orderBy = (db as unknown as { orderBy: { mock: { calls: unknown[][] } } }).orderBy.mock.calls[0]!;
    expect(orderBy).toHaveLength(3);   // sortOrder, createdAt, id
  });
});
```

Also extend the `Chain` type alias near `:65` so the new assertions typecheck:

```ts
type Chain = {
  set: { mock: { calls: unknown[][] } };
  delete: { mock: { calls: unknown[][] } };
  update: { mock: { calls: unknown[][] } };
  limit: { mock: { calls: unknown[][] } };
  for: { mock: { calls: unknown[][] } };
};
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/contractService.test.ts`
Expected: FAIL — `svc.updateContractLine is not a function`, plus the `removeContractLine` and ordering describes failing on the current shapes.


- [ ] **Step 3: Write the failing integration test**

Create `apps/api/src/__tests__/integration/contractLineEditing.integration.test.ts`:

```ts
/**
 * #3205 W03 acceptance bar, real Postgres as breeze_app (forced RLS, no bypass).
 *
 * The headline is LINEAGE: editing a line in place leaves an already-generated
 * draft invoice issuable, where delete-and-re-add wedges it with SOURCE_NOT_FOUND
 * (invoiceService.ts:1194-1199). The delete path is the CONTROL in the same test,
 * so the fix is provably the thing being measured.
 *
 * The asymmetry matrix is asserted on BOTH sides. Three of its five cases the
 * database ACCEPTS — that is the point. Nobody may later "fix" one of these by
 * assuming a constraint that does not exist; if a wave wants those constraints,
 * that is a migration, not an assumption.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, deviceGroups, contracts, contractLines, invoiceLines } from '../../db/schema';
import {
  addContractLineToContract, updateContractLine, removeContractLine, getContract,
  generateDueInvoice, type ContractActorT,
} from '../../services/contractService';
import { issueInvoice } from '../../services/invoiceService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  actor: ContractActorT; partnerId: string; orgId: string; otherOrgId: string;
  siteId: string; otherSiteId: string; groupId: string; otherGroupId: string; contractId: string;
}

async function seed(status: 'draft' | 'active' | 'paused' | 'cancelled' = 'draft'): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `EP ${sfx}`, slug: `ep-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [oA, oB] = await db.insert(organizations).values([
      { currencyCode: 'USD', partnerId: p!.id, name: 'EA', slug: `ea-${sfx}` },
      { currencyCode: 'USD', partnerId: p!.id, name: 'EB', slug: `eb-${sfx}` },
    ]).returning({ id: organizations.id });
    const [sA] = await db.insert(sites).values({ orgId: oA!.id, name: `A-${sfx}` }).returning({ id: sites.id });
    const [sB] = await db.insert(sites).values({ orgId: oB!.id, name: `B-${sfx}` }).returning({ id: sites.id });
    const [gA] = await db.insert(deviceGroups).values({ orgId: oA!.id, name: `GA ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id });
    const [gB] = await db.insert(deviceGroups).values({ orgId: oB!.id, name: `GB ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: oA!.id, name: `Edit ${sfx}`, status, intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
    }).returning({ id: contracts.id });
    return {
      actor: { userId: null as unknown as string, partnerId: p!.id, accessibleOrgIds: [oA!.id] },
      partnerId: p!.id, orgId: oA!.id, otherOrgId: oB!.id, siteId: sA!.id, otherSiteId: sB!.id,
      groupId: gA!.id, otherGroupId: gB!.id, contractId: c!.id,
    };
  });
}

/** Insert a line straight through SQL so the fixture is not bounded by the
 *  writer's own validation — the point of the matrix is what the DB does. */
async function rawLine(f: Fixture, cols: Record<string, unknown>): Promise<string> {
  const rows = await withSystemDbAccessContext(() => db.insert(contractLines).values({
    contractId: f.contractId, orgId: f.orgId, lineType: 'per_device', description: 'L',
    unitPrice: '10.00', taxable: false, ...cols,
  } as never).returning({ id: contractLines.id }));
  return rows[0]!.id;
}

function pgErrorFields(error: unknown): { code?: string; constraint?: string } {
  const wrapped = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | undefined;
  const node = wrapped?.cause ?? wrapped;
  return { code: node?.code, constraint: node?.constraint_name };
}

/** Forge the same row the service refused, as breeze_app, and report the verdict. */
async function forge(lineId: string, setSql: ReturnType<typeof sql>): Promise<{ code?: string; constraint?: string } | 'accepted'> {
  try {
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE contract_lines SET ${setSql} WHERE id = ${lineId}::uuid`));
    return 'accepted';
  } catch (err) {
    return pgErrorFields(err);
  }
}

describe('contract line editing (real DB) #3205 W03', () => {
  // ---- asymmetry matrix: app verdict AND database verdict, every case -------
  runDb('roles onto a per_device line: app 400, DB 23514 on contract_lines_device_roles_chk', async () => {
    const f = await seed();
    const id = await rawLine(f, {});
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { deviceRoles: ['server'] } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
    expect(await forge(id, sql`device_roles = ARRAY['server']::text[]`))
      .toEqual({ code: '23514', constraint: 'contract_lines_device_roles_chk' });
  });

  runDb('roles cleared from a per_device_role line: app 400, DB 23514', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] });
    // deviceRoles is not nullable in the patch schema, so the app-side proof is
    // the merged-row rule reached through a sibling edit that cannot fix it.
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { deviceRoles: ['server', 'server'] } as never, f.actor)))
      .rejects.toMatchObject({ status: 400 });
    expect(await forge(id, sql`device_roles = NULL`))
      .toEqual({ code: '23514', constraint: 'contract_lines_device_roles_chk' });
  });

  runDb('a site_id onto a per_device_group line: app 400, DB 23514 on contract_lines_device_group_chk', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'per_device_group', deviceGroupId: f.groupId, deviceGroupName: 'GA' });
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { siteId: f.siteId } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
    expect(await forge(id, sql`site_id = ${f.siteId}::uuid`))
      .toEqual({ code: '23514', constraint: 'contract_lines_device_group_chk' });
  });

  // `<@` is CONTAINMENT, not set equality — the helper is the only guard.
  runDb('duplicate roles: app 400, DB ACCEPTS', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'per_device_role', deviceRoles: ['server'] });
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { deviceRoles: ['server', 'server'] } as never, f.actor)))
      .rejects.toMatchObject({ status: 400 });
    expect(await forge(id, sql`device_roles = ARRAY['server','server']::text[]`)).toBe('accepted');
  });

  // There is NO CHECK on manual_quantity at all — the helper is the only guard.
  runDb('manualQuantity on a flat line: app 400, DB ACCEPTS', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'flat' });
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { manualQuantity: '5.00' } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
    expect(await forge(id, sql`manual_quantity = 5.00`)).toBe('accepted');
  });

  // W02's CHECK forbids a site on per_device_group ONLY — the helper is the
  // only guard for flat / manual / per_seat.
  runDb('site_id on a flat line: app 400, DB ACCEPTS', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'flat' });
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { siteId: f.siteId } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
    expect(await forge(id, sql`site_id = ${f.siteId}::uuid`)).toBe('accepted');
  });

  // ---- the orphaned-group repair (decision 7) ------------------------------
  runDb('re-points an orphaned group line at a live group and re-stamps the name; a foreign group is 400', async () => {
    const f = await seed();
    const id = await rawLine(f, { lineType: 'per_device_group', deviceGroupId: null, deviceGroupName: 'Retired group' });
    const [replacement] = await withSystemDbAccessContext(() => db.insert(deviceGroups)
      .values({ orgId: f.orgId, name: 'Replacement', type: 'static' }).returning({ id: deviceGroups.id }));
    const { line } = await withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { deviceGroupId: replacement!.id } as never, f.actor));
    expect(line).toMatchObject({ deviceGroupId: replacement!.id, deviceGroupName: 'Replacement' });
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { deviceGroupId: f.otherGroupId } as never, f.actor)))
      .rejects.toMatchObject({ code: 'GROUP_NOT_IN_ORG', status: 400 });
  });

  runDb('a site in another org is 400 SITE_NOT_IN_ORG', async () => {
    const f = await seed();
    const id = await rawLine(f, {});
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { siteId: f.otherSiteId } as never, f.actor)))
      .rejects.toMatchObject({ code: 'SITE_NOT_IN_ORG', status: 400 });
  });

  // ---- bounds never reach Postgres ----------------------------------------
  runDb('over-bounds unitPrice and sortOrder are rejected by the schema, so the service is never called', async () => {
    const { updateContractLineSchema } = await import('@breeze/shared');
    expect(updateContractLineSchema.safeParse({ unitPrice: '99999999999.00' }).success).toBe(false);
    expect(updateContractLineSchema.safeParse({ sortOrder: 2147483648 }).success).toBe(false);
    // And the value that IS in range round-trips through the column.
    const f = await seed();
    const id = await rawLine(f, {});
    const { line } = await withSystemDbAccessContext(() => updateContractLine(f.contractId, id, { unitPrice: '9999999999.99', sortOrder: 2147483647 } as never, f.actor));
    expect(line).toMatchObject({ unitPrice: '9999999999.99', sortOrder: 2147483647 });
  });

  // ---- deterministic ordering ---------------------------------------------
  runDb('three lines all at sortOrder 0 come back in the same order on repeated reads, and a sortOrder edit reorders', async () => {
    const f = await seed();
    const ids: string[] = [];
    for (const description of ['one', 'two', 'three']) {
      ids.push(await rawLine(f, { description }));
    }
    const first = await withSystemDbAccessContext(() => getContract(f.contractId, f.actor));
    const second = await withSystemDbAccessContext(() => getContract(f.contractId, f.actor));
    expect(second.lines.map((l) => l.id)).toEqual(first.lines.map((l) => l.id));
    await withSystemDbAccessContext(() => updateContractLine(f.contractId, ids[0]!, { sortOrder: 9 } as never, f.actor));
    const third = await withSystemDbAccessContext(() => getContract(f.contractId, f.actor));
    expect(third.lines.at(-1)!.id).toBe(ids[0]);
  });

  runDb('generateDueInvoice bills lines in (sortOrder, createdAt, id) order', async () => {
    const f = await seed('active');
    const ids: string[] = [];
    for (const description of ['first', 'second', 'third']) {
      ids.push(await rawLine(f, { lineType: 'flat', description, unitPrice: '1.00' }));
    }
    // Push the first line to the back; the other two keep their createdAt order.
    await withSystemDbAccessContext(() => updateContractLine(f.contractId, ids[0]!, { sortOrder: 9 } as never, f.actor));
    const gen = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'))));
    const rows = await withSystemDbAccessContext(() => db.select({ description: invoiceLines.description, sourceId: invoiceLines.sourceId })
      .from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));
    expect(rows.map((r) => r.sourceId)).toEqual([ids[1], ids[2], ids[0]]);
  });

  // ---- LINEAGE (the headline) ---------------------------------------------
  runDb('editing a source line leaves the drafted invoice byte-identical and still issuable; delete-and-re-add wedges it', async () => {
    const f = await seed('active');
    const lineId = await rawLine(f, { lineType: 'flat', description: 'Monthly fee', unitPrice: '100.00' });
    const gen = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'))));
    expect(gen.generated).toBe(true);
    const [beforeLine] = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));

    await withSystemDbAccessContext(() => updateContractLine(f.contractId, lineId, { unitPrice: '250.00', description: 'Renamed' } as never, f.actor));
    const [afterLine] = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));
    expect(afterLine).toEqual(beforeLine);
    await expect(withSystemDbAccessContext(() => issueInvoice(gen.invoiceId!, {
      userId: null, partnerId: f.partnerId, accessibleOrgIds: [f.orgId],
    } as never))).resolves.toBeDefined();

    // CONTROL: the pre-W03 repair — delete and re-add — wedges the draft.
    const g2 = await seed('active');
    const lineId2 = await rawLine(g2, { lineType: 'flat', description: 'Monthly fee', unitPrice: '100.00' });
    const gen2 = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(g2.contractId, new Date('2026-07-01T06:00:00Z'))));
    await withSystemDbAccessContext(() => removeContractLine(g2.contractId, lineId2, g2.actor));
    await withSystemDbAccessContext(() => addContractLineToContract(g2.contractId, {
      lineType: 'flat', description: 'Monthly fee', unitPrice: '250.00', taxable: false,
    } as never, g2.actor));
    await expect(withSystemDbAccessContext(() => issueInvoice(gen2.invoiceId!, {
      userId: null, partnerId: g2.partnerId, accessibleOrgIds: [g2.orgId],
    } as never))).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', status: 409 });
  });

  // ---- edit vs generation (decision 5) ------------------------------------
  runDb('an edit fired during generation waits for the contract lock; the invoice keeps the PRE-edit price', async () => {
    const f = await seed('active');
    const lineId = await rawLine(f, { lineType: 'flat', description: 'Monthly fee', unitPrice: '100.00' });
    // Both take contracts.id FOR UPDATE as their first statement, so they
    // serialise. The hold makes the interleaving observable, not the outcome.
    const generation = withSystemDbAccessContext(() => db.transaction(async () => {
      const r = await generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      return r;
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const edit = withSystemDbAccessContext(() => updateContractLine(f.contractId, lineId, { unitPrice: '250.00' } as never, f.actor));
    const [gen] = await Promise.all([generation, edit]);
    const [invLine] = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));
    expect(invLine!.unitPrice).toBe('100.00');
    const [row] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, lineId)));
    expect(row!.unitPrice).toBe('250.00');
  });

  runDb('an edit that commits first is billed by the next generation', async () => {
    const f = await seed('active');
    const lineId = await rawLine(f, { lineType: 'flat', description: 'Monthly fee', unitPrice: '100.00' });
    await withSystemDbAccessContext(() => updateContractLine(f.contractId, lineId, { unitPrice: '250.00' } as never, f.actor));
    const gen = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contractId, new Date('2026-07-01T06:00:00Z'))));
    const [invLine] = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, gen.invoiceId!)));
    expect(invLine!.unitPrice).toBe('250.00');
  });

  // ---- edit vs edit: last-writer-wins, documented not accidental -----------
  runDb('concurrent patches to DIFFERENT fields both survive; sequential patches to the SAME field leave the later value', async () => {
    const f = await seed();
    const lineId = await rawLine(f, { lineType: 'flat', description: 'Original', unitPrice: '10.00' });
    await Promise.all([
      withSystemDbAccessContext(() => updateContractLine(f.contractId, lineId, { description: 'Renamed' } as never, f.actor)),
      withSystemDbAccessContext(() => updateContractLine(f.contractId, lineId, { unitPrice: '11.00' } as never, f.actor)),
    ]);
    const [both] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, lineId)));
    expect(both).toMatchObject({ description: 'Renamed', unitPrice: '11.00' });

    await withSystemDbAccessContext(() => updateContractLine(f.contractId, lineId, { unitPrice: '20.00' } as never, f.actor));
    await withSystemDbAccessContext(() => updateContractLine(f.contractId, lineId, { unitPrice: '30.00' } as never, f.actor));
    const [last] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, lineId)));
    expect(last!.unitPrice).toBe('30.00');
  });

  // ---- status and tenancy gates -------------------------------------------
  runDb.each(['paused', 'cancelled'] as const)('editing a line on a %s contract is 409 INVALID_STATE', async (status) => {
    const f = await seed();
    const lineId = await rawLine(f, {});
    await withSystemDbAccessContext(() => db.update(contracts).set({ status }).where(eq(contracts.id, f.contractId)));
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, lineId, { description: 'x' } as never, f.actor)))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  runDb('an actor whose accessibleOrgIds excludes the org gets 403 and changes no row', async () => {
    const f = await seed();
    const lineId = await rawLine(f, { description: 'Original' });
    const foreign: ContractActorT = { ...f.actor, accessibleOrgIds: [f.otherOrgId] };
    await expect(withSystemDbAccessContext(() => updateContractLine(f.contractId, lineId, { description: 'Hijacked' } as never, foreign)))
      .rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
    const [row] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, lineId)));
    expect(row!.description).toBe('Original');
  });

  runDb('DELETE for a line that does not exist is 404 LINE_NOT_FOUND', async () => {
    const f = await seed();
    await expect(withSystemDbAccessContext(() => removeContractLine(f.contractId, '99999999-9999-4999-8999-999999999999', f.actor)))
      .rejects.toMatchObject({ code: 'LINE_NOT_FOUND', status: 404 });
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run:
```bash
cd apps/api && DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test \
  npx vitest run --config vitest.integration.config.ts src/__tests__/integration/contractLineEditing.integration.test.ts
```
Expected: FAIL — `updateContractLine` is not exported from `contractService`, so the module import errors before any case runs.

- [ ] **Step 5: Error codes and the shared audit type (`contractTypes.ts`)**

Add to the end of `ContractServiceErrorCode` (after `'BROKEN_CONTRACT_LINEAGE'`, converting its `;` to `|`):

```ts
  // #3205 W03: the patch, merged onto the current row, violates a contract-line
  // invariant (roles on a non-role line, a site on a group line, an unlink with
  // no price, a refresh with no link). `details.issues` carries the failing
  // paths. Distinct from INVALID_STATE, which is about the CONTRACT's status.
  | 'INVALID_LINE_PATCH'
  // #3205 W03: resolvePrice could not reach the catalog item. Deliberately does
  // NOT distinguish missing / foreign / RLS-invisible (catalogService.ts:680) —
  // a 404 that fires only for foreign ids enumerates other partners' catalogs.
  | 'CATALOG_ITEM_NOT_FOUND';
```

Add the import at the top of the file and the audit type at the bottom:

```ts
import type { ContractLineType } from '@breeze/shared';
```

```ts
/**
 * #3205 W03: what a line mutation tells the audit log. Both doors write it —
 * the HTTP route through writeRouteAudit, the AI tool through writeAuditEvent
 * with initiatedBy: 'ai'.
 *
 * NO FREE TEXT. No description, no site name, no group name: the audit log is
 * queryable by support and none of that is incident data (same reasoning as the
 * recipient-count rule at routes/invoices/lifecycle.ts:70-72).
 */
export interface ContractLineAudit {
  orgId: string;
  contractId: string;
  /** Absent on `contract.line.added`: the add path derives its payload from the
   *  inserted row, which carries no contract name, and its signature is
   *  deliberately unchanged. Becomes the audit event's resourceName when set. */
  contractName?: string;
  contractLineId: string;
  lineType: ContractLineType;
  /** Column NAMES whose persisted value changed. Empty on a no-op patch.
   *  Absent for add/remove. Never a value — see the no-free-text rule. */
  changedFields?: string[];
  oldUnitPrice?: string;   // only when unitPrice changed
  newUnitPrice?: string;   // also set on add
}
```

- [ ] **Step 6: Catalog error mapping, on both paths (`contractService.ts`)**

Extend the `@breeze/shared` import on `:6` with the W03 helpers and add the type import:

```ts
import {
  BILLABLE_DEVICE_ROLES, isRepresentableInCurrency, minorUnitExponent, roundToCurrency, PERMISSION_GRANTS,
  contractLineInvariantIssues, mergeContractLinePatch, patchHasKey,
  type DeviceRole, type UpdateContractLineInput,
} from '@breeze/shared';
```

and `:4`:

```ts
import { ContractServiceError, actorCan, type ContractActor, type ContractLineAudit } from './contractTypes';
```

Insert immediately above `addContractLineToContract` (after `assertRepresentable`, `:865`):

```ts
/**
 * #3205 W03: one mapping for every resolvePrice failure on a contract line.
 *
 * ITEM_NOT_FOUND was UNMAPPED on the add path: resolvePrice opens with
 * getOwnedItemOr404, which throws CatalogServiceError('Catalog item not found',
 * 404, 'ITEM_NOT_FOUND'), and handleContractError rethrows anything that is not
 * a ContractServiceError — so a stale or foreign catalog item id on add was a
 * live 500. 400, not 404: the contract line exists; the id in the body is what
 * is wrong. The message deliberately does NOT distinguish missing / foreign /
 * RLS-invisible, because a 404 that fires only for foreign ids is a
 * partner-enumeration oracle.
 */
function mapCatalogResolveError(err: unknown): never {
  if (err instanceof CatalogServiceError) {
    if (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE') {
      throw new ContractServiceError(err.message, 409, err.code);
    }
    if (err.code === 'ITEM_NOT_FOUND') {
      throw new ContractServiceError('That catalog item is not available on this contract', 400, 'CATALOG_ITEM_NOT_FOUND');
    }
  }
  throw err;
}
```

In `addContractLineToContract`, replace the whole existing catch body (`:879-885`) with:

```ts
      } catch (err) {
        mapCatalogResolveError(err);
      }
```

- [ ] **Step 7: `withLineRefs` and deterministic ordering**

Insert after `getOwnedContractOr404` (`:52`) — `sites` is already imported on `:3`; add `deviceGroups` to that import (W02 does the same):

```ts
export type DecoratedContractLine = typeof contractLines.$inferSelect & {
  site: { id: string; name: string } | null;
  deviceGroup: { id: string; name: string; type: 'static' | 'dynamic' } | null;
};

/** #3205 W03: one decorator for every line read. The group leg is W02's
 *  (renamed from withDeviceGroup); the site leg is the W01-deferred detail-page
 *  legibility fix — ContractDetail loads no sites of its own, so the name has to
 *  travel on the line. Both legs match on (id, org_id): defence in depth beside
 *  the composite FKs, and null when the referenced row is gone (site_id is
 *  ON DELETE SET NULL). Two batched inArray selects, never a per-line query. */
async function withLineRefs<T extends { siteId: string | null; deviceGroupId: string | null; orgId: string }>(
  lines: T[],
): Promise<Array<T & {
  site: { id: string; name: string } | null;
  deviceGroup: { id: string; name: string; type: 'static' | 'dynamic' } | null;
}>> {
  const siteIds = [...new Set(lines.map((l) => l.siteId).filter((x): x is string => x !== null))];
  const groupIds = [...new Set(lines.map((l) => l.deviceGroupId).filter((x): x is string => x !== null))];
  const siteRows = siteIds.length === 0 ? [] : await db
    .select({ id: sites.id, orgId: sites.orgId, name: sites.name })
    .from(sites).where(inArray(sites.id, siteIds));
  const groupRows = groupIds.length === 0 ? [] : await db
    .select({ id: deviceGroups.id, orgId: deviceGroups.orgId, name: deviceGroups.name, type: deviceGroups.type })
    .from(deviceGroups).where(inArray(deviceGroups.id, groupIds));
  const siteByKey = new Map(siteRows.map((s) => [`${s.id}|${s.orgId}`, { id: s.id, name: s.name }]));
  const groupByKey = new Map(groupRows.map((g) => [`${g.id}|${g.orgId}`, { id: g.id, name: g.name, type: g.type }]));
  return lines.map((l) => ({
    ...l,
    site: l.siteId ? (siteByKey.get(`${l.siteId}|${l.orgId}`) ?? null) : null,
    deviceGroup: l.deviceGroupId ? (groupByKey.get(`${l.deviceGroupId}|${l.orgId}`) ?? null) : null,
  }));
}
```

Replace W02's `withDeviceGroup` call in `getContract` with `withLineRefs`, and give all three line reads the deterministic order. In `getContract` (`:136-138`):

```ts
export async function getContract(contractId: string, actor: ContractActor) {
  const contract = await getOwnedContractOr404(contractId, actor);
  // #3205 W03: (sortOrder, createdAt, id). sortOrder alone is not a total order
  // — addContractLineToContract defaults it to 0, so everything created through
  // the editor ties — and Postgres was free to reshuffle the table on any edit.
  const lines = await db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId))
    .orderBy(contractLines.sortOrder, contractLines.createdAt, contractLines.id);
  const periods = await db.select().from(contractBillingPeriods)
    .where(eq(contractBillingPeriods.contractId, contractId)).orderBy(desc(contractBillingPeriods.periodStart));
  return { contract, lines: await withLineRefs(lines), periods };
}
```

Apply the identical three-column `orderBy` to `computeContractEstimate` (`:264-266`) and `generateDueInvoice` (`:1093-1094`) — all three, not just the UI one, so the estimate, the detail table and the generated invoice agree.

- [ ] **Step 8: The audit diff**

Insert after `withLineRefs`:

```ts
/** Columns a line PATCH can move. The audit reports NAMES from this list only. */
const AUDITED_LINE_COLUMNS = [
  'description', 'unitPrice', 'taxable', 'catalogItemId', 'manualQuantity',
  'siteId', 'deviceRoles', 'deviceGroupId', 'deviceGroupName', 'sortOrder',
] as const;
type AuditedLineColumn = typeof AUDITED_LINE_COLUMNS[number];
type ContractLineRowT = typeof contractLines.$inferSelect;

function lineColumnChanged(field: AuditedLineColumn, before: ContractLineRowT, after: ContractLineRowT): boolean {
  if (field === 'deviceRoles') {
    // A reorder is not a change: the set is what bills.
    const norm = (v: readonly string[] | null) => (v === null ? null : JSON.stringify([...v].sort()));
    return norm(before.deviceRoles) !== norm(after.deviceRoles);
  }
  // String()-normalise: Postgres hands numerics back as strings, and a numeric
  // column round-tripped through Drizzle must not read as "changed".
  const norm = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return norm(before[field]) !== norm(after[field]);
}

/** #3205 W03: changedFields comes from the PERSISTED rows, never from the patch
 *  keys — an ignored client price (transition rows 2/4) must never claim to have
 *  applied, and a patch that changes nothing must report []. */
function diffLineAudit(
  before: ContractLineRowT, after: ContractLineRowT,
  c: { id: string; orgId: string; name: string },
): ContractLineAudit {
  const changedFields = AUDITED_LINE_COLUMNS.filter((f) => lineColumnChanged(f, before, after));
  return {
    orgId: c.orgId, contractId: c.id, contractName: c.name,
    contractLineId: after.id, lineType: after.lineType,
    changedFields: [...changedFields],
    ...(changedFields.includes('unitPrice')
      ? { oldUnitPrice: before.unitPrice, newUnitPrice: after.unitPrice }
      : {}),
  };
}
```

- [ ] **Step 9: `updateContractLine`**

Insert immediately after `addContractLineToContract`:

```ts
/**
 * PATCH one contract line in place (#3205 W03). Keeping the line's id is the
 * whole point: invoice_lines.source_id carries it, and issueInvoice refuses a
 * draft whose source line is gone (invoiceService.ts:1194-1199), so
 * delete-and-re-add wedges any unissued generated invoice.
 *
 * Lock order is the one every contract writer takes — contracts FOR UPDATE, then
 * contract_lines — the same order issueInvoice/voidInvoice take, so there is no
 * new deadlock edge. No FOR UPDATE on the line itself: the contract lock already
 * excludes every other line writer.
 *
 * Edits affect FUTURE periods only, by construction rather than by a guard:
 * invoice lines carry their own copies of description, quantity, unit price and
 * taxable (invoiceService.ts:405-450), and nothing re-reads a contract line's
 * CONTENT after generation.
 */
export async function updateContractLine(
  contractId: string, lineId: string, patch: UpdateContractLineInput, actor: ContractActor,
): Promise<{ line: DecoratedContractLine; audit: ContractLineAudit }> {
  const { before, after, contract } = await db.transaction(async (tx) => {
    const c = await lockContract(tx, contractId, actor);
    assertEditable(c);

    const [current] = await tx.select().from(contractLines)
      .where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId))).limit(1);
    if (!current) throw new ContractServiceError('Contract line not found', 404, 'LINE_NOT_FOUND');

    // ---- catalog transition table (spec § Validators (d)) ------------------
    const touchesLink = patchHasKey(patch, 'catalogItemId');
    const targetItemId = touchesLink ? (patch.catalogItemId ?? null) : current.catalogItemId;
    // Row 4 is excluded here on purpose: the SAME id re-sent is a no-op, not a
    // reprice — a form echoing the current id must change nothing.
    const relinking = touchesLink && patch.catalogItemId != null && patch.catalogItemId !== current.catalogItemId;
    const unlinking = touchesLink && patch.catalogItemId === null && current.catalogItemId !== null;
    const refreshing = patch.refreshCatalogPrice === true;

    if (refreshing && targetItemId === null) {
      throw new ContractServiceError('The line is not linked to a catalog item', 400, 'INVALID_LINE_PATCH', {
        issues: [{ path: 'refreshCatalogPrice', message: 'the line is not linked to a catalog item' }],
      });
    }

    let resolved: { unitPrice: string; taxable: boolean; catalogItemId: string | null } | undefined;
    if (relinking || (refreshing && targetItemId !== null)) {
      let priced: Awaited<ReturnType<typeof resolvePrice>>;
      try {
        priced = await resolvePrice(
          targetItemId!, c.currencyCode, c.orgId,
          { userId: actor.userId, partnerId: c.partnerId, accessibleOrgIds: actor.accessibleOrgIds },
          tx,
        );
      } catch (err) {
        mapCatalogResolveError(err);
      }
      resolved = { unitPrice: priced.unitPrice, taxable: priced.taxable, catalogItemId: targetItemId };
    } else if (unlinking) {
      // After an unlink nothing re-resolves this number ever again, so the
      // operator has to supply it now.
      if (patch.unitPrice === undefined || patch.taxable === undefined) {
        throw new ContractServiceError('unitPrice and taxable are required when clearing catalogItemId', 400, 'INVALID_LINE_PATCH', {
          issues: [{ path: 'unitPrice', message: 'unitPrice and taxable are required when clearing catalogItemId' }],
        });
      }
      assertRepresentable(patch.unitPrice, c.currencyCode);
    } else if (targetItemId === null && patch.unitPrice !== undefined) {
      assertRepresentable(patch.unitPrice, c.currencyCode);
    }
    // When the merged row stays LINKED and no resolve ran (rows 2 and 4),
    // mergeContractLinePatch drops patch.unitPrice / patch.taxable.

    const merged = mergeContractLinePatch(current, patch, resolved);
    const issues = contractLineInvariantIssues(merged, { mode: 'persisted' });
    if (issues.length > 0) {
      throw new ContractServiceError(issues[0]!.message, 400, 'INVALID_LINE_PATCH', { issues });
    }

    // Ownership checks, only when the patch actually moves them.
    if (merged.siteId !== null && merged.siteId !== current.siteId) {
      await assertSiteInOrg(tx, merged.siteId, c.orgId);
    }
    // Ordering note: the invariants above read deviceGroupName from `current`,
    // which W02's CHECK guarantees non-null on any persisted group line.
    // Re-stamping here changes the STRING, never its null-ness. Sound as
    // written — do not reorder to "fix" an imagined dependency.
    let deviceGroupName = current.deviceGroupName;
    if (patch.deviceGroupId !== undefined) {
      const group = await assertGroupInOrg(tx, patch.deviceGroupId, c.orgId);
      deviceGroupName = group.name;
    }

    let updated: ContractLineRowT;
    try {
      const [row] = await tx.update(contractLines).set({
        description: merged.description,
        unitPrice: merged.unitPrice,
        taxable: merged.taxable,
        catalogItemId: merged.catalogItemId,
        manualQuantity: merged.manualQuantity,
        siteId: merged.siteId,
        // The merged shape is readonly string[] for portability across the web
        // editor; the column is DeviceRole[] and the schema edge already proved
        // membership (z.enum(BILLABLE_DEVICE_ROLES)).
        deviceRoles: merged.deviceRoles === null ? null : ([...merged.deviceRoles] as DeviceRole[]),
        deviceGroupId: merged.deviceGroupId,
        deviceGroupName,
        sortOrder: merged.sortOrder,
      }).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId))).returning();
      updated = row!;
    } catch (err) {
      // The delete race: deleteDeviceGroup holds FOR UPDATE on the group row, so
      // this update waited and then lost. Same answer as a cross-org group.
      if (isGroupFkViolation(err)) {
        throw new ContractServiceError('Device group does not belong to this organization', 400, 'GROUP_NOT_IN_ORG');
      }
      throw err;
    }

    return { before: current, after: updated, contract: c };
  });

  const [line] = await withLineRefs([after]);
  return { line: line as DecoratedContractLine, audit: diffLineAudit(before, after, contract) };
}
```

- [ ] **Step 10: `removeContractLine` gains a pre-read and a 404**

Replace the whole function (`:915-921`):

```ts
export async function removeContractLine(
  contractId: string, lineId: string, actor: ContractActor,
): Promise<ContractLineAudit> {
  return db.transaction(async (tx) => {
    const c = await lockContract(tx, contractId, actor);
    assertEditable(c);
    // #3205 W03: read before deleting so contract.line.removed names the real
    // lineType, and so a miss is a typed 404 rather than a silent 200 (the
    // pre-W03 behaviour deleted by (id, contract_id) and never checked whether
    // a row matched). Its permissiveness is exactly what would make the audit lie.
    const [row] = await tx.select({ id: contractLines.id, lineType: contractLines.lineType })
      .from(contractLines)
      .where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId))).limit(1);
    if (!row) throw new ContractServiceError('Contract line not found', 404, 'LINE_NOT_FOUND');
    await tx.delete(contractLines).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId)));
    return { orgId: c.orgId, contractId, contractName: c.name, contractLineId: row.id, lineType: row.lineType };
  });
}
```

- [ ] **Step 11: Run unit + integration, then commit**

Run:
```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
npx vitest run src/services/contractService.test.ts
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractLineEditing.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/contractDeviceGroups.integration.test.ts
```
Expected: tsc reports only `apps/api/src/routes/contracts/lines.ts` (Task 3 has not wired the new `removeContractLine` return yet — it type-checks, since `{ data: <ContractLineAudit> }` is valid) and nothing else; all three suites PASS. If `contractService.integration.test.ts` fails on a `getContract` line shape, it is the new `site`/`deviceGroup` keys — widen the assertion, never drop the keys.

```bash
git add apps/api/src/services/contractTypes.ts apps/api/src/services/contractService.ts apps/api/src/services/contractService.test.ts apps/api/src/__tests__/integration/contractLineEditing.integration.test.ts
git commit -m "feat(billing): updateContractLine — in-place line edits keeping invoice lineage (#3205 W03)"
```

---

### Task 3: Route — `PATCH /contracts/:id/lines/:lineId` and audit on all three line mutations

**Files:**
- Modify: `apps/api/src/routes/contracts/lines.ts` (whole file, 23 lines today)
- Test: `apps/api/src/routes/contracts/contracts.test.ts` — service mock `:4-19`, new `auditEvents` mock, `contract line routes` describe `:168-226`

**Interfaces:**
- Consumes: Task 1 `updateContractLineSchema`; Task 2 `updateContractLine`, `removeContractLine → ContractLineAudit`, `ContractLineAudit`.
- Produces: `PATCH /:id/lines/:lineId` → `{ data: DecoratedContractLine }`; `DELETE` → `{ data: { ok: true } }`; audit actions `contract.line.added` / `contract.line.updated` / `contract.line.removed`, `resourceType: 'contract'`, `resourceId` = the **contract** id.

- [ ] **Step 1: Write the failing route tests**

In `apps/api/src/routes/contracts/contracts.test.ts`, add `updateContractLine: vi.fn(),` to the `contractService` mock (after `removeContractLine`), and add a new mock beside the others:

```ts
// #3205 W03: the three line routes now audit. Stub the durable audit chain so
// route tests assert the CALL, not the persistence path.
vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));
```

and the import beside `import * as svc`:

```ts
import { writeRouteAudit } from '../../services/auditEvents';
import { contractLineRoutes } from './lines';
```

Replace the existing `DELETE /:id/lines/:lineId removes a line` test and append the rest inside the `contract line routes` describe:

```ts
  it('PATCH /:id/lines/:lineId forwards (contractId, lineId, patch, actor) and returns the line', async () => {
    (svc.updateContractLine as any).mockResolvedValue({
      line: { id: LINE_ID, description: 'Renamed', site: null, deviceGroup: null },
      audit: { orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'flat', changedFields: ['description'] },
    });
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.description).toBe('Renamed');
    expect(svc.updateContractLine).toHaveBeenCalledWith(CONTRACT_ID, LINE_ID, { description: 'Renamed' }, expect.anything());
  });

  it('PATCH rejects a body containing lineType, with no service call', async () => {
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Renamed', lineType: 'flat' }),
    });
    expect(res.status).toBe(400);
    expect(svc.updateContractLine).not.toHaveBeenCalled();
  });

  it('PATCH rejects a non-GUID lineId param, with no service call', async () => {
    const res = await app().request(`/${CONTRACT_ID}/lines/not-a-guid`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Renamed' }),
    });
    expect(res.status).toBe(400);
    expect(svc.updateContractLine).not.toHaveBeenCalled();
  });

  it('PATCH renders a ContractServiceError with code and details intact', async () => {
    (svc.updateContractLine as any).mockRejectedValue(
      new ContractServiceError('bad patch', 400, 'INVALID_LINE_PATCH', { issues: [{ path: 'siteId', message: 'nope' }] }),
    );
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteId: null }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad patch', code: 'INVALID_LINE_PATCH', details: { issues: [{ path: 'siteId', message: 'nope' }] } });
  });

  it('PATCH maps a 409 INVALID_STATE through handleContractError', async () => {
    (svc.updateContractLine as any).mockRejectedValue(new ContractServiceError('not editable', 409, 'INVALID_STATE'));
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'x' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('INVALID_STATE');
  });

  // ---- audit -------------------------------------------------------------
  it('writes contract.line.updated once, against the CONTRACT id', async () => {
    (svc.updateContractLine as any).mockResolvedValue({
      line: { id: LINE_ID },
      audit: { orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'flat', changedFields: ['unitPrice'], oldUnitPrice: '10.00', newUnitPrice: '12.00' },
    });
    await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unitPrice: '12.00' }),
    });
    expect(writeRouteAudit).toHaveBeenCalledTimes(1);
    expect((writeRouteAudit as any).mock.calls[0][1]).toEqual({
      orgId: ORG_ID, action: 'contract.line.updated', resourceType: 'contract',
      resourceId: CONTRACT_ID, resourceName: 'Acme MSA',
      details: { contractLineId: LINE_ID, lineType: 'flat', changedFields: ['unitPrice'], oldUnitPrice: '10.00', newUnitPrice: '12.00' },
    });
  });

  it('writes NO audit event when the service reports changedFields: []', async () => {
    (svc.updateContractLine as any).mockResolvedValue({
      line: { id: LINE_ID },
      audit: { orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'flat', changedFields: [] },
    });
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'same' }),
    });
    expect(res.status).toBe(200);
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('POST writes contract.line.added with the new price', async () => {
    (svc.addContractLineToContract as any).mockResolvedValue({ id: LINE_ID, orgId: ORG_ID, lineType: 'flat', unitPrice: '150.00' });
    await app().request(`/${CONTRACT_ID}/lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lineType: 'flat', description: 'Monthly fee', unitPrice: '150.00', taxable: true }),
    });
    expect((writeRouteAudit as any).mock.calls[0][1]).toMatchObject({
      action: 'contract.line.added', resourceType: 'contract', resourceId: CONTRACT_ID,
      details: { contractLineId: LINE_ID, lineType: 'flat', newUnitPrice: '150.00' },
    });
  });

  it('DELETE returns { ok: true } and writes contract.line.removed', async () => {
    (svc.removeContractLine as any).mockResolvedValue({
      orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'per_seat',
    });
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(svc.removeContractLine).toHaveBeenCalledWith(CONTRACT_ID, LINE_ID, expect.anything());
    expect((writeRouteAudit as any).mock.calls[0][1]).toMatchObject({
      action: 'contract.line.removed', details: { contractLineId: LINE_ID, lineType: 'per_seat' },
    });
  });

  it('DELETE returns 404 when the service throws LINE_NOT_FOUND', async () => {
    (svc.removeContractLine as any).mockRejectedValue(new ContractServiceError('Contract line not found', 404, 'LINE_NOT_FOUND'));
    const res = await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('LINE_NOT_FOUND');
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  // The suite stubs requirePermission, so a real 403 cannot be asserted here.
  // What CAN be pinned is that PATCH is registered behind the same middleware
  // chain as its siblings — scopes, writePerm, param validator (+ the json
  // validator PATCH alone carries) — so it cannot ship unguarded.
  it('PATCH is registered behind the same scope and permission middleware as DELETE, plus a body validator', () => {
    const onPath = contractLineRoutes.routes.filter((r) => r.path === '/:id/lines/:lineId');
    const patch = onPath.filter((r) => r.method === 'PATCH');
    const del = onPath.filter((r) => r.method === 'DELETE');
    expect(del.length).toBeGreaterThan(0);
    expect(patch).toHaveLength(del.length + 1);
  });

  // Decision 6's no-free-text rule, enforced at the boundary that persists it.
  it.each([
    ['contract.line.added'],
    ['contract.line.updated'],
    ['contract.line.removed'],
  ])('the %s details object carries no free text', async (action) => {
    const AUDIT = { orgId: ORG_ID, contractId: CONTRACT_ID, contractName: 'Acme MSA', contractLineId: LINE_ID, lineType: 'flat' };
    if (action === 'contract.line.added') {
      (svc.addContractLineToContract as any).mockResolvedValue({ id: LINE_ID, orgId: ORG_ID, lineType: 'flat', unitPrice: '1.00' });
      await app().request(`/${CONTRACT_ID}/lines`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lineType: 'flat', description: 'Secret name', unitPrice: '1.00', taxable: false }),
      });
    } else if (action === 'contract.line.updated') {
      (svc.updateContractLine as any).mockResolvedValue({ line: { id: LINE_ID }, audit: { ...AUDIT, changedFields: ['description'] } });
      await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Secret name' }),
      });
    } else {
      (svc.removeContractLine as any).mockResolvedValue(AUDIT);
      await app().request(`/${CONTRACT_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    }
    const details = (writeRouteAudit as any).mock.calls[0][1].details as Record<string, unknown>;
    const allowed = ['contractLineId', 'lineType', 'changedFields', 'oldUnitPrice', 'newUnitPrice'];
    expect(Object.keys(details).every((k) => allowed.includes(k))).toBe(true);
    expect(JSON.stringify(details)).not.toContain('Secret name');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/contracts/contracts.test.ts`
Expected: FAIL — the PATCH route 404s (no handler), `writeRouteAudit` is never called on POST/DELETE, and DELETE returns `{}` rather than `{ data: { ok: true } }`.

- [ ] **Step 3: Implement the route file**

Replace `apps/api/src/routes/contracts/lines.ts` in full:

```ts
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { contractLineInputSchema, updateContractLineSchema } from '@breeze/shared';
import { addContractLineToContract, removeContractLine, updateContractLine } from '../../services/contractService';
import { writeRouteAudit } from '../../services/auditEvents';
import type { ContractLineAudit } from '../../services/contractTypes';
import { contractActorFrom, handleContractError } from './contracts';

export const contractLineRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);
const idParam = z.object({ id: z.string().guid() });
const lineParam = z.object({ id: z.string().guid(), lineId: z.string().guid() });

type AuditableContext = Parameters<typeof writeRouteAudit>[0];
type ContractLineAuditAction = 'contract.line.added' | 'contract.line.removed' | 'contract.line.updated';

/**
 * #3205 W03: all three line mutations audit, through one helper so the call
 * sites cannot drift. resourceType 'contract' with the CONTRACT id as
 * resourceId (the line id lives in details), so filtering the audit log by a
 * contract shows its whole line history together.
 *
 * NO FREE TEXT: only the line id, the lineType, the changed column NAMES and a
 * numeric old/new unit price. No description, no site name, no group name.
 * A no-op patch (changedFields: []) writes no event at all.
 */
const writeLineAudit = (c: AuditableContext, action: ContractLineAuditAction, a: ContractLineAudit): void => {
  if (a.changedFields && a.changedFields.length === 0) return;
  writeRouteAudit(c, {
    orgId: a.orgId,
    action,
    resourceType: 'contract',
    resourceId: a.contractId,
    resourceName: a.contractName,
    details: {
      contractLineId: a.contractLineId,
      lineType: a.lineType,
      ...(a.changedFields ? { changedFields: a.changedFields } : {}),
      ...(a.oldUnitPrice !== undefined ? { oldUnitPrice: a.oldUnitPrice } : {}),
      ...(a.newUnitPrice !== undefined ? { newUnitPrice: a.newUnitPrice } : {}),
    },
  });
};

contractLineRoutes.post('/:id/lines', scopes, writePerm, zValidator('param', idParam), zValidator('json', contractLineInputSchema), async (c) => {
  try {
    const contractId = c.req.valid('param').id;
    const row = await addContractLineToContract(contractId, c.req.valid('json'), contractActorFrom(c));
    writeLineAudit(c, 'contract.line.added', {
      orgId: row.orgId, contractId, contractLineId: row.id, lineType: row.lineType, newUnitPrice: row.unitPrice,
    });
    return c.json({ data: row });
  } catch (err) { return handleContractError(c, err); }
});

// #3205 W03. Mount order needs no change: contractLineRoutes is registered
// before contractCrudRoutes (routes/contracts/index.ts:19-20) and Hono matches
// method+path, so PATCH /:id/lines/:lineId cannot shadow PATCH /:id.
contractLineRoutes.patch('/:id/lines/:lineId', scopes, writePerm,
  zValidator('param', lineParam), zValidator('json', updateContractLineSchema), async (c) => {
  try {
    const p = c.req.valid('param');
    const { line, audit } = await updateContractLine(p.id, p.lineId, c.req.valid('json'), contractActorFrom(c));
    writeLineAudit(c, 'contract.line.updated', audit);
    return c.json({ data: line });
  } catch (err) { return handleContractError(c, err); }
});

contractLineRoutes.delete('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), async (c) => {
  try {
    const p = c.req.valid('param');
    const audit = await removeContractLine(p.id, p.lineId, contractActorFrom(c));
    writeLineAudit(c, 'contract.line.removed', audit);
    // Was {"data":undefined} -> {} before W03; removeContractLine returns the
    // pre-read audit payload now and 404s on a miss.
    return c.json({ data: { ok: true } });
  } catch (err) { return handleContractError(c, err); }
});
```

- [ ] **Step 4: Run to verify it passes, then commit**

Run:
```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
npx vitest run src/routes/contracts
```
Expected: tsc clean; PASS.

```bash
git add apps/api/src/routes/contracts/lines.ts apps/api/src/routes/contracts/contracts.test.ts
git commit -m "feat(billing): PATCH contract line route + audit on add/update/remove (#3205 W03)"
```

---

### Task 4: AI parity — `update_line` in all four registration sites, plus tool audit and `details`

**Files:**
- Modify: `apps/api/src/services/aiToolsContracts.ts:21-39` (imports), `:46-56` (`MANAGE_CONTRACTS_REQUIRED`), `:66-71` (`serviceErrorToJson`), `:80-82` (payload parsers), `:169-179` (definition enum), `:185-198` (`line` description) + a new `patch` property, `:214-249` (switch)
- Modify: `apps/api/src/services/aiToolSchemas.ts:452-462`
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:2416-2426`
- Modify: `apps/api/src/services/aiGuardrails.ts:622-632`
- Test: `apps/api/src/services/aiToolsContracts.manageContracts.test.ts` (append), `apps/api/src/services/aiToolsContracts.test.ts:3-15` (wholesale service mock must gain `updateContractLine`)
- Create: `apps/api/src/services/aiToolsContracts.registryParity.contract.test.ts`

**Interfaces:**
- Consumes: Task 1 `updateContractLineSchema`; Task 2 `updateContractLine`, `ContractLineAudit`.
- Produces: `manage_contracts` action `update_line` taking `contractId`, `lineId`, `patch`; `serviceErrorToJson` emits `details`; audit events `contract.line.{added,updated,removed}` with `tool_name: 'manage_contracts'` and `initiatedBy: 'ai'`.

- [ ] **Step 1: Write the failing parity contract test**

Create `apps/api/src/services/aiToolsContracts.registryParity.contract.test.ts`:

```ts
/**
 * #3205 W03: `manage_contracts` has FOUR registration sites, and an action
 * present in fewer than four is either invisible or FAIL-CLOSED DENIED:
 *
 *   1. aiToolsContracts.ts definition enum + MANAGE_CONTRACTS_REQUIRED + switch
 *   2. aiToolSchemas.ts toolInputSchemas.manage_contracts.action
 *   3. aiAgentSdkTools.ts tool('manage_contracts', …) action enum
 *   4. aiGuardrails.ts TOOL_PERMISSIONS.manage_contracts
 *
 * Site 4 is the dangerous one: a missing entry denies with
 * `Unknown action "<x>" for tool "manage_contracts"` (aiGuardrails.ts:1861-1870),
 * which reads like a permissions bug rather than a registration bug.
 *
 * Table-driven over EVERY action, so the next one cannot drift either. Site 3's
 * enum lives inside a tool() factory call and is not importable, so it is read
 * from the source text — the extractor throws rather than silently matching
 * nothing if that block is restructured.
 *
 * NOTE: no vi.mock — this suite needs the REAL registries, same rationale as
 * aiGuardrails.readonly.contract.test.ts and aiAgentSdkTools.registryParity.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';

import { registerContractTools } from './aiToolsContracts';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, requiredPermissionsForTool } from './aiGuardrails';
import type { AiTool } from './aiTools';

function definitionActions(): string[] {
  const map = new Map<string, AiTool>();
  registerContractTools(map);
  const tool = map.get('manage_contracts');
  if (!tool) throw new Error('manage_contracts is not registered');
  const props = tool.definition.input_schema.properties as Record<string, { enum?: string[] }>;
  const actions = props.action?.enum;
  if (!actions) throw new Error('manage_contracts definition has no action enum');
  return actions;
}

function centralSchemaActions(): string[] {
  const schema = toolInputSchemas.manage_contracts as unknown as z.ZodObject<{ action: z.ZodEnum<[string, ...string[]]> }>;
  return [...schema.shape.action.options];
}

function sdkActions(): string[] {
  const src = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');
  const toolStart = src.indexOf("      'manage_contracts',");
  if (toolStart < 0) throw new Error("tool('manage_contracts', …) block not found in aiAgentSdkTools.ts");
  const enumStart = src.indexOf('action: z.enum([', toolStart);
  const enumEnd = src.indexOf(']),', enumStart);
  if (enumStart < 0 || enumEnd < 0) throw new Error('manage_contracts action enum not found in aiAgentSdkTools.ts');
  return [...src.slice(enumStart, enumEnd).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

function guardrailActions(): string[] {
  const entry = TOOL_PERMISSIONS.manage_contracts as Record<string, { resource: string; action: string }>;
  return Object.keys(entry);
}

const ACTIONS = definitionActions();

describe('manage_contracts four-site registry parity (#3205 W03)', () => {
  it('registers update_line', () => {
    expect(ACTIONS).toContain('update_line');
  });

  it.each(ACTIONS)('%s is present at every one of the four sites', (action) => {
    expect(centralSchemaActions()).toContain(action);
    expect(sdkActions()).toContain(action);
    expect(guardrailActions()).toContain(action);
  });

  it.each([
    ['central schema', centralSchemaActions],
    ['SDK tool enum', sdkActions],
    ['guardrail permissions', guardrailActions],
  ])('%s advertises no action the tool cannot dispatch', (_name, read) => {
    expect([...read()].sort()).toEqual([...ACTIONS].sort());
  });

  it('update_line resolves to contracts:write, not contracts:manage', () => {
    const entry = TOOL_PERMISSIONS.manage_contracts as Record<string, { resource: string; action: string }>;
    expect(entry.update_line).toEqual({ resource: 'contracts', action: 'write' });
    expect(requiredPermissionsForTool('manage_contracts', { action: 'update_line' }))
      .toEqual([{ resource: 'contracts', action: 'write' }]);
  });

  // The fail-closed path site 4 protects: an action with no TOOL_PERMISSIONS
  // entry resolves to no requirements at all and is denied with
  // `Unknown action "<x>" for tool "manage_contracts"` (aiGuardrails.ts:1861-1870).
  it('denies an action that is not registered in TOOL_PERMISSIONS', () => {
    expect(requiredPermissionsForTool('manage_contracts', { action: 'invented_action' })).toBeNull();
  });
});
```

- [ ] **Step 2: Write the failing behaviour tests**

Append to `apps/api/src/services/aiToolsContracts.manageContracts.test.ts`. First extend the `./contractService` mock factory (inside `vi.mock`) with:

```ts
    updateContractLine: vi.fn().mockResolvedValue({
      line: { id: 'line-1', contractId: 'contract-1', description: 'Renamed' },
      audit: { orgId: 'org-1', contractId: 'contract-1', contractName: 'Acme MSA', contractLineId: 'line-1', lineType: 'flat', changedFields: ['description'] },
    }),
```

and change `removeContractLine` to
`removeContractLine: vi.fn().mockResolvedValue({ orgId: 'org-1', contractId: 'contract-1', contractName: 'Acme MSA', contractLineId: 'line-1', lineType: 'flat' }),`
and `addContractLineToContract` to
`addContractLineToContract: vi.fn().mockResolvedValue({ id: 'line-1', contractId: 'contract-1', orgId: 'org-1', lineType: 'flat', unitPrice: '5.00' }),`.

Add the audit mock beside it:

```ts
// #3205 W03: the tool audits through the second door (writeAuditEvent +
// requestLikeFromSnapshot), not writeRouteAudit — there is no Hono context here.
const { writeAuditEvent } = vi.hoisted(() => ({ writeAuditEvent: vi.fn() }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent,
  requestLikeFromSnapshot: vi.fn(() => ({})),
}));
```

Then the cases:

```ts
describe('manage_contracts update_line (#3205 W03)', () => {
  const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
  const LINE_ID = '22222222-2222-4222-8222-222222222222';
  const run = async (input: Record<string, unknown>) => getTool().handler(input, auth);

  beforeEach(() => vi.clearAllMocks());

  it('requires contractId, lineId and patch before any coercion', async () => {
    const missing = JSON.parse(await run({ action: 'update_line', contractId: CONTRACT_ID, patch: { description: 'x' } }));
    expect(missing.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(missing)).toContain('lineId');
    expect(contractService.updateContractLine).not.toHaveBeenCalled();
  });

  it('forwards the parsed patch and returns the line JSON', async () => {
    const out = JSON.parse(await run({ action: 'update_line', contractId: CONTRACT_ID, lineId: LINE_ID, patch: { description: 'Renamed' } }));
    expect(contractService.updateContractLine).toHaveBeenCalledWith(CONTRACT_ID, LINE_ID, { description: 'Renamed' }, actor);
    expect(out).toMatchObject({ id: 'line-1', description: 'Renamed' });
  });

  // The payload parser wraps the value under its param name, so a ZodError path
  // reads `patch.lineType` rather than a bare `lineType`.
  it('rejects a patch containing lineType with a VALIDATION_ERROR naming patch.lineType', async () => {
    const out = JSON.parse(await run({ action: 'update_line', contractId: CONTRACT_ID, lineId: LINE_ID, patch: { description: 'x', lineType: 'flat' } }));
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(out)).toContain('patch');
    expect(contractService.updateContractLine).not.toHaveBeenCalled();
  });

  it('writes the audit with tool_name manage_contracts and initiatedBy ai', async () => {
    await run({ action: 'update_line', contractId: CONTRACT_ID, lineId: LINE_ID, patch: { description: 'Renamed' } });
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent.mock.calls[0]![1]).toMatchObject({
      orgId: 'org-1', action: 'contract.line.updated', resourceType: 'contract', resourceId: 'contract-1',
      initiatedBy: 'ai',
      details: { contractLineId: 'line-1', lineType: 'flat', changedFields: ['description'], tool_name: 'manage_contracts' },
    });
  });

  it('add_line and remove_line audit too', async () => {
    await run({ action: 'add_line', contractId: CONTRACT_ID, line: { lineType: 'flat', description: 'Fee', unitPrice: '5.00', taxable: false } });
    expect(writeAuditEvent.mock.calls.at(-1)![1]).toMatchObject({ action: 'contract.line.added', initiatedBy: 'ai' });
    await run({ action: 'remove_line', contractId: CONTRACT_ID, lineId: LINE_ID });
    expect(writeAuditEvent.mock.calls.at(-1)![1]).toMatchObject({ action: 'contract.line.removed', initiatedBy: 'ai' });
  });

  // Without this a model told "those changes aren't valid" has nothing to
  // self-correct against.
  it('surfaces ContractServiceError details in the JSON error', async () => {
    (contractService.updateContractLine as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ContractServiceError('bad patch', 400, 'INVALID_LINE_PATCH', { issues: [{ path: 'siteId', message: 'nope' }] }),
    );
    const out = JSON.parse(await run({ action: 'update_line', contractId: CONTRACT_ID, lineId: LINE_ID, patch: { siteId: null } }));
    expect(out).toEqual({ error: 'bad patch', code: 'INVALID_LINE_PATCH', details: { issues: [{ path: 'siteId', message: 'nope' }] } });
  });

  it('the tool description explains the tri-state catalogItemId and the locked lineType', () => {
    const props = getTool().definition.input_schema.properties as Record<string, { description?: string; enum?: string[] }>;
    expect(props.action!.enum).toContain('update_line');
    const desc = props.patch!.description!;
    expect(desc).toContain('lineType');
    expect(desc).toContain('refreshCatalogPrice');
    expect(desc).toMatch(/future billing periods/i);
  });
});
```

The `vi.mock('./contractService')` factory must also export `ContractServiceError` (it already does) — the `details` argument is added to that stub class:

```ts
  class ContractServiceError extends Error {
    constructor(
      message: string,
      public status: 400 | 403 | 404 | 409 | 500 = 400,
      public code?: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'ContractServiceError';
    }
  }
```

- [ ] **Step 3: Keep the sibling tool suite importable and cover `get_contract`'s new keys**

`apps/api/src/services/aiToolsContracts.test.ts` mocks `./contractService` **wholesale** (`:3-15`), so it must gain the new export or importing `aiToolsContracts` throws once the tool imports `updateContractLine`. Add to that mock factory:

```ts
  updateContractLine: vi.fn(),
```

and append the pass-through case, since `get_contract`'s lines now carry `site` and `deviceGroup` from `withLineRefs`:

```ts
describe('get_contract line shape (#3205 W03)', () => {
  it('passes the decorated site and deviceGroup through to the model', async () => {
    const decorated = {
      id: 'l1', lineType: 'per_device', description: 'Managed device', unitPrice: '10.00',
      siteId: 'site-1', site: { id: 'site-1', name: 'HQ' },
      deviceGroupId: null, deviceGroupName: null, deviceGroup: null,
    };
    (getContract as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      contract: { id: 'ct-1', currencyCode: 'USD' }, lines: [decorated], periods: [],
    });
    const out = JSON.parse(await getTool('get_contract').handler({ contractId: 'ct-1' }, auth));
    expect(out.lines[0]).toMatchObject({ site: { id: 'site-1', name: 'HQ' }, deviceGroup: null });
  });
});
```

(add `import { getContract } from './contractService';` and reuse the same `auth` fixture shape `aiToolsContracts.manageContracts.test.ts` defines — copy it verbatim into this file if it has none).

- [ ] **Step 4: Run to verify both fail**

Run: `cd apps/api && npx vitest run src/services/aiToolsContracts`
Expected: FAIL — `registers update_line` fails (`update_line` absent from the definition enum), the per-action parity loop still passes for the nine existing actions, and every `update_line` behaviour case fails with `{"error":"Unknown action: update_line","code":"VALIDATION_ERROR"}`.

- [ ] **Step 5: Implement site 1 (`aiToolsContracts.ts`)**

Imports (`:21-39`) gain the schema, the service function and the audit door:

```ts
import { BILLABLE_DEVICE_ROLES, createContractSchema, updateContractSchema, contractLineInputSchema, updateContractLineSchema } from '@breeze/shared';
```

```ts
  addContractLineToContract,
  removeContractLine,
  updateContractLine,
```

```ts
import { ContractServiceError, type ContractActor, type ContractLineAudit } from './contractTypes';
import { writeAuditEvent, requestLikeFromSnapshot } from './auditEvents';
```

`MANAGE_CONTRACTS_REQUIRED` (`:46-56`) gains, after `remove_line`:

```ts
  update_line: ['contractId', 'lineId', 'patch'],
```

`serviceErrorToJson` (`:66-71`) widens to carry `details` — this benefits every `manage_contracts` action, not just the new one:

```ts
function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof ContractServiceError) {
    // #3205 W03: HTTP returns `details` verbatim (routes/contracts/contracts.ts
    // :50-57) while this door dropped it. A model that trips INVALID_LINE_PATCH
    // and is told only "those changes aren't valid" cannot self-correct.
    return JSON.stringify({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  return null;
}
```

Payload parsers (`:80-82`) gain one, beside the others:

```ts
const lineUpdatePayload = z.object({ patch: updateContractLineSchema });
```

Add the audit helper after the payload parsers (modelled on `aiToolsOrgs.ts:124-150`):

```ts
/** Best-effort audit write for the AI door (#3205 W03). Never blocks the tool
 *  result. initiatedBy 'ai' is an explicit value of the initiated_by_type enum
 *  (db/schema/audit.ts:14) and writeAuditEventAsync honours it over its
 *  actor-type inference (auditEvents.ts:73-74). Same no-free-text payload as
 *  the HTTP door. */
function auditContractLineToolEvent(
  auth: AuthContext,
  action: 'contract.line.added' | 'contract.line.removed' | 'contract.line.updated',
  a: ContractLineAudit,
): void {
  if (a.changedFields && a.changedFields.length === 0) return;
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: a.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action,
      resourceType: 'contract',
      resourceId: a.contractId,
      resourceName: a.contractName,
      result: 'success',
      initiatedBy: 'ai',
      details: {
        contractLineId: a.contractLineId,
        lineType: a.lineType,
        ...(a.changedFields ? { changedFields: a.changedFields } : {}),
        ...(a.oldUnitPrice !== undefined ? { oldUnitPrice: a.oldUnitPrice } : {}),
        ...(a.newUnitPrice !== undefined ? { newUnitPrice: a.newUnitPrice } : {}),
        tool_name: 'manage_contracts',
      },
    });
  } catch (err) {
    console.error('[manage_contracts] audit write failed', err);
  }
}
```

Definition enum (`:169-179`) gains `'update_line',` after `'remove_line',`. Add a `patch`-specific description beside the existing `patch` property — rename the existing generic one so both are documented (`patch` is shared by `update` and `update_line`):

```ts
          patch: {
            type: 'object',
            description:
              'For action "update": contract header fields. For action "update_line": the line patch. ' +
              'update_line edits one line in place, keeping its id (and therefore its invoice lineage). ' +
              'Every field of a line is editable EXCEPT lineType — sending lineType is rejected; to change the ' +
              'type, remove_line then add_line. catalogItemId is three-valued: leave it out to keep the current ' +
              'link AND the current stamped price, send a DIFFERENT item id to re-link and re-resolve price and ' +
              'taxable in the contract\'s currency (any unitPrice/taxable you send is ignored), or send null to ' +
              'unlink — which requires unitPrice AND taxable in the same call. Sending the item id the line ' +
              'already has changes nothing; to re-price an unchanged link, send refreshCatalogPrice: true. ' +
              'siteId accepts null to widen a site-scoped line to the whole org. Lines are only editable on ' +
              'draft and active contracts. Edits apply to future billing periods; invoices already generated ' +
              'are unchanged.',
          },
```

The switch (`:214-249`) gains the case and the two existing line cases gain their audit calls:

```ts
          case 'add_line': {
            const row = await addContractLineToContract(
              String(input.contractId),
              linePayload.parse({ line: input.line }).line,
              actor
            );
            auditContractLineToolEvent(auth, 'contract.line.added', {
              orgId: row.orgId, contractId: String(input.contractId),
              contractLineId: row.id, lineType: row.lineType, newUnitPrice: row.unitPrice,
            });
            return JSON.stringify(row);
          }
          case 'remove_line': {
            const audit = await removeContractLine(String(input.contractId), String(input.lineId), actor);
            auditContractLineToolEvent(auth, 'contract.line.removed', audit);
            return JSON.stringify({ ok: true });
          }
          case 'update_line': {
            const { line, audit } = await updateContractLine(
              String(input.contractId), String(input.lineId),
              lineUpdatePayload.parse({ patch: input.patch }).patch, actor,
            );
            auditContractLineToolEvent(auth, 'contract.line.updated', audit);
            return JSON.stringify(line);
          }
```

- [ ] **Step 6: Implement sites 2, 3 and 4**

`apps/api/src/services/aiToolSchemas.ts:452-462` — add `'update_line',` to the `manage_contracts` action enum after `'remove_line',`. Without it the central schema rejects the call.

`apps/api/src/services/aiAgentSdkTools.ts:2416-2426` — add `'update_line',` to the SDK `tool()` schema's enum after `'remove_line',`. Without it the SDK/agent surface cannot call it. The tier map entry (`:242`) is unchanged: `update_line` is tier 2 like every other non-lifecycle action.

`apps/api/src/services/aiGuardrails.ts:622-632` — add to `TOOL_PERMISSIONS.manage_contracts` after `remove_line`:

```ts
    update_line: { resource: 'contracts', action: 'write' },
```

Without it the guardrail denies with `Unknown action "update_line" for tool "manage_contracts"` (`:1861-1870`) — a fail-closed denial that would look like a permissions bug.

- [ ] **Step 7: Run to verify it passes, then commit**

Run:
```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
npx vitest run src/services/aiToolsContracts src/services/aiGuardrails src/services/aiAgentSdkTools
```
Expected: tsc clean; PASS, including the pre-existing `aiAgentSdkTools.registryParity.contract.test.ts` and `aiGuardrails.readonly.contract.test.ts`.

```bash
git add apps/api/src/services/aiToolsContracts.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiToolsContracts.test.ts apps/api/src/services/aiToolsContracts.manageContracts.test.ts apps/api/src/services/aiToolsContracts.registryParity.contract.test.ts
git commit -m "feat(ai): manage_contracts update_line across all four registries, line audit, error details (#3205 W03)"
```

---

### Task 5: Web — inline line edit, status-gated affordances, site sub-label, 8 locales

**Files:**
- Modify: `apps/web/src/lib/api/contracts.ts:70-84` (`ContractLine`), `:207-209` (line wrappers)
- Modify: `apps/web/src/components/contracts/ContractEditor.tsx` — imports `:14-36`, state near `:137-147`, `:396` (guards), line rows `:912-946`
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx:375-382`
- Create: `apps/web/src/components/contracts/ContractEditor.editline.test.tsx`
- Create: `apps/web/src/components/contracts/ContractDetail.site.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`

**Interfaces:**
- Consumes: Task 3's `PATCH /contracts/:id/lines/:lineId`; the line read's new `site` and W02's `deviceGroup`; W02's `deviceGroupsList` editor state, `SITE_SCOPED_TYPES` / `AUTO_QTY_TYPES` / `LINE_TYPE_LABELS` (`lineTypes.ts`), and the `contracts.shared.dynamicGroup` / `deletedGroup` keys.
- Produces:

```ts
export interface UpdateContractLinePatch {
  description?: string; unitPrice?: string; taxable?: boolean;
  catalogItemId?: string | null; refreshCatalogPrice?: boolean;
  manualQuantity?: string; siteId?: string | null;
  deviceRoles?: string[]; deviceGroupId?: string; sortOrder?: number;
}
export function updateContractLine(id: string, lineId: string, body: UpdateContractLinePatch): Promise<Response>;
// ContractLine gains: site: { id: string; name: string } | null
```

- [ ] **Step 1: Write the failing editor test**

Create `apps/web/src/components/contracts/ContractEditor.editline.test.tsx` (mocks copied verbatim from `ContractEditor.roles.test.tsx`, with `updateContractLine` added to the api mock):

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContractEditor from './ContractEditor';
import { fetchWithAuth } from '../../stores/auth';
import * as api from '../../lib/api/contracts';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../catalog/CatalogItemPicker', () => ({ default: () => null }));
vi.mock('../../lib/api/catalog', () => ({
  listCatalog: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) }),
  resolveCatalogPrice: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: null }) }),
}));
vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return {
    ...actual,
    createContract: vi.fn(), updateContract: vi.fn(), addContractLine: vi.fn(),
    removeContractLine: vi.fn(), updateContractLine: vi.fn(), contractTransition: vi.fn(),
    getContractEstimate: vi.fn(),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const resp = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const contract = {
  id: 'ct-1', partnerId: 'p1', orgId: 'org-1', name: 'Acme MSA', status: 'draft', billingTiming: 'advance',
  intervalMonths: 1, startDate: '2026-06-01', endDate: null, nextBillingAt: null, autoIssue: false, autoRenew: false,
  renewalTermMonths: null, renewalNoticeDays: null, currencyCode: 'USD', notes: null, terms: null,
  createdBy: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
} as const;

const baseLine = {
  id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Managed device',
  catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: null, deviceRoles: null,
  deviceGroupId: null, deviceGroupName: null, deviceGroup: null, site: null, taxable: false, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
} as const;

describe('ContractEditor — inline line edit (#3205 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return resp({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return resp({ data: [{ id: 'site-1', name: 'HQ' }] });
      if (url.startsWith('/device-groups')) return resp({ data: [{ id: 'g-1', name: 'VIP laptops', type: 'static' }] });
      return resp({ data: {} });
    });
    (api.getContractEstimate as any).mockResolvedValue(resp({
      data: { currencyCode: 'USD', periodTotal: '0.00', lines: [], uncoveredDevices: null },
    }));
    (api.updateContractLine as any).mockResolvedValue(resp({ data: { ...baseLine, description: 'Renamed' } }));
  });

  const renderEdit = (lines: unknown[] = [baseLine], status: string = 'draft') =>
    render(<ContractEditor detail={{ contract: { ...contract, status } as any, lines: lines as any, periods: [] }} onChanged={vi.fn()} />);

  const patchBody = () => (api.updateContractLine as any).mock.calls[0][2] as Record<string, unknown>;

  // Decision 11: Remove was gated on permission alone and 409'd on click for a
  // cancelled or expired contract. Edit and Remove now share one predicate.
  it.each(['draft', 'active'])('renders Edit and Remove on a %s contract', async (status) => {
    renderEdit([baseLine], status);
    expect(await screen.findByTestId('line-edit-0')).toBeInTheDocument();
    expect(screen.getByTestId('line-remove-0')).toBeInTheDocument();
  });

  it.each(['paused', 'cancelled', 'expired'])('renders NEITHER on a %s contract', async (status) => {
    renderEdit([baseLine], status);
    await screen.findByTestId('line-row-0');
    expect(screen.queryByTestId('line-edit-0')).toBeNull();
    expect(screen.queryByTestId('line-remove-0')).toBeNull();
  });

  it('shows the type as a locked label with no type select', async () => {
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    const form = await screen.findByTestId('line-edit-form-0');
    expect(within(form).getByTestId('line-edit-type-locked').textContent).toMatch(/can.t be changed/i);
    expect(within(form).queryByTestId('line-edit-type')).toBeNull();
  });

  it('sends ONLY the changed field for a description-only edit', async () => {
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ description: 'Renamed' });
  });

  // The unlink EXCEPTION to the minimal patch: transition row 6 requires all
  // three, so a minimal patch would 400 on a legitimate gesture.
  it('sends catalogItemId, unitPrice and taxable together on an unlink even when neither was retyped', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00', taxable: true }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.click(screen.getByTestId('line-edit-unlink-0'));
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ catalogItemId: null, unitPrice: '20.00', taxable: true });
  });

  it('"Refresh price from catalog" sends exactly { refreshCatalogPrice: true }', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00' }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.click(screen.getByTestId('line-edit-refresh-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ refreshCatalogPrice: true });
  });

  it('shows a catalog-linked price read-only, and keeps Save disabled after an unlink until a price is entered', async () => {
    renderEdit([{ ...baseLine, catalogItemId: 'cat-1', unitPrice: '20.00', taxable: true }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-price-0')).toBeDisabled();
    expect(screen.getByTestId('line-edit-taxable-0')).toBeDisabled();
    fireEvent.click(screen.getByTestId('line-edit-unlink-0'));
    expect(screen.getByTestId('line-edit-price-0')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('line-edit-price-0'), { target: { value: '' } });
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
    fireEvent.change(screen.getByTestId('line-edit-price-0'), { target: { value: '3.00' } });
    expect(screen.getByTestId('line-edit-save-0')).not.toBeDisabled();
  });

  it('disables Save with no changes and with no roles left on a role line', async () => {
    renderEdit([{ ...baseLine, lineType: 'per_device_role', deviceRoles: ['server'] }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();          // nothing changed yet
    fireEvent.click(screen.getByTestId('line-edit-role-server-0'));          // uncheck the only role
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
  });

  // The orphaned-group repair: Save stays disabled until a live group is picked,
  // so a patch can never re-send the null the FK left behind.
  it('disables Save on an orphaned group line until a group is picked', async () => {
    renderEdit([{ ...baseLine, lineType: 'per_device_group', siteId: null, deviceGroupId: null, deviceGroupName: 'Retired', deviceGroup: null }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-save-0')).toBeDisabled();
    const select = await screen.findByTestId('line-edit-group-0');
    await within(select).findByRole('option', { name: /VIP laptops/ });
    fireEvent.change(select, { target: { value: 'g-1' } });
    expect(screen.getByTestId('line-edit-save-0')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(patchBody()).toEqual({ deviceGroupId: 'g-1' });
  });

  it('disables Edit on every other row while one is open', async () => {
    renderEdit([baseLine, { ...baseLine, id: 'l2', description: 'Second' }]);
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    expect(screen.getByTestId('line-edit-1')).toBeDisabled();
  });

  it('renders a site-scoped line with the labelled site sub-label from line.site', async () => {
    renderEdit([{ ...baseLine, siteId: 'site-1', site: { id: 'site-1', name: 'HQ' } }]);
    expect((await screen.findByTestId('line-site-0')).textContent).toBe('Site: HQ');
  });

  it('toasts the friendly message on a 409 INVALID_STATE and keeps the row in edit mode', async () => {
    (api.updateContractLine as any).mockResolvedValue(
      resp({ error: 'not editable', code: 'INVALID_STATE' }, false, 409),
    );
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Lines can only be edited on draft or active contracts.' }),
    ));
    expect(screen.getByTestId('line-edit-form-0')).toBeInTheDocument();
  });

  it('does not toast on a 401 — the auth redirect is the feedback', async () => {
    (api.updateContractLine as any).mockResolvedValue(resp({ error: 'Unauthorized' }, false, 401));
    renderEdit();
    fireEvent.click(await screen.findByTestId('line-edit-0'));
    fireEvent.change(screen.getByTestId('line-edit-desc-0'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('line-edit-save-0'));
    await waitFor(() => expect(api.updateContractLine).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
```

- [ ] **Step 2: Write the failing detail-page test**

Create `apps/web/src/components/contracts/ContractDetail.site.test.tsx` by copying the mock block of `ContractDetail.roles.test.tsx` verbatim and replacing its cases with:

```tsx
describe('ContractDetail — line site sub-label (#3205 W03)', () => {
  it('renders the site name from line.site and issues no /sites request', async () => {
    renderDetail([{
      id: 'l1', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Managed device',
      catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: 'site-1',
      site: { id: 'site-1', name: 'HQ' }, deviceRoles: null, deviceGroupId: null, deviceGroupName: null,
      deviceGroup: null, taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }]);
    expect((await screen.findByTestId('contract-detail-line-site-l1')).textContent).toBe('Site: HQ');
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/orgs/sites'))).toBe(false);
  });

  it('renders no site sub-label for an org-wide line', async () => {
    renderDetail([{
      id: 'l2', contractId: 'ct-1', orgId: 'org-1', lineType: 'per_device', description: 'Managed device',
      catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId: null, site: null,
      deviceRoles: null, deviceGroupId: null, deviceGroupName: null, deviceGroup: null,
      taxable: false, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
    }]);
    await screen.findByTestId('contract-detail-line-l2');
    expect(screen.queryByTestId('contract-detail-line-site-l2')).toBeNull();
  });
});
```

(`renderDetail` and `fetchMock` are the helpers `ContractDetail.roles.test.tsx` already defines; copy them unchanged.)

- [ ] **Step 3: Run to verify both fail**

Run: `cd apps/web && npx vitest run src/components/contracts/ContractEditor.editline.test.tsx src/components/contracts/ContractDetail.site.test.tsx`
Expected: FAIL — `api.updateContractLine is not a function`, `line-edit-0` never renders, and `contract-detail-line-site-l1` does not exist.

- [ ] **Step 4: API client**

`apps/web/src/lib/api/contracts.ts` — on `ContractLine` (`:70-84`), after `deviceRoles` (W02 already added the three `deviceGroup*` fields):

```ts
  /** #3205 W03: resolved server-side so the detail page needs no site lookup. */
  site: { id: string; name: string } | null;
```

After `removeContractLine` (`:207-209`):

```ts
/** Body of PATCH /contracts/:id/lines/:lineId (#3205 W03). Omitted keys are
 *  unchanged; `catalogItemId: null` unlinks (and then unitPrice + taxable are
 *  required in the same patch); the same id re-sent is a no-op — use
 *  `refreshCatalogPrice` to re-price an unchanged link. `lineType` is rejected. */
export interface UpdateContractLinePatch {
  description?: string;
  unitPrice?: string;
  taxable?: boolean;
  catalogItemId?: string | null;
  refreshCatalogPrice?: boolean;
  manualQuantity?: string;
  siteId?: string | null;
  deviceRoles?: string[];
  deviceGroupId?: string;
  sortOrder?: number;
}

export function updateContractLine(id: string, lineId: string, body: UpdateContractLinePatch): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/lines/${lineId}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body),
  });
}
```

- [ ] **Step 5: i18n — 18 keys in 8 locales**

`apps/web/src/locales/en/billing.json`. Under `contracts.shared`, add a new `lineScope` object beside `values`:

```json
    "lineScope": { "site": "Site: {{name}}" },
```

Under `contracts.contractEditor.lines`, add `"edit": "Edit"`. Add a new `editLine` object beside `addLine`:

```json
    "editLine": {
      "save": "Save line",
      "cancel": "Cancel",
      "typeLocked": "Line type can’t be changed. Remove the line and add a new one.",
      "priceFromCatalog": "Price comes from the catalog. Clear the catalog link to set it by hand.",
      "refreshPrice": "Refresh price from catalog",
      "unlinkNeedsPrice": "Enter a unit price and tax setting to clear the catalog link.",
      "noChanges": "Nothing to save yet."
    },
```

Under `contracts.contractEditor.toast`, add `"lineUpdated": "Line updated"`. Under `contracts.contractEditor.errors`, add:

```json
      "updateLine": "Could not update the line.",
      "lineNotFound": "That line no longer exists. Refresh the contract.",
      "contractNotEditable": "Lines can only be edited on draft or active contracts.",
      "siteNotInOrg": "That site belongs to a different organization.",
      "groupNotInOrg": "That device group belongs to a different organization.",
      "invalidLinePatch": "Those changes aren’t valid for this line type.",
      "priceNotRepresentable": "That price has too many decimal places for {{currency}}.",
      "catalogItemNotFound": "That catalog item isn’t available on this contract."
```

The same 18 keys in the other seven locales (`localeParity.test.ts` flattens every file and compares key sets **and** interpolation tokens, so `{{name}}` / `{{currency}}` must survive translation):

| key | de-DE | es-419 |
|---|---|---|
| `shared.lineScope.site` | Standort: {{name}} | Sitio: {{name}} |
| `lines.edit` | Bearbeiten | Editar |
| `editLine.save` | Position speichern | Guardar línea |
| `editLine.cancel` | Abbrechen | Cancelar |
| `editLine.typeLocked` | Der Positionstyp kann nicht geändert werden. Entfernen Sie die Position und fügen Sie eine neue hinzu. | El tipo de línea no se puede cambiar. Elimina la línea y agrega una nueva. |
| `editLine.priceFromCatalog` | Der Preis stammt aus dem Katalog. Entfernen Sie die Katalogverknüpfung, um ihn manuell zu setzen. | El precio viene del catálogo. Quita el vínculo al catálogo para definirlo manualmente. |
| `editLine.refreshPrice` | Preis aus dem Katalog aktualisieren | Actualizar precio desde el catálogo |
| `editLine.unlinkNeedsPrice` | Geben Sie einen Stückpreis und die Steuereinstellung an, um die Katalogverknüpfung zu entfernen. | Ingresa un precio unitario y la configuración de impuestos para quitar el vínculo al catálogo. |
| `editLine.noChanges` | Noch nichts zu speichern. | Aún no hay nada que guardar. |
| `toast.lineUpdated` | Position aktualisiert | Línea actualizada |
| `errors.updateLine` | Die Position konnte nicht aktualisiert werden. | No se pudo actualizar la línea. |
| `errors.lineNotFound` | Diese Position existiert nicht mehr. Aktualisieren Sie den Vertrag. | Esa línea ya no existe. Actualiza el contrato. |
| `errors.contractNotEditable` | Positionen können nur bei Verträgen im Entwurf oder aktiven Verträgen bearbeitet werden. | Las líneas solo se pueden editar en contratos en borrador o activos. |
| `errors.siteNotInOrg` | Dieser Standort gehört zu einer anderen Organisation. | Ese sitio pertenece a otra organización. |
| `errors.groupNotInOrg` | Diese Gerätegruppe gehört zu einer anderen Organisation. | Ese grupo de dispositivos pertenece a otra organización. |
| `errors.invalidLinePatch` | Diese Änderungen sind für diesen Positionstyp nicht gültig. | Esos cambios no son válidos para este tipo de línea. |
| `errors.priceNotRepresentable` | Dieser Preis hat zu viele Nachkommastellen für {{currency}}. | Ese precio tiene demasiados decimales para {{currency}}. |
| `errors.catalogItemNotFound` | Dieser Katalogartikel ist für diesen Vertrag nicht verfügbar. | Ese artículo del catálogo no está disponible en este contrato. |

| key | fr-CA and fr-FR (identical strings) | it-IT |
|---|---|---|
| `shared.lineScope.site` | Site : {{name}} | Sede: {{name}} |
| `lines.edit` | Modifier | Modifica |
| `editLine.save` | Enregistrer la ligne | Salva riga |
| `editLine.cancel` | Annuler | Annulla |
| `editLine.typeLocked` | Le type de ligne ne peut pas être modifié. Supprimez la ligne et ajoutez-en une nouvelle. | Il tipo di riga non può essere modificato. Rimuovi la riga e aggiungine una nuova. |
| `editLine.priceFromCatalog` | Le prix provient du catalogue. Retirez le lien au catalogue pour le définir manuellement. | Il prezzo proviene dal catalogo. Rimuovi il collegamento al catalogo per impostarlo manualmente. |
| `editLine.refreshPrice` | Actualiser le prix depuis le catalogue | Aggiorna il prezzo dal catalogo |
| `editLine.unlinkNeedsPrice` | Saisissez un prix unitaire et le réglage de taxe pour retirer le lien au catalogue. | Inserisci un prezzo unitario e l’impostazione fiscale per rimuovere il collegamento al catalogo. |
| `editLine.noChanges` | Rien à enregistrer pour l’instant. | Non c’è ancora nulla da salvare. |
| `toast.lineUpdated` | Ligne mise à jour | Riga aggiornata |
| `errors.updateLine` | Impossible de mettre à jour la ligne. | Impossibile aggiornare la riga. |
| `errors.lineNotFound` | Cette ligne n’existe plus. Actualisez le contrat. | Questa riga non esiste più. Aggiorna il contratto. |
| `errors.contractNotEditable` | Les lignes ne peuvent être modifiées que sur les contrats brouillon ou actifs. | Le righe possono essere modificate solo su contratti in bozza o attivi. |
| `errors.siteNotInOrg` | Ce site appartient à une autre organisation. | Questa sede appartiene a un’altra organizzazione. |
| `errors.groupNotInOrg` | Ce groupe d’appareils appartient à une autre organisation. | Questo gruppo di dispositivi appartiene a un’altra organizzazione. |
| `errors.invalidLinePatch` | Ces modifications ne sont pas valides pour ce type de ligne. | Queste modifiche non sono valide per questo tipo di riga. |
| `errors.priceNotRepresentable` | Ce prix comporte trop de décimales pour {{currency}}. | Questo prezzo ha troppi decimali per {{currency}}. |
| `errors.catalogItemNotFound` | Cet article du catalogue n’est pas disponible sur ce contrat. | Questo articolo del catalogo non è disponibile su questo contratto. |

| key | pt-BR | tr-TR |
|---|---|---|
| `shared.lineScope.site` | Site: {{name}} | Konum: {{name}} |
| `lines.edit` | Editar | Düzenle |
| `editLine.save` | Salvar linha | Satırı kaydet |
| `editLine.cancel` | Cancelar | İptal |
| `editLine.typeLocked` | O tipo de linha não pode ser alterado. Remova a linha e adicione uma nova. | Satır türü değiştirilemez. Satırı kaldırıp yenisini ekleyin. |
| `editLine.priceFromCatalog` | O preço vem do catálogo. Remova o vínculo com o catálogo para defini-lo manualmente. | Fiyat katalogdan gelir. Elle ayarlamak için katalog bağlantısını kaldırın. |
| `editLine.refreshPrice` | Atualizar preço do catálogo | Fiyatı katalogdan yenile |
| `editLine.unlinkNeedsPrice` | Informe um preço unitário e a configuração de imposto para remover o vínculo com o catálogo. | Katalog bağlantısını kaldırmak için birim fiyat ve vergi ayarını girin. |
| `editLine.noChanges` | Ainda não há nada para salvar. | Henüz kaydedilecek bir şey yok. |
| `toast.lineUpdated` | Linha atualizada | Satır güncellendi |
| `errors.updateLine` | Não foi possível atualizar a linha. | Satır güncellenemedi. |
| `errors.lineNotFound` | Essa linha não existe mais. Atualize o contrato. | Bu satır artık mevcut değil. Sözleşmeyi yenileyin. |
| `errors.contractNotEditable` | As linhas só podem ser editadas em contratos em rascunho ou ativos. | Satırlar yalnızca taslak veya etkin sözleşmelerde düzenlenebilir. |
| `errors.siteNotInOrg` | Esse site pertence a outra organização. | Bu konum farklı bir kuruluşa ait. |
| `errors.groupNotInOrg` | Esse grupo de dispositivos pertence a outra organização. | Bu cihaz grubu farklı bir kuruluşa ait. |
| `errors.invalidLinePatch` | Essas alterações não são válidas para este tipo de linha. | Bu değişiklikler bu satır türü için geçerli değil. |
| `errors.priceNotRepresentable` | Esse preço tem casas decimais demais para {{currency}}. | Bu fiyatın {{currency}} için çok fazla ondalık basamağı var. |
| `errors.catalogItemNotFound` | Esse item do catálogo não está disponível neste contrato. | Bu katalog öğesi bu sözleşmede kullanılamıyor. |

No other new keys: the edit form reuses the existing `contracts.contractEditor.addLine.*` labels (`quantity`, `siteOptional`, `allSites`, `deviceRoles`, `deviceRolesRequired`, `deviceGroup`, `selectGroup`, `deviceGroupRequired`, `clearCatalogLink`), `contracts.contractEditor.lines.unitPrice` and `common:labels.description`.

- [ ] **Step 6: `ContractEditor.tsx` — the edit row**

Import the new client function beside the others (`:14-26`):

```ts
  updateContractLine,
  type UpdateContractLinePatch,
```

Add, just below `roleLineMissingRoles` (`:396`):

```ts
  // #3205 W03: lines are editable on draft/active only (assertEditable). Remove
  // was gated on permission ALONE and 409'd on click for cancelled/expired.
  const linesEditable = canWrite && (contract?.status === 'draft' || contract?.status === 'active');
```

Add the draft state beside the add-form state (`:137-147`) — the add form's own state is untouched, so opening an edit never disturbs a half-typed new line:

```ts
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditLineDraft | null>(null);
```

Add the module-level draft type and pure helpers above the component:

```tsx
interface EditLineDraft {
  description: string;
  unitPrice: string;
  taxable: boolean;
  manualQuantity: string;
  siteId: string;                                   // '' = all sites
  deviceRoles: Exclude<DeviceRole, 'unknown'>[];
  deviceGroupId: string;
  catalogItemId: string | null;                     // null after an unlink
}

function draftFromLine(l: ContractLine): EditLineDraft {
  return {
    description: l.description,
    unitPrice: l.unitPrice,
    taxable: l.taxable,
    manualQuantity: l.manualQuantity ?? '0',
    siteId: l.siteId ?? '',
    deviceRoles: (l.deviceRoles ?? []) as Exclude<DeviceRole, 'unknown'>[],
    deviceGroupId: l.deviceGroupId ?? '',
    catalogItemId: l.catalogItemId,
  };
}

const sameRoleSet = (a: readonly string[], b: readonly string[] | null): boolean => {
  const other = b ?? [];
  return a.length === other.length && [...a].sort().join(',') === [...other].sort().join(',');
};

const MONEY_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Minimal patch: only fields whose draft value differs from the row, so a
 * description edit never re-sends a price and cannot trip catalog transition
 * row 3 or 6 by accident.
 *
 * ONE EXCEPTION — an unlink always sends catalogItemId, unitPrice AND taxable
 * together, even when the operator retyped neither: row 6 requires all three,
 * and a minimal patch would 400 on a legitimate gesture.
 */
function buildLinePatch(l: ContractLine, d: EditLineDraft): UpdateContractLinePatch {
  const patch: UpdateContractLinePatch = {};
  if (d.description.trim() !== l.description) patch.description = d.description.trim();

  if (l.catalogItemId !== null && d.catalogItemId === null) {
    patch.catalogItemId = null;
    patch.unitPrice = d.unitPrice;
    patch.taxable = d.taxable;
  } else {
    if (d.catalogItemId === null && d.unitPrice !== l.unitPrice) patch.unitPrice = d.unitPrice;
    if (d.catalogItemId === null && d.taxable !== l.taxable) patch.taxable = d.taxable;
  }

  if (l.lineType === 'manual' && d.manualQuantity !== (l.manualQuantity ?? '0')) patch.manualQuantity = d.manualQuantity;
  if (SITE_SCOPED_TYPES.has(l.lineType) && (d.siteId || null) !== l.siteId) patch.siteId = d.siteId || null;
  if (l.lineType === 'per_device_role' && !sameRoleSet(d.deviceRoles, l.deviceRoles)) patch.deviceRoles = d.deviceRoles;
  if (l.lineType === 'per_device_group' && d.deviceGroupId && d.deviceGroupId !== l.deviceGroupId) patch.deviceGroupId = d.deviceGroupId;
  return patch;
}

function editDraftIncomplete(l: ContractLine, d: EditLineDraft): boolean {
  if (!d.description.trim()) return true;
  if (l.lineType === 'per_device_role' && d.deviceRoles.length === 0) return true;
  if (l.lineType === 'per_device_group' && !d.deviceGroupId) return true;
  if (d.catalogItemId === null && !MONEY_RE.test(d.unitPrice)) return true;
  return false;
}
```

Add the submit callback beside `removeLine` (`:607-618`):

```tsx
  const saveLine = useCallback((l: ContractLine, patch: UpdateContractLinePatch) =>
    runScoped(`edit-${l.id}`, async () => {
      if (!contract) return;
      await runAction({
        request: () => updateContractLine(contract.id, l.id, patch),
        errorFallback: t('contracts.contractEditor.errors.updateLine'),
        friendly: (code) => ({
          NO_PRICE_FOR_CURRENCY: t('contracts.contractEditor.errors.noPriceForCurrency', { currency: contract.currencyCode }),
          PRICE_NOT_REPRESENTABLE: t('contracts.contractEditor.errors.priceNotRepresentable', { currency: contract.currencyCode }),
          CATALOG_ITEM_NOT_FOUND: t('contracts.contractEditor.errors.catalogItemNotFound'),
          INVALID_STATE: t('contracts.contractEditor.errors.contractNotEditable'),
          LINE_NOT_FOUND: t('contracts.contractEditor.errors.lineNotFound'),
          SITE_NOT_IN_ORG: t('contracts.contractEditor.errors.siteNotInOrg'),
          GROUP_NOT_IN_ORG: t('contracts.contractEditor.errors.groupNotInOrg'),
          INVALID_LINE_PATCH: t('contracts.contractEditor.errors.invalidLinePatch'),
        } as Record<string, string>)[code],
        successMessage: t('contracts.contractEditor.toast.lineUpdated'),
        onUnauthorized: UNAUTHORIZED,
      });
      // Only on success: the row stays in edit mode after a failure so the
      // operator can correct and retry (runScoped routes the throw to
      // handleActionError, which swallows the 401 the redirect already handled).
      setEditingLineId(null);
      setEditDraft(null);
      refresh();
    }, t('contracts.contractEditor.errors.updateLine')),
  [runScoped, contract, refresh, t]);
```

Replace the line-row body (`:912-946`). The type cell's bare site name becomes the labelled shared key, so a site name never renders as an unlabelled string next to a group name:

```tsx
                      lines.map((l, idx) => {
                        const editing = editingLineId === l.id;
                        const d = editing ? editDraft : null;
                        const patch = editing && d ? buildLinePatch(l, d) : null;
                        const saveDisabled = !d || !patch || Object.keys(patch).length === 0
                          || editDraftIncomplete(l, d) || isPending(`edit-${l.id}`);
                        return (
                        <tr key={l.id} className="border-t" data-testid={`line-row-${idx}`}>
                          {editing && d ? (
                            <td className="px-3 py-3" colSpan={6}>
                              <div className="flex flex-col gap-3" data-testid={`line-edit-form-${idx}`}>
                                <span className="text-xs text-muted-foreground" data-testid={`line-edit-type-locked-${idx}`}>
                                  {t(/* i18n-dynamic */ LINE_TYPE_LABELS[l.lineType])} — {t('contracts.contractEditor.editLine.typeLocked')}
                                </span>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                    {t('common:labels.description')}
                                    <input
                                      value={d.description}
                                      onChange={(e) => setEditDraft({ ...d, description: e.target.value })}
                                      data-testid={`line-edit-desc-${idx}`}
                                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                                    />
                                  </label>
                                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                    {t('contracts.contractEditor.lines.unitPrice')}
                                    <input
                                      value={d.unitPrice} disabled={d.catalogItemId !== null}
                                      onChange={(e) => setEditDraft({ ...d, unitPrice: e.target.value })}
                                      data-testid={`line-edit-price-${idx}`}
                                      className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-50"
                                    />
                                    {d.catalogItemId !== null && (
                                      <span data-testid={`line-edit-price-source-${idx}`}>{t('contracts.contractEditor.editLine.priceFromCatalog')}</span>
                                    )}
                                    {d.catalogItemId === null && l.catalogItemId !== null && (
                                      <span className="text-amber-600 dark:text-amber-500">{t('contracts.contractEditor.editLine.unlinkNeedsPrice')}</span>
                                    )}
                                  </label>
                                  {l.lineType === 'manual' && (
                                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                      {t('contracts.contractEditor.addLine.quantity')}
                                      <input
                                        value={d.manualQuantity}
                                        onChange={(e) => setEditDraft({ ...d, manualQuantity: e.target.value })}
                                        data-testid={`line-edit-qty-${idx}`}
                                        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                                      />
                                    </label>
                                  )}
                                  {SITE_SCOPED_TYPES.has(l.lineType) && (
                                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                      {t('contracts.contractEditor.addLine.siteOptional')}
                                      <select
                                        value={d.siteId} onChange={(e) => setEditDraft({ ...d, siteId: e.target.value })}
                                        data-testid={`line-edit-site-${idx}`}
                                        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                                      >
                                        <option value="">{t('contracts.contractEditor.addLine.allSites')}</option>
                                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                                      </select>
                                    </label>
                                  )}
                                  {l.lineType === 'per_device_group' && (
                                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                      {t('contracts.contractEditor.addLine.deviceGroup')}
                                      <select
                                        value={d.deviceGroupId} onChange={(e) => setEditDraft({ ...d, deviceGroupId: e.target.value })}
                                        data-testid={`line-edit-group-${idx}`}
                                        className="h-9 rounded-md border bg-background px-3 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
                                      >
                                        <option value="">{t('contracts.contractEditor.addLine.selectGroup')}</option>
                                        {deviceGroupsList.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                                      </select>
                                      {!d.deviceGroupId && <span className="text-amber-600 dark:text-amber-500">{t('contracts.contractEditor.addLine.deviceGroupRequired')}</span>}
                                    </label>
                                  )}
                                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <input
                                      type="checkbox" checked={d.taxable} disabled={d.catalogItemId !== null}
                                      onChange={(e) => setEditDraft({ ...d, taxable: e.target.checked })}
                                      data-testid={`line-edit-taxable-${idx}`}
                                    />
                                    {t('contracts.contractEditor.lines.tax')}
                                  </label>
                                </div>
                                {l.lineType === 'per_device_role' && (
                                  <fieldset className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid={`line-edit-roles-${idx}`}>
                                    <legend className="mb-1">{t('contracts.contractEditor.addLine.deviceRoles')}</legend>
                                    <div className="flex flex-wrap gap-2">
                                      {BILLABLE_DEVICE_ROLES.map((role) => {
                                        const checked = d.deviceRoles.includes(role);
                                        return (
                                          <label key={role} className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm ${checked ? 'border-primary bg-primary/10 text-foreground' : 'bg-background text-muted-foreground hover:text-foreground'}`}>
                                            <input
                                              type="checkbox" className="sr-only" checked={checked}
                                              onChange={() => setEditDraft({
                                                ...d,
                                                deviceRoles: checked ? d.deviceRoles.filter((r) => r !== role) : [...d.deviceRoles, role],
                                              })}
                                              data-testid={`line-edit-role-${role}-${idx}`}
                                            />
                                            {getDeviceRoleLabel(role)}
                                          </label>
                                        );
                                      })}
                                    </div>
                                    {d.deviceRoles.length === 0 && (
                                      <span className="text-amber-600 dark:text-amber-500">{t('contracts.contractEditor.addLine.deviceRolesRequired')}</span>
                                    )}
                                  </fieldset>
                                )}
                                <div className="flex flex-wrap items-center gap-2">
                                  <button
                                    type="button" disabled={saveDisabled}
                                    onClick={() => { if (patch) void saveLine(l, patch); }}
                                    data-testid={`line-edit-save-${idx}`}
                                    className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50"
                                  >
                                    {t('contracts.contractEditor.editLine.save')}
                                  </button>
                                  <button
                                    type="button" onClick={() => { setEditingLineId(null); setEditDraft(null); }}
                                    data-testid={`line-edit-cancel-${idx}`}
                                    className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-muted"
                                  >
                                    {t('contracts.contractEditor.editLine.cancel')}
                                  </button>
                                  {l.catalogItemId !== null && d.catalogItemId !== null && (
                                    <>
                                      <button
                                        type="button" disabled={isPending(`edit-${l.id}`)}
                                        onClick={() => void saveLine(l, { refreshCatalogPrice: true })}
                                        data-testid={`line-edit-refresh-${idx}`}
                                        className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                                      >
                                        {t('contracts.contractEditor.editLine.refreshPrice')}
                                      </button>
                                      <button
                                        type="button" onClick={() => setEditDraft({ ...d, catalogItemId: null })}
                                        data-testid={`line-edit-unlink-${idx}`}
                                        className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-muted"
                                      >
                                        {t('contracts.contractEditor.addLine.clearCatalogLink')}
                                      </button>
                                    </>
                                  )}
                                  {patch && Object.keys(patch).length === 0 && (
                                    <span className="text-xs text-muted-foreground">{t('contracts.contractEditor.editLine.noChanges')}</span>
                                  )}
                                </div>
                              </div>
                            </td>
                          ) : (
                            <>
                              <td className="px-3 py-2">
                                {t(/* i18n-dynamic */ LINE_TYPE_LABELS[l.lineType])}
                                {SITE_SCOPED_TYPES.has(l.lineType) && l.site
                                  ? <span className="block text-xs text-muted-foreground" data-testid={`line-site-${idx}`}>{t('contracts.shared.lineScope.site', { name: l.site.name })}</span>
                                  : null}
                                {l.lineType === 'per_device_role' && l.deviceRoles
                                  ? <span className="block text-xs text-muted-foreground" data-testid={`line-roles-${idx}`}>{l.deviceRoles.map(getDeviceRoleLabel).join(', ')}</span>
                                  : null}
                                {l.lineType === 'per_device_group'
                                  ? <span className="block text-xs text-muted-foreground" data-testid={`line-group-${idx}`}>
                                      {l.deviceGroup
                                        ? `${l.deviceGroup.name}${l.deviceGroup.type === 'dynamic' ? ` · ${t('contracts.shared.dynamicGroup')}` : ''}`
                                        : t('contracts.shared.deletedGroup', { name: l.deviceGroupName ?? '' })}
                                    </span>
                                  : null}
                              </td>
                              <td className="px-3 py-2">{l.description}</td>
                              <td className="px-3 py-2 text-right">{formatMoney(l.unitPrice, contract?.currencyCode)}</td>
                              <td className="px-3 py-2 text-right tabular-nums" data-testid={`line-qty-${idx}`}>
                                {AUTO_QTY_TYPES.has(l.lineType)
                                  ? (estByLine.has(l.id)
                                      ? estByLine.get(l.id)
                                      : <span className="text-muted-foreground">{t('contracts.shared.values.auto')}</span>)
                                  : (l.lineType === 'manual' ? (l.manualQuantity ?? '0') : '1')}
                              </td>
                              <td className="px-3 py-2 text-center">{l.taxable ? '✓' : '—'}</td>
                              <td className="px-3 py-2 text-right">
                                {linesEditable && (
                                  <div className="flex justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={() => { setEditingLineId(l.id); setEditDraft(draftFromLine(l)); }}
                                      disabled={editingLineId !== null || isPending(`edit-${l.id}`)}
                                      data-testid={`line-edit-${idx}`}
                                      className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                                    >
                                      {t('contracts.contractEditor.lines.edit')}
                                    </button>
                                    <button
                                      type="button" onClick={() => setPendingRemove(l)} disabled={isPending(`remove-${l.id}`) || editingLineId !== null}
                                      data-testid={`line-remove-${idx}`}
                                      className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                                    >
                                      {t('common:actions.remove')}
                                    </button>
                                  </div>
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                        );
                      })
```

Keep the estimate's live-quantity cell, the group sub-label and the `line-qty-<idx>` test id exactly as W02 left them; the only changes above are the labelled site sub-label, the `linesEditable` gate, the Edit button and the edit form.

Three symbols in that block are **W02's, not new**: the `deviceGroupsList` state and its `/device-groups?orgId=…&limit=200` fetch (W02 plan Task 9 Step 5), and the `contracts.shared.dynamicGroup` / `contracts.shared.deletedGroup` locale keys (W02 plan Task 9 Step 6). If W02 named any of them differently, re-point — the edit form's group select needs the same list the add form already loads, not a second fetch.

- [ ] **Step 7: `ContractDetail.tsx` — the site sub-label**

In the type cell (`:377-382`), between the type label and the role sub-label:

```tsx
                        {l.site
                          ? <span className="block text-xs text-muted-foreground" data-testid={`contract-detail-line-site-${l.id}`}>{t('contracts.shared.lineScope.site', { name: l.site.name })}</span>
                          : null}
```

No site fetch and no new request: `line.site` is resolved server-side by `withLineRefs`. This is the W01-deferred legibility fix.

- [ ] **Step 8: Run and commit**

Run:
```bash
cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
npx vitest run src/components/contracts src/lib/i18n
```
Expected: tsc clean; PASS — including the wave 1 `ContractEditor.roles`, wave 2 `ContractEditor.groups` / `ContractDetail.groups` suites, `ContractEditor.autosave`, `ContractEditor.permissions`, and the `localeParity` / `translationCoverage` / `keyUsage` i18n suites.

```bash
git add apps/web/src/lib/api/contracts.ts apps/web/src/components/contracts/ContractEditor.tsx apps/web/src/components/contracts/ContractEditor.editline.test.tsx apps/web/src/components/contracts/ContractDetail.tsx apps/web/src/components/contracts/ContractDetail.site.test.tsx apps/web/src/locales
git commit -m "feat(web): inline contract line editing, status-gated row actions, site sub-label (#3205 W03)"
```

---

### Task 6: Docs and release-notes draft

**Files:**
- Modify: `apps/docs/src/content/docs/features/contracts.mdx:45` (the paragraph after the line-type table) and `:53-60` (the Steps block)
- Modify: `docs/release-notes/next-release-draft.md` — the existing `## Contract lines billed by device role (#3205)` section (`:56-78`)

**Interfaces:** none (prose only).

- [ ] **Step 1: Docs page**

In `apps/docs/src/content/docs/features/contracts.mdx`, after the paragraph at `:45` (the site/catalog one W02 rewrote), insert:

```md
**Editing a line.** On a draft or active contract you can edit a line in place -- its description, price, tax flag, quantity, site, device roles, device group and catalog link -- from the contract editor. The line keeps its identity, so invoices already generated from it stay linked to it and any allowance you set later is preserved. **The line type cannot be changed**: remove the line and add a new one instead. A catalog-linked line keeps the price it was given when it was added; use **Refresh price from catalog** to re-price it. Clearing a catalog link asks you for a unit price, because nothing re-prices the line afterwards. Edits apply from the next billing period onward; invoices that have already been generated are never rewritten.
```

In the `<Steps>` block, extend step 3 so the editing affordance is discoverable from the walkthrough:

```md
3. Add lines -- choose flat, per device, per device role, per device group, per seat, or manual, and set the price (and quantity, roles or group where applicable). Link a catalog item to prefill description and price. You can edit any line later from the same screen while the contract is a draft or active.
```

- [ ] **Step 2: Release-notes draft**

In `docs/release-notes/next-release-draft.md`, append to the existing `## Contract lines billed by device role (#3205)` section, after its **Behaviour** bullets and before the next `##` heading:

```md
### Contract line editing (W03)

**Behaviour**

- Contract lines are now **editable in place** on draft and active contracts
  (`PATCH /api/v1/contracts/:id/lines/:lineId`, and the AI `manage_contracts`
  action `update_line`). The line keeps its id, so an already-generated draft
  invoice stays linked to it — deleting and re-adding a line used to wedge that
  invoice with `SOURCE_NOT_FOUND` on issue. The **line type** cannot be changed;
  remove the line and add a new one.
- All three line mutations now write audit events: `contract.line.added`,
  `contract.line.updated`, `contract.line.removed` (resource type `contract`,
  resource id the contract). The payload carries the line id, the line type, the
  names of the changed columns and, for a price change, the old and new unit
  price — no descriptions, site names or group names.

**Self-Hosting / Upgrade Notes** — three deliberate behaviour changes, no migration:

- `DELETE /api/v1/contracts/:id/lines/:lineId` now returns **404
  `LINE_NOT_FOUND`** for a line that does not exist (previously a silent 200),
  and its success body is `{"data":{"ok":true}}` (previously `{}`).
- `unitPrice`, `manualQuantity` (max 10 digits before the decimal point) and
  `sortOrder` (max 2147483647) bounds now apply on line **create** as well as
  update. Input that previously reached Postgres and returned a 500 is now a 400.
- A stale or foreign `catalogItemId` when **adding** a line is now
  `400 CATALOG_ITEM_NOT_FOUND` instead of a 500.
```

- [ ] **Step 3: Build the docs site and commit**

Run: `cd apps/docs && pnpm build 2>&1 | tail -3`
Expected: build succeeds.

```bash
git add apps/docs/src/content/docs/features/contracts.mdx docs/release-notes/next-release-draft.md
git commit -m "docs(contracts): editing a contract line in place (#3205 W03)"
```

---

### Task 7: Full verification and pull request

**Files:** none new.

- [ ] **Step 1: Full local verification on a fresh test stack**

```bash
cd packages/shared && npx tsc --noEmit -p tsconfig.json
cd ../../apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd ../web && npx tsc --noEmit -p tsconfig.json
cd ../.. && pnpm lint
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
```
Expected: all green. `pnpm db:check-drift` is not needed — W03 adds no column and no migration — but run it anyway to prove that claim:

```bash
cd apps/api && DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test pnpm db:check-drift
```
Expected: no drift, and `git status` shows no file under `apps/api/migrations/`.

- [ ] **Step 2: Contract suites (real database)**

```bash
cd apps/api && DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5433/breeze_test POSTGRES_PASSWORD=breeze_test \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/contractLineEditing.integration.test.ts \
  src/__tests__/integration/contractService.integration.test.ts \
  src/__tests__/integration/contractDeviceGroups.integration.test.ts \
  src/__tests__/integration/contractDeviceRoles.integration.test.ts \
  src/__tests__/integration/contractQuantities.integration.test.ts \
  src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
npx vitest run --config vitest.config.rls.ts
```
Expected: all green. The four tenancy suites are run to **prove the no-registration claim**: W03 adds no table and no column, so they must pass with zero edits to `tenantCascade.ts`, `tenantExportPolicyRegistry.ts` or `rls-coverage.integration.test.ts`. If any of them goes red, a column crept in — stop and add the registration rather than editing the suite.

- [ ] **Step 3: Manual checks from the spec**

- In psql as `breeze_app` (`docker exec -it breeze-postgres psql -U breeze_app -d breeze`), forge the five asymmetry-matrix cases and confirm each verdict: roles onto a `per_device` line and a `site_id` onto a `per_device_group` line **reject** (`23514`); duplicate roles, a `manual_quantity` on a `flat` line and a `site_id` on a `flat` line **accept**.
- In the UI on a running stack: edit a `per_device_role` line's roles and confirm the estimate sidebar's quantity changes on refresh; edit a line on a contract that already generated an invoice and confirm the invoice detail is unchanged; confirm Edit and Remove are both absent on a cancelled contract.

- [ ] **Step 4: Tear down the test stack, push, open the PR**

```bash
git push -u origin feature/3205-line-editing/wave-4652
gh pr create --repo LanternOps/breeze --base main --title "feat(billing): contract line editing (#3205 W03)" --body "$(cat <<'EOF'
Closes #4652
Refs #3205

Spec: `docs/superpowers/specs/billing/2026-09-03-contract-line-editing-design.md`
Plan: `docs/superpowers/plans/billing/2026-09-03-contract-line-editing.md`

## What

- `PATCH /contracts/:id/lines/:lineId` edits a contract line **in place**, keeping its id. That is the point: `invoice_lines.source_id` carries the contract line id and `issueInvoice` refuses a draft whose source line is gone (`invoiceService.ts:1194-1199`), so the pre-W03 repair — delete and re-add — wedged any unissued generated invoice. The integration suite proves both halves: the edit path leaves the drafted invoice byte-identical and issuable, and the delete-and-re-add control fails `SOURCE_NOT_FOUND`.
- One two-mode invariant helper in `@breeze/shared` (`create` reproduces the pre-W03 add-schema behaviour byte for byte — the wave 1/2 validator describes pass unedited — and `persisted` is the merged-row rule set), plus a pure `mergeContractLinePatch`, so the web editor runs the identical rules with no second copy.
- `catalogItemId` is tri-state by key presence: omitted keeps the link **and** the stamped price, a different id re-links and re-resolves, `null` unlinks (and then `unitPrice` + `taxable` are required). Re-sending the same id is a no-op; repricing an unchanged link is `refreshCatalogPrice: true`, a named auditable gesture rather than a side effect.
- Audit: `contract.line.added` / `.updated` / `.removed` from both doors (HTTP and the AI tool, the latter with `initiatedBy: 'ai'`). `changedFields` is diffed from the persisted row before/after the UPDATE, never from the patch keys, so an ignored client price cannot claim to have applied. No free text in any payload.
- `update_line` registered at all four `manage_contracts` sites, with a table-driven parity test over every action so the next one cannot drift (site 4 omission is a fail-closed `Unknown action` denial that reads like a permissions bug).
- Web: one row in edit mode at a time, gated on `canWrite && status ∈ {draft, active}` — the same predicate now gates **Remove**, which was permission-gated only and 409'd on click for cancelled/expired contracts. Minimal patches, with one deliberate exception for the unlink. Detail page gains the W01-deferred site sub-label from `line.site`.

## Migrations

**None.** No new column and no new table, so `CORE_TENANT_EXPORT_POLICY`, `CORE_ORG_CASCADE_DELETE_ORDER` and the RLS allowlists are untouched — proven by running those four contract suites unchanged.

## Deliberate behaviour changes to existing surfaces

1. `DELETE /contracts/:id/lines/:lineId` returns **404 `LINE_NOT_FOUND`** for a line that does not exist (was a silent 200), and its success body is `{"data":{"ok":true}}` (was `{}`). Its permissiveness is what would make the removal audit lie.
2. `unitPrice`, `manualQuantity` and `sortOrder` bounds tighten on **create** as well as update — input that previously reached Postgres as a `22003` and 500'd is now a typed 400.
3. A stale or foreign `catalogItemId` on **add** is now 400 `CATALOG_ITEM_NOT_FOUND` instead of a live 500 (`resolvePrice`'s `ITEM_NOT_FOUND` was unmapped). Non-enumerating on purpose: missing, foreign and RLS-invisible are one answer.
4. All three line reads (`getContract`, `computeContractEstimate`, `generateDueInvoice`) order by `(sortOrder, createdAt, id)`. `sortOrder` alone was not a total order — the editor defaults it to 0 — so an edit could visibly reshuffle the table and two generations could order invoice lines differently.

## Tests

Shared validator: strict/tri-state/bounds pins, the full two-mode asymmetry matrix, `mergeContractLinePatch`. Service unit: lock order, all seven catalog transition rows, the three catalog error mappings, merged-row invariants, ownership re-checks and group re-stamp, FK-race mapping, audit diff (reorder is not a change, no-op is `[]`, key-set allowlist). Service integration on real Postgres as `breeze_app`: the asymmetry matrix asserted on **both** sides (three cases the database accepts), orphaned-group repair, ordering determinism, the lineage headline with its delete-and-re-add control, edit-vs-generation in both orders, edit-vs-edit, status and tenancy gates. Routes: wiring, strict-body rejection, error rendering, audit call shape and the no-free-text key allowlist. AI: four-site parity table, `update_line` dispatch, `details` propagation, `initiatedBy: 'ai'`. Web: status gate on both affordances, locked type, minimal patch, the unlink exception, refresh-price, Save gating, single-open-row, friendly error mapping, 401 silence, detail site sub-label, locale parity.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01AXFWi7tAV9LWM2UCNMPrpZ
EOF
)"
```

Stop here. Do not merge. Report the PR URL and anything that was skipped or failed.
