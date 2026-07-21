# Reports PDF Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduled report emails attach the real branded PDF, the executive summary gets the posture-style designed cover, report rows show next-run + recipients, runs carry trend baselines ("79, up from 74"), and partner-level cross-org reports get a design doc.

**Architecture:** `reportPdf.ts` (pure jsPDF renderer, dependency-clean by design) lifts from `apps/web` into `packages/shared` under a new `./reportPdf` export subpath (NOT the root barrel, so jsPDF never rides along with ordinary shared imports). The API's `reportScheduleWorker` then builds the same branded PDF server-side and attaches it. Executive summary gains a canonical shared type + a designed cover reusing the posture primitives (scorecard, metric grid, recommended actions). Trend baselines are attached to `report_runs.result.previous` at generation time so snapshots stay self-contained. No DB migrations are needed for any task — everything rides in existing `config`/`result` JSONB.

**Tech Stack:** TypeScript, Hono, Drizzle, BullMQ, jsPDF 4 + jspdf-autotable 5 (proven to run headless in Node), Zod 4, React, Vitest.

**Branch context:** This branch (`ToddHebebrand/reports-pdf-enhanements`) is stacked on `origin/ToddHebebrand/reports-improvements` (PR #2148, pending merge). After #2148 squash-merges, rebase with `git rebase --onto main origin/ToddHebebrand/reports-improvements`.

## Global Constraints

- Zod 4 idioms: `z.string().guid()` (not `.uuid()`), `z.string().email()` is fine (repo precedent `apps/api/src/routes/users.ts:101`), `z.looseObject({...})` for passthrough objects.
- `@breeze/shared` ships raw TS source (no build). jsPDF must NOT be re-exported from the root barrel `packages/shared/src/index.ts` — only via the `./reportPdf` subpath.
- `apps/api` tsup config bundles `@breeze/shared` via `noExternal` — the pattern must also match the new subpath import (use `/^@breeze\/shared/` regex).
- Never edit shipped migrations; this plan requires **no** migrations.
- Report renderer stays pure: no network, no DOM, no path-alias imports. `Intl` is allowed.
- All timestamps shown to users are formatted in the report's timezone (org → partner → UTC chain).
- API tests use the Drizzle mock patterns from the existing `apps/api/src/jobs/reportScheduleWorker.test.ts`. Web tests are Vitest + jsdom. Run per-package: `pnpm --filter @breeze/api test <file>`, `pnpm --filter @breeze/shared test <file>`, `pnpm --filter @breeze/web test <file>` (web package name may be `web` — check `apps/web/package.json` if the filter misses).
- Commit after each task with a `feat(reports):`/`fix(reports):` message.

---

### Task 1: Stop stripping `config.schedule` / `config.emailRecipients` on create (bug fix)

`POST /reports` persists `c.req.valid('json').config` — a plain `z.object` that doesn't declare `schedule`, `emailRecipients`, or any of the builder's metadata keys. Zod strips unknown keys, so **reports created via POST lose their cadence detail and recipients** (the schedule worker then falls back to 09:00/monday/1st defaults and never emails anyone). `PUT` used `config: z.any()` so edits survived — which is also a validation gap (memory: validate per-field, don't `z.any()`).

**Files:**
- Modify: `apps/api/src/routes/reports/schemas.ts`
- Create: `apps/api/src/routes/reports/schemas.config.test.ts`

**Interfaces:**
- Produces: `reportConfigSchema` (exported for tests), used by `createReportSchema.config` and `updateReportSchema.config`. Task 3's worker relies on `config.schedule.{time,day,date}` and `config.emailRecipients` surviving create.

- [ ] **Step 1: Write the failing test** — `apps/api/src/routes/reports/schemas.config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createReportSchema, updateReportSchema } from './schemas';

const builderConfig = {
  builderType: 'device_inventory',
  dataSource: 'devices',
  columns: ['hostname'],
  filterConditions: [{ field: 'status', operator: 'eq', value: 'online' }],
  schedule: { time: '09:00', day: 'monday', date: '1' },
  exportFormats: ['pdf'],
  emailRecipients: ['client@example.com', 'msp@example.com'],
};

describe('report config schema', () => {
  it('preserves schedule detail and emailRecipients on create', () => {
    const parsed = createReportSchema.parse({
      name: 'Monthly posture',
      type: 'security_compliance_posture',
      schedule: 'monthly',
      format: 'pdf',
      config: builderConfig,
    });
    expect(parsed.config.schedule).toEqual({ time: '09:00', day: 'monday', date: '1' });
    expect(parsed.config.emailRecipients).toEqual(['client@example.com', 'msp@example.com']);
    // Builder metadata must round-trip for the edit page.
    expect((parsed.config as Record<string, unknown>).builderType).toBe('device_inventory');
    expect((parsed.config as Record<string, unknown>).exportFormats).toEqual(['pdf']);
  });

  it('rejects malformed recipients and times', () => {
    expect(() =>
      createReportSchema.parse({
        name: 'x', type: 'compliance',
        config: { emailRecipients: ['not-an-email'] },
      })
    ).toThrow();
    expect(() =>
      createReportSchema.parse({
        name: 'x', type: 'compliance',
        config: { schedule: { time: '25:99' } },
      })
    ).toThrow();
  });

  it('validates config on update too (was z.any())', () => {
    expect(() =>
      updateReportSchema.parse({ config: { emailRecipients: ['nope'] } })
    ).toThrow();
    const ok = updateReportSchema.parse({ config: builderConfig });
    expect(ok.config?.emailRecipients).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it** — `pnpm --filter @breeze/api test src/routes/reports/schemas.config.test.ts` — expect FAIL (schedule/emailRecipients stripped; update accepts anything).

- [ ] **Step 3: Implement** in `apps/api/src/routes/reports/schemas.ts`. Add above `createReportSchema`:

```ts
/**
 * Cadence detail + delivery config persisted inside `config`. The builder
 * writes these and reportScheduleWorker reads them; they must be declared here
 * because zod strips unknown object keys — before this schema existed, creates
 * silently dropped schedule times and email recipients (edits survived only
 * because update used z.any()).
 */
const reportScheduleDetailSchema = z.object({
  // 24h "HH:MM"
  time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).optional(),
  // weekday name; the worker lowercases, so accept any case
  day: z.string().max(16).optional(),
  // day-of-month "1".."31" as string (builder sends strings)
  date: z.string().regex(/^([1-9]|[12]\d|3[01])$/).optional()
});

const reportConfigFields = {
  dateRange: z.object({
    start: z.string().optional(),
    end: z.string().optional(),
    preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']).optional()
  }).optional(),
  filters: z.object({
    siteIds: z.array(z.string().guid()).optional(),
    deviceIds: z.array(z.string().guid()).optional(),
    osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
    status: z.array(z.string()).optional(),
    severity: z.array(z.string()).optional()
  }).optional(),
  columns: z.array(z.string()).optional(),
  groupBy: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  schedule: reportScheduleDetailSchema.optional(),
  emailRecipients: z.array(z.string().email().max(254)).max(50).optional(),
  ...securityCompliancePostureConfigFields
};

// Loose: the builder round-trips presentation metadata (builderType, dataSource,
// filterConditions, aggregation, chartType, exportFormats, templateName…)
// through config; declared keys above are validated, unknown keys pass through.
export const reportConfigSchema = z.looseObject(reportConfigFields);
```

Then in `createReportSchema` replace the inline `config: z.object({...}).optional().default({})` with `config: reportConfigSchema.optional().default({})`, and in `updateReportSchema` replace `config: z.any().optional()` with `config: reportConfigSchema.optional()`. Leave `generateReportSchema` as-is (ad-hoc runs don't persist config).

- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter @breeze/api test src/routes/reports/` and `pnpm --filter @breeze/api typecheck`. Expect PASS. (If `z.looseObject` is unavailable in the pinned Zod, use `z.object(reportConfigFields).passthrough()`.)

- [ ] **Step 5: Commit** — `fix(reports): persist schedule detail + emailRecipients through create validation`

---

### Task 2: Lift `reportPdf.ts` into `packages/shared` (+ Node smoke test)

The renderer is already dependency-clean ("no network, no DOM, no path-alias deps"). Move it verbatim; only its one import changes.

**Files:**
- Move: `apps/web/src/components/reports/reportPdf.ts` → `packages/shared/src/reportPdf/reportPdf.ts` (via `git mv`)
- Create: `packages/shared/src/reportPdf/index.ts`, `packages/shared/src/reportPdf/reportPdf.test.ts`
- Modify: `packages/shared/package.json`, `apps/api/package.json`, `apps/api/tsup.config.ts`, `apps/web/src/components/reports/reportExport.ts`, `apps/web/src/components/reports/reportExport.posture.test.tsx`

**Interfaces:**
- Produces: `import { buildReportPdf, type ReportBranding } from '@breeze/shared/reportPdf'` — `buildReportPdf(rows: unknown[], opts: BuildOpts): jsPDF`. Also export `type BuildOpts`. Tasks 3, 5, 6 build on this module.
- Do NOT touch `packages/shared/src/index.ts` (root barrel must stay jsPDF-free).

- [ ] **Step 1: Move the file and fix its one cross-package import**

```bash
mkdir -p packages/shared/src/reportPdf
git mv apps/web/src/components/reports/reportPdf.ts packages/shared/src/reportPdf/reportPdf.ts
```

In the moved file change line 3 `import type { PostureSummary } from '@breeze/shared';` → `import type { PostureSummary } from '../types/postureReport';` and export `BuildOpts` (`type BuildOpts` → `export type BuildOpts`). Create `packages/shared/src/reportPdf/index.ts`:

```ts
export { buildReportPdf } from './reportPdf';
export type { ReportBranding, BuildOpts } from './reportPdf';
```

- [ ] **Step 2: Wire packages.** `packages/shared/package.json`: add to `exports`: `"./reportPdf": "./src/reportPdf/index.ts"`; add to `dependencies`: `"jspdf": "^4.2.1", "jspdf-autotable": "^5.0.8"`. `apps/api/package.json`: add the same two to `dependencies` (tsup externalizes node_modules imports found inside bundled shared source; the API must resolve them at runtime). `apps/api/tsup.config.ts`: change `noExternal: ['@breeze/shared', 'dotenv']` → `noExternal: [/^@breeze\/shared/, 'dotenv']` (the string form doesn't match the `/reportPdf` subpath). Run `pnpm install`.

- [ ] **Step 3: Update web importers.** `apps/web/src/components/reports/reportExport.ts` line 6: `import { buildReportPdf, type ReportBranding } from '@breeze/shared/reportPdf';`. `reportExport.posture.test.tsx` line 48: `import type { ReportBranding } from '@breeze/shared/reportPdf';`.

- [ ] **Step 4: Node smoke test** — `packages/shared/src/reportPdf/reportPdf.test.ts` (runs in shared's default Node environment — this is the proof the worker can render):

```ts
import { describe, expect, it } from 'vitest';
import { buildReportPdf } from './reportPdf';
import type { PostureSummary } from '../types/postureReport';

const postureSummary: PostureSummary = {
  org: { id: 'o1', name: 'Acme Corp' },
  deviceCount: 2,
  postureScore: 79,
  controls: { edrCoveragePct: 50, anyAvCoveragePct: 100, unprotectedCount: 0, encryptionPct: 50, firewallPct: 100, patchCurrentPct: 50 },
  privilegedAccess: { uacInterceptionEnabled: true, activePamRules: 1 },
  securityProducts: [{ product: 'Defender', category: 'edr', active: true }],
};
const postureRows = [
  { hostname: 'PC-1', os: 'windows', site: 'HQ', protection: 'Defender', firewall: true, encryption: 'Encrypted', pendingPatches: 0, criticalPatches: 0, openVulnHigh: 0, openVulnCritical: 0, protectionManaged: true },
  { hostname: 'PC-2', os: 'macos', site: 'HQ', protection: 'No data', firewall: false, encryption: 'Unencrypted', pendingPatches: 3, criticalPatches: 1, openVulnHigh: 2, openVulnCritical: 0, protectionManaged: false },
];
const opts = { generatedAt: 'Jul 1, 2026, 9:00 AM', timezone: 'UTC' };

describe('buildReportPdf in Node (no DOM)', () => {
  it('renders the posture cover + device table', () => {
    const doc = buildReportPdf(postureRows, { ...opts, reportType: 'security_compliance_posture', summary: postureSummary });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(2);
    expect(Buffer.from(doc.output('arraybuffer')).byteLength).toBeGreaterThan(1000);
  });

  it('renders a generic table for row reports', () => {
    const doc = buildReportPdf([{ hostname: 'PC-1', status: 'online' }], { ...opts, reportType: 'device_inventory' });
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it('renders branded chrome with a partner name', () => {
    const doc = buildReportPdf([], { ...opts, reportType: 'compliance', branding: { name: 'Olive MSP', logoDataUrl: null, logoAspect: null } });
    expect(Buffer.from(doc.output('arraybuffer')).byteLength).toBeGreaterThan(500);
  });
});
```

- [ ] **Step 5: Verify everything still builds** — `pnpm --filter @breeze/shared test src/reportPdf`, `pnpm --filter @breeze/shared typecheck`, web tests `pnpm --filter web test src/components/reports` (reportExport + posture tests must stay green), `pnpm --filter @breeze/api build` (proves tsup bundles the subpath). Expect PASS.

- [ ] **Step 6: Commit** — `feat(reports): lift branded PDF renderer into @breeze/shared/reportPdf`

---

### Task 3: Scheduled emails attach the branded PDF

PDF-format reports currently get a link only (`reportScheduleWorker.ts:289` skips attachment for `format === 'pdf'`). Attach the real branded PDF, rendered server-side with partner branding and the report's timezone.

**Files:**
- Create: `apps/api/src/services/reportBranding.ts`, `apps/api/src/services/reportBranding.test.ts`
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts` (`emailReportRun`, `processRunScheduledReport`), `apps/api/src/jobs/reportScheduleWorker.test.ts`

**Interfaces:**
- Consumes: `buildReportPdf`, `ReportBranding` from `@breeze/shared/reportPdf` (Task 2).
- Produces: `loadReportBrandingForOrg(orgId: string): Promise<ReportBranding>` and `pngAspectFromDataUrl(dataUrl: string): number | null` in `reportBranding.ts`. `emailReportRun` gains `summary`, `branding`, `timezone` fields (Task 6 adds `previous`).

- [ ] **Step 1: Write failing tests for branding helper** — `apps/api/src/services/reportBranding.test.ts`. Mock `../db` like the worker test does. Cases: (a) partner with a `data:image/png;base64,...` logo (use a real 1×2 PNG fixture, e.g. build one with `Buffer` from the canonical 8-byte signature + IHDR — assert `logoAspect === 0.5`); (b) partner with an external `https://` logo URL → `logoDataUrl: null`, name still set (server can't guarantee format; name-only branding is the safe fallback); (c) org with no partner → all-null branding. To make a valid fixture: `const png = (w: number, h: number) => { const b = Buffer.alloc(24); b.write('\x89PNG\r\n\x1a\n', 0, 'binary'); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return 'data:image/png;base64,' + b.toString('base64'); };`

- [ ] **Step 2: Implement** `apps/api/src/services/reportBranding.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations, partners } from '../db/schema';
import type { ReportBranding } from '@breeze/shared/reportPdf';

/** Parse intrinsic width/height from a PNG data URL (IHDR is always the first
 * chunk: width at byte 16, height at byte 20). Returns null for non-PNG data. */
export function pngAspectFromDataUrl(dataUrl: string): number | null {
  if (!dataUrl.startsWith('data:image/png;base64,')) return null;
  try {
    const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return w > 0 && h > 0 ? w / h : null;
  } catch {
    return null;
  }
}

/**
 * Partner branding for server-rendered report PDFs. Mirrors the web's
 * loadPartnerBranding (reportExport.ts) but headless: only uploaded PNG data
 * URLs are embeddable (no canvas to re-encode external images); anything else
 * degrades to name-only branding, matching the renderer's fallback chain.
 */
export async function loadReportBrandingForOrg(orgId: string): Promise<ReportBranding> {
  const empty: ReportBranding = { name: null, logoDataUrl: null, logoAspect: null };
  const [row] = await db
    .select({ partnerName: partners.name, partnerSettings: partners.settings })
    .from(organizations)
    .leftJoin(partners, eq(organizations.partnerId, partners.id))
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row?.partnerName) return empty;
  const settings = (row.partnerSettings ?? {}) as { branding?: { logoUrl?: string } };
  const logoUrl = settings.branding?.logoUrl ?? null;
  const aspect = logoUrl ? pngAspectFromDataUrl(logoUrl) : null;
  return {
    name: row.partnerName,
    logoDataUrl: aspect != null ? logoUrl : null,
    logoAspect: aspect,
  };
}
```

- [ ] **Step 3: Run branding tests** — expect PASS.

- [ ] **Step 4: Write failing worker test.** In `reportScheduleWorker.test.ts`, add a `processRunScheduledReport` case: report with `format: 'pdf'`, config `{ emailRecipients: ['a@b.co'] }`, `generateReportMock` returning `{ rows: [{ hostname: 'PC-1' }], rowCount: 1 }`; mock `../services/reportBranding` → `{ loadReportBrandingForOrg: vi.fn(async () => ({ name: 'Olive MSP', logoDataUrl: null, logoAspect: null })) }`. Assert `sendEmailMock` was called with one attachment whose `filename` ends `.pdf`, `contentType === 'application/pdf'`, and `content` is a Buffer starting with `%PDF` (`content.subarray(0, 4).toString() === '%PDF'` — real jsPDF output, NOT mocked; this is the end-to-end Node proof). Also assert the csv path is unchanged (existing csv test still passes).

- [ ] **Step 5: Implement in the worker.** In `reportScheduleWorker.ts`:
  - Add imports: `import { buildReportPdf, type ReportBranding } from '@breeze/shared/reportPdf';` and `import { loadReportBrandingForOrg } from '../services/reportBranding';` and extend the existing schema import with nothing new (org/partner already imported).
  - In `processRunScheduledReport`, after loading the report, resolve timezone + branding once:

```ts
  const [tzRow] = await db
    .select({ orgSettings: organizations.settings, partnerTimezone: partners.timezone, partnerSettings: partners.settings })
    .from(organizations)
    .leftJoin(partners, eq(organizations.partnerId, partners.id))
    .where(eq(organizations.id, report.orgId))
    .limit(1);
  const timeZone = timezoneFor(tzRow?.orgSettings ?? null, tzRow?.partnerTimezone ?? null, tzRow?.partnerSettings ?? null);
```

  and in the email call pass `format`, `rows`, plus new fields `summary: result.summary`, `timezone: timeZone`, `branding: await loadReportBrandingForOrg(report.orgId)` (fetch branding lazily inside the `recipients.length > 0` block — don't query it when nobody gets email).
  - Rework `emailReportRun`'s attachment block:

```ts
async function emailReportRun(opts: {
  reportName: string;
  reportType: string;
  format: string;
  recipients: string[];
  rows: unknown[];
  summary?: Record<string, unknown>;
  timezone: string;
  branding: ReportBranding;
}): Promise<void> {
  const email = getEmailService();
  if (!email) {
    console.warn('[ReportScheduleWorker] Email service not configured; skipping recipients for', opts.reportName);
    return;
  }
  const base = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
  const link = `${base}/reports`;
  const dateStr = new Date().toISOString().split('T')[0];

  const attachments = [] as Array<{ filename: string; content: Buffer; contentType?: string }>;
  if (opts.format === 'pdf') {
    // The branded PDF is the deliverable an MSP wants landing in the client's
    // inbox — render it here exactly as the web does (same shared renderer).
    try {
      const generatedAt = new Intl.DateTimeFormat('en-US', {
        timeZone: opts.timezone, dateStyle: 'medium', timeStyle: 'short',
      }).format(new Date());
      const doc = buildReportPdf(opts.rows, {
        reportType: opts.reportType,
        generatedAt,
        timezone: opts.timezone,
        summary: opts.summary as never,
        branding: opts.branding,
      });
      const content = Buffer.from(doc.output('arraybuffer'));
      if (content.byteLength <= MAX_ATTACHMENT_BYTES) {
        attachments.push({ filename: `${opts.reportType}-report-${dateStr}.pdf`, content, contentType: 'application/pdf' });
      }
    } catch (err) {
      // A render failure must not block delivery — fall back to the link-only email.
      console.error('[ReportScheduleWorker] PDF render failed; sending link-only email:', err);
    }
  } else if (opts.rows.length > 0) {
    const csv = rowsToCsv(opts.rows);
    const content = Buffer.from(csv, 'utf8');
    if (content.byteLength <= MAX_ATTACHMENT_BYTES) {
      attachments.push({ filename: `${opts.reportType}-report-${dateStr}.csv`, content, contentType: 'text/csv' });
    }
  }

  const bodyText =
    opts.rows.length > 0
      ? `Your scheduled report "${opts.reportName}" has been generated with ${opts.rows.length} record${opts.rows.length === 1 ? '' : 's'}.`
      : `Your scheduled report "${opts.reportName}" has been generated.`;
  const attachmentNote =
    attachments.length === 0
      ? 'Open Breeze to view and download the formatted report.'
      : attachments[0]!.contentType === 'application/pdf'
        ? 'The formatted report is attached as a PDF.'
        : 'The data is attached as CSV; open Breeze for the fully formatted report.';
  // ... sendEmail call unchanged (subject/html/text/attachments)
}
```

  Keep the existing `sendEmail` call. Note the `rows.length` body line: for row-less summary reports (executive summary) prefer the bare "has been generated." line — the `rows.length > 0` ternary already does this.

- [ ] **Step 6: Run worker tests** — `pnpm --filter @breeze/api test src/jobs/reportScheduleWorker.test.ts` — expect PASS (including the `%PDF` magic-byte assertion). Then `pnpm --filter @breeze/api typecheck && pnpm --filter @breeze/api build`.

- [ ] **Step 7: Commit** — `feat(reports): attach branded PDF to scheduled report emails`

---

### Task 4: Canonical `ExecutiveSummary` type + org name in the generator

The exec summary snapshot crosses the API→shared-renderer boundary and is persisted, so it gets the same single-sourced-type treatment as `PostureSummary`. The generator currently omits the org name the cover needs.

**Files:**
- Create: `packages/shared/src/types/executiveSummaryReport.ts`
- Modify: `packages/shared/src/types/index.ts` (add `export * from './executiveSummaryReport';` beside the postureReport export), `apps/api/src/services/reportGenerationService.ts` (`generateExecutiveSummaryReport`)
- Create: `apps/api/src/services/reportGenerationService.execSummary.test.ts`

**Interfaces:**
- Produces: `ExecutiveSummary` type importable from `@breeze/shared` (types are erased — safe in the root barrel). Generator returns `{ summary: ExecutiveSummary; generatedAt: string }` with `org.name` populated. Task 5's renderer consumes this type.

- [ ] **Step 1: Create the type** — `packages/shared/src/types/executiveSummaryReport.ts`:

```ts
/**
 * Canonical shape of the Executive Summary report's `summary` snapshot.
 * Single-sourced (API produces with `satisfies`, the shared PDF renderer
 * consumes) and persisted in report_runs.result, so all fields are optional —
 * a legacy snapshot must still render. Mirrors postureReport.ts.
 */
export type ExecutiveSummaryDevices = {
  total?: number;
  online?: number;
  offline?: number;
  /** Share of managed devices online, 0-100. */
  healthPercentage?: number;
};

export type ExecutiveSummaryAlerts = {
  total?: number;
  critical?: number;
  high?: number;
  resolved?: number;
  /** Share of window alerts resolved, 0-100. */
  resolutionRate?: number;
};

export type ExecutiveSummary = {
  org?: { id?: string; name?: string };
  devices?: ExecutiveSummaryDevices;
  alerts?: ExecutiveSummaryAlerts;
  osDistribution?: Record<string, number>;
  siteBreakdown?: Array<{ site: string; count: number }>;
};
```

- [ ] **Step 2: Write the failing generator test** — `reportGenerationService.execSummary.test.ts` with Drizzle `../db` mocks (follow the worker test's `selectMock` pattern; each `db.select()` call in the generator returns the next queued result — queue: org row `[{ id: 'org-1', name: 'Acme Corp' }]`, device stats, alert stats, os distribution, site breakdown). Assert `result.summary.org` equals `{ id: 'org-1', name: 'Acme Corp' }` and the existing numeric shape is unchanged (`devices.total`, `alerts.resolutionRate`, etc.). Note the org-name query must be added FIRST in the generator so mock ordering is stable.

- [ ] **Step 3: Implement.** In `generateExecutiveSummaryReport`: import `organizations` into the service's schema import list and `import type { ExecutiveSummary } from '@breeze/shared';`. At the top of the function add:

```ts
  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
```

Then in the return, add `org: { id: orgId, name: orgRow?.name ?? '' },` as the first key of `summary`, and change `summary: { ... }` to `summary: { ... } satisfies ExecutiveSummary`.

- [ ] **Step 4: Run** — `pnpm --filter @breeze/api test src/services/reportGenerationService.execSummary.test.ts` + `pnpm --filter @breeze/shared typecheck` — expect PASS.

- [ ] **Step 5: Commit** — `feat(reports): canonical ExecutiveSummary type with org identity`

---

### Task 5: Executive summary PDF — the posture treatment

Today `executive_summary` PDFs render "No data available" (no `rows`, and the rich `summary` is ignored). Give it the designed cover: fleet-health scorecard, thematic metric grids, OS/site breakdowns, recommended actions. Same skeleton as posture, different data.

**Files:**
- Modify: `packages/shared/src/reportPdf/reportPdf.ts`
- Modify: `packages/shared/src/reportPdf/reportPdf.test.ts`

**Interfaces:**
- Consumes: `ExecutiveSummary` (Task 4), posture primitives already in the file (`drawTitleBlock`, `drawScorecard`, `drawSectionHeading`, `drawMetricGrid`, `drawLegend`, `Recommendation`, `drawRecommendedActions` internals).
- Produces: `BuildOpts.summary` widens to `PostureSummary | ExecutiveSummary`; `buildReportPdf` dispatches `executive_summary` → `renderExecutiveSummaryCover`. Web callers need no change (they already pass `data.summary` through for all types).

- [ ] **Step 1: Failing test.** Add to `reportPdf.test.ts`:

```ts
import type { ExecutiveSummary } from '../types/executiveSummaryReport';

const execSummary: ExecutiveSummary = {
  org: { id: 'o1', name: 'Acme Corp' },
  devices: { total: 42, online: 39, offline: 3, healthPercentage: 93 },
  alerts: { total: 18, critical: 2, high: 5, resolved: 12, resolutionRate: 67 },
  osDistribution: { windows: 30, macos: 10, linux: 2 },
  siteBreakdown: [
    { site: 'HQ', count: 25 },
    { site: 'Warehouse', count: 12 },
    { site: 'Remote', count: 5 },
  ],
};

it('renders the executive summary cover from summary (no rows)', () => {
  const doc = buildReportPdf([], { ...opts, reportType: 'executive_summary', summary: execSummary });
  expect(doc.getNumberOfPages()).toBe(1);
  expect(Buffer.from(doc.output('arraybuffer')).byteLength).toBeGreaterThan(2000);
});

it('falls back to the generic empty page when an exec summary has no summary', () => {
  const doc = buildReportPdf([], { ...opts, reportType: 'executive_summary' });
  expect(doc.getNumberOfPages()).toBe(1);
});
```

Run: `pnpm --filter @breeze/shared test src/reportPdf` — the first new test fails only after Step 2's size assertion (a blank "No data" page is small); verify it FAILS before implementing.

- [ ] **Step 2: Implement the renderer.** In `reportPdf.ts`:
  1. Change the import line to `import type { PostureSummary } from '../types/postureReport';` + `import type { ExecutiveSummary } from '../types/executiveSummaryReport';` and widen `BuildOpts.summary?: PostureSummary | ExecutiveSummary;`.
  2. In `buildReportPdf`, keep the posture branch keying on `reportType === 'security_compliance_posture'` (cast `opts.summary as PostureSummary` where passed down), and add before the generic fallback:

```ts
  } else if (opts.reportType === 'executive_summary' && opts.summary && 'devices' in (opts.summary as object)) {
    renderExecutiveSummaryCover(doc, opts.summary as ExecutiveSummary, opts);
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
  } else {
```

  3. Add the renderer + recommendations (place after the posture cover section):

```ts
// ----------------------------------------------------------------------------
// Executive summary cover: the QBR artifact. Same designed skeleton as the
// posture cover — fleet-health scorecard, thematic metric grids, recommended
// actions — driven by the ExecutiveSummary snapshot instead of posture data.
// ----------------------------------------------------------------------------

function buildExecRecommendations(summary: ExecutiveSummary): Recommendation[] {
  const d = summary.devices ?? {};
  const a = summary.alerts ?? {};
  const recs: Recommendation[] = [];
  if ((d.offline ?? 0) > 0) {
    recs.push({ severity: 'bad', text: `Investigate ${d.offline} offline device${d.offline === 1 ? '' : 's'} — offline endpoints are unmonitored and unpatched.` });
  }
  const unresolvedCritical = Math.max(0, (a.critical ?? 0) - (a.resolved ?? 0));
  if ((a.critical ?? 0) > 0) {
    recs.push({ severity: 'bad', text: `Triage the ${a.critical} critical alert${a.critical === 1 ? '' : 's'} raised in this reporting window${unresolvedCritical > 0 ? '' : ' (all resolved — verify root causes)'}.` });
  }
  if (a.resolutionRate != null && a.resolutionRate < 80 && (a.total ?? 0) > 0) {
    recs.push({ severity: 'warn', text: `Raise the alert resolution rate — ${a.resolutionRate}% of alerts were resolved against an 80% target.` });
  }
  if (d.healthPercentage != null && d.healthPercentage < 90 && (d.total ?? 0) > 0) {
    recs.push({ severity: 'warn', text: `Restore fleet health to 90%+ — ${d.healthPercentage}% of devices are currently online.` });
  }
  if ((a.high ?? 0) > 0) {
    recs.push({ severity: 'warn', text: `Review ${a.high} high-severity alert${a.high === 1 ? '' : 's'} for recurring patterns worth automating away.` });
  }
  return [...recs.filter((r) => r.severity === 'bad'), ...recs.filter((r) => r.severity === 'warn')];
}

function renderExecutiveSummaryCover(doc: jsPDF, summary: ExecutiveSummary, opts: BuildOpts): void {
  const d = summary.devices ?? {};
  const a = summary.alerts ?? {};
  const total = d.total ?? 0;

  let y = drawTitleBlock(
    doc,
    'Executive Summary',
    summary.org?.name ?? '',
    `Generated ${opts.generatedAt}   ·   ${total} managed device${total === 1 ? '' : 's'}`,
    PAGE.bandH + 8,
  );

  if (d.healthPercentage != null) {
    const offline = d.offline ?? 0;
    const stats: ScoreStat[] = [
      { label: 'Devices online', value: `${d.online ?? 0}/${total}`, tone: offline > 0 ? C.warning : C.success },
      { label: 'Critical alerts', value: String(a.critical ?? 0), tone: (a.critical ?? 0) > 0 ? C.danger : C.success },
      { label: 'Alerts resolved', value: a.resolutionRate == null ? 'N/A' : `${a.resolutionRate}%`, tone: (a.resolutionRate ?? 100) >= 80 ? C.success : C.warning },
    ];
    y = drawScorecard(doc, d.healthPercentage, 'Fleet health — share of managed devices online', stats, y);
    set.text(doc, C.faint);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text(
      'Fleet health: percentage of managed devices reporting online. Alert figures cover the configured reporting window.',
      PAGE.mx,
      y - 2.5,
    );
    y += 1.5;
  }

  const overviewHeadingY = y + 2;
  y = drawSectionHeading(doc, 'Fleet & alert overview', overviewHeadingY);
  drawLegend(doc, overviewHeadingY);
  // Left column: device availability. Right column: alert activity.
  // Column-major fill, so array order = reading order per column.
  const deviceMetrics: Metric[] = [
    { label: 'Managed devices', value: String(total), status: 'neutral' },
    { label: 'Online now', value: String(d.online ?? 0), status: pctStatus(d.healthPercentage) },
    { label: 'Offline', value: String(d.offline ?? 0), status: (d.offline ?? 0) > 0 ? 'warn' : 'good', target: 'none' },
    { label: 'Fleet health', value: d.healthPercentage == null ? 'N/A' : `${d.healthPercentage}%`, status: pctStatus(d.healthPercentage), target: '>=90%' },
  ];
  const alertMetrics: Metric[] = [
    { label: 'Alerts in window', value: String(a.total ?? 0), status: 'neutral' },
    { label: 'Critical', value: String(a.critical ?? 0), status: (a.critical ?? 0) > 0 ? 'bad' : 'good', target: 'none' },
    { label: 'High severity', value: String(a.high ?? 0), status: (a.high ?? 0) > 0 ? 'warn' : 'good', target: 'none' },
    { label: 'Resolution rate', value: a.resolutionRate == null ? 'N/A' : `${a.resolutionRate}%`, status: pctStatus(a.resolutionRate, 80, 50), target: '>=80%' },
  ];
  y = drawMetricGrid(doc, [...deviceMetrics, ...alertMetrics], y);

  // OS + site composition, side by side via the same two-column grid: left
  // column = OS distribution, right column = largest sites. Pad the shorter
  // list so column-major fill keeps each theme in its own column.
  const osEntries = Object.entries(summary.osDistribution ?? {});
  const sites = summary.siteBreakdown ?? [];
  if (osEntries.length > 0 || sites.length > 0) {
    y = drawSectionHeading(doc, 'Fleet composition', y + 2.5);
    const MAX_COMPOSITION_ROWS = 5;
    const osMetrics: Metric[] = osEntries
      .sort(([, x], [, z]) => z - x)
      .slice(0, MAX_COMPOSITION_ROWS)
      .map(([os, count]) => ({
        label: OS_LABELS[os.toLowerCase()] ?? titleCase(os),
        value: `${count} device${count === 1 ? '' : 's'}`,
        status: 'neutral' as MetricStatus,
      }));
    const shownSites = sites.slice(0, MAX_COMPOSITION_ROWS);
    const siteMetrics: Metric[] = shownSites.map((s) => ({
      label: s.site,
      value: `${s.count} device${s.count === 1 ? '' : 's'}`,
      status: 'neutral' as MetricStatus,
    }));
    if (sites.length > MAX_COMPOSITION_ROWS) {
      const rest = sites.slice(MAX_COMPOSITION_ROWS).reduce((acc, s) => acc + s.count, 0);
      siteMetrics[MAX_COMPOSITION_ROWS - 1] = {
        label: `${shownSites[MAX_COMPOSITION_ROWS - 1]!.site} + ${sites.length - MAX_COMPOSITION_ROWS} more`,
        value: `${(shownSites[MAX_COMPOSITION_ROWS - 1]!.count) + rest} devices`,
        status: 'neutral',
      };
    }
    const rows = Math.max(osMetrics.length, siteMetrics.length);
    const pad = (arr: Metric[]): Metric[] =>
      arr.concat(Array.from({ length: rows - arr.length }, () => ({ label: '', value: '', status: 'na' as MetricStatus })));
    y = drawMetricGrid(doc, [...pad(osMetrics), ...pad(siteMetrics)], y);
  }

  // Recommended actions close the page — the reader leaves with next steps.
  const recs = buildExecRecommendations(summary);
  if (recs.length > 0) {
    const rowH = 5.2;
    const maxY = PAGE.footY - 4;
    if (y + 5 + rowH <= maxY) {
      const fit = Math.min(recs.length, 5, Math.floor((maxY - y - 5) / rowH));
      y = drawSectionHeading(doc, 'Recommended actions', y + 2.5);
      doc.setFontSize(9);
      recs.slice(0, fit).forEach((rec, i) => {
        set.text(doc, rec.severity === 'bad' ? C.danger : C.warning);
        doc.setFont('helvetica', 'bold');
        doc.text(`${i + 1}.`, PAGE.mx + 1, y);
        set.text(doc, C.ink);
        doc.setFont('helvetica', 'normal');
        doc.text(rec.text, PAGE.mx + 6.5, y);
        y += rowH;
      });
    }
  }
}
```

  Note: padding cells with `label: ''` renders empty grid slots (hairline only) — acceptable; if it looks noisy in visual verification, suppress the separator for empty labels inside `drawMetricGrid` (`if (!m.label) return;` before drawing).

- [ ] **Step 3: Run shared tests** — expect PASS. Also `pnpm --filter web test src/components/reports` (download path already passes `summary` for every type — the old "harmless for other types" comment is now load-bearing; update it to say posture/exec covers consume it).

- [ ] **Step 4: Visual verification (headless harness).** Write a scratchpad script (Node, run from repo root) that imports the shared renderer, renders (a) the exec fixture above and (b) the posture fixture, writes PDFs, then `pdftoppm -png -r 80`. Read the PNGs and check: no overlapping sections, legend right-aligned, composition columns read as two themes, recommendations visible. Iterate until clean.

```bash
cd packages/shared && node --experimental-strip-types /private/tmp/claude-501/-Users-toddhebebrand-orca-workspaces-breeze-reports-pdf-enhanements/9becc41b-da35-41ee-99b0-88dd3dd306f0/scratchpad/renderExec.mts
pdftoppm -png -r 80 <out>.pdf <out>
```

- [ ] **Step 5: Commit** — `feat(reports): designed executive summary PDF cover (scorecard, composition, actions)`

---

### Task 6: Trend baselines — "score 79, up from 74 last month"

Runs already persist snapshots in `report_runs.result`. Attach the prior run's summary as `result.previous` at generation time (snapshot stays self-contained), and surface deltas in the scorecards and the scheduled email.

**Files:**
- Modify: `apps/api/src/services/reportGenerationService.ts` (type + helper), `apps/api/src/routes/reports/runs.ts` (POST generate), `apps/api/src/jobs/reportScheduleWorker.ts` (worker path + email line), `packages/shared/src/reportPdf/reportPdf.ts` (BuildOpts + scorecard trend), `apps/web/src/components/reports/ReportsList.tsx` + `apps/web/src/components/reports/reportExport.ts` (pass-through)
- Create: `apps/api/src/services/reportGenerationService.previous.test.ts`
- Modify tests: `packages/shared/src/reportPdf/reportPdf.test.ts`, `apps/api/src/jobs/reportScheduleWorker.test.ts`

**Interfaces:**
- Produces: `ReportResult.previous?: { generatedAt: string | null; summary?: Record<string, unknown> }`; `previousBaselineFor(reportId: string): Promise<ReportResult['previous']>` exported from `reportGenerationService.ts`; `BuildOpts.previous?: { generatedAt?: string | null; summary?: unknown }`; `drawScorecard` gains optional `trend` param.

- [ ] **Step 1: Failing helper test** — `reportGenerationService.previous.test.ts` (Drizzle mocks): prior completed run exists with `result: { summary: { postureScore: 74 }, generatedAt: '2026-06-01T09:00:00Z' }` → helper returns `{ generatedAt: '2026-06-01T09:00:00Z', summary: { postureScore: 74 } }`; no prior run → `undefined`; prior run without `summary` → `undefined`.

- [ ] **Step 2: Implement helper.** In `reportGenerationService.ts` add `reportRuns` to the schema import and `desc` is already imported:

```ts
export type ReportResult = {
  rows?: unknown[];
  rowCount?: number;
  summary?: Record<string, unknown>;
  generatedAt?: string;
  /** Slim baseline from the previous completed run of the same report, copied
   * into the snapshot at generation time so trend deltas ("79, up from 74")
   * render from the stored result alone. Only `summary` is copied — never
   * `previous` — so baselines don't chain. */
  previous?: { generatedAt: string | null; summary?: Record<string, unknown> };
};

/** Baseline from the most recent completed run of this report, if it captured
 * a summary. Call BEFORE marking the new run completed. */
export async function previousBaselineFor(reportId: string): Promise<ReportResult['previous']> {
  const [prior] = await db
    .select({ result: reportRuns.result, completedAt: reportRuns.completedAt })
    .from(reportRuns)
    .where(and(eq(reportRuns.reportId, reportId), eq(reportRuns.status, 'completed')))
    .orderBy(desc(reportRuns.completedAt))
    .limit(1);
  const priorResult = prior?.result as ReportResult | null | undefined;
  if (!priorResult?.summary || typeof priorResult.summary !== 'object') return undefined;
  return {
    generatedAt: priorResult.generatedAt ?? prior?.completedAt?.toISOString() ?? null,
    summary: priorResult.summary,
  };
}
```

(`and` is already imported in the service.)

- [ ] **Step 3: Wire both generation paths.** In `runs.ts` POST `/:id/generate`, after `const result = await generateReport(...)` add:

```ts
      const previous = await previousBaselineFor(report.id);
      if (previous) result.previous = previous;
```

(import `previousBaselineFor` beside `generateReport`). Same two lines in the worker's `processRunScheduledReport` after its `generateReport` call, and pass `previous: result.previous` into `emailReportRun`.

- [ ] **Step 4: Renderer deltas.** In `reportPdf.ts`:
  1. `BuildOpts` gains `previous?: { generatedAt?: string | null; summary?: unknown };`.
  2. `drawScorecard` signature gains a final optional param `trend?: { delta: number; sinceLabel: string } | null` and, after the band chip block, renders it:

```ts
  // Trend vs the previous run: "+5 since Jun 1" — the line that makes a
  // recurring report feel alive. Muted date; signed delta carries the colour.
  if (trend && trend.delta !== 0) {
    const up = trend.delta > 0;
    set.text(doc, up ? C.success : C.danger);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    const deltaStr = `${up ? '▲' : '▼'} ${up ? '+' : ''}${trend.delta}`;
    const chipRight = x + 10 + chipW;
    doc.text(deltaStr, chipRight + 4, top + 27.8);
    set.text(doc, C.muted);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(trend.sinceLabel, chipRight + 4 + doc.getTextWidth(deltaStr) + 2, top + 27.8);
  }
```

  (`chipW` is in scope in `drawScorecard`. If jsPDF's helvetica lacks the ▲/▼ glyphs — check the rendered PNG in Step 7 — use `'+5'`/`'-3'` alone.)
  3. Add a small helper + use it in both covers:

```ts
function trendFor(opts: BuildOpts, current: number | null | undefined, pick: (s: Record<string, unknown>) => unknown): { delta: number; sinceLabel: string } | null {
  const prevSummary = opts.previous?.summary;
  if (current == null || !prevSummary || typeof prevSummary !== 'object') return null;
  const prevRaw = pick(prevSummary as Record<string, unknown>);
  const prev = typeof prevRaw === 'number' ? prevRaw : null;
  if (prev == null) return null;
  let since = 'vs previous run';
  const iso = opts.previous?.generatedAt;
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      since = `since ${new Intl.DateTimeFormat('en-US', { timeZone: opts.timezone, month: 'short', day: 'numeric' }).format(d)}`;
    }
  }
  return { delta: current - prev, sinceLabel: since };
}
```

  Posture cover: `y = drawScorecard(doc, summary.postureScore, caption, stats, y, trendFor(opts, summary.postureScore, (s) => (s as { postureScore?: unknown }).postureScore));`
  Exec cover: `y = drawScorecard(doc, d.healthPercentage, '...', stats, y, trendFor(opts, d.healthPercentage, (s) => ((s as { devices?: { healthPercentage?: unknown } }).devices ?? {}).healthPercentage));`

  4. Renderer test: posture fixture + `previous: { generatedAt: '2026-06-01T00:00:00Z', summary: { postureScore: 74 } }` renders without throwing and byte size exceeds the no-trend render (the delta text adds content).

- [ ] **Step 5: Email trend line.** In the worker, build a summary line and prepend it to the email body when available:

```ts
function trendLineOf(result: ReportResult): string | null {
  const s = result.summary as Record<string, unknown> | undefined;
  const prev = result.previous?.summary as Record<string, unknown> | undefined;
  const score = typeof s?.postureScore === 'number' ? (s.postureScore as number) : null;
  if (score != null) {
    const prevScore = typeof prev?.postureScore === 'number' ? (prev.postureScore as number) : null;
    if (prevScore != null && prevScore !== score) {
      return `Posture score ${score} — ${score > prevScore ? 'up' : 'down'} from ${prevScore} last run.`;
    }
    return `Posture score ${score}.`;
  }
  const health = (s?.devices as { healthPercentage?: unknown } | undefined)?.healthPercentage;
  if (typeof health === 'number') {
    const prevHealth = (prev?.devices as { healthPercentage?: unknown } | undefined)?.healthPercentage;
    if (typeof prevHealth === 'number' && prevHealth !== health) {
      return `Fleet health ${health}% — ${health > prevHealth ? 'up' : 'down'} from ${prevHealth}% last run.`;
    }
    return `Fleet health ${health}%.`;
  }
  return null;
}
```

  `emailReportRun` gains `previous`/`summary` already (Task 3); pass the whole `result` or add `trendLine: trendLineOf(result)` and render it as an extra `renderParagraph` (and a line in `text:`). Worker test: posture run with previous → `sendEmailMock` html contains `up from 74`.

- [ ] **Step 6: Web pass-through.** `reportExport.ts`: `exportReport` opts gain `previous?: { generatedAt?: string | null; summary?: unknown }` and forward to `buildReportPdf`. `ReportsList.tsx` `handleDownload`: `const data = payload.data as { rows?: unknown[]; summary?: unknown; previous?: { generatedAt?: string | null; summary?: unknown } } | undefined;` and pass `previous: data?.previous`.

- [ ] **Step 7: Run all touched suites + visual check.** API service/worker tests, shared renderer tests, web reports tests. Re-run the Step-4/Task-5 harness with a `previous` baseline in the fixture and Read the PNG: delta chip sits beside the band chip without collision; glyphs render (else switch to `+5`).

- [ ] **Step 8: Commit** — `feat(reports): trend baselines in run snapshots, scorecard deltas, email trend line`

---

### Task 7: Next-run + recipients in ReportsList

Users can set a cadence but can't see when it fires next or who receives it. Both are derivable client-side: next run from `schedule` + `config.schedule` (the list endpoint returns full rows including `config`), recipients from `config.emailRecipients`.

**Files:**
- Create: `packages/shared/src/utils/reportSchedule.ts`, `packages/shared/src/utils/reportSchedule.test.ts`
- Modify: `packages/shared/src/utils/index.ts` (add `export * from './reportSchedule';`), `apps/api/src/jobs/reportScheduleWorker.ts` (delete local math, re-import), `apps/web/src/components/reports/ReportsList.tsx`

**Interfaces:**
- Produces: in `@breeze/shared`: `type ScheduleCadence`, `type ScheduleConfig`, `wallClockIn`, `lastOccurrenceKey`, `isDue`, plus new `nextOccurrence(now: Date, cadence: ScheduleCadence, cfg: ScheduleConfig, timeZone: string): { y: number; m: number; d: number; hh: number; mm: number }` and `formatNextOccurrence(occ, opts?: { weekday?: boolean }): string` (e.g. "Mon, Jul 6, 9:00 AM").
- The worker re-exports `wallClockIn`, `lastOccurrenceKey`, `isDue`, `ScheduleCadence`, `ScheduleConfig` so `reportScheduleWorker.test.ts` keeps importing them from `./reportScheduleWorker` unchanged.

- [ ] **Step 1: Move the math.** Cut from `reportScheduleWorker.ts` the block from `export type ScheduleCadence` down through `isDue` (lines ~61-183: `ScheduleCadence`, `ScheduleConfig`, `DAY_INDEX`, `WEEKDAY_SHORT_INDEX`, `WallClock`, `wallClockIn`, `keyOf`, `shiftDays`, `daysInMonth`, `parseTime`, `lastOccurrenceKey`, `isDue`) into `packages/shared/src/utils/reportSchedule.ts` verbatim (keep the "Occurrence math" comment block). In the worker replace with:

```ts
import {
  lastOccurrenceKey,
  isDue,
  type ScheduleCadence,
  type ScheduleConfig,
} from '@breeze/shared';

// Re-exported so the occurrence-math tests colocated with this worker keep
// importing from here; the implementation lives in @breeze/shared so the web
// can compute "next run" from the same math.
export { lastOccurrenceKey, isDue, wallClockIn } from '@breeze/shared';
export type { ScheduleCadence, ScheduleConfig } from '@breeze/shared';
```

(dedupe: one import for use + one re-export is fine, or `export *`-style named re-export only — implementer's choice, keep `tsc` happy.)

- [ ] **Step 2: Add the forward math + formatter** to `reportSchedule.ts`:

```ts
/**
 * The next scheduled occurrence strictly after `now`, as wall-clock parts in
 * `timeZone`. Forward mirror of lastOccurrenceKey — used by the web to show
 * "Next: Mon, Jul 6, 9:00 AM" without inverse-timezone math (the parts are
 * formatted directly, never converted back to an instant).
 */
export function nextOccurrence(
  now: Date,
  cadence: ScheduleCadence,
  cfg: ScheduleConfig,
  timeZone: string,
): { y: number; m: number; d: number; hh: number; mm: number } {
  const nowWc = wallClockIn(now, timeZone);
  const nowKey = keyOf(nowWc.y, nowWc.m, nowWc.d, nowWc.hh, nowWc.mm);
  const { hh, mm } = parseTime(cfg.time);

  if (cadence === 'daily') {
    let day = { y: nowWc.y, m: nowWc.m, d: nowWc.d };
    if (keyOf(day.y, day.m, day.d, hh, mm) <= nowKey) day = shiftDays(day.y, day.m, day.d, 1);
    return { ...day, hh, mm };
  }

  if (cadence === 'weekly') {
    const target = DAY_INDEX[(cfg.day ?? 'monday').toLowerCase()] ?? 1;
    const delta = (target - nowWc.weekday + 7) % 7;
    let day = shiftDays(nowWc.y, nowWc.m, nowWc.d, delta);
    if (keyOf(day.y, day.m, day.d, hh, mm) <= nowKey) day = shiftDays(day.y, day.m, day.d, 7);
    return { ...day, hh, mm };
  }

  // monthly
  const wanted = Math.max(1, Math.min(31, Number(cfg.date) || 1));
  let y = nowWc.y;
  let m = nowWc.m;
  let d = Math.min(wanted, daysInMonth(y, m));
  if (keyOf(y, m, d, hh, mm) <= nowKey) {
    m += 1;
    if (m === 13) { m = 1; y += 1; }
    d = Math.min(wanted, daysInMonth(y, m));
  }
  return { y, m, d, hh, mm };
}

/** Format wall-clock occurrence parts as a display label ("Mon, Jul 6, 9:00 AM").
 * The parts are already in the schedule's timezone, so format them as UTC to
 * avoid any further conversion. */
export function formatNextOccurrence(
  occ: { y: number; m: number; d: number; hh: number; mm: number },
  opts?: { weekday?: boolean },
): string {
  const instant = new Date(Date.UTC(occ.y, occ.m - 1, occ.d, occ.hh, occ.mm));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    ...(opts?.weekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}
```

- [ ] **Step 3: Shared tests** — `reportSchedule.test.ts`: port two or three `lastOccurrenceKey` sanity cases from the worker test (they now live in shared as the canonical home; leave the worker's copies in place — they still pass via re-export) and add `nextOccurrence` cases: daily before/after today's time (2026-07-01T14:00Z, 'UTC', time 16:00 → same day; time 09:00 → Jul 2); weekly wrap (Wednesday now, target monday → Jul 6); monthly clamp (date '31' in June → Jun 30... use: now 2026-06-15, date '31' → {m: 6, d: 30}); year wrap (now 2026-12-20, monthly date '1' → 2027-01-01); `formatNextOccurrence({ y: 2026, m: 7, d: 6, hh: 9, mm: 0 }, { weekday: true })` → `'Mon, Jul 6, 9:00 AM'`. Run shared tests AND `pnpm --filter @breeze/api test src/jobs/reportScheduleWorker.test.ts` (re-exports must keep it green).

- [ ] **Step 4: ReportsList UI.** In `ReportsList.tsx`: import `Mail` from lucide, and `import { nextOccurrence, formatNextOccurrence, type ScheduleCadence, type ScheduleConfig } from '@breeze/shared';`. Add helpers above the component:

```ts
function scheduleConfigOf(config: Record<string, unknown> | undefined): ScheduleConfig {
  const raw = config?.schedule;
  return raw && typeof raw === 'object' ? (raw as ScheduleConfig) : {};
}

function recipientCountOf(config: Record<string, unknown> | undefined): number {
  const raw = config?.emailRecipients;
  return Array.isArray(raw) ? raw.filter((r) => typeof r === 'string' && r.trim() !== '').length : 0;
}
```

In the Schedule `<td>` (currently just the pill), render for recurring reports a second muted line. The next run is computed in the viewer's timezone — the worker fires in the org's timezone, so this is a close approximation, not a contract (note it in a code comment):

```tsx
<td className="px-4 py-3">
  <span className={cn(/* existing pill unchanged */)}>
    <Calendar className="h-3 w-3" />
    {scheduleLabels[report.schedule]}
  </span>
  {report.schedule !== 'one_time' && (
    <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        Next: {formatNextOccurrence(
          nextOccurrence(new Date(), report.schedule as ScheduleCadence, scheduleConfigOf(report.config), effectiveTimezone),
          { weekday: report.schedule === 'weekly' }
        )}
      </span>
      {recipientCountOf(report.config) > 0 && (
        <span className="inline-flex items-center gap-1" title="Email recipients">
          <Mail className="h-3 w-3" />
          {recipientCountOf(report.config)}
        </span>
      )}
    </p>
  )}
</td>
```

- [ ] **Step 5: Web test.** Extend an existing ReportsList test file (or add `ReportsList.schedule.test.tsx` following `ReportsList.templates.test.tsx`'s fetch-mock setup): a monthly report with `config: { schedule: { time: '09:00', date: '1' }, emailRecipients: ['a@b.co', 'second@example.com'] }` renders text matching `/Next: .+/` and the recipient count `2`; a `one_time` report renders no "Next:" line. Run web reports tests.

- [ ] **Step 6: Commit** — `feat(reports): next-run time and recipient count on report rows`

---

### Task 8: Partner-level cross-org reports — design doc (no implementation)

Bigger lift (new scope axis; partner-wide-first principle applies). Produce the design pass as its own doc for a follow-up PR.

**Files:**
- Create: `docs/superpowers/plans/open/2026-07-01-partner-level-reports-design.md`

- [ ] **Step 1: Write the design doc** covering, concretely against current code:
  - **Problem:** `reports.orgId` is NOT NULL; partner users only get per-org reports. The MSP-shaped gap is a fleet-wide roll-up — one posture/patch table comparing all their client orgs (the report that sells the MSP's value upward).
  - **Ownership axis:** follow the config-policy dual-owner precedent (`apps/api/src/db/schema/configurationPolicies.ts:64-81`): make `org_id` nullable, add nullable `partner_id` + one-owner CHECK constraint + indexes, migration `2026-07-XX-partner-owned-reports.sql` (idempotent). RLS: reports currently rides shape-1 auto-discovery on `org_id`; dual-owner needs the shape-4-style `breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)` policy pair and an entry in the RLS contract-test allowlists — call out the FK-child and dual-axis contract blindspots explicitly.
  - **Report types:** new `fleet_posture_rollup` (and later `fleet_patch_rollup`) enum values; generator loops the partner's orgs (`organizations WHERE partner_id = $1`), reuses `generateSecurityCompliancePostureReport` per org under system context, and emits one row per org (`org, devices, postureScore, unprotected, criticalFindings, patchCurrentPct, …`) plus a partner-level summary (weighted average score, best/worst org). Renderer: one new cover in `@breeze/shared/reportPdf` reusing the scorecard + a per-ORG (not per-device) table; trend baselines from Task 6 apply unchanged.
  - **Routes:** create accepts `ownerScope: 'partner'` with partner id derived from `auth.partnerId` (never client-supplied) and requires `orgAccess === 'all'` (mirror `configurationPolicies/crud.ts:57-105`); list/get/runs branch on owner axis; the schedule worker's due-query needs a partner-timezone branch for org-less reports.
  - **Web:** `isPartnerScope` gate (`getJwtClaims()` pattern from `ConfigPolicyCreatePage.tsx:41-46`); builder gets an owner-scope selector shown only to partner-scope users; ReportsList badges partner-wide rows.
  - **Cost note:** rollup fans out one posture generation per org — enqueue as a normal scheduled run (BullMQ concurrency 2 already throttles); cap orgs per rollup initially (e.g. 100) and log truncation.
  - **Open questions:** per-org site filters in rollups (skip v1); org-level users must never see partner rollups (RLS + route double-gate); does the rollup email attach one PDF (yes — single artifact is the point).

- [ ] **Step 2: Commit** — `docs(reports): design pass for partner-level cross-org reports`

---

### Task 9: Full verification sweep

- [ ] **Step 1:** `pnpm --filter @breeze/shared test && pnpm --filter @breeze/shared typecheck`
- [ ] **Step 2:** `pnpm --filter @breeze/api test src/routes/reports src/jobs/reportScheduleWorker.test.ts src/services/reportGenerationService.execSummary.test.ts src/services/reportGenerationService.previous.test.ts src/services/reportBranding.test.ts && pnpm --filter @breeze/api typecheck && pnpm --filter @breeze/api build`
- [ ] **Step 3:** web: reports component tests + `pnpm --filter web typecheck` (or the repo's `astro check` equivalent — remember tsc skips `.astro`; the Type Check CI job includes test files).
- [ ] **Step 4:** End-to-end headless render: posture WITH previous baseline + branding, exec summary WITH previous, generic report — `pdftoppm` each and visually Read every page (logo chip, delta chip, composition grids, footer attribution).
- [ ] **Step 5:** Fix anything found; final commit.
