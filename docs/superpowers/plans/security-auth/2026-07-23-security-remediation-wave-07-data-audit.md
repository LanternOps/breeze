# Security Remediation Wave 07: Data Protection and Auditability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent capability-bearing request paths and tenant secrets from entering telemetry or exports, assign audit events to the data actually affected, audit successful sensitive reads, and expose public quotes through an exact customer DTO.

**Architecture:** A matched-route helper is the only request label available to logs and Sentry. Tenant export performs a complete information-schema/classification preflight before its first tenant-data query and selects only explicitly included columns. Time-entry services report the exact mutated entry identities back to route-local audit collection; download handlers audit only after bytes are prepared. Public quote serialization moves to a typed field-by-field mapper shared with the portal contract.

**Tech Stack:** Hono, TypeScript, Sentry Node SDK, Drizzle ORM, PostgreSQL information schema/forced RLS, Archiver, Vitest, Astro/React portal.

**Implementation Branch:** `fix/security-review-data-audit`

## Global Constraints

- Wave 07 may implement in parallel after Wave 01, but rebase over Waves 05 and 06 before final verification so new tenant tables and certificate columns are classified.
- Do not add or edit a database migration in this wave. All changes are code, contracts, tests, and explicit audit calls.
- A raw URL, pathname, query string, route parameter, capability token, file path, or download content must never be a log/Sentry label or audit detail.
- Before route resolution, telemetry may contain method plus a generated correlation ID only. After resolution, the sole path-like value is the bounded matched Hono route template.
- Unmatched and wildcard-only routes use exact label `unmatched`; never fall back to `c.req.path`, `c.req.url`, `request.url`, or inbound transaction names.
- Export policy is deny by default. Classification of every existing column occurs before the first tenant-row query; an absent, duplicate, suspicious-unreviewed, or open-container-unreviewed classification aborts the export.
- Preserve `getOrgCascadeDeleteOrder()` discovery, existing `<table>.json` filenames, deterministic file order, `manifest.json` shape, checksums, and row counts.
- Tenant export reads remain in `withSystemDbAccessContext`, but all filtering is by the requested organization and all output projections are explicit.
- Audit writes use `writeRouteAudit`/the existing non-blocking retry path and never make an otherwise authorized successful product operation fail.
- Audit only a completed sensitive retrieval. Validation, authorization, not-found, upstream command failure, serialization failure, and empty/invalid report failure emit no success audit.
- Public quote keysets are exact. Adding a database column cannot add a public response field.
- Run integration tests against real PostgreSQL for information-schema/export/cascade/RLS behavior.
- Apply one independent review round. If review changes export classification, route labeling, audit ownership, or public DTO keys, rerun the complete Wave 07 gate.

## Finding Coverage

| Finding | Owning tasks | Red-green regression | Enforcement acceptance |
|---|---|---|---|
| `SEC-LOG-001` | Tasks 1 and 2 | Start with failing quote/invite/provisioning/installer/remote-access capability fixtures across logs and every Sentry surface; make them green with matched-route labeling and event rebuilding. | Serialized logs/events contain zero token bytes, use `unmatched` without fallback, and retain request ID plus bounded route-template diagnostics. |
| `DP-EXPORT-001` | Tasks 3 and 4 | Start with failing preflight-order, unclassified/suspicious/open-container, extension, and secret-sentinel ZIP tests; make them green with exhaustive checked-in policy and explicit projections. | Classification completes before tenant reads, every prohibited sentinel is absent by key and value, and unclassified core/extension columns fail the export closed. |
| `AUDIT-001` | Task 5 | Start with failing row-org, NULL-org, mixed-org bulk, auto-stop, failed mutation, and fallback-duplicate tests; make them green with service mutation recording and route grouping. | Every successful lifecycle mutation is owned by its affected row organization and time-entry paths receive no generic duplicate. |
| `AUDIT-READ-001` | Task 6 | Start with failing success/failure ordering, exact counts, cross-org denial, serialization failure, and audit-backend rejection tests for all four downloads; make them green with post-preparation fixed-schema audit calls. | Only completed reads audit; records contain actor/org/resource/format/row/byte metadata and no content, path, capability, or credential. |
| `DP-PUBLIC-QUOTE-001` | Task 7 | Start with a failing exact-keyset source row populated with every internal sentinel plus portal field/render tests; make them green with `toPublicQuoteHeader`. | Public JSON has the exact shared DTO key order and excludes all tenant, creator, invoice/document, delivery-job, failure, and internal timestamp fields. |

