# Final Review Fixes Report

Base: `8a9df9d3d74d388ddc79d089b0eb41601f05390b`

## Fixes

1. `GET /patches/approvals`
   - Added `devices:read` authorization before query validation/handler execution.
   - Reused the existing authoritative `requirePartnerWideApprovalAccess` guard.
   - `partnerOrgAccess=selected|none` now returns 403 before partner resolution or DB access.

2. `GET /huntress/status`
   - Narrowed route scope to partner/system.
   - Replaced permissive partner resolution with the same `requirePartnerManager` full-partner authority check used by Huntress partner-global inventory/configuration routes.
   - `partnerOrgAccess=selected|none` now returns 403 before DB access.

3. Portal customer invoice header
   - Added explicit `CustomerInvoiceHeader` DTO and `toCustomerInvoiceHeader` serializer.
   - The serializer exposes only the existing portal `InvoiceDetail` fields and never spreads a database row.
   - Internal tenant axes, actor IDs, lifecycle timestamps, replacement-chain IDs, PDF reference/hash, tax implementation fields, and other database metadata are omitted.
   - Existing customer-safe line DTO remains unchanged.

4. Tenant role editing
   - Removed the unconditional global-identity `PATCH /users/:id` from the Users page edit flow.
   - Tenant admins now submit changed roles directly to `POST /users/:id/role`; no-op role saves make no mutation.
   - Name/email remain read-only in this UI. This UI does not expose a system/platform global-identity editor, so no legitimate system identity-edit flow was changed.

## TDD RED evidence

### Patch approvals

Command:

```bash
pnpm --filter @breeze/api test -- src/routes/patches/approvals.test.ts
```

Observed before implementation: `src/routes/patches/approvals.test.ts (21 tests | 3 failed)`. Both `selected` and `none` cases entered the DB handler and threw at `approvals.ts:61`; the missing `devices:read` case did the same. The watch-mode process was then interrupted after the failures were captured (exit 130).

### Huntress status

Command:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/huntress.test.ts
```

Observed before implementation: exit 1; `2 failed | 16 passed`. Both `selected` and `none` received 500 instead of 403 after entering the partner-global DB read at `huntress.ts:713`.

### Customer invoice header

Command:

```bash
pnpm --filter @breeze/api exec vitest run src/services/invoiceService.test.ts
```

Observed before implementation: exit 1; `1 failed | 33 passed`. Exact-keyset assertion showed the raw header contained 21 extra fields, including `createdBy`, replacement IDs, PDF reference/hash, partner/org/site IDs, and lifecycle metadata.

### Users role edit

Command:

```bash
pnpm --filter @breeze/web exec vitest run src/components/settings/UsersPage.test.tsx
```

Observed before implementation: exit 1; `2 failed | 2 passed`. Both the changed-role and unchanged-role flows made one forbidden global identity PATCH where zero were expected.

## Focused GREEN evidence

- `pnpm --filter @breeze/api exec vitest run src/routes/patches/approvals.test.ts`
  - exit 0; 1 file passed; 21 tests passed.
- `pnpm --filter @breeze/api exec vitest run src/routes/huntress.test.ts`
  - exit 0; 1 file passed; 18 tests passed.
- `pnpm --filter @breeze/api exec vitest run src/services/invoiceService.test.ts`
  - exit 0; 1 file passed; 34 tests passed.
- `pnpm --filter @breeze/web exec vitest run src/components/settings/UsersPage.test.tsx`
  - exit 0; 1 file passed; 4 tests passed. Vitest emitted the pre-existing Node experimental localStorage warning.

## Consolidated verification

Affected API suites, including patch approvals, Huntress, portal invoice route/service, and users API:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/patches/approvals.test.ts src/routes/huntress.test.ts src/routes/portal/invoices.test.ts src/services/invoiceService.test.ts src/routes/users.test.ts
```

Result: exit 0; 5 files passed; 182 tests passed.

Users page rerun:

```bash
pnpm --filter @breeze/web exec vitest run src/components/settings/UsersPage.test.tsx
```

Result: exit 0; 1 file passed; 4 tests passed. Vitest emitted the pre-existing Node experimental localStorage warning.

Targeted API lint:

```bash
cd apps/api && pnpm exec eslint src/routes/huntress.ts src/routes/huntress.test.ts src/routes/patches/approvals.ts src/routes/patches/approvals.test.ts src/services/invoiceService.ts src/services/invoiceService.test.ts
```

Result: exit 0; no output.

Targeted web lint:

```bash
cd apps/web && pnpm exec eslint src/components/settings/UsersPage.tsx src/components/settings/UsersPage.test.tsx
```

Result: exit 0; no output.

API typecheck:

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit -p tsconfig.json
```

Result: exit 0; no output. An initial concurrent run without `NODE_OPTIONS` exhausted Node's default ~4 GB heap; the isolated 8 GB retry above is the authoritative result.

Web Astro diagnostics:

```bash
cd apps/web && pnpm exec astro check
```

Result: exit 0; 1,440 files checked; 0 errors; 0 warnings; 226 pre-existing hints.

Portal Astro diagnostics:

```bash
cd apps/portal && pnpm exec astro check
```

Result: exit 0; 65 files checked; 0 errors; 0 warnings; 24 pre-existing hints.

Diff hygiene:

```bash
git diff --check
```

Result: exit 0; no output.

## Self-review

- Verified authorization middleware executes before query handlers and all database reads.
- Verified the patch read uses `devices:read` while existing mutations retain `devices:execute` + MFA.
- Verified system scope remains authorized for both partner-global routes.
- Compared the customer invoice-header allowlist field-for-field with `apps/portal/src/lib/api.ts` `InvoiceDetail`; no existing portal consumer field was removed.
- Confirmed the PDF route still receives `id`, `invoiceNumber`, and `status` from the narrowed DTO.
- Confirmed the Users page has no editable global name/email control, so removing its PATCH does not remove a visible system identity-edit feature.
- Reviewed the complete diff for unrelated changes; none found.

## Concerns

- No implementation blocker.
- Repository-wide Astro diagnostics contain existing hints outside this change; both checks report zero errors and zero warnings.