---

### Task 1: Establish a matched-route-only request label

**Files:**

- Create: `apps/api/src/services/safeRequestLabel.ts`
- Create: `apps/api/src/services/safeRequestLabel.test.ts`
- Modify: `apps/api/src/middleware/requestPathLogger.ts`
- Modify: `apps/api/src/middleware/requestPathLogger.test.ts`

Expose:

```ts
export const UNMATCHED_ROUTE_LABEL = 'unmatched';

export function safeMatchedRouteLabel(c: Context): string {
  // Reads c.req.routePath only; no raw-path fallback.
}

export function newRequestCorrelationId(inbound: string | undefined): string {
  // Reuses only a canonical UUID; otherwise returns randomUUID().
}
```

Accept a matched template only when it is non-empty, not `*` or `/*`, begins with `/`, contains no `?`, `#`, CR, LF, percent-encoded bytes, or segment longer than 80 characters, and is at most 200 characters. Return `unmatched` otherwise. These restrictions apply to extension-provided route templates too.

`requestPathLogger` emits:

```text
<-- <METHOD> request_id=<UUID>
--> <METHOD> route=<MATCHED_TEMPLATE_OR_UNMATCHED> status=<STATUS> duration_ms=<INTEGER> request_id=<UUID>
```

Generate/validate the correlation ID before `await next()`, set `X-Request-Id` on the response, and call `safeMatchedRouteLabel` only after `await next()`.

- [ ] Add failing helper tests for a static route, `/:token`, nested params, wildcard/unmatched, empty route, query/fragment/control characters, encoded bytes, overlong template/segment, and proof that the helper never reads `path` or `url`.
- [ ] Add failing middleware tests whose quote token, invite token, provisioning token, installer token, and remote-access capability each appear in the raw request path. Assert none appears in either log line and the completion line contains the matched template.
- [ ] Add tests for valid inbound UUID reuse, attacker-supplied non-UUID replacement, one request ID across both lines/header, 404 `unmatched`, and thrown route errors.
- [ ] Implement the helper and logger format. Do not interpolate a pathname in the pre-resolution line.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/safeRequestLabel.test.ts src/middleware/requestPathLogger.test.ts`; expect all token non-disclosure assertions to pass.
- [ ] Commit this task as `fix(security): label requests by matched route only`.

### Task 2: Remove raw path surfaces from serialized Sentry events

**Files:**

- Modify: `apps/api/src/services/sentry.ts`
- Modify: `apps/api/src/services/sentry.test.ts`
- Modify: `apps/api/src/services/sentry.isolation.test.ts`
- Create: `apps/api/src/services/sentry.capability-paths.test.ts`

`captureException(err, c)` sets only:

- tag `method`;
- tag `route_template` from `safeMatchedRouteLabel(c)`;
- the existing bounded `pg_code` and `rls_deny` tags;
- existing non-secret tenant/user isolation identifiers.

Remove tag `path` and request-context `path`. Do not derive a Sentry transaction name from the request.

`scrubEvent` rebuilds request/telemetry surfaces:

```ts
event.request = event.request?.method ? { method: event.request.method } : undefined;
delete event.transaction;
delete event.breadcrumbs;
delete event.contexts;
event.tags = pickAllowedTags(event.tags, [
  'method', 'route_template', 'pg_code', 'rls_deny',
  'user_id', 'scope', 'org_id', 'partner_id',
]);
delete event.message;
delete event.logentry;
delete event.extra;
event.exception = rebuildSafeException(event.exception);
```

Do not retain a free-form `extra` channel. `captureMessage` and `captureException` may keep their
existing optional `extra` parameter for source compatibility, but the Sentry adapter drops it
entirely. If a caller needs a diagnostic field, add that bounded scalar explicitly to the typed tag
allowlist in a separately reviewed change; never recursively “redact” arbitrary objects and then
forward what remains. A tag supplied through the optional `tags` argument is retained only when its
name is in the allowlist and its value is at most 128 characters with no `/`, `?`, `#`, CR, or LF.

`rebuildSafeException` keeps only a bounded exception type plus structural stack frames
(`function`, `module`, `lineno`, `colno`, `in_app`). It replaces every exception value with
`[redacted]` and drops filename/absolute path, context/pre/post lines, local variables, and mechanism
data. This preserves stack shape for diagnosis without preserving free-form strings that can contain
a capability URL.

- [ ] Add failing unit fixtures with raw data in `request.url`, `request.query_string`, transaction,
  `event.message`, `logentry`, every `exception.values[].value`, exception mechanism data,
  filename/absolute path, stack context/variables, tags, contexts, breadcrumbs, `extra` under both
  dangerous and innocuous nested keys, header casing variants, and SDK-populated request fields.
- [ ] Seed exact quote, invite, provisioning, installer, and remote-access capabilities into every
  Sentry surface, including innocently named nested `extra` fields and arbitrary array/string
  values supplied by existing `captureMessage` callers; serialize the scrubbed event and assert
  neither each full token nor a distinctive token substring appears and `extra` is absent.
- [ ] Add capture tests proving a matched `/:token` template is retained, an unmatched route is `unmatched`, and `c.req.path` is never sent.
- [ ] Implement allowlist rebuilding and delete `event.extra` wholesale. Preserve method, route
  template, RLS classification, release, the structural stack fields allowed above, and isolation
  identifiers.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/sentry.test.ts src/services/sentry.isolation.test.ts src/services/sentry.capability-paths.test.ts`; expect all event serialization tests to pass.
- [ ] Commit this task as `fix(security): scrub raw request paths from Sentry`.

### Task 3: Build the deny-default export classifier and preflight

**Files:**

- Create: `apps/api/src/services/tenantExportPolicy.ts`
- Create: `apps/api/src/services/tenantExportPolicy.test.ts`
- Modify: `apps/api/src/services/tenantExport.ts`
- Modify: `apps/api/src/services/tenantExport.test.ts`

Define:

```ts
export type ExportColumnDecision = {
  decision: 'include' | 'exclude';
  rationale: string;
  reviewedSensitiveName?: true;
  openContainerReviewed?: true;
};

export type TenantExportTablePolicy = {
  organizationKey: 'id' | 'org_id';
  columns: Readonly<Record<string, ExportColumnDecision>>;
};

export type TenantExportPolicyRegistry =
  Readonly<Record<string, TenantExportTablePolicy>>;

export type ExportTablePlan = {
  table: string;
  organizationKey: 'id' | 'org_id';
  includedColumns: readonly string[];
};

export async function buildTenantExportPlan(
  tables: readonly string[],
  registry: TenantExportPolicyRegistry,
): Promise<readonly ExportTablePlan[]>;
```

**Registry injection (added 2026-07-25 — resolves a Task 3/Task 4 cycle).** An earlier revision
declared `buildTenantExportPlan(tables)` with no registry source: the concrete registry module is
created by Task 4, but Task 4 forbids modifying `tenantExportPolicy.ts`, so Task 3 could not be
implemented without an unapproved temporary API, an unresolved import, or an always-deny stub.

The registry is therefore an explicit REQUIRED parameter. Task 3 owns the pure, deny-default
classifier and takes the registry as data — it imports no registry module and hardcodes no table.
Task 3's tests supply small fixture registries directly, which is what makes the missing-policy,
extra-column, and unreviewed-container cases testable in isolation. Task 4 then creates the real
`tenantExportPolicyRegistry.ts` and is the only task that wires it into the `buildOrgExportZip`
call site. Deny-default still holds: a table absent from the supplied registry fails the preflight.

`buildTenantExportPlan` performs one `information_schema.columns` query for the full cascade set before any tenant table is read. For each existing table:

- policy must exist;
- policy keys and live column names must match exactly;
- include/exclude sets are therefore exhaustive and non-overlapping;
- `organizations` must use `id`; every other current core cascade table uses `org_id`;
- a suspicious-name include requires `reviewedSensitiveName: true`;
- JSON/JSONB/bytea or column names `credentials`, `headers`, `config`, `settings`, `metadata`, `payload`, `data`, `blob`, and `opaque` require `openContainerReviewed: true` for either decision;
- identifiers are validated before quoting.

The suspicious-name matcher covers `password`, `hash`, `mfa`, `totp`, `recovery`, `token`, `secret`, `private_key`, `credential`, `authorization`, `cookie`, `webhook`, `encryption_key`, `provision`, `bootstrap`, `invite`, `refresh`, `access_key`, and `client_key`.

`buildOrgExportZip` calls and completes this preflight before creating the archive or querying rows. Replace `SELECT *` with a quoted explicit projection from `includedColumns`. Missing optional tables remain absent from the plan and archive. Policy failure returns no partial ZIP and performs no table-data query.

- [ ] Add failing pure policy tests for missing table policy, missing/extra/duplicate column, suspicious include without review, open JSON/container without review, wrong organization key, unsafe identifier, and a complete safe table.
- [ ] Add failing service tests that record query order and prove classification failure occurs before the first tenant-row query or archive append.
- [ ] Implement information-schema preflight and explicit projection. Keep the existing sequential deterministic archive order.
- [ ] Add a test where an excluded sentinel secret is present in the mocked DB row source; prove the SQL projection never requests it and neither its key nor value enters the ZIP.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/tenantExportPolicy.test.ts src/services/tenantExport.test.ts`; expect all preflight/query-order tests to pass.
- [ ] Commit this task as `fix(security): preflight tenant export columns`.

### Task 4: Classify every core and extension export column

**Files:**

- Create: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Create: `apps/api/scripts/check-tenant-export-policy.ts`
- Create: `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`
- Modify: `packages/extension-api/src/legacy.ts`
- Modify: `packages/extension-api/src/index.test.ts`
- Modify: `packages/extension-sdk/src/manifest.ts`
- Modify: `packages/extension-sdk/src/manifest.test.ts`
- Modify: `apps/api/src/extensions/tenancyRegistry.ts`
- Modify: `apps/api/src/extensions/tenancyRegistry.test.ts`
- Modify: `apps/api/src/services/tenantExport.ts`
- Modify: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`

Check in a literal `CORE_TENANT_EXPORT_POLICY` entry for every live column of every table returned by `getOrgCascadeDeleteOrder()`. The verification script reads the database and reports exact missing/extra classifications; it never auto-accepts a new column.

Initial prohibited classes are always `exclude`:

- password verifiers/hashes;
- MFA/TOTP seeds and recovery codes;
- API, session, access, refresh, invite, enrollment, provisioning, installer, bootstrap, reset, and token hashes or plaintext tokens;
- encrypted/plaintext access and refresh tokens;
- client/webhook secrets;
- private/signing/backup encryption keys;
- credential/header JSON;
- live provisioning handles;
- certificate private keys and recovery proofs introduced by Wave 05.

Every JSON/JSONB/bytea and open container gets a human-readable rationale and explicit review marker. Operational IDs, timestamps, statuses, public keys/cert fingerprints, or error metadata are not automatically safe: classify them individually according to the tenant export contract. Keep Wave 05 certificate-history exclusions consistent with its plan.

Extend tenancy manifests compatibly:

```ts
orgExportColumns: z.record(
  z.string(),
  z.object({
    include: z.array(z.string()),
    exclude: z.array(z.string()),
  }).strict(),
).default({})
```

Every extension `orgCascadeDeleteTables` entry must have an `orgExportColumns` entry at export time. Old manifests still load because the field defaults to `{}`, but an export involving an unclassified extension table fails safely before data reads.

- [ ] Generate the current information-schema report with `pnpm --filter @breeze/api exec tsx scripts/check-tenant-export-policy.ts`; expect failure listing every unclassified core column.
- [ ] Review each listed column and add its literal include/exclude decision and rationale to `tenantExportPolicyRegistry.ts`; do not add a wildcard, type-wide include, or runtime “safe by default.”
- [ ] Add extension schema/registry tests for complete classification, missing extension policy, missing column, suspicious/open container, and two extensions declaring the same table inconsistently.
- [ ] Add an integration test that creates a temporary new suspicious column and proves the check fails, then rolls the column back in test cleanup.
- [ ] Populate every prohibited secret class in export fixtures with unique key/value sentinels. Build the ZIP and assert neither any prohibited key nor any sentinel value occurs in any entry or manifest.
- [ ] Prove a newly registered extension cascade table without classification aborts before its rows are queried; prove a fully classified extension table exports only its includes.
- [ ] Run `pnpm --filter @breeze/api exec tsx scripts/check-tenant-export-policy.ts`; expect `all cascade tables and columns classified`.
- [ ] Run `pnpm --filter @breeze/api test:integration -- src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`; expect both to pass under a real database.
- [ ] Commit this task as `fix(security): classify tenant export data`.

### Task 5: Assign time-entry mutation audits to affected entries

**Files:**

- Modify: `apps/api/src/services/timeEntryService.ts`
- Modify: `apps/api/src/services/timeEntryService.test.ts`
- Modify: `apps/api/src/routes/timeEntries/timeEntries.ts`
- Modify: `apps/api/src/routes/timeEntries/timeEntries.test.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/src/index.time-entry-audit.test.ts`

Add:

```ts
export type TimeEntryAuditMutation = {
  action:
    | 'time_entry.created'
    | 'time_entry.started'
    | 'time_entry.stopped'
    | 'time_entry.updated'
    | 'time_entry.deleted'
    | 'time_entry.approved'
    | 'time_entry.unapproved';
  entryId: string;
  orgId: string | null;
};

export type TimeEntryActor = {
  userId: string;
  name?: string;
  email?: string;
  partnerId: string | null;
  manageAll: boolean;
  accessibleOrgIds: string[] | null;
  recordAuditMutation?: (mutation: TimeEntryAuditMutation) => void;
};
```

Call the optional recorder only after the corresponding database mutation succeeds. Record:

- create: returned row;
- start: auto-stopped prior row, if present, plus newly created row;
- stop/update: returned row;
- delete: the authorized row captured before deletion, only after delete succeeds;
- bulk approve/unapprove: every row returned by the update, including `org_id` in `returning`.

The route creates one collector per request. After service success, group bulk records by exact `orgId` and call `writeRouteAudit` once per group with action, resource type `time_entry`, exact affected IDs, and count. Simple operations emit one record per affected entry. A NULL organization is the documented partner-level representation and remains NULL; never substitute the request org or first accessible org.

Add `/time-entries` to `FALLBACK_AUDIT_EXCLUDE_PREFIXES` in the same change. This excludes `/api/v1/time-entries` and its descendants only.

- [ ] Add failing service tests for create/start auto-stop/stop/update/delete, failed delete, mixed-org bulk approval, skipped IDs, and partner-level NULL org.
- [ ] Add failing route tests asserting exact action/org/resource/count, per-org grouping, no audit on service failure, and audit failure not changing the successful HTTP response.
- [ ] Add a fallback test proving each time-entry mutation gets only explicit records while an unrelated mutation still gets fallback audit.
- [ ] Implement the recorder, route collector, grouping, and fallback exclusion. Audit details contain entry IDs/count only, never descriptions, rates, ticket content, or request bodies.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/timeEntryService.test.ts src/routes/timeEntries/timeEntries.test.ts src/index.time-entry-audit.test.ts`; expect all ownership/deduplication tests to pass.
- [ ] Run `pnpm --filter @breeze/api test:integration -- src/__tests__/integration/time-entries-rls.integration.test.ts`; expect selected-org and partner-axis isolation to remain green.
- [ ] Commit this task as `fix(audit): own time entry mutation events`.

### Task 6: Audit successful sensitive downloads after byte preparation

**Files:**

- Create: `apps/api/src/services/sensitiveReadAudit.ts`
- Create: `apps/api/src/services/sensitiveReadAudit.test.ts`
- Modify: `apps/api/src/routes/systemTools/fileBrowser.ts`
- Create: `apps/api/src/routes/systemTools/fileBrowser.audit.test.ts`
- Modify: `apps/api/src/routes/contracts/documents.ts`
- Modify: `apps/api/src/routes/contracts/documents.test.ts`
- Modify: `apps/api/src/routes/tickets/export.ts`
- Modify: `apps/api/src/routes/tickets/parts.test.ts`
- Modify: `apps/api/src/routes/reports/runs.ts`
- Create: `apps/api/src/routes/reports/runs.audit.test.ts`
- Modify: `apps/api/src/services/contractDocumentService.ts` (**scope exception approved
  2026-07-25** — see below)
- Modify: `apps/api/src/services/contractDocumentService.test.ts` (same exception)

**Scope exception (approved 2026-07-25).** This task must attribute each successful sensitive
download to its owning organization, but `getContractDocumentPdf` returns only
`{ pdfData, mime, byteSize, sha256 }` — it has `row.orgId` internally (it already uses it for the
`canAccessOrg` check) and discards it. Auditing the download without it would either omit the org or
re-derive it from request state, which is exactly the kind of inferred tenancy this program is
closing.

Add `orgId` to the returned object and audit from that value. Keep the existing `canAccessOrg` check
where it is; this exception widens the return type only, and must not relax the authorization that
already guards it.

Expose:

```ts
export function auditSensitiveRead(
  c: AuthContext,
  input: {
    action: 'file.download' | 'contract.document.download'
      | 'billing.billables.download' | 'report.run.download';
    orgId: string | null;
    resourceType: 'device_file' | 'contract_document'
      | 'billing_export' | 'report_run';
    resourceId: string;
    format: string;
    rowCount: number;
    byteCount: number;
  },
): void;
```

It delegates to `writeRouteAudit` with those bounded fields only. It accepts no content, file path, URL, query, token, credential, error, filename, or arbitrary metadata field.

Place calls after:

- file browser: successful base64 decode and final buffer creation; org from authorized device, resource ID is `deviceId`, format `binary`, rows 1, exact buffer length;
- contract PDF: successful `getContractDocumentPdf`; org from returned document, resource ID is document UUID, format `pdf`, rows 1, `byteSize`;
- billables CSV: successful row serialization; resource ID `billables`, format `csv`, row count, UTF-8 byte count; org is requested `q.orgId` or NULL for a partner-wide export;
- report run: successful JSON/PDF payload or CSV/TSV serialization; org from authorized run, resource ID is run UUID, exact format, result-row count, UTF-8 byte count.

For report JSON responses, compute bytes from the exact serialized response payload before returning so the audit count and response match. Do not audit the report metadata GET.

- [ ] Add a pure helper test proving its fixed details schema cannot carry content/capability fields and `writeRouteAudit` receives exact metadata.
- [ ] Add route tests for success, unauthorized/wrong org, not found, upstream command failure, parse/serialization failure, empty report, and audit backend rejection for all four surfaces.
- [ ] Implement calls immediately before the successful return, after bytes/rows are known. Ensure audit rejection is fire-and-forget and response bytes/status remain identical.
- [ ] Search the four audit actions and assert no details include `content`, `path`, `url`, `token`, `headers`, `credentials`, `filename`, or raw query.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/sensitiveReadAudit.test.ts src/routes/systemTools/fileBrowser.audit.test.ts src/routes/contracts/documents.test.ts src/routes/tickets/parts.test.ts src/routes/reports/runs.audit.test.ts`; expect exact success/failure audit behavior.
- [ ] Commit this task as `feat(audit): record successful sensitive downloads`.

### Task 7: Replace public quote row spreading with an exact DTO

**Files:**

- Create: `packages/shared/src/types/publicQuote.ts`
- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/api/src/services/publicQuoteDto.ts`
- Create: `apps/api/src/services/publicQuoteDto.test.ts`
- Modify: `apps/api/src/routes/quotesPublic.ts`
- Modify: `apps/api/src/routes/quotesPublic.test.ts`
- Modify: `apps/api/src/__tests__/integration/quotesPublicRoutes.integration.test.ts`
- Modify: `apps/portal/src/lib/api.ts`
- Modify: `apps/portal/src/components/portal/PublicQuoteView.tsx`
- Create: `apps/portal/src/components/portal/PublicQuoteView.test.tsx`

Define the exact shared contract:

```ts
export interface PublicQuoteHeader {
  id: string;
  quoteNumber: string | null;
  title: string | null;
  status: 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted';
  currencyCode: string;
  issueDate: string | null;
  expiryDate: string | null;
  subtotal: string;
  taxRate: string | null;
  taxTotal: string;
  total: string;
  oneTimeTotal: string;
  monthlyRecurringTotal: string;
  annualRecurringTotal: string;
  depositType: 'none' | 'percent' | 'selected_lines';
  depositAmount: string | null;
  dueOnAcceptanceTotal: string;
  depositDueTotal: string | null;
  categoryBreakdown: Array<{
    category: string;
    oneTimeTotal: string;
    monthlyTotal: string;
    annualTotal: string;
  }>;
  billToName: string | null;
  introNotes: string | null;
  terms: string | null;
  sellerSnapshot: PublicQuoteSellerSnapshot | null;
  coverPage: PublicQuoteCoverPage | null;
  termsAndConditions: string | null;
}

export interface PublicQuoteSellerSnapshot {
  name: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

export interface PublicQuoteCoverPage {
  enabled: boolean;
  title: string | null;
  coverImageId: string | null;
  preparedForName: string | null;
  showPreparedBy: boolean;
}
```

`toPublicQuoteHeader(row, totals)` returns an object literal containing those keys in that order.
Normalize stored `sent` to public `viewed`; the route already rejects draft. Map `sellerSnapshot`
and `coverPage` field by field into the exact nested contracts, normalizing absent optional cover
fields to `null` and `showPreparedBy` to its current default. Do not use spread, `Object.assign`,
schema passthrough, cast-through, or “omit internal fields” at any nesting level.

Explicitly exclude `partnerId`, `orgId`, `siteId`, `billToAddress`, `billToTaxId`, `acceptedAt`, `declinedAt`, `convertedAt`, `declineReason`, `convertedInvoiceId`, `pdfDocumentRef`, `pdfSha256`, `sentAt`, `sendScheduledAt`, `sendJobId`, `sendEmailReason`, `firstViewedAt`, `viewedAt`, `createdBy`, `createdAt`, and `updatedAt`.

- [ ] Add a failing mapper exact-keyset test using a source row populated with every included and
  excluded field. Assert `Object.keys(result)` exactly equals the interface order, assert exact
  nested keysets for seller/address/cover, and prove internal sentinels injected into both JSONB
  objects are absent from serialized JSON.
- [ ] Add a compile-time `satisfies PublicQuoteHeader` assertion and tests for sent normalization,
  all public statuses, legacy/null/malformed nested values, seller snapshot, billing name,
  issue/expiry dates, terms, deposits, category breakdown, cover defaults, and recurring totals.
- [ ] Replace `{ ...quote }` in `quotesPublic.ts` with the mapper; leave sanitized blocks, customer-visible lines, and branding contracts unchanged.
- [ ] Update portal `PublicQuoteDetail.quote` to `PublicQuoteHeader`; keep the authenticated `QuoteHeader` separate.
- [ ] Add route/integration exact-keyset tests and a portal render test covering seller, recurring totals, deposit, categories, dates, and terms.
- [ ] Run `pnpm --filter @breeze/shared typecheck`, `pnpm --filter @breeze/api test:run -- src/services/publicQuoteDto.test.ts src/routes/quotesPublic.test.ts`, and `pnpm --filter @breeze/api test:integration -- src/__tests__/integration/quotesPublicRoutes.integration.test.ts`; expect all contracts to pass.
- [ ] Run `pnpm --filter @breeze/portal test` and `pnpm --filter @breeze/portal build`; expect portal rendering and TypeScript build to pass.
- [ ] Commit this task as `fix(security): serialize public quotes explicitly`.

### Task 8: Execute the Wave 07 integration, RLS, and rollback gates

**Deployment order:**

1. deploy route/Sentry scrubbing;
2. deploy export preflight and the complete current registry together;
3. deploy explicit time-entry and sensitive-read audits;
4. deploy the public DTO with portal compatibility in the same release.

**Rollback:** Route/Sentry scrub may be rolled back only to another matched-template-only build, never to raw path logging. If export classification blocks a legitimate archive, classify the specific column in a forward fix; do not restore `SELECT *` or bypass preflight. Audit code may be disabled by action behind the existing audit delivery mechanism only if it threatens service health; do not include content as a diagnostic workaround. Public DTO rollback must retain an explicit allowlist mapper.

- [ ] Run all focused Wave 07 tests:

  ```bash
  pnpm --filter @breeze/api test:run -- \
    src/services/safeRequestLabel.test.ts \
    src/middleware/requestPathLogger.test.ts \
    src/services/sentry.test.ts \
    src/services/sentry.isolation.test.ts \
    src/services/sentry.capability-paths.test.ts \
    src/services/tenantExportPolicy.test.ts \
    src/services/tenantExport.test.ts \
    src/services/timeEntryService.test.ts \
    src/routes/timeEntries/timeEntries.test.ts \
    src/services/sensitiveReadAudit.test.ts \
    src/routes/systemTools/fileBrowser.audit.test.ts \
    src/routes/contracts/documents.test.ts \
    src/routes/tickets/parts.test.ts \
    src/routes/reports/runs.audit.test.ts \
    src/services/publicQuoteDto.test.ts \
    src/routes/quotesPublic.test.ts
  ```

  Expect zero failures.

- [ ] Run `pnpm --filter @breeze/api test:integration`, `pnpm --filter @breeze/api test:rls-coverage`, `pnpm --filter @breeze/api db:check-drift`, and `pnpm --filter @breeze/api build`; expect zero failures, no RLS regression, no drift, and successful compilation.
- [ ] Run the policy checker against the migration-current test database; expect every Wave 05/06 table and column classified before any rollout.
- [ ] Populate every prohibited export secret class, build the archive under system context, and prove neither secret keys nor sentinel values exist in any ZIP entry.
- [ ] As `breeze_app`, prove tenant export request routes cannot directly read another organization; system-context export with an authorized org ID returns only that org's explicitly included columns.
- [ ] Send capability-bearing quote, invite, provisioning, installer, and remote-access paths through matched, unmatched, thrown-error, and Sentry paths. Search captured logs/events; expect zero token bytes and useful route-template/request-ID diagnostics.
- [ ] Exercise time entries in two organizations plus a NULL-org partner entry; expect per-affected-org audits and no fallback duplicates.
- [ ] Exercise successful and failed file, contract, billing, and report downloads; expect one intended success audit per completed retrieval scope and none on failures.
- [ ] Confirm every sensitive-read audit has actor, org representation, resource, format, row count, and byte count, with no content/capability data.
- [ ] Run `pnpm --filter @breeze/shared typecheck`, `pnpm --filter @breeze/portal test`, and `pnpm --filter @breeze/portal build`; expect public quote type/render compatibility.
- [ ] Obtain one independent review covering no raw-path fallback, preflight-before-read order, complete export registry, extension fail-safe behavior, audit success ordering/org ownership, and quote exact keyset.
- [ ] Commit verification-only adjustments as `test(security): close Wave 07 data protection gates`.

## Completion Criteria

- Logs and serialized Sentry events retain correlation and matched-route diagnostics without raw capability-bearing paths.
- Export discovery remains automatic, while every current and extension column is classified before data is queried.
- Prohibited secrets and open containers do not enter export process memory or archive output without explicit reviewed inclusion.
- Time-entry audit organization comes from each affected row; mixed-org bulk operations split and generic fallback does not duplicate them.
- File, contract, billing, and report success audits occur only after retrieval and contain counts/identity, never content or capabilities.
- Public quote JSON contains exactly the customer contract and no internal tenant, creator, invoice/document, delivery-job, failure, or internal timestamp field.
- RLS, integration, API build, shared typecheck, portal tests, and portal build are green.
