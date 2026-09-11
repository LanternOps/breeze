# Customer Portal Visibility — Wave 1 Plan, Part A (W01–W03: trust hazards, foundation, gating)

> Part of `docs/superpowers/plans/portal/2026-09-02-portal-visibility-wave1.md` — read that file's **Global Constraints** and **File Structure** first; every task below inherits them. Spec: `docs/superpowers/specs/portal/2026-09-02-portal-visibility-wave1-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

---

## Wave W01 — Remove misleading report surfaces

### Task 1.1: Remove the four aliased report-template cards

**Files:**

- **Modify:** `apps/web/src/components/reports/ReportTemplates.tsx:1-14,57-71,76-239`
- **Modify:** `apps/web/src/components/reports/ReportTemplates.posture.test.tsx:1-31,48-150`
- **Modify:** `apps/web/src/locales/en/reports.json:852-879`
- **Modify:** `apps/web/src/locales/de-DE/reports.json:852-879`
- **Modify:** `apps/web/src/locales/es-419/reports.json:852-879`
- **Modify:** `apps/web/src/locales/fr-CA/reports.json:852-879`
- **Modify:** `apps/web/src/locales/fr-FR/reports.json:852-879`
- **Modify:** `apps/web/src/locales/it-IT/reports.json:190-196`
- **Modify:** `apps/web/src/locales/pt-BR/reports.json:852-879`
- **Modify:** `apps/web/src/locales/tr-TR/reports.json:852-879`
- **Test:** `apps/web/src/components/reports/ReportTemplates.posture.test.tsx`
- **Test:** `apps/web/src/lib/i18n/localeParity.test.ts`
- **Test:** `apps/web/src/lib/i18n/translationCoverage.test.ts`

**Interfaces:**

- **Consumes:** Existing `TemplateReportType = ReportBuilderFormValues['type']` values accepted by `ReportTemplates`.
- **Produces:** The template gallery exposes only report types backed by their own implementation; retained aliases are exactly:
  ```ts
  const typeAliases: Record<string, TemplateReportType> = {
    device_health: 'performance',
    alert_summary: 'alert_summary'
  };
  ```

- [ ] **Step 1: Write the failing template-card regression test.**

  Add to `apps/web/src/components/reports/ReportTemplates.posture.test.tsx`:

  ```tsx
  it('does not advertise report templates that alias unrelated report types', async () => {
    mockTemplatesFetch(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    render(<ReportTemplates />);

    expect(await screen.findByText('Executive Summary')).toBeInTheDocument();
    expect(screen.queryByText('Patch Compliance Report')).not.toBeInTheDocument();
    expect(screen.queryByText('Technician Activity Report')).not.toBeInTheDocument();
    expect(screen.queryByText('SLA Compliance Report')).not.toBeInTheDocument();
    expect(screen.queryByText('Billing/Usage Report')).not.toBeInTheDocument();
  });
  ```

  Keep this test in the existing file, after its hoisted `fetchWithAuth`, `useOrgStore`, `navigateTo`, and `showToast` mocks and the `mockTemplatesFetch` helper. The neighboring `beforeEach` already clears mocks and restores `currentOrgId = 'org-1'`.

- [ ] **Step 2: Run the focused test and confirm the four alias cards are still rendered.**

  ```bash
  cd apps/web && npx vitest run src/components/reports/ReportTemplates.posture.test.tsx
  ```

  Expected failure: `queryByText` finds Patch Compliance Report, Technician Activity Report, SLA Compliance Report, and Billing/Usage Report.

- [ ] **Step 3: Delete the four cards, their aliases, unused icons, and their locale objects.**

  In `ReportTemplates.tsx`, remove the `CreditCard`, `Timer`, and `Users` imports. Delete the four objects below from the real `defaultTemplates: ReportTemplate[]` registry; keep the `security_compliance_posture`, `executive_summary`, `device_health`, and `alert_summary` objects unchanged:

  ```tsx
  {
    id: 'patch_compliance',
    name: 'Patch Compliance Report',
    description: 'Patch coverage, overdue updates, and remediation status.',
    defaults: {
      name: 'Patch Compliance Report',
      type: 'compliance',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: ShieldCheck,
    tone: {
      iconBg: 'bg-amber-500/15',
      iconColor: 'text-amber-600'
    }
  }

  {
    id: 'technician_activity',
    name: 'Technician Activity Report',
    description: 'Ticket volume, device touches, and resolution velocity.',
    defaults: {
      name: 'Technician Activity Report',
      type: 'device_inventory',
      dateRange: { preset: 'last_30_days' },
      schedule: 'weekly',
      format: 'csv'
    },
    icon: Users,
    tone: {
      iconBg: 'bg-teal-500/15',
      iconColor: 'text-teal-600'
    }
  }

  {
    id: 'sla_compliance',
    name: 'SLA Compliance Report',
    description: 'SLA adherence, breach risk, and response timelines.',
    defaults: {
      name: 'SLA Compliance Report',
      type: 'compliance',
      dateRange: { preset: 'last_90_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: Timer,
    tone: {
      iconBg: 'bg-blue-500/15',
      iconColor: 'text-blue-600'
    }
  }

  {
    id: 'billing_usage',
    name: 'Billing/Usage Report',
    description: 'License utilization, usage tiers, and chargeback summaries.',
    defaults: {
      name: 'Billing/Usage Report',
      type: 'software_inventory',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'excel'
    },
    icon: CreditCard,
    tone: {
      iconBg: 'bg-orange-500/15',
      iconColor: 'text-orange-600'
    }
  }
  ```

  Reduce the real alias map to:

  ```ts
  const typeAliases: Record<string, TemplateReportType> = {
    device_health: 'performance',
    alert_summary: 'alert_summary'
  };
  ```

  Delete the `billing_usage`, `patch_compliance`, `sla_compliance`, and `technician_activity` keyed objects from `reports.reportTemplates.templates` in every listed `reports.json` file. The English objects are:

  ```json
  {
    "billing_usage": {
      "description": "License utilization, usage tiers, and chargeback summaries.",
      "name": "Billing/Usage Report"
    },
    "patch_compliance": {
      "description": "Patch coverage, overdue updates, and remediation status.",
      "name": "Patch Compliance Report"
    },
    "sla_compliance": {
      "description": "SLA adherence, breach risk, and response timelines.",
      "name": "SLA Compliance Report"
    },
    "technician_activity": {
      "description": "Ticket volume, device touches, and resolution velocity.",
      "name": "Technician Activity Report"
    }
  }
  ```

  Delete the same four keys with their translated `description` and `name` values from the other seven locales; `it-IT/reports.json` stores these objects on single lines.

- [ ] **Step 4: Run the component and locale suites green.**

  ```bash
  cd apps/web && npx vitest run src/components/reports/ReportTemplates.posture.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
  ```

  Expected result: the remaining report cards render, all four misleading cards are absent, and locale parity remains exact.

- [ ] **Step 5: Commit the report-template cleanup.**

  ```bash
  git add apps/web/src/components/reports/ReportTemplates.tsx apps/web/src/components/reports/ReportTemplates.posture.test.tsx apps/web/src/locales/*/reports.json && git commit -m "fix(portal): remove aliased report templates"
  ```

### Task 1.2: Remove the two unmounted hard-coded compliance reports

**Files:**

- **Modify:** `apps/web/src/components/software/index.ts:1-7`
- **Delete:** `apps/web/src/components/software/SoftwareComplianceReport.tsx`
- **Modify:** `apps/web/src/components/audit/index.ts:1-6`
- **Delete:** `apps/web/src/components/audit/ComplianceReport.tsx`
- **Modify:** `apps/web/src/locales/en/policies.json:1632-1645`
- **Modify:** `apps/web/src/locales/de-DE/policies.json:1632-1645`
- **Modify:** `apps/web/src/locales/es-419/policies.json:1632-1645`
- **Modify:** `apps/web/src/locales/fr-CA/policies.json:1632-1645`
- **Modify:** `apps/web/src/locales/fr-FR/policies.json:1632-1645`
- **Modify:** `apps/web/src/locales/it-IT/policies.json:1632-1645`
- **Modify:** `apps/web/src/locales/pt-BR/policies.json:1632-1645`
- **Modify:** `apps/web/src/locales/tr-TR/policies.json:1632-1645`
- **Modify:** `apps/web/src/locales/en/admin.json:692-765`
- **Modify:** `apps/web/src/locales/de-DE/admin.json:692-765`
- **Modify:** `apps/web/src/locales/es-419/admin.json:692-765`
- **Modify:** `apps/web/src/locales/fr-CA/admin.json:692-765`
- **Modify:** `apps/web/src/locales/fr-FR/admin.json:692-765`
- **Modify:** `apps/web/src/locales/it-IT/admin.json:692-765`
- **Modify:** `apps/web/src/locales/pt-BR/admin.json:692-765`
- **Modify:** `apps/web/src/locales/tr-TR/admin.json:692-765`
- **Create:** `apps/web/src/components/reports/noHardcodedComplianceReports.test.ts`
- **Test:** `apps/web/src/components/reports/noHardcodedComplianceReports.test.ts`
- **Test:** `apps/web/src/lib/i18n/localeParity.test.ts`
- **Test:** `apps/web/src/lib/i18n/translationCoverage.test.ts`

**Interfaces:**

- **Consumes:** Real mounted replacements:
  - `SoftwareCatalog` from `apps/web/src/pages/software/index.astro:1-8`
  - `SoftwarePage` from `apps/web/src/pages/software-inventory/index.astro:1-8`
  - `SoftwarePage defaultTab="policies"` from `apps/web/src/pages/software-policies/index.astro:1-8`
  - `AuditLogViewer` from `apps/web/src/pages/audit/index.astro:1-8`
- **Produces:** Neither deleted component remains exported or mountable. No replacement query is required because repository search shows neither component has a page or route mount.

- [ ] **Step 1: Add a source-level regression test proving the dead exports and literal datasets are absent.**

  Create `apps/web/src/components/reports/noHardcodedComplianceReports.test.ts`:

  ```ts
  import { readFileSync } from 'node:fs';
  import { resolve } from 'node:path';
  import { describe, expect, it } from 'vitest';

  const sourceRoot = resolve(process.cwd(), 'src/components');

  describe('hard-coded compliance report surfaces', () => {
    it('does not export the unmounted software compliance report', () => {
      const barrel = readFileSync(
        resolve(sourceRoot, 'software/index.ts'),
        'utf8',
      );

      expect(barrel).not.toContain('SoftwareComplianceReport');
    });

    it('does not export the unmounted audit compliance report', () => {
      const barrel = readFileSync(
        resolve(sourceRoot, 'audit/index.ts'),
        'utf8',
      );

      expect(barrel).not.toContain('ComplianceReport');
    });

    it('does not retain the literal report components', () => {
      expect(() =>
        readFileSync(
          resolve(sourceRoot, 'software/SoftwareComplianceReport.tsx'),
          'utf8',
        ),
      ).toThrow();

      expect(() =>
        readFileSync(
          resolve(sourceRoot, 'audit/ComplianceReport.tsx'),
          'utf8',
        ),
      ).toThrow();
    });
  });
  ```

- [ ] **Step 2: Run the focused test and confirm both barrel exports and files still exist.**

  ```bash
  cd apps/web && npx vitest run src/components/reports/noHardcodedComplianceReports.test.ts
  ```

  Expected failure: both barrels still contain the component names, and both files can still be read.

- [ ] **Step 3: Remove the files, barrel exports, and now-unused locale namespaces.**

  Remove this export from `apps/web/src/components/software/index.ts`:

  ```ts
  export { default as SoftwareComplianceReport } from './SoftwareComplianceReport';
  ```

  Remove this export from `apps/web/src/components/audit/index.ts`:

  ```ts
  export { default as ComplianceReport } from './ComplianceReport';
  ```

  Delete:

  ```text
  apps/web/src/components/software/SoftwareComplianceReport.tsx
  apps/web/src/components/audit/ComplianceReport.tsx
  ```

  Delete the complete `software.softwareComplianceReport` object from every listed `policies.json` locale, and delete the complete `audit.complianceReport` object from every listed `admin.json` locale.

  Preserve the real mounted pages and their API-backed components unchanged:

  ```text
  apps/web/src/pages/software/index.astro
  apps/web/src/pages/software-inventory/index.astro
  apps/web/src/pages/software-policies/index.astro
  apps/web/src/pages/audit/index.astro
  ```

- [ ] **Step 4: Run the regression and locale suites green.**

  ```bash
  cd apps/web && npx vitest run src/components/reports/noHardcodedComplianceReports.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
  ```

  Expected result: the obsolete files and exports are absent, and all eight locales retain identical key sets.

- [ ] **Step 5: Commit the dead-surface removal.**

  ```bash
  git add apps/web/src/components/software apps/web/src/components/audit apps/web/src/components/reports/noHardcodedComplianceReports.test.ts apps/web/src/locales/*/policies.json apps/web/src/locales/*/admin.json && git commit -m "fix(portal): remove hard-coded compliance reports"
  ```

## Wave W02 — Establish portal visibility read-model foundations

### Task 2.1: Define the shared portal visibility DTO contract

**Files:**

- **Create:** `packages/shared/src/types/portalVisibility.ts`
- **Create:** `packages/shared/src/types/portalVisibility.test.ts`
- **Modify:** `packages/shared/src/types/index.ts:803-833`
- **Test:** `packages/shared/src/types/portalVisibility.test.ts`

**Interfaces:**

- **Consumes:** Existing report status and device identifiers serialized by the API.
- **Produces:** `TileStatus`, `DashboardDto`, `SecurityOverviewDto`, `SecurityDeviceRow`, `BackupOverviewDto`, `BackupDeviceRow`, `SupportUsageDto`, `SlaDto`, `PortalRunDto`, and `EnrichedPortalDevice`.

- [ ] **Step 1: Write the failing type-contract test.**

  Create `packages/shared/src/types/portalVisibility.test.ts`:

  ```ts
  import { describe, expect, expectTypeOf, it } from 'vitest';
  import type {
    BackupDeviceRow,
    BackupOverviewDto,
    DashboardDto,
    EnrichedPortalDevice,
    PortalRunDto,
    SecurityDeviceRow,
    SecurityOverviewDto,
    SlaDto,
    SupportUsageDto,
    TileStatus,
  } from './portalVisibility';

  describe('portal visibility DTOs', () => {
    it('keeps tile and protection states closed unions', () => {
      expectTypeOf<TileStatus>().toEqualTypeOf<
        'ok' | 'no_data' | 'not_configured' | 'stale'
      >();

      expectTypeOf<SecurityDeviceRow['protection']>().toEqualTypeOf<
        'protected' | 'unprotected' | 'unknown'
      >();

      expectTypeOf<SlaDto['status']>().toEqualTypeOf<
        | 'breached'
        | 'at_risk'
        | 'paused'
        | 'on_track'
        | 'met'
        | 'not_configured'
      >();
    });

    it('exports every approved top-level DTO', () => {
      expectTypeOf<DashboardDto>().toBeObject();
      expectTypeOf<SecurityOverviewDto>().toBeObject();
      expectTypeOf<SecurityDeviceRow>().toBeObject();
      expectTypeOf<BackupOverviewDto>().toBeObject();
      expectTypeOf<BackupDeviceRow>().toBeObject();
      expectTypeOf<SupportUsageDto>().toBeObject();
      expectTypeOf<SlaDto>().toBeObject();
      expectTypeOf<PortalRunDto>().toBeObject();
      expectTypeOf<EnrichedPortalDevice>().toBeObject();

      const status: TileStatus = 'no_data';
      expect(status).toBe('no_data');
    });
  });
  ```

- [ ] **Step 2: Run the test and confirm the module cannot be resolved.**

  ```bash
  cd packages/shared && npx vitest run src/types/portalVisibility.test.ts
  ```

  Expected failure: `./portalVisibility` and its exported DTOs do not exist.

- [ ] **Step 3: Add the complete shared DTO module and barrel export.**

  Create `packages/shared/src/types/portalVisibility.ts`:

  ```ts
  export type TileStatus =
    | 'ok'
    | 'no_data'
    | 'not_configured'
    | 'stale';

  export type SecurityScoreBand =
    | 'strong'
    | 'good'
    | 'fair'
    | 'at_risk';

  export interface PaginationDto {
    page: number;
    limit: number;
    total: number;
  }

  export interface CountHoursDto {
    minutes: number;
    hours: number;
  }

  export interface SecurityScoreTileDto {
    status: TileStatus;
    score: number | null;
    band: SecurityScoreBand | null;
    delta30d: number | null;
    capturedAt: string | null;
  }

  export interface DevicesProtectedTileDto {
    status: TileStatus;
    protected: number | null;
    unprotected: number | null;
    unknown: number | null;
    total: number | null;
    asOf: string | null;
  }

  export interface PatchesAppliedTileDto {
    status: TileStatus;
    applied: number | null;
    devicesWithOutstandingCritical: number | null;
    month: string;
    timezone: string;
    asOf: string;
  }

  export interface BackupTileDto {
    status: TileStatus;
    completedAt: string | null;
    verificationType: string | null;
    configured: number | null;
    total: number | null;
    asOf: string;
  }

  export interface SupportTileDto {
    status: TileStatus;
    openTickets: number | null;
    averageFirstResponseMinutes: number | null;
    sampleSize: number;
    month: string;
    timezone: string;
    asOf: string;
  }

  export interface ActionItemsTileDto {
    status: TileStatus;
    count: number | null;
    topIssues: string[];
    asOf: string;
  }

  export interface AwaitingYouTileDto {
    status: TileStatus;
    proposals: number | null;
    invoices: number | null;
    asOf: string;
  }

  export interface DashboardDto {
    asOf: string;
    timezone: string;
    securityScore: SecurityScoreTileDto;
    devicesProtected: DevicesProtectedTileDto;
    patchesApplied: PatchesAppliedTileDto;
    backup: BackupTileDto;
    support: SupportTileDto;
    actionItems: ActionItemsTileDto;
    awaitingYou: AwaitingYouTileDto;
  }

  export interface SecurityTrendPoint {
    capturedAt: string;
    score: number;
  }

  export interface ThreatSourceCounts {
    native: number;
    sentinelOne: number;
    huntress: number;
  }

  export interface ThreatWeekDto {
    weekStart: string;
    detected: number;
    resolved: number;
    detectedBySource: ThreatSourceCounts;
    resolvedBySource: ThreatSourceCounts;
  }

  export interface SecurityOverviewDto {
    dataStatus: TileStatus;
    asOf: string;
    score: number | null;
    band: SecurityScoreBand | null;
    scoreHistory: SecurityTrendPoint[];
    threatEvents: {
      label: 'endpoint threat events';
      weeks: ThreatWeekDto[];
    };
    vulnerabilities: {
      openBySeverity: Record<string, number>;
      kevCount: number;
      lastDetectedAt: string | null;
    };
  }

  export interface SecurityDeviceRow {
    id: string;
    name: string;
    protection: 'protected' | 'unprotected' | 'unknown';
    avProducts: string[];
    realTimeProtection: boolean | null;
    definitionsAgeDays: number | null;
    encryption: string | null;
    firewall: boolean | null;
    pendingCriticalPatches: number;
    observedAt: string | null;
  }

  export interface SecurityDevicesDto {
    dataStatus: TileStatus;
    asOf: string;
    data: SecurityDeviceRow[];
    pagination: PaginationDto;
  }

  export interface BackupDeviceRow {
    id: string;
    name: string;
    configured: boolean;
    lastRestorePointAt: string | null;
    lastRestorePointDegraded: boolean;
    lastTestRestore: {
      status: string;
      completedAt: string | null;
      restoreTimeSeconds: number | null;
    } | null;
    openBreaches: string[];
    readinessScore: number | null;
    estimatedRtoMinutes: number | null;
    estimatedRpoMinutes: number | null;
  }

  export interface BackupOverviewDto {
    dataStatus: TileStatus;
    asOf: string;
    protected: number | null;
    unprotected: number | null;
    total: number | null;
    lastPassedVerification: {
      completedAt: string;
      verificationType: string;
    } | null;
    lastTestRestoreAt: string | null;
    openRpoBreaches: number | null;
    openRtoBreaches: number | null;
    meanReadinessScore: number | null;
  }

  export interface BackupDevicesDto {
    dataStatus: TileStatus;
    asOf: string;
    data: BackupDeviceRow[];
    pagination: PaginationDto;
  }

  export interface SupportUsageTicketDto {
    ticketNumber: string;
    title: string | null;
    billedMinutes: number;
    toBeBilledMinutes: number;
    coveredByContractMinutes: number;
    pendingReviewMinutes: number;
  }

  export interface SupportUsageDto {
    dataStatus: TileStatus;
    asOf: string;
    month: string;
    timezone: string;
    totals: {
      billed: CountHoursDto;
      toBeBilled: CountHoursDto;
      coveredByContract: CountHoursDto;
      pendingReview: CountHoursDto;
    };
    tickets: SupportUsageTicketDto[];
  }

  export interface SlaDto {
    firstResponseMinutes: number | null;
    resolutionMinutes: number | null;
    responseTargetMinutes: number | null;
    resolutionTargetMinutes: number | null;
    status:
      | 'breached'
      | 'at_risk'
      | 'paused'
      | 'on_track'
      | 'met'
      | 'not_configured';
  }

  export interface PortalRunDto {
    id: string;
    reportId: string;
    type: 'security_compliance_posture' | 'executive_summary';
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    startedAt: string | null;
    completedAt: string | null;
    rowCount: number | null;
    createdAt: string;
  }

  export interface PortalRunsDto {
    data: PortalRunDto[];
    pagination: PaginationDto;
  }

  export interface EnrichedPortalDevice {
    id: string;
    hostname: string;
    displayName: string | null;
    osType: string;
    osVersion: string;
    status: string;
    lastSeenAt: string | null;
    lastPatchAt: string | null;
    protection: 'protected' | 'unprotected' | 'unknown';
    encryption: string | null;
    lastBackupAt: string | null;
    warrantyEndsAt: string | null;
  }
  ```

  Add to `packages/shared/src/types/index.ts`:

  ```ts
  export * from './portalVisibility';
  ```

- [ ] **Step 4: Run the shared type test and package typecheck green.**

  ```bash
  cd packages/shared && npx vitest run src/types/portalVisibility.test.ts
  cd packages/shared && pnpm typecheck
  ```

  Expected result: all approved DTO names and closed unions compile.

- [ ] **Step 5: Commit the shared contract.**

  ```bash
  git add packages/shared/src/types/portalVisibility.ts packages/shared/src/types/portalVisibility.test.ts packages/shared/src/types/index.ts && git commit -m "feat(portal): define visibility DTOs"
  ```

### Task 2.2: Extract and reuse device-protection classification

**Files:**

- **Create:** `apps/api/src/services/portal/protection.ts`
- **Create:** `apps/api/src/services/portal/protection.test.ts`
- **Modify:** `apps/api/src/services/securityComplianceReport.ts:1-35,234-247,407-505,534-570`
- **Modify:** `apps/api/src/services/securityComplianceReport.test.ts:63-99,157-509`
- **Test:** `apps/api/src/services/portal/protection.test.ts`
- **Test:** `apps/api/src/services/securityComplianceReport.test.ts`

**Interfaces:**

- **Consumes:** The existing protection rule and Drizzle-derived provider type from `apps/api/src/services/securityComplianceReport.ts:420-445` and `apps/api/src/db/schema/security.ts`.
- **Produces:**
  ```ts
  import type { securityStatus } from '../../db/schema';

  type SecurityProvider = (typeof securityStatus.$inferSelect)['provider'];

  export type ProtectionState =
    | 'protected'
    | 'unprotected'
    | 'unknown';

  export function classifyDeviceProtection(input: {
    securityStatus: {
      provider: SecurityProvider;
      realTimeProtection: boolean | null;
    } | null;
    hasS1Agent: boolean;
    hasHuntressAgent: boolean;
  }): ProtectionState;
  ```

- [ ] **Step 1: Write the failing classifier tests.**

  Create `apps/api/src/services/portal/protection.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import type { securityStatus as securityStatusTable } from '../../db/schema';
  import { classifyDeviceProtection } from './protection';

  type SecurityProvider = (typeof securityStatusTable.$inferSelect)['provider'];

  function status(
    overrides: Partial<{
      provider: SecurityProvider;
      realTimeProtection: boolean | null;
    }> = {},
  ) {
    return {
      provider: 'windows_defender' as const,
      realTimeProtection: true,
      ...overrides,
    };
  }

  describe('classifyDeviceProtection', () => {
    it.each([
      {
        name: 'S1 agent takes precedence over an absent status row',
        securityStatus: null,
        hasS1Agent: true,
        hasHuntressAgent: false,
        expected: 'protected',
      },
      {
        name: 'absent row is unknown',
        securityStatus: null,
        hasS1Agent: false,
        hasHuntressAgent: false,
        expected: 'unknown',
      },
      {
        name: 'stale Defender with RTP on remains protected',
        securityStatus: status(),
        hasS1Agent: false,
        hasHuntressAgent: false,
        observedAt: new Date('2026-07-04T12:00:00.000Z'),
        expected: 'protected',
      },
      {
        name: 'fresh provider other is unprotected',
        securityStatus: status({ provider: 'other' }),
        hasS1Agent: false,
        hasHuntressAgent: false,
        observedAt: new Date('2026-09-02T12:00:00.000Z'),
        expected: 'unprotected',
      },
      {
        name: 'RTP null is unprotected',
        securityStatus: status({ realTimeProtection: null }),
        hasS1Agent: false,
        hasHuntressAgent: false,
        expected: 'unprotected',
      },
    ])('$name', ({ expected, securityStatus, hasS1Agent, hasHuntressAgent }) => {
      expect(classifyDeviceProtection({
        securityStatus,
        hasS1Agent,
        hasHuntressAgent,
      })).toBe(expected);
    });

    it.each([
      ['base dev-1 managed Huntress', status(), false, true, 'protected', 'protected'],
      ['base dev-2 other/RTP-off', status({ provider: 'other', realTimeProtection: false }), false, false, 'unprotected', 'unprotected'],
      ['base dev-3 absent', null, false, false, 'unknown', 'unprotected'],
      ['Elastic Defend RTP-on', status({ provider: 'elastic_defend' }), false, false, 'protected', 'protected'],
      ['fresh Defender', status(), false, false, 'protected', 'protected'],
      ['60-day stale Defender', status(), false, false, 'protected', 'protected'],
      ['10-day Defender under seven-day maximum', status(), false, false, 'protected', 'protected'],
      ['assessed Defender', status(), false, false, 'protected', 'protected'],
      ['assessed-set stale Defender', status(), false, false, 'protected', 'protected'],
      ['assessed-set absent row', null, false, false, 'unknown', 'unprotected'],
      ['exact 30-day cutoff', status(), false, false, 'protected', 'protected'],
      ['31 days past cutoff', status(), false, false, 'protected', 'protected'],
      ['missing updatedAt legacy row', status(), false, false, 'protected', 'protected'],
      ['inventory other/RTP-off', status({ provider: 'other', realTimeProtection: false }), false, false, 'unprotected', 'unprotected'],
      ['SentinelOne managed row', status({ provider: 'sentinelone' }), true, false, 'protected', 'protected'],
      ['native Defender row', status(), false, false, 'protected', 'protected'],
      ['other provider with RTP on', status({ provider: 'other' }), false, false, 'unprotected', 'unprotected'],
      ['CrowdStrike with RTP off', status({ provider: 'crowdstrike', realTimeProtection: false }), false, false, 'unprotected', 'unprotected'],
      ['coverage dev-1 Defender', status(), false, false, 'protected', 'protected'],
      ['coverage dev-2 Defender', status(), false, false, 'protected', 'protected'],
      ['coverage dev-3 Defender', status(), false, false, 'protected', 'protected'],
      ['coverage dev-4 Defender', status(), false, false, 'protected', 'protected'],
      ['coverage dev-5 managed SentinelOne', status({ provider: 'sentinelone' }), true, false, 'protected', 'protected'],
      ['coverage dev-6 managed SentinelOne/RTP-off', status({ provider: 'sentinelone', realTimeProtection: false }), true, false, 'protected', 'protected'],
    ] as const)(
      'matches report fixture %s and its existing report bucket',
      (_, securityStatus, hasS1Agent, hasHuntressAgent, expected, reportBucket) => {
        const actual = classifyDeviceProtection({
          securityStatus,
          hasS1Agent,
          hasHuntressAgent,
        });

        expect(actual).toBe(expected);
        expect(actual === 'protected' ? 'protected' : 'unprotected')
          .toBe(reportBucket);
      },
    );
  });
  ```

- [ ] **Step 2: Run the classifier test and confirm the new module is missing.**

  ```bash
  cd apps/api && npx vitest run src/services/portal/protection.test.ts
  ```

  Expected failure: `./protection` cannot be resolved.

- [ ] **Step 3: Implement the classifier and replace report-local normalization.**

  Create `apps/api/src/services/portal/protection.ts`:

  ```ts
  import type { securityStatus } from '../../db/schema';

  type SecurityProvider = (typeof securityStatus.$inferSelect)['provider'];

  export type ProtectionState =
    | 'protected'
    | 'unprotected'
    | 'unknown';

  export function classifyDeviceProtection(input: {
    securityStatus: {
      provider: SecurityProvider;
      realTimeProtection: boolean | null;
    } | null;
    hasS1Agent: boolean;
    hasHuntressAgent: boolean;
  }): ProtectionState {
    if (input.hasS1Agent || input.hasHuntressAgent) {
      return 'protected';
    }

    if (input.securityStatus === null) {
      return 'unknown';
    }

    return input.securityStatus.provider !== 'other' &&
      input.securityStatus.realTimeProtection === true
      ? 'protected'
      : 'unprotected';
  }
  ```

  This is a direct extraction of `securityComplianceReport.ts:420-445`: provider is the selected `security_status.provider` enum value, and either managed-agent table takes precedence over status-row presence and native AV state. The helper deliberately does not consume `updatedAt`, `now`, or `maxSecurityStatusAgeDays`. Keep `updatedAt` in the report query because the existing `ssFresh` calculation still governs only the encryption and firewall buckets. Keep the existing `hasNativeAv` boolean because the later AV-definition-age denominator at lines 477-482 needs the raw native-provider fact even on a managed-EDR device. Import the helper and replace only `protectedDevice` plus the three coverage counters inside the device loop with:

  ```ts
  const protection = classifyDeviceProtection({
    securityStatus: ss
      ? {
          provider: ss.provider,
          realTimeProtection: ss.realTimeProtection,
        }
      : null,
    hasS1Agent: s1Devices.has(d.id),
    hasHuntressAgent: huntressDevices.has(d.id),
  });

  if (ss) reporting += 1;
  if (isManaged) managedEdr += 1;
  if (protection === 'protected') anyAv += 1;
  // The report has no unknown protection bucket. An absent status row has
  // always counted as unprotected here, so preserve that public contract.
  if (protection !== 'protected') unprotected += 1;
  ```

  Keep the existing report fixture rows unchanged: they already contain the exact inputs the helper reads. A status row's staleness remains exposed to portal callers as `observedAt` from `security_status.updated_at`; it is not a `ProtectionState`. Add a parity test that runs the report before/after the extraction over every existing protection/freshness fixture group and compares the full returned report object, not only the three counters. Enumerate the groups explicitly so none are silently omitted:

  - base Defender/`other` rows at lines 71-72;
  - Elastic Defend at line 175;
  - fresh/stale rows at lines 205-206;
  - custom-age row at line 232;
  - assessed/stale rows at lines 254-255;
  - exact-cutoff/past-cutoff rows at lines 279-280;
  - missing-`updatedAt` row at line 299;
  - `other` provider row at line 392;
  - SentinelOne/native rows at lines 429-430;
  - `other`/RTP-off rows at lines 455-456;
  - six coverage rows at lines 504-509.

  The parity assertion must prove the extraction leaves `managedEdr`, `anyAv`, `unprotected`, row labels, and the rest of the report byte-for-byte unchanged. In particular, stale Defender rows with RTP on remain protected, while an absent row returns `'unknown'` from the helper and maps to the report's existing unprotected bucket.

- [ ] **Step 4: Run the classifier and report suites green.**

  ```bash
  cd apps/api && npx vitest run src/services/portal/protection.test.ts src/services/securityComplianceReport.test.ts
  ```

  Expected result: either managed agent classifies first; an absent row is unknown; `provider !== 'other' && realTimeProtection === true` is protected regardless of observation age; all other present rows are unprotected; and the existing security report's full fixture output is byte-for-byte unchanged because unknown maps to its existing unprotected bucket.

- [ ] **Step 5: Commit the extraction.**

  ```bash
  git add apps/api/src/services/portal/protection.ts apps/api/src/services/portal/protection.test.ts apps/api/src/services/securityComplianceReport.ts apps/api/src/services/securityComplianceReport.test.ts && git commit -m "refactor(portal): share protection classification"
  ```

### Task 2.3: Extract organization timezone resolution

**Files:**

- **Create:** `apps/api/src/services/portal/timezone.ts`
- **Create:** `apps/api/src/services/portal/timezone.test.ts`
- **Modify:** `apps/api/src/routes/portal/auth.ts:119-136,211`
- **Modify:** `apps/api/src/routes/portal/schemas.ts:16-28`
- **Modify:** `apps/api/src/routes/portal/authOrgStatusGate.test.ts:19-145`
- **Modify:** `apps/api/src/routes/portal/invoices.test.ts:96-108`
- **Modify:** `apps/api/src/routes/portal/quotes.test.ts:74-86`
- **Modify:** `apps/api/src/__tests__/integration/portalQuotePay.integration.test.ts:79-93`
- **Modify:** `apps/api/src/__tests__/integration/multiCurrencyWave6QuoteAcceptance.integration.test.ts:75-90`
- **Modify:** `apps/api/src/jobs/reportScheduleWorker.ts:49-57,123-150,205-228,625-631`
- **Modify:** `apps/api/src/jobs/reportScheduleWorker.test.ts:24-67`
- **Test:** `apps/api/src/services/portal/timezone.test.ts`
- **Test:** `apps/api/src/routes/portal/authOrgStatusGate.test.ts`
- **Test:** `apps/api/src/jobs/reportScheduleWorker.test.ts`

**Interfaces:**

- **Consumes:** The real `timezoneFor` precedence at `apps/api/src/jobs/reportScheduleWorker.ts:123-150`, `canonicalizeTimezone` and `resolveEffectiveTimezone` from `@breeze/shared`, and `portalAuthMiddleware`'s existing system-context hydration at `apps/api/src/routes/portal/auth.ts:119-136`.
- **Produces:**
  ```ts
  export function resolveTimezoneFromRows(
    orgSettings: unknown,
    partnerTimezone: string | null,
    partnerSettings: unknown,
  ): string;

  export async function resolveOrgTimezone(
    orgId: string,
  ): Promise<string>;
  ```

  `PortalAuthContext` also gains required `timezone: string`. Every later portal route passes `auth.timezone` into its read models; read models never call `resolveOrgTimezone`.

- [ ] **Step 1: Write failing precedence and SQL-scope tests.**

  Create `apps/api/src/services/portal/timezone.test.ts`:

  ```ts
  import { beforeEach, describe, expect, it, vi } from 'vitest';
  import { PgDialect, type SQL } from 'drizzle-orm/pg-core';

  const state = vi.hoisted(() => ({
    rows: [] as Record<string, unknown>[],
    where: undefined as SQL | undefined,
  }));

  vi.mock('../../db', () => ({
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn((where: SQL) => {
              state.where = where;
              return {
                limit: vi.fn(async () => state.rows),
              };
            }),
          })),
        })),
      })),
    },
  }));

  import {
    resolveOrgTimezone,
    resolveTimezoneFromRows,
  } from './timezone';

  describe('portal timezone resolution', () => {
    beforeEach(() => {
      state.rows = [];
      state.where = undefined;
    });

    it.each([
      [{ timezone: 'America/Denver' }, 'Europe/Berlin', { timezone: 'Asia/Tokyo' }, 'America/Denver'],
      [{}, 'Europe/Berlin', { timezone: 'Asia/Tokyo' }, 'Europe/Berlin'],
      [{}, 'UTC', { timezone: 'Asia/Tokyo' }, 'Asia/Tokyo'],
      [{}, 'utc', {}, 'UTC'],
      [{ timezone: 'not/a-zone' }, 'not/a-zone', { timezone: 'Asia/Tokyo' }, 'Asia/Tokyo'],
      [null, null, null, 'UTC'],
    ])(
      'uses the worker precedence with canonicalization and validation',
      (orgSettings, partnerTimezone, partnerSettings, expected) => {
        expect(resolveTimezoneFromRows(
          orgSettings,
          partnerTimezone,
          partnerSettings,
        )).toBe(expected);
      },
    );

    it('queries the requested organization with a left join', async () => {
      state.rows = [{
        orgSettings: {},
        partnerTimezone: 'UTC',
        partnerSettings: {},
      }];

      await expect(resolveOrgTimezone(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      )).resolves.toBe('UTC');

      const query = new PgDialect().sqlToQuery(state.where as SQL);
      expect(query.sql).toContain(
        '"organizations"."id" = $1',
      );
      expect(query.params).toEqual([
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ]);
    });
  });
  ```

  Extend the real `authOrgStatusGate.test.ts` harness with this hoisted resolver mock before importing `./auth`:

  ```ts
  const resolveOrgTimezone = vi.hoisted(() =>
    vi.fn(async () => 'UTC'),
  );

  vi.mock('../../services/portal/timezone', () => ({
    resolveOrgTimezone,
  }));
  ```

  Have the protected handler return `c.get('portalAuth').timezone`, then add this regression:

  ```ts
  it('hydrates the organization timezone exactly once into portalAuth', async () => {
    vi.mocked(resolveOrgTimezone).mockResolvedValue('America/Denver');
    seedSession();

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ timezone: 'America/Denver' });
    expect(resolveOrgTimezone).toHaveBeenCalledTimes(1);
    expect(resolveOrgTimezone).toHaveBeenCalledWith(ORG_ID);
  });
  ```

  Update `makeApp()` for this file to return `{ timezone: c.get('portalAuth').timezone }`; adjust the existing success assertion only where it currently expects `{ ok: true }`.

- [ ] **Step 2: Run the focused test and confirm the resolver module is absent.**

  ```bash
  cd apps/api && npx vitest run src/services/portal/timezone.test.ts
  ```

  Expected failure: `./timezone` cannot be resolved.

- [ ] **Step 3: Implement the resolver and make the schedule worker consume it.**

  Create `apps/api/src/services/portal/timezone.ts` by moving the worker's exact precedence into a shared pure helper and adding the org lookup. The lookup deliberately does not open a system context: `portalAuthMiddleware` calls it inside its existing system-context hydration, and worker callers already run under worker system authority.

  ```ts
  import { eq } from 'drizzle-orm';
  import {
    canonicalizeTimezone,
    resolveEffectiveTimezone,
  } from '@breeze/shared';
  import { db } from '../../db';
  import { organizations, partners } from '../../db/schema';

  export function resolveTimezoneFromRows(
    orgSettings: unknown,
    partnerTimezone: string | null,
    partnerSettings: unknown,
  ): string {
    const orgTz = orgSettings && typeof orgSettings === 'object'
      ? (orgSettings as Record<string, unknown>).timezone
      : null;
    const partnerColumn = canonicalizeTimezone(partnerTimezone);
    const partnerFromSettings = partnerSettings && typeof partnerSettings === 'object'
      ? (partnerSettings as Record<string, unknown>).timezone
      : null;
    const partnerTz = partnerColumn !== null && partnerColumn !== 'UTC'
      ? partnerColumn
      : typeof partnerFromSettings === 'string' && partnerFromSettings.length > 0
        ? partnerFromSettings
        : partnerColumn;

    return resolveEffectiveTimezone({
      siteTz: null,
      orgTz: typeof orgTz === 'string' ? orgTz : null,
      partnerTz,
    });
  }

  export async function resolveOrgTimezone(
    orgId: string,
  ): Promise<string> {
    const [row] = await db
      .select({
        orgSettings: organizations.settings,
        partnerTimezone: partners.timezone,
        partnerSettings: partners.settings,
      })
      .from(organizations)
      .leftJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(organizations.id, orgId))
      .limit(1);

    return resolveTimezoneFromRows(
      row?.orgSettings,
      row?.partnerTimezone ?? null,
      row?.partnerSettings,
    );
  }
  ```

  Remove the worker-local `timezoneFor` and import:

  ```ts
  import {
    resolveOrgTimezone,
    resolveTimezoneFromRows,
  } from '../services/portal/timezone';
  ```

  Replace worker call sites that already have loaded rows with:

  ```ts
  const timezone = resolveTimezoneFromRows(
    organization.settings,
    partner.timezone,
    partner.settings,
  );
  ```

  Replace the worker’s standalone organization lookup with:

  ```ts
  const timezone = await resolveOrgTimezone(report.orgId);
  ```

  In `portalAuthMiddleware`, keep the portal-user lookup and timezone resolution inside one existing `withSystemDbAccessContext` callback and call the resolver exactly once:

  ```ts
  const hydrated = await withSystemDbAccessContext(async () => {
    const [user] = await db
      .select({
        id: portalUsers.id,
        orgId: portalUsers.orgId,
        email: portalUsers.email,
        name: portalUsers.name,
        receiveNotifications: portalUsers.receiveNotifications,
        status: portalUsers.status,
      })
      .from(portalUsers)
      .where(and(
        eq(portalUsers.id, sessionData.portalUserId),
        eq(portalUsers.orgId, sessionData.orgId),
      ))
      .limit(1);

    return {
      user,
      timezone: user
        ? await resolveOrgTimezone(sessionData.orgId)
        : null,
    };
  });
  const { user, timezone } = hydrated;
  ```

  After the existing missing-user and status checks, replace the context assignment with:

  ```ts
  c.set('portalAuth', {
    user,
    token,
    authMethod,
    timezone: timezone ?? 'UTC',
  });
  ```

  Add `timezone: string` to `PortalAuthContext` in `routes/portal/schemas.ts`. Do not resolve the timezone again in a route or read model.

  Add this exact property to the typed `portalAuth` object in `invoices.test.ts`, `quotes.test.ts`, `portalQuotePay.integration.test.ts`, and `multiCurrencyWave6QuoteAcceptance.integration.test.ts`, immediately after each file's existing `authMethod` property:

  ```ts
  timezone: 'UTC',
  ```

  Preserve each file's existing `user` and `authMethod` expressions. The `tickets.test.ts` and `ticketAttachmentsRls.integration.test.ts` injectors cast the key/value to `never`, so this type-contract change does not require touching them.

- [ ] **Step 4: Run the resolver and worker suites green.**

  ```bash
  cd apps/api && npx vitest run src/services/portal/timezone.test.ts src/routes/portal/authOrgStatusGate.test.ts src/jobs/reportScheduleWorker.test.ts
  cd apps/api && npx vitest run src/routes/portal/invoices.test.ts src/routes/portal/quotes.test.ts
  cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalQuotePay.integration.test.ts src/__tests__/integration/multiCurrencyWave6QuoteAcceptance.integration.test.ts
  ```

  Expected result: the exact worker precedence/canonicalization is unchanged, the organization lookup uses a left join, middleware resolves once and exposes `auth.timezone`, and background report scheduling still resolves its timezone.

- [ ] **Step 5: Commit the shared timezone resolver.**

  ```bash
  git add apps/api/src/services/portal/timezone.ts apps/api/src/services/portal/timezone.test.ts apps/api/src/routes/portal/auth.ts apps/api/src/routes/portal/schemas.ts apps/api/src/routes/portal/authOrgStatusGate.test.ts apps/api/src/routes/portal/invoices.test.ts apps/api/src/routes/portal/quotes.test.ts apps/api/src/__tests__/integration/portalQuotePay.integration.test.ts apps/api/src/__tests__/integration/multiCurrencyWave6QuoteAcceptance.integration.test.ts apps/api/src/jobs/reportScheduleWorker.ts apps/api/src/jobs/reportScheduleWorker.test.ts && git commit -m "refactor(portal): share organization timezone resolution"
  ```

### Task 2.4: Add tenant-safe support usage aggregation

**Files:**

- **Create:** `apps/api/src/services/portal/supportUsage.ts`
- **Create:** `apps/api/src/services/portal/supportUsage.test.ts`
- **Test:** `apps/api/src/services/portal/supportUsage.test.ts`

**Interfaces:**

- **Consumes:** `timeEntries` from `apps/api/src/db/schema/timeTracking.ts:19-56`, `tickets` from `apps/api/src/db/schema/portal.ts:76-133`, and system-context helpers from `apps/api/src/db/index.ts:525-575,610-612,770-782`.
- **Produces:**
  ```ts
  export async function supportUsageForOrg(args: {
    orgId: string;
    month: string;
    timezone: string;
    portalUserId: string;
  }): Promise<SupportUsageDto>;
  ```

- [ ] **Step 1: Write the failing aggregation and compiled-SQL tests.**

  Create `apps/api/src/services/portal/supportUsage.test.ts`:

  ```ts
  import { beforeEach, describe, expect, it, vi } from 'vitest';
  import { PgDialect, type SQL } from 'drizzle-orm/pg-core';

  const state = vi.hoisted(() => ({
    rows: [] as Record<string, unknown>[],
    join: undefined as SQL | undefined,
    where: undefined as SQL | undefined,
  }));

  vi.mock('../../db', () => ({
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn((_table, join: SQL) => {
            state.join = join;
            return {
              where: vi.fn(async (where: SQL) => {
                state.where = where;
                return state.rows;
              }),
            };
          }),
        })),
      })),
    },
    runOutsideDbContext: vi.fn(async (
      fn: () => Promise<unknown>,
    ) => fn()),
    withSystemDbAccessContext: vi.fn(async (
      fn: () => Promise<unknown>,
    ) => fn()),
  }));

  import {
    supportUsageForOrg,
  } from './supportUsage';

  const args = {
    orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    month: '2026-09',
    timezone: 'America/Denver',
    portalUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };

  describe('supportUsageForOrg', () => {
    beforeEach(() => {
      state.rows = [];
      state.join = undefined;
      state.where = undefined;
    });

    it('places minutes into the four approved buckets', async () => {
      state.rows = [
        {
          ticketNumber: 'T-1',
          title: 'Visible',
          durationMinutes: 15,
          billingStatus: 'billed',
          isApproved: true,
        },
        {
          ticketNumber: 'T-2',
          title: null,
          durationMinutes: 30,
          billingStatus: 'not_billed',
          isApproved: true,
        },
        {
          ticketNumber: 'T-3',
          title: null,
          durationMinutes: 45,
          billingStatus: 'contract',
          isApproved: true,
        },
        {
          ticketNumber: 'T-4',
          title: null,
          durationMinutes: 60,
          billingStatus: 'not_billed',
          isApproved: false,
        },
      ];

      const result = await supportUsageForOrg(args);

      expect(result.totals).toEqual({
        billed: { minutes: 15, hours: 0.25 },
        toBeBilled: { minutes: 30, hours: 0.5 },
        coveredByContract: { minutes: 45, hours: 0.75 },
        pendingReview: { minutes: 60, hours: 1 },
      });
    });

    it('contains both organization predicates in compiled SQL', async () => {
      await supportUsageForOrg(args);

      const dialect = new PgDialect();
      const join = dialect.sqlToQuery(state.join as SQL);
      const where = dialect.sqlToQuery(state.where as SQL);

      expect(join.sql).toContain('"tickets"."org_id" = $');
      expect(join.params).toContain(args.orgId);
      expect(where.sql).toContain('"time_entries"."org_id" = $');
      expect(where.params).toContain(args.orgId);
    });

    it('rejects an invalid month before querying', async () => {
      await expect(supportUsageForOrg({
        ...args,
        month: 'September',
      })).rejects.toThrow('month must use YYYY-MM');
    });
  });
  ```

- [ ] **Step 2: Run the test and confirm the service is missing.**

  ```bash
  cd apps/api && npx vitest run src/services/portal/supportUsage.test.ts
  ```

  Expected failure: `./supportUsage` cannot be resolved.

- [ ] **Step 3: Implement the system-scoped query with two explicit organization predicates.**

  Create `apps/api/src/services/portal/supportUsage.ts`:

  ```ts
  import type { SupportUsageDto } from '@breeze/shared';
  import {
    and,
    eq,
    isNotNull,
    isNull,
    ne,
    sql,
  } from 'drizzle-orm';
  import {
    db,
    runOutsideDbContext,
    withSystemDbAccessContext,
  } from '../../db';
  import { tickets, timeEntries } from '../../db/schema';

  type UsageRow = {
    ticketNumber: string;
    title: string | null;
    durationMinutes: number | null;
    billingStatus:
      | 'not_billed'
      | 'billed'
      | 'no_charge'
      | 'contract';
    isApproved: boolean;
  };

  function amount(minutes: number) {
    return {
      minutes,
      hours: minutes / 60,
    };
  }

  export async function supportUsageForOrg(args: {
    orgId: string;
    month: string;
    timezone: string;
    portalUserId: string;
  }): Promise<SupportUsageDto> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(args.month)) {
      throw new Error('month must use YYYY-MM');
    }

    const [year, month] = args.month.split('-').map(Number);
    const start = sql`make_timestamptz(
      ${year},
      ${month},
      1,
      0,
      0,
      0,
      ${args.timezone}
    )`;
    const end = sql`${start} + interval '1 month'`;

    const rows = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({
            ticketNumber: tickets.ticketNumber,
            title: sql<string | null>`
              CASE
                WHEN ${tickets.submittedBy} = ${args.portalUserId}
                THEN ${tickets.subject}
                ELSE NULL
              END
            `,
            durationMinutes: timeEntries.durationMinutes,
            billingStatus: timeEntries.billingStatus,
            isApproved: timeEntries.isApproved,
          })
          .from(timeEntries)
          .innerJoin(
            tickets,
            and(
              eq(tickets.id, timeEntries.ticketId),
              eq(tickets.orgId, args.orgId),
            ),
          )
          .where(and(
            eq(timeEntries.orgId, args.orgId),
            isNotNull(timeEntries.ticketId),
            eq(timeEntries.isBillable, true),
            ne(timeEntries.billingStatus, 'no_charge'),
            isNull(tickets.deletedAt),
            sql`${timeEntries.startedAt} >= ${start}`,
            sql`${timeEntries.startedAt} < ${end}`,
          )) as Promise<UsageRow[]>,
      ),
    );

    let billed = 0;
    let toBeBilled = 0;
    let coveredByContract = 0;
    let pendingReview = 0;

    const ticketsByNumber = new Map<
      string,
      SupportUsageDto['tickets'][number]
    >();

    for (const row of rows) {
      const minutes = row.durationMinutes ?? 0;
      const ticket = ticketsByNumber.get(row.ticketNumber) ?? {
        ticketNumber: row.ticketNumber,
        title: row.title,
        billedMinutes: 0,
        toBeBilledMinutes: 0,
        coveredByContractMinutes: 0,
        pendingReviewMinutes: 0,
      };

      if (!row.isApproved) {
        pendingReview += minutes;
        ticket.pendingReviewMinutes += minutes;
      } else if (row.billingStatus === 'billed') {
        billed += minutes;
        ticket.billedMinutes += minutes;
      } else if (row.billingStatus === 'contract') {
        coveredByContract += minutes;
        ticket.coveredByContractMinutes += minutes;
      } else {
        toBeBilled += minutes;
        ticket.toBeBilledMinutes += minutes;
      }

      ticketsByNumber.set(row.ticketNumber, ticket);
    }

    return {
      dataStatus: rows.length > 0 ? 'ok' : 'no_data',
      asOf: new Date().toISOString(),
      month: args.month,
      timezone: args.timezone,
      totals: {
        billed: amount(billed),
        toBeBilled: amount(toBeBilled),
        coveredByContract: amount(coveredByContract),
        pendingReview: amount(pendingReview),
      },
      tickets: [...ticketsByNumber.values()],
    };
  }
  ```

- [ ] **Step 4: Run the focused suite green.**

  ```bash
  cd apps/api && npx vitest run src/services/portal/supportUsage.test.ts
  ```

  Expected result: all buckets aggregate correctly and compiled SQL proves both `time_entries.org_id` and `tickets.org_id` are constrained.

- [ ] **Step 5: Commit the support usage foundation.**

  ```bash
  git add apps/api/src/services/portal/supportUsage.ts apps/api/src/services/portal/supportUsage.test.ts && git commit -m "feat(portal): add tenant-safe support usage"
  ```

### Task 2.5: Add the system-scoped vulnerability catalog adapter

**Files:**

- **Create:** `apps/api/src/services/portal/vulnerabilityCatalog.ts`
- **Create:** `apps/api/src/services/portal/vulnerabilityCatalog.test.ts`
- **Modify:** `apps/api/src/services/securityComplianceReportVulnerabilities.ts:1-90`
- **Modify:** `apps/api/src/services/securityComplianceReportVulnerabilities.test.ts:1-112`
- **Test:** `apps/api/src/services/portal/vulnerabilityCatalog.test.ts`
- **Test:** `apps/api/src/services/securityComplianceReportVulnerabilities.test.ts`

**Interfaces:**

- **Consumes:** The system-scoped catalog pattern in `apps/api/src/services/securityComplianceReportVulnerabilities.ts:1-90`.
- **Produces:**
  ```ts
  export async function vulnerabilitySeverityForFindings(
    vulnIds: string[],
  ): Promise<Map<string, {
    severity: string;
    isKev: boolean;
  }>>;
  ```

- [ ] **Step 1: Write failing empty, normalized, batched, and missing-record tests.**

  Create `apps/api/src/services/portal/vulnerabilityCatalog.test.ts`:

  ```ts
  import { beforeEach, describe, expect, it, vi } from 'vitest';

  const state = vi.hoisted(() => ({
    selectMock: vi.fn(),
    batches: [] as string[][],
    rows: [] as Array<{
      id: string;
      severity: string | null;
      knownExploited: boolean | null;
    }>,
    systemCalls: 0,
  }));

  vi.mock('../../db', () => ({
    db: {
      select: (...args: unknown[]) => state.selectMock(...args),
    },
    runOutsideDbContext: vi.fn(async (
      fn: () => Promise<unknown>,
    ) => fn()),
    withSystemDbAccessContext: vi.fn(async (
      fn: () => Promise<unknown>,
    ) => {
      state.systemCalls += 1;
      return fn();
    }),
  }));

  vi.mock('../../db/schema', () => ({
    vulnerabilities: {
      id: 'vulnerabilities.id',
      severity: 'vulnerabilities.severity',
      knownExploited: 'vulnerabilities.knownExploited',
    },
  }));

  vi.mock('drizzle-orm', () => ({
    inArray: (column: unknown, values: string[]) => ({
      op: 'inArray',
      column,
      values,
    }),
  }));

  import {
    vulnerabilitySeverityForFindings,
  } from './vulnerabilityCatalog';

  describe('vulnerabilitySeverityForFindings', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      state.batches = [];
      state.rows = [];
      state.systemCalls = 0;
      state.selectMock.mockImplementation(() => ({
        from: () => ({
          where: async (predicate: { values: string[] }) => {
            state.batches.push(predicate.values);
            return state.rows.filter((row) =>
              predicate.values.includes(row.id),
            );
          },
        }),
      }));
    });

    it('does not enter system context for an empty input', async () => {
      await expect(vulnerabilitySeverityForFindings([]))
        .resolves.toEqual(new Map());
      expect(state.systemCalls).toBe(0);
    });

    it('normalizes severity and KEV metadata', async () => {
      state.rows = [{
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        severity: 'CRITICAL',
        knownExploited: true,
      }];

      await expect(vulnerabilitySeverityForFindings([
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ])).resolves.toEqual(new Map([
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
          severity: 'critical',
          isKev: true,
        }],
      ]));
    });

    it('maps findings absent from the catalog to unknown', async () => {
      await expect(vulnerabilitySeverityForFindings([
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ])).resolves.toEqual(new Map([
        ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', {
          severity: 'unknown',
          isKev: false,
        }],
      ]));
    });

    it('reads more than 10,000 ids in bounded batches', async () => {
      const ids = Array.from(
        { length: 10_001 },
        (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
      );

      await vulnerabilitySeverityForFindings(ids);

      expect(state.batches.map((batch) => batch.length))
        .toEqual([10_000, 1]);
      expect(state.systemCalls).toBe(1);
    });
  });
  ```

- [ ] **Step 2: Run the test and confirm the adapter module is absent.**

  ```bash
  cd apps/api && npx vitest run src/services/portal/vulnerabilityCatalog.test.ts
  ```

  Expected failure: `./vulnerabilityCatalog` cannot be resolved.

- [ ] **Step 3: Implement the bounded system-context catalog lookup and reuse it from the report service.**

  Create `apps/api/src/services/portal/vulnerabilityCatalog.ts`:

  ```ts
  import { inArray } from 'drizzle-orm';
  import {
    db,
    runOutsideDbContext,
    withSystemDbAccessContext,
  } from '../../db';
  import { vulnerabilities } from '../../db/schema';

  const BATCH_SIZE = 10_000;

  export async function vulnerabilitySeverityForFindings(
    vulnIds: string[],
  ): Promise<Map<string, {
    severity: string;
    isKev: boolean;
  }>> {
    const ids = [...new Set(vulnIds)];
    if (ids.length === 0) return new Map();

    const result = new Map<string, {
      severity: string;
      isKev: boolean;
    }>();

    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
          const batch = ids.slice(offset, offset + BATCH_SIZE);
          const rows = await db
            .select({
              id: vulnerabilities.id,
              severity: vulnerabilities.severity,
              knownExploited: vulnerabilities.knownExploited,
            })
            .from(vulnerabilities)
            .where(inArray(vulnerabilities.id, batch));

          for (const row of rows) {
            result.set(row.id, {
              severity: row.severity?.toLowerCase() ?? 'unknown',
              isKev: row.knownExploited === true,
            });
          }
        }
      }),
    );

    for (const id of ids) {
      if (!result.has(id)) {
        result.set(id, {
          severity: 'unknown',
          isKev: false,
        });
      }
    }

    return result;
  }
  ```

  Replace the catalog lookup in `securityComplianceReportVulnerabilities.ts` with:

  ```ts
  import {
    vulnerabilitySeverityForFindings,
  } from './portal/vulnerabilityCatalog';

  const severityByVulnerability =
    await vulnerabilitySeverityForFindings(
      findings.map((finding) => finding.vulnerabilityId),
    );

  const catalogRows = [...severityByVulnerability].map(
    ([id, metadata]) => ({
      id,
      severity: metadata.severity,
    }),
  );
  ```

  Pass `catalogRows` to the existing `aggregateVulnerabilityCounts`. Keep the findings query under its existing organization-scoped context; pass only the already-scoped vulnerability UUIDs through the system-context adapter. Extend the real schema mock in `securityComplianceReportVulnerabilities.test.ts:17-23` with `knownExploited`, and replace its missing-catalog throw assertion with a zero-count assertion: an unknown catalog id has severity `'unknown'` and never increments `high` or `critical`.

- [ ] **Step 4: Run both vulnerability suites green.**

  ```bash
  cd apps/api && npx vitest run src/services/portal/vulnerabilityCatalog.test.ts src/services/securityComplianceReportVulnerabilities.test.ts
  ```

  Expected result: catalog metadata is normalized, unknown UUIDs map to the `'unknown'` severity bucket without throwing, bounded reads use one system context, and report findings remain selected under organization scope.

- [ ] **Step 5: Commit the catalog adapter.**

  ```bash
  git add apps/api/src/services/portal/vulnerabilityCatalog.ts apps/api/src/services/portal/vulnerabilityCatalog.test.ts apps/api/src/services/securityComplianceReportVulnerabilities.ts apps/api/src/services/securityComplianceReportVulnerabilities.test.ts && git commit -m "refactor(portal): isolate vulnerability catalog lookup"
  ```

### Task 2.6: Add portal read indexes and the cross-tenant RLS contract

**Files:**

- **Create:** `apps/api/migrations/2026-09-28-a-portal-visibility-indexes.sql`
- **Create:** `apps/api/src/__tests__/integration/portalVisibilityRls.integration.test.ts`
- **Modify:** `apps/api/src/db/schema/patches.ts:193-219`
- **Modify:** `apps/api/src/db/schema/security.ts:81-100`
- **Modify:** `apps/api/src/db/schema/sentinelOne.ts:60-85`
- **Modify:** `apps/api/src/db/schema/huntress.ts:97-117`
- **Modify:** `apps/api/src/db/schema/backupVerification.ts:1-35`
- **Modify:** `apps/api/src/db/schema/timeTracking.ts:1-56`
- **Test:** `apps/api/src/__tests__/integration/portalVisibilityRls.integration.test.ts`
- **Test:** `apps/api/src/db/autoMigrate.test.ts`

The `-a-`/`-b-` infix is intentional: the W02 index migration and W03 flag migration are owned by two independent PRs landing on 2026-09-28, so explicit ordering avoids a same-date lexicographic collision without reusing the closed 2026-08-06 block.

**Interfaces:**

- **Consumes:** Shape-1 organization RLS policies for evidence tables, the device-join policy for `report_runs`, and the partner-axis policy for `time_entries`.
- **Produces:** Nine idempotent read indexes and a portal-shaped forced-RLS contract using:
  ```ts
  {
    scope: 'organization',
    orgId: orgA.id,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: null,
  }
  ```

- [ ] **Step 1: Write the failing live-DB RLS and index integration test.**

  Create `apps/api/src/__tests__/integration/portalVisibilityRls.integration.test.ts` with fixtures for two organizations under the same partner. The central assertions are:

  ```ts
  import './setup';
  import { randomUUID } from 'node:crypto';
  import { describe, expect, it } from 'vitest';
  import { sql } from 'drizzle-orm';
  import {
    db,
    withDbAccessContext,
    type DbAccessContext,
  } from '../../db';
  import {
    backupConfigs,
    backupJobs,
    backupVerifications,
    devices,
    portalUsers,
    reports,
    reportRuns,
    securityPostureOrgSnapshots,
    securityStatus,
    sites,
    tickets,
    timeEntries,
  } from '../../db/schema';
  import {
    supportUsageForOrg,
  } from '../../services/portal/supportUsage';
  import {
    createOrganization,
    createPartner,
    createUser,
  } from './db-utils';
  import { getTestDb } from './setup';

  async function seedDevice(
    admin: ReturnType<typeof getTestDb>,
    orgId: string,
    label: string,
  ) {
    const [site] = await admin
      .insert(sites)
      .values({ orgId, name: `${label} Site` })
      .returning({ id: sites.id });

    const [device] = await admin
      .insert(devices)
      .values({
        orgId,
        siteId: site.id,
        agentId: `${label}-${randomUUID()}`,
        hostname: `${label}-host`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: 'test',
        status: 'online',
      })
      .returning({ id: devices.id });

    return device.id;
  }

  describe('portal visibility RLS', () => {
    it('hides organization B evidence from organization A', async () => {
      const admin = getTestDb();
      const partner = await createPartner();
      const orgA = await createOrganization({
        partnerId: partner.id,
      });
      const orgB = await createOrganization({
        partnerId: partner.id,
      });
      const technician = await createUser({
        partnerId: partner.id,
        orgId: null,
      });

      const [portalA] = await admin
        .insert(portalUsers)
        .values({
          orgId: orgA.id,
          email: `portal-${randomUUID()}@example.test`,
          name: 'Portal A',
          status: 'active',
        })
        .returning({ id: portalUsers.id });

      const deviceA = await seedDevice(admin, orgA.id, 'a');
      const deviceB = await seedDevice(admin, orgB.id, 'b');

      await admin.insert(securityStatus).values([
        {
          orgId: orgA.id,
          deviceId: deviceA,
          provider: 'windows_defender',
          realTimeProtection: true,
          avProducts: [{ displayName: 'Defender' }],
        },
        {
          orgId: orgB.id,
          deviceId: deviceB,
          provider: 'windows_defender',
          realTimeProtection: true,
          avProducts: [{ displayName: 'Defender' }],
        },
      ]);

      const score = {
        overallScore: 80,
        devicesAudited: 1,
        lowRiskDevices: 1,
        mediumRiskDevices: 0,
        highRiskDevices: 0,
        criticalRiskDevices: 0,
        patchComplianceScore: 80,
        encryptionScore: 80,
        avHealthScore: 80,
        firewallScore: 80,
        openPortsScore: 80,
        passwordPolicyScore: 80,
        osCurrencyScore: 80,
        adminExposureScore: 80,
      };

      await admin.insert(securityPostureOrgSnapshots).values([
        { orgId: orgA.id, ...score },
        { orgId: orgB.id, ...score },
      ]);

      const configs = await admin
        .insert(backupConfigs)
        .values([
          {
            orgId: orgA.id,
            name: 'A',
            type: 'file',
            provider: 'local',
            providerConfig: {},
          },
          {
            orgId: orgB.id,
            name: 'B',
            type: 'file',
            provider: 'local',
            providerConfig: {},
          },
        ])
        .returning({
          id: backupConfigs.id,
          orgId: backupConfigs.orgId,
        });
      const configByOrg = new Map(
        configs.map((row) => [row.orgId, row.id]),
      );

      const jobs = await admin
        .insert(backupJobs)
        .values([
          {
            orgId: orgA.id,
            configId: configByOrg.get(orgA.id)!,
            deviceId: deviceA,
            status: 'completed',
          },
          {
            orgId: orgB.id,
            configId: configByOrg.get(orgB.id)!,
            deviceId: deviceB,
            status: 'completed',
          },
        ])
        .returning({
          id: backupJobs.id,
          orgId: backupJobs.orgId,
        });
      const jobByOrg = new Map(
        jobs.map((row) => [row.orgId, row.id]),
      );

      await admin.insert(backupVerifications).values([
        {
          orgId: orgA.id,
          deviceId: deviceA,
          backupJobId: jobByOrg.get(orgA.id)!,
          verificationType: 'integrity',
          status: 'passed',
          startedAt: new Date(),
          completedAt: new Date(),
        },
        {
          orgId: orgB.id,
          deviceId: deviceB,
          backupJobId: jobByOrg.get(orgB.id)!,
          verificationType: 'integrity',
          status: 'passed',
          startedAt: new Date(),
          completedAt: new Date(),
        },
      ]);

      const reportRows = await admin
        .insert(reports)
        .values([
          {
            orgId: orgA.id,
            name: 'A',
            type: 'device_inventory',
            config: {},
            schedule: 'one_time',
            format: 'csv',
          },
          {
            orgId: orgB.id,
            name: 'B',
            type: 'device_inventory',
            config: {},
            schedule: 'one_time',
            format: 'csv',
          },
        ])
        .returning({
          id: reports.id,
          orgId: reports.orgId,
        });
      const reportByOrg = new Map(
        reportRows.map((row) => [row.orgId, row.id]),
      );

      const runs = await admin
        .insert(reportRuns)
        .values([
          {
            reportId: reportByOrg.get(orgA.id)!,
            status: 'completed',
          },
          {
            reportId: reportByOrg.get(orgB.id)!,
            status: 'completed',
          },
        ])
        .returning({
          id: reportRuns.id,
          reportId: reportRuns.reportId,
        });
      const runA = runs.find(
        (row) => row.reportId === reportByOrg.get(orgA.id),
      )!.id;
      const runB = runs.find(
        (row) => row.reportId === reportByOrg.get(orgB.id),
      )!.id;

      const [ticketB] = await admin
        .insert(tickets)
        .values({
          orgId: orgB.id,
          partnerId: partner.id,
          ticketNumber: `B-${randomUUID()}`,
          subject: 'B secret',
          source: 'portal',
        })
        .returning({ id: tickets.id });

      await admin.insert(timeEntries).values({
        partnerId: partner.id,
        orgId: orgB.id,
        ticketId: ticketB.id,
        userId: technician.id,
        startedAt: new Date(),
        endedAt: new Date(),
        durationMinutes: 75,
        isBillable: true,
        billingStatus: 'billed',
        isApproved: true,
        currencyCode: 'USD',
      });

      const context: DbAccessContext = {
        scope: 'organization',
        orgId: orgA.id,
        accessibleOrgIds: [orgA.id],
        accessiblePartnerIds: [],
        userId: null,
        currentPartnerId: null,
      };

      await withDbAccessContext(context, async () => {
        expect(
          (await db.select({
            orgId: securityStatus.orgId,
          }).from(securityStatus)).map((row) => row.orgId),
        ).toEqual([orgA.id]);

        expect(
          (await db.select({
            orgId: securityPostureOrgSnapshots.orgId,
          }).from(securityPostureOrgSnapshots))
            .map((row) => row.orgId),
        ).toEqual([orgA.id]);

        expect(
          (await db.select({
            orgId: backupVerifications.orgId,
          }).from(backupVerifications)).map((row) => row.orgId),
        ).toEqual([orgA.id]);

        const visibleRuns = await db
          .select({ id: reportRuns.id })
          .from(reportRuns);
        expect(visibleRuns.map((row) => row.id)).toContain(runA);
        expect(visibleRuns.map((row) => row.id)).not.toContain(runB);

        await expect(
          db.select({ id: timeEntries.id }).from(timeEntries),
        ).resolves.toEqual([]);

        const usage = await supportUsageForOrg({
          orgId: orgA.id,
          month: new Date().toISOString().slice(0, 7),
          timezone: 'UTC',
          portalUserId: portalA.id,
        });

        expect(
          Object.values(usage.totals).map((value) => value.minutes),
        ).toEqual([0, 0, 0, 0]);
      });
    });

    it('installs every portal visibility query index', async () => {
      const expected = [
        'device_patches_org_installed_at_idx',
        'security_threats_org_detected_at_idx',
        'security_threats_org_resolved_at_idx',
        's1_threats_org_detected_at_idx',
        's1_threats_org_resolved_at_idx',
        'huntress_incidents_org_reported_at_idx',
        'huntress_incidents_org_resolved_at_idx',
        'backup_verifications_org_completed_at_idx',
        'time_entries_org_started_at_idx',
      ];

      const result = await getTestDb().execute<{
        indexname: string;
      }>(sql`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ${expected}
      `);

      expect(new Set(result.rows.map((row) => row.indexname)))
        .toEqual(new Set(expected));
    });
  });
  ```

- [ ] **Step 2: Run the integration test against a live DB and confirm the nine indexes are absent.**

  ```bash
  cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalVisibilityRls.integration.test.ts
  ```

  Expected failure: the index-name set is incomplete. This command requires a live PostgreSQL test database.

- [ ] **Step 3: Add the full idempotent migration and matching Drizzle index declarations.**

  Create `apps/api/migrations/2026-09-28-a-portal-visibility-indexes.sql`:

  ```sql
  -- Portal visibility Wave 1 read-model query indexes.
  -- autoMigrate owns the transaction; do not add BEGIN or COMMIT.

  CREATE INDEX IF NOT EXISTS device_patches_org_installed_at_idx
    ON device_patches (org_id, installed_at)
    WHERE status = 'installed';

  CREATE INDEX IF NOT EXISTS security_threats_org_detected_at_idx
    ON security_threats (org_id, detected_at);

  CREATE INDEX IF NOT EXISTS security_threats_org_resolved_at_idx
    ON security_threats (org_id, resolved_at)
    WHERE resolved_at IS NOT NULL;

  CREATE INDEX IF NOT EXISTS s1_threats_org_detected_at_idx
    ON s1_threats (org_id, detected_at)
    WHERE detected_at IS NOT NULL;

  CREATE INDEX IF NOT EXISTS s1_threats_org_resolved_at_idx
    ON s1_threats (org_id, resolved_at)
    WHERE resolved_at IS NOT NULL;

  CREATE INDEX IF NOT EXISTS huntress_incidents_org_reported_at_idx
    ON huntress_incidents (org_id, reported_at)
    WHERE reported_at IS NOT NULL;

  CREATE INDEX IF NOT EXISTS huntress_incidents_org_resolved_at_idx
    ON huntress_incidents (org_id, resolved_at)
    WHERE resolved_at IS NOT NULL;

  CREATE INDEX IF NOT EXISTS backup_verifications_org_completed_at_idx
    ON backup_verifications (org_id, completed_at);

  CREATE INDEX IF NOT EXISTS time_entries_org_started_at_idx
    ON time_entries (org_id, started_at)
    WHERE org_id IS NOT NULL;
  ```

  Add the matching declarations to each table's real callback. `patches.ts`, `security.ts`, `sentinelOne.ts`, `huntress.ts`, and `backupVerification.ts` use keyed object callbacks; `timeTracking.ts` is the one real array-callback exception. Add `import { sql } from 'drizzle-orm';` to `security.ts`; the other partial-index files already import `sql`.

  ```ts
  // patches.ts — devicePatches callback
  }, (table) => ({
  devicePatchUnique: uniqueIndex('device_patches_device_patch_unique')
    .on(table.deviceId, table.patchId),
  userScopeIdx: index('idx_device_patches_user_scope')
    .on(table.deviceId)
    .where(sql`scope = 'user'`),
  pendingIdx: index('idx_device_patches_pending')
    .on(table.deviceId)
    .where(sql`status = 'pending'`),
  orgInstalledAtIdx: index('device_patches_org_installed_at_idx')
    .on(table.orgId, table.installedAt)
    .where(sql`${table.status} = 'installed'`),
  }));

  // security.ts — securityThreats callback
  }, (table) => ({
  deviceDetectedIdx: index('security_threats_device_detected_idx')
    .on(table.deviceId, table.detectedAt),
  statusIdx: index('security_threats_status_idx').on(table.status),
  deviceStatusDetectedIdx: index('security_threats_device_status_detected_idx')
    .on(table.deviceId, table.status, table.detectedAt),
  orgDetectedAtIdx: index('security_threats_org_detected_at_idx')
    .on(table.orgId, table.detectedAt),
  orgResolvedAtIdx: index('security_threats_org_resolved_at_idx')
    .on(table.orgId, table.resolvedAt)
    .where(sql`${table.resolvedAt} IS NOT NULL`),
  }));

  // sentinelOne.ts — s1Threats callback
  }, (table) => ({
  threatIdx: uniqueIndex('s1_threats_external_idx')
    .on(table.integrationId, table.s1ThreatId),
  orgStatusIdx: index('s1_threats_org_status_idx')
    .on(table.orgId, table.status),
  orgSeverityStatusIdx: index('s1_threats_org_severity_status_idx')
    .on(table.orgId, table.severity, table.status),
  integrationIdx: index('s1_threats_integration_idx')
    .on(table.integrationId),
  integrationDetectedIdx: index('s1_threats_integration_detected_idx')
    .on(table.integrationId, table.detectedAt),
  deviceIdx: index('s1_threats_device_idx').on(table.deviceId),
  orgDetectedAtIdx: index('s1_threats_org_detected_at_idx')
    .on(table.orgId, table.detectedAt)
    .where(sql`${table.detectedAt} IS NOT NULL`),
  orgResolvedAtIdx: index('s1_threats_org_resolved_at_idx')
    .on(table.orgId, table.resolvedAt)
    .where(sql`${table.resolvedAt} IS NOT NULL`),
  }));

  // huntress.ts — huntressIncidents callback
  }, (table) => ({
  incidentIdIdx: uniqueIndex('huntress_incidents_external_idx')
    .on(table.integrationId, table.huntressIncidentId),
  orgStatusIdx: index('huntress_incidents_org_status_idx')
    .on(table.orgId, table.status),
  orgReportedAtIdx: index('huntress_incidents_org_reported_at_idx')
    .on(table.orgId, table.reportedAt)
    .where(sql`${table.reportedAt} IS NOT NULL`),
  orgResolvedAtIdx: index('huntress_incidents_org_resolved_at_idx')
    .on(table.orgId, table.resolvedAt)
    .where(sql`${table.resolvedAt} IS NOT NULL`),
  }));

  // backupVerification.ts — backupVerifications callback
  }, (table) => ({
  orgDeviceIdx: index('backup_verify_org_device_idx')
    .on(table.orgId, table.deviceId),
  statusIdx: index('backup_verify_status_idx').on(table.status),
  orgCompletedAtIdx: index('backup_verifications_org_completed_at_idx')
    .on(table.orgId, table.completedAt),
  }));

  // timeTracking.ts — timeEntries callback
  }, (t) => [
  uniqueIndex('time_entries_one_running_per_user_uq')
    .on(t.userId)
    .where(sqlIsRunning(t)),
  index('time_entries_partner_started_idx').on(t.partnerId, t.startedAt),
  index('time_entries_ticket_idx').on(t.ticketId),
  index('time_entries_user_started_idx').on(t.userId, t.startedAt),
  index('time_entries_org_started_at_idx')
    .on(t.orgId, t.startedAt)
    .where(sql`${t.orgId} IS NOT NULL`),
  ]);
  ```

  This migration adds no table or column. Therefore it requires no tenant-cascade registration, `CORE_TENANT_EXPORT_POLICY` change, RLS coverage allowlist change, policy, or `GRANT`.

- [ ] **Step 4: Run RLS, migration-order, and drift checks green.**

  ```bash
  cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalVisibilityRls.integration.test.ts
  cd apps/api && npx vitest run src/db/autoMigrate.test.ts
  pnpm db:check-drift
  ```

  Expected result: the live-DB test sees only organization A evidence, organization B contributes zero support minutes, all nine indexes exist, migration ordering passes, and Drizzle reports no drift.

- [ ] **Step 5: Commit the index and isolation contract.**

  ```bash
  git add apps/api/migrations/2026-09-28-a-portal-visibility-indexes.sql apps/api/src/__tests__/integration/portalVisibilityRls.integration.test.ts apps/api/src/db/schema/patches.ts apps/api/src/db/schema/security.ts apps/api/src/db/schema/sentinelOne.ts apps/api/src/db/schema/huntress.ts apps/api/src/db/schema/backupVerification.ts apps/api/src/db/schema/timeTracking.ts && git commit -m "feat(portal): index and verify visibility evidence"
  ```

## Wave W03 — Add fail-closed portal visibility gating

### Task 3.1: Persist and export the five visibility flags

**Files:**

- **Create:** `apps/api/migrations/2026-09-28-b-portal-visibility-flags.sql`
- **Modify:** `apps/api/src/db/schema/portal.ts:12-37`
- **Modify:** `apps/api/src/services/tenantExportPolicyRegistry.ts:273`
- **Modify:** `packages/shared/src/validators/portal.ts:3-18`
- **Modify:** `packages/shared/src/validators/portal.test.ts:1-69`
- **Modify:** `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts:1-62`
- **Modify:** `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts:27-236`
- **Test:** `packages/shared/src/validators/portal.test.ts`
- **Test:** `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`
- **Test:** `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
- **Test:** `apps/api/src/db/autoMigrate.test.ts`

The `-a-`/`-b-` infix is intentional: the W02 index migration and W03 flag migration are owned by two independent PRs landing on 2026-09-28, so explicit ordering avoids a same-date lexicographic collision without reusing the closed 2026-08-06 block.

**Interfaces:**

- **Consumes:** Existing `portal_branding` shape-1 `org_id` policy and export-policy entry.
- **Produces:** `enableDashboard`, `enableSecurity`, `enableBackups`, `enableReports`, and `enableSupportUsage`, each `boolean NOT NULL DEFAULT false`.

- [ ] **Step 1: Extend the validator and export-policy tests first.**

  Add to `packages/shared/src/validators/portal.test.ts`:

  ```ts
  it('accepts all portal visibility flags', () => {
    expect(updatePortalSettingsSchema.parse({
      enableDashboard: true,
      enableSecurity: true,
      enableBackups: true,
      enableReports: true,
      enableSupportUsage: true,
    })).toEqual({
      enableDashboard: true,
      enableSecurity: true,
      enableBackups: true,
      enableReports: true,
      enableSupportUsage: true,
    });
  });

  it('rejects non-boolean portal visibility flags', () => {
    expect(updatePortalSettingsSchema.safeParse({
      enableDashboard: 'true',
    }).success).toBe(false);
  });
  ```

  Add this explicit registry assertion to the real live-schema suite `tenant-export-policy.integration.test.ts`:

  ```ts
  it('exports every portal visibility flag', () => {
    const columns = getTenantExportPolicyRegistry()
      .portal_branding?.columns;
    expect(columns).toBeDefined();

    for (const column of [
      'enable_dashboard',
      'enable_security',
      'enable_backups',
      'enable_reports',
      'enable_support_usage',
    ]) {
      expect(columns?.[column]?.decision).toBe('include');
    }
  });
  ```

  In the real `seedTwoOrgs()` helper in `tenantExportErasureRoundtrip.integration.test.ts`, seed one row per organization with distinct values:

  ```ts
  await db.execute(sql`
    INSERT INTO portal_branding (
      org_id,
      enable_dashboard,
      enable_security,
      enable_backups,
      enable_reports,
      enable_support_usage
    ) VALUES
      (${orgA}, true, true, false, true, false),
      (${orgB}, false, false, true, false, true)
  `);
  ```

  In the existing export test, after `JSZip.loadAsync(zipBuffer)`, assert the real snake-case export keys:

  ```ts
  expect(byName.get('portal_branding.json')?.rowCount).toBe(1);
  const portalBrandingRows = JSON.parse(
    await zip.file('portal_branding.json')!.async('string'),
  ) as Array<Record<string, unknown>>;
  expect(portalBrandingRows).toEqual([
    expect.objectContaining({
      org_id: orgA,
      enable_dashboard: true,
      enable_security: true,
      enable_backups: false,
      enable_reports: true,
      enable_support_usage: false,
    }),
  ]);
  ```

  In the erasure test, use the existing `rowCount()` helper around the real `cascadeDeleteOrg()` call:

  ```ts
  expect(await rowCount(db, 'portal_branding', orgA)).toBe(1);
  expect(await rowCount(db, 'portal_branding', orgB)).toBe(1);

  const stats = await cascadeDeleteOrg(
    orgA,
    PERFORMED_BY,
    PERFORMED_EMAIL,
  );

  expect(await rowCount(db, 'portal_branding', orgA)).toBe(0);
  expect(await rowCount(db, 'portal_branding', orgB)).toBe(1);
  expect(stats.tablesDeleted.portal_branding).toBe(1);
  expect(stats.totalRowsDeleted).toBeGreaterThanOrEqual(8);
  ```

  Update the adjacent stats comment from seven target-org rows to eight: the new org A `portal_branding` row is now part of the seeded erasure contract.

- [ ] **Step 2: Run the focused tests and confirm the fields are rejected or absent.**

  ```bash
  cd packages/shared && npx vitest run src/validators/portal.test.ts
  cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
  ```

  Expected failure: the strict validator rejects the new keys, the export registry omits them, and the live schema has no columns for the round-trip fixture.

- [ ] **Step 3: Add the schema fields, full migration, validator keys, and export registration.**

  Add to `portalBranding` in `apps/api/src/db/schema/portal.ts`:

  ```ts
  enableDashboard: boolean('enable_dashboard')
    .notNull()
    .default(false),
  enableSecurity: boolean('enable_security')
    .notNull()
    .default(false),
  enableBackups: boolean('enable_backups')
    .notNull()
    .default(false),
  enableReports: boolean('enable_reports')
    .notNull()
    .default(false),
  enableSupportUsage: boolean('enable_support_usage')
    .notNull()
    .default(false),
  ```

  Create `apps/api/migrations/2026-09-28-b-portal-visibility-flags.sql`:

  ```sql
  -- Portal visibility Wave 1 feature flags.
  -- Existing portal_branding RLS and grants cover these columns.
  -- autoMigrate owns the transaction; do not add BEGIN or COMMIT.

  ALTER TABLE portal_branding
    ADD COLUMN IF NOT EXISTS enable_dashboard
      boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS enable_security
      boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS enable_backups
      boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS enable_reports
      boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS enable_support_usage
      boolean NOT NULL DEFAULT false;
  ```

  Extend the shared settings validator:

  ```ts
  enableDashboard: z.boolean().optional(),
  enableSecurity: z.boolean().optional(),
  enableBackups: z.boolean().optional(),
  enableReports: z.boolean().optional(),
  enableSupportUsage: z.boolean().optional(),
  ```

  Add these exact snake-case columns to the `included` array passed to `tablePolicy(...)` for the `portal_branding` entry in `CORE_TENANT_EXPORT_POLICY`:

  ```ts
  'enable_dashboard',
  'enable_security',
  'enable_backups',
  'enable_reports',
  'enable_support_usage',
  ```

  Registration audit:

  ```text
  tenantCascade.ts:
    no change; portal_branding is already registered at line 313.

  rls-coverage.integration.test.ts:
    no allowlist change; portal_branding remains auto-discovered shape 1.

  tenantExportPolicyRegistry.ts:
    append all five columns to the portal_branding tablePolicy included array.

  GRANT:
    no new GRANT; this migration adds columns to an already-granted table.

  RLS:
    no new policy; existing forced organization RLS applies to the whole table.
  ```

- [ ] **Step 4: Run validator, export, migration, and drift checks green.**

  ```bash
  cd packages/shared && npx vitest run src/validators/portal.test.ts
  cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
  cd apps/api && npx vitest run src/db/autoMigrate.test.ts
  pnpm db:check-drift
  ```

  Expected result: all five fields validate, export policy covers them, migration ordering passes, and schema drift is empty.

- [ ] **Step 5: Commit the visibility columns.**

  ```bash
  git add apps/api/migrations/2026-09-28-b-portal-visibility-flags.sql apps/api/src/db/schema/portal.ts apps/api/src/services/tenantExportPolicyRegistry.ts packages/shared/src/validators/portal.ts packages/shared/src/validators/portal.test.ts apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts && git commit -m "feat(portal): persist visibility flags"
  ```

### Task 3.2: Extend the MSP settings API and define the report-provisioning seam

**Files:**

- **Create:** `apps/api/src/services/portal/portalFlags.ts`
- **Create:** `apps/api/src/services/portal/portalFlags.test.ts`
- **Modify:** `apps/api/src/routes/orgPortalSettings.ts:18-70,90-147`
- **Modify:** `apps/api/src/routes/orgPortalSettings.test.ts:4-98,121-252`
- **Test:** `apps/api/src/services/portal/portalFlags.test.ts`
- **Test:** `apps/api/src/routes/orgPortalSettings.test.ts`

**Interfaces:**

- **Consumes:** The five Drizzle properties introduced in Task 3.1.
- **Produces:**
  ```ts
  export const PORTAL_VISIBILITY_FLAG_KEYS: readonly [
    'enableDashboard',
    'enableSecurity',
    'enableBackups',
    'enableReports',
    'enableSupportUsage',
  ];

  export type PortalVisibilityFlag =
    typeof PORTAL_VISIBILITY_FLAG_KEYS[number];

  export type PortalVisibilityFlags =
    Record<PortalVisibilityFlag, boolean>;

  export async function onPortalFlagsChanged(args: {
    orgId: string;
    createdBy: string;
    requested: Partial<PortalVisibilityFlags>;
    current: PortalVisibilityFlags;
  }): Promise<void>;
  ```

- [ ] **Step 1: Write failing route tests for defaults, persistence, and seam invocation.**

  Add to `apps/api/src/routes/orgPortalSettings.test.ts`:

  ```ts
  const onPortalFlagsChanged = vi.hoisted(() => vi.fn());

  vi.mock('../services/portal/portalFlags', async () => {
    const actual = await vi.importActual<
      typeof import('../services/portal/portalFlags')
    >('../services/portal/portalFlags');

    return {
      ...actual,
      onPortalFlagsChanged,
    };
  });

  it('returns false defaults for every visibility flag', async () => {
    dbSelectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([]);

    const response = await makeApp().request(
      `/organizations/${ORG_ID}/portal-settings`,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      enableDashboard: false,
      enableSecurity: false,
      enableBackups: false,
      enableReports: false,
      enableSupportUsage: false,
    });
  });

  it('persists visibility flags and invokes the W09 seam', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([{
      ...FULL_ROW,
      enableDashboard: true,
      enableReports: true,
    }]);

    const response = await makeApp().request(
      `/organizations/${ORG_ID}/portal-settings`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enableDashboard: true,
          enableReports: true,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      enableDashboard: true,
      enableSecurity: false,
      enableBackups: false,
      enableReports: true,
      enableSupportUsage: false,
    });
    expect(onPortalFlagsChanged).toHaveBeenCalledWith({
      orgId: ORG_ID,
      createdBy: 'u-1',
      requested: {
        enableDashboard: true,
        enableReports: true,
      },
      current: {
        enableDashboard: true,
        enableSecurity: false,
        enableBackups: false,
        enableReports: true,
        enableSupportUsage: false,
      },
    });
  });

  it('does not invoke the visibility seam for unrelated settings', async () => {
    dbSelectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    dbUpsertReturning.mockResolvedValue([FULL_ROW]);

    await makeApp().request(
      `/organizations/${ORG_ID}/portal-settings`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          supportEmail: 'support@example.test',
        }),
      },
    );

    expect(onPortalFlagsChanged).not.toHaveBeenCalled();
  });
  ```

  Extend the real hoisted harness rather than adding a second state object: use `dbSelectResult` for the two GET selects and `dbUpsertReturning` for PATCH. Add the five mock columns to `portalBranding`:

  ```ts
  enableDashboard: 'enableDashboard',
  enableSecurity: 'enableSecurity',
  enableBackups: 'enableBackups',
  enableReports: 'enableReports',
  enableSupportUsage: 'enableSupportUsage',
  ```

  Add the five values to `FULL_ROW` and to both existing exact GET response objects:

  ```ts
  enableDashboard: false,
  enableSecurity: false,
  enableBackups: false,
  enableReports: false,
  enableSupportUsage: false,
  ```

- [ ] **Step 2: Run the route test and confirm the new fields and seam are missing.**

  ```bash
  cd apps/api && npx vitest run src/routes/orgPortalSettings.test.ts
  ```

  Expected failure: returned DTOs omit the visibility flags and the hook is never called.

- [ ] **Step 3: Implement the seam and extend GET/PATCH projections.**

  Create `apps/api/src/services/portal/portalFlags.ts`:

  ```ts
  export const PORTAL_VISIBILITY_FLAG_KEYS = [
    'enableDashboard',
    'enableSecurity',
    'enableBackups',
    'enableReports',
    'enableSupportUsage',
  ] as const;

  export type PortalVisibilityFlag =
    typeof PORTAL_VISIBILITY_FLAG_KEYS[number];

  export type PortalVisibilityFlags =
    Record<PortalVisibilityFlag, boolean>;

  export async function onPortalFlagsChanged(args: {
    orgId: string;
    createdBy: string;
    requested: Partial<PortalVisibilityFlags>;
    current: PortalVisibilityFlags;
  }): Promise<void> {
    void args;
  }
  ```

  Extend every stage of the route's real allowlisted response pipeline. Add the fields to `PORTAL_SETTINGS_DEFAULTS`:

  ```ts
  enableDashboard: false,
  enableSecurity: false,
  enableBackups: false,
  enableReports: false,
  enableSupportUsage: false,
  ```

  Add the corresponding booleans to `PortalSettingsRow`:

  ```ts
  enableDashboard: boolean;
  enableSecurity: boolean;
  enableBackups: boolean;
  enableReports: boolean;
  enableSupportUsage: boolean;
  ```

  Add the columns to `portalSettingsColumns()`:

  ```ts
  enableDashboard: portalBranding.enableDashboard,
  enableSecurity: portalBranding.enableSecurity,
  enableBackups: portalBranding.enableBackups,
  enableReports: portalBranding.enableReports,
  enableSupportUsage: portalBranding.enableSupportUsage,
  ```

  Add the fields to the row-present branch of `toResponse()`:

  ```ts
  enableDashboard: row.enableDashboard,
  enableSecurity: row.enableSecurity,
  enableBackups: row.enableBackups,
  enableReports: row.enableReports,
  enableSupportUsage: row.enableSupportUsage,
  ```

  The existing `.values({ orgId: org.id, ...body })` and conflict `set: { ...body, updatedAt: new Date() }` already persist each defined strict-schema field. After the upsert returns, invoke the seam only when a visibility key was requested. Read the real staff auth context and use the real `org.id` and returned `row` symbols:

  ```ts
  const auth = c.get('auth') as AuthContext;
  const requested = Object.fromEntries(
    PORTAL_VISIBILITY_FLAG_KEYS
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  ) as Partial<PortalVisibilityFlags>;

  if (Object.keys(requested).length > 0) {
    await onPortalFlagsChanged({
      orgId: org.id,
      createdBy: auth.user.id,
      requested,
      current: {
        enableDashboard: row.enableDashboard,
        enableSecurity: row.enableSecurity,
        enableBackups: row.enableBackups,
        enableReports: row.enableReports,
        enableSupportUsage: row.enableSupportUsage,
      },
    });
  }
  ```

  The seam intentionally remains a no-op in W03. W09 replaces its body with idempotent report-definition provisioning whenever `requested.enableReports === true`, including retries where `current.enableReports` was already true.

- [ ] **Step 4: Run the seam and route tests green.**

  ```bash
  cd apps/api && npx vitest run src/services/portal/portalFlags.test.ts src/routes/orgPortalSettings.test.ts
  ```

  Expected result: GET defaults fail closed, PATCH persists all five flags, and report provisioning has one named extension seam.

- [ ] **Step 5: Commit the settings API extension.**

  ```bash
  git add apps/api/src/services/portal/portalFlags.ts apps/api/src/services/portal/portalFlags.test.ts apps/api/src/routes/orgPortalSettings.ts apps/api/src/routes/orgPortalSettings.test.ts && git commit -m "feat(portal): expose visibility settings"
  ```

### Task 3.3: Add strict API gates, protected mounts, and authenticated branding flags

**Files:**

- **Create:** `apps/api/src/routes/portal/dashboard.ts`
- **Create:** `apps/api/src/routes/portal/security.ts`
- **Create:** `apps/api/src/routes/portal/backups.ts`
- **Create:** `apps/api/src/routes/portal/reports.ts`
- **Create:** `apps/api/src/routes/portal/featureFlags.test.ts`
- **Modify:** `apps/api/src/routes/portal/featureFlags.ts:1-49`
- **Modify:** `apps/api/src/routes/portal/branding.ts:1-106`
- **Create:** `apps/api/src/routes/portal/branding.test.ts`
- **Modify:** `apps/api/src/routes/portal/index.ts:1-37`
- **Test:** `apps/api/src/routes/portal/featureFlags.test.ts`
- **Test:** `apps/api/src/routes/portal/branding.test.ts`

**Interfaces:**

- **Consumes:** `PortalVisibilityFlag` from `apps/api/src/services/portal/portalFlags.ts`.
- **Produces:**
  ```ts
  export function createPortalFeatureGateStrict(
    flag: PortalVisibilityFlag,
  ): MiddlewareHandler;
  ```
  and protected route mounts for `/dashboard`, `/security`, `/backups`, `/reports`, and `/tickets/usage`.

- [ ] **Step 1: Write failing strict-gate and branding SQL tests.**

  In `featureFlags.test.ts`, use the neighboring portal route FIFO Drizzle mock and assert:

  ```ts
  it.each([
    ['enableDashboard', 'PORTAL_DASHBOARD_DISABLED'],
    ['enableSecurity', 'PORTAL_SECURITY_DISABLED'],
    ['enableBackups', 'PORTAL_BACKUPS_DISABLED'],
    ['enableReports', 'PORTAL_REPORTS_DISABLED'],
    ['enableSupportUsage', 'PORTAL_SUPPORT_USAGE_DISABLED'],
  ] as const)(
    'fails closed for %s',
    async (flag, code) => {
      dbState.rows = [];
      const app = createTestApp(flag);
      const response = await app.request('/protected');

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code });

      const query = new PgDialect().sqlToQuery(
        dbState.where as SQL,
      );
      expect(query.sql).toContain(
        '"portal_branding"."org_id" = $1',
      );
      expect(query.params).toEqual([ORG_ID]);
    },
  );

  it('continues only when the strict flag is true', async () => {
    dbState.rows = [{ enableSecurity: true }];
    const response = await createTestApp(
      'enableSecurity',
    ).request('/protected');

    expect(response.status).toBe(200);
  });
  ```

  Add to `branding.test.ts`:

  ```ts
  it('returns all visibility flags for the authenticated org', async () => {
    dbState.rows = [{
      enableDashboard: true,
      enableSecurity: true,
      enableBackups: false,
      enableReports: true,
      enableSupportUsage: false,
    }];

    const response = await authenticatedApp.request('/branding');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      branding: {
        enableDashboard: true,
        enableSecurity: true,
        enableBackups: false,
        enableReports: true,
        enableSupportUsage: false,
      },
    });

    const query = new PgDialect().sqlToQuery(
      dbState.where as SQL,
    );
    expect(query.sql).toContain(
      '"portal_branding"."org_id" = $1',
    );
    expect(query.params).toEqual([ORG_ID]);
  });
  ```

- [ ] **Step 2: Run the focused API tests and confirm strict gating and flags do not exist.**

  ```bash
  cd apps/api && npx vitest run src/routes/portal/featureFlags.test.ts src/routes/portal/branding.test.ts
  ```

  Expected failure: `createPortalFeatureGateStrict` is absent and authenticated branding omits the five flags.

- [ ] **Step 3: Implement strict gates, route hubs, mount ordering, and branding projection.**

  Extend `featureFlags.ts`:

  ```ts
  import type { MiddlewareHandler } from 'hono';
  import type {
    PortalVisibilityFlag,
  } from '../../services/portal/portalFlags';

  const STRICT_PORTAL_FEATURES: Record<
    PortalVisibilityFlag,
    { error: string; code: string }
  > = {
    enableDashboard: {
      error: 'Dashboard is not enabled for this portal',
      code: 'PORTAL_DASHBOARD_DISABLED',
    },
    enableSecurity: {
      error: 'Security visibility is not enabled for this portal',
      code: 'PORTAL_SECURITY_DISABLED',
    },
    enableBackups: {
      error: 'Backup visibility is not enabled for this portal',
      code: 'PORTAL_BACKUPS_DISABLED',
    },
    enableReports: {
      error: 'Reports are not enabled for this portal',
      code: 'PORTAL_REPORTS_DISABLED',
    },
    enableSupportUsage: {
      error: 'Support usage is not enabled for this portal',
      code: 'PORTAL_SUPPORT_USAGE_DISABLED',
    },
  };

  export function createPortalFeatureGateStrict(
    flag: PortalVisibilityFlag,
  ): MiddlewareHandler {
    return async (c, next) => {
      const auth = c.get('portalAuth');
      if (!auth) {
        return c.json({ error: 'Authentication required' }, 401);
      }

      const [row] = await db
        .select({ [flag]: portalBranding[flag] })
        .from(portalBranding)
        .where(eq(portalBranding.orgId, auth.user.orgId))
        .limit(1);

      if (row?.[flag] !== true) {
        return c.json(STRICT_PORTAL_FEATURES[flag], 403);
      }

      return next();
    };
  }
  ```

  Create the four route hubs:

  ```ts
  // dashboard.ts
  import { Hono } from 'hono';
  export const portalDashboardRoutes = new Hono();

  // security.ts
  import { Hono } from 'hono';
  export const portalSecurityRoutes = new Hono();

  // backups.ts
  import { Hono } from 'hono';
  export const portalBackupRoutes = new Hono();

  // reports.ts
  import { Hono } from 'hono';
  export const portalReportRoutes = new Hono();
  ```

  In `portal/index.ts`, import the four new route constants and `createPortalFeatureGateStrict`. Keep `authRoutes` public, but move the `brandingRoutes` mount after an exact authenticated `/branding` middleware line; exact `/branding/:domain` remains public because the exact middleware path does not match it:

  ```ts
  portalRoutes.route('/', authRoutes);
  portalRoutes.use('/branding', portalAuthMiddleware);
  portalRoutes.route('/', brandingRoutes);
  ```

  Then mount authentication first, strict gates second, and the route modules at root. Root mounting matches every existing portal module (`deviceRoutes`, `ticketRoutes`, and the others) and allows later waves to add absolute `/dashboard/...`, `/security/...`, `/backups/...`, and `/reports/...` handlers without doubled paths:

  ```ts
  portalRoutes.use('/dashboard/*', portalAuthMiddleware);
  portalRoutes.use(
    '/dashboard/*',
    createPortalFeatureGateStrict('enableDashboard'),
  );
  portalRoutes.use('/security/*', portalAuthMiddleware);
  portalRoutes.use(
    '/security/*',
    createPortalFeatureGateStrict('enableSecurity'),
  );
  portalRoutes.use('/backups/*', portalAuthMiddleware);
  portalRoutes.use(
    '/backups/*',
    createPortalFeatureGateStrict('enableBackups'),
  );
  portalRoutes.use('/reports/*', portalAuthMiddleware);
  portalRoutes.use(
    '/reports/*',
    createPortalFeatureGateStrict('enableReports'),
  );
  portalRoutes.use('/tickets/usage', portalAuthMiddleware);
  portalRoutes.use(
    '/tickets/usage',
    createPortalFeatureGateStrict('enableSupportUsage'),
  );

  portalRoutes.use('/tickets/*', async (c, next) => {
    if (c.req.path.endsWith('/tickets/usage')) {
      return next();
    }
    return portalAuthMiddleware(c, next);
  });
  portalRoutes.use('/tickets/*', async (c, next) => {
    if (c.req.path.endsWith('/tickets/usage')) {
      return next();
    }
    return portalTicketsEnabledMiddleware(c, next);
  });

  portalRoutes.route('/', portalDashboardRoutes);
  portalRoutes.route('/', portalSecurityRoutes);
  portalRoutes.route('/', portalBackupRoutes);
  portalRoutes.route('/', portalReportRoutes);
  ```

  Replace both existing generic `/tickets/*` middleware registrations with those two wrappers, so `/tickets/usage` does not hydrate authentication twice and does not inherit `enableTickets`. Keep the existing root `ticketRoutes` mount. Part B adds the `/tickets/usage` handler to that existing module; the two exact middleware lines already protect it. Support usage therefore requires only authentication and `enableSupportUsage`.

  Add the five columns to the new authenticated exact-route projection only:

  ```ts
  enableDashboard: portalBranding.enableDashboard,
  enableSecurity: portalBranding.enableSecurity,
  enableBackups: portalBranding.enableBackups,
  enableReports: portalBranding.enableReports,
  enableSupportUsage: portalBranding.enableSupportUsage,
  ```

  Replace the current host-derived public exact `GET /branding` handler with an authenticated organization projection. Read `const auth = c.get('portalAuth')`, select the same branding columns plus the five flags, and constrain `.where(eq(portalBranding.orgId, auth.user.orgId))`. Return `{ branding }` and use private caching:

  ```ts
  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    vary: ['Authorization', 'Cookie'],
  });
  ```

  Keep `/branding/:domain` and `resolveBrandingByDomain()` unchanged, public, and system-scoped because they resolve visual branding before login; the public projection does not need the authenticated feature flags.

- [ ] **Step 4: Run strict-gate and branding suites green.**

  ```bash
  cd apps/api && npx vitest run src/routes/portal/featureFlags.test.ts src/routes/portal/branding.test.ts
  ```

  Expected result: missing and false branding rows return 403, true flags continue, compiled gate and branding SQL contain the organization predicate, and public domain branding remains available.

- [ ] **Step 5: Commit the API gates and mounts.**

  ```bash
  git add apps/api/src/routes/portal/dashboard.ts apps/api/src/routes/portal/security.ts apps/api/src/routes/portal/backups.ts apps/api/src/routes/portal/reports.ts apps/api/src/routes/portal/featureFlags.ts apps/api/src/routes/portal/featureFlags.test.ts apps/api/src/routes/portal/branding.ts apps/api/src/routes/portal/branding.test.ts apps/api/src/routes/portal/index.ts && git commit -m "feat(portal): enforce visibility gates"
  ```

### Task 3.4: Make portal navigation and landing behavior flag-aware

**Files:**

- **Modify:** `apps/portal/src/lib/api.ts:677-696,938-953`
- **Modify:** `apps/portal/src/lib/api.test.ts:1-220`
- **Modify:** `apps/portal/src/lib/server.ts:9-30`
- **Modify:** `apps/portal/src/lib/navItems.ts:1-43`
- **Modify:** `apps/portal/src/lib/navItems.test.ts:1-59`
- **Modify:** `apps/portal/src/lib/nextPath.ts:16-58`
- **Modify:** `apps/portal/src/lib/nextPath.test.ts:5-14`
- **Modify:** `apps/portal/src/middleware.ts:1-118`
- **Modify:** `apps/portal/src/components/portal/LoginForm.tsx:39-46`
- **Modify:** `apps/portal/src/components/portal/AcceptInviteForm.tsx:81-90`
- **Create:** `apps/portal/src/lib/landing.ts`
- **Create:** `apps/portal/src/lib/landing.test.ts`
- **Test:** `apps/portal/src/lib/navItems.test.ts`
- **Test:** `apps/portal/src/lib/landing.test.ts`
- **Test:** `apps/portal/src/lib/nextPath.test.ts`
- **Test:** `apps/portal/src/lib/api.test.ts`

**Interfaces:**

- **Consumes:** Authenticated `GET /portal/branding` and public `GET /portal/branding/:domain`.
- **Produces:**
  ```ts
  export function buildPortalNavItems(
    branding: Pick<
      BrandingConfig,
      | 'enableTickets'
      | 'enableAssetCheckout'
      | 'enableSelfService'
      | 'enablePasswordReset'
      | 'enableDashboard'
      | 'enableSecurity'
      | 'enableBackups'
      | 'enableReports'
      | 'enableSupportUsage'
    >,
  ): PortalNavItem[];

  export function portalLandingPath(
    branding: Pick<BrandingConfig, 'enableDashboard'>,
  ): '/dashboard' | '/quotes';
  ```

- [ ] **Step 1: Write failing navigation, landing, and safe-next tests.**

  Replace the principal nav cases with:

  ```ts
  it('orders every enabled portal destination', () => {
    expect(buildPortalNavItems({
      enableTickets: true,
      enableAssetCheckout: true,
      enableSelfService: true,
      enablePasswordReset: true,
      enableDashboard: true,
      enableSecurity: true,
      enableBackups: true,
      enableReports: true,
      enableSupportUsage: true,
    }).map((item) => item.href)).toEqual([
      '/dashboard',
      '/quotes',
      '/invoices',
      '/tickets',
      '/devices',
      '/security',
      '/backups',
      '/reports',
      '/assets',
      '/profile',
    ]);
  });

  it('fails closed for new flags and honors self-service false', () => {
    expect(buildPortalNavItems({
      enableTickets: false,
      enableAssetCheckout: false,
      enableSelfService: false,
      enablePasswordReset: true,
      enableDashboard: false,
      enableSecurity: false,
      enableBackups: false,
      enableReports: false,
      enableSupportUsage: false,
    }).map((item) => item.href)).toEqual([
      '/quotes',
      '/invoices',
      '/profile',
    ]);
  });
  ```

  Create `landing.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { portalLandingPath } from './landing';

  describe('portalLandingPath', () => {
    it('uses dashboard only when explicitly enabled', () => {
      expect(portalLandingPath({
        enableDashboard: true,
      })).toBe('/dashboard');
      expect(portalLandingPath({
        enableDashboard: false,
      })).toBe('/quotes');
      expect(portalLandingPath({})).toBe('/quotes');
    });
  });
  ```

  Add safe deep-link cases to `nextPath.test.ts`:

  ```ts
  it.each([
    '/dashboard',
    '/security/devices?page=2',
    '/backups/devices',
    '/reports',
  ])('accepts the protected portal path %s', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });
  ```

  Add to `api.test.ts`, using its existing `vi.stubGlobal('fetch', ...)` pattern:

  ```ts
  it('loads public branding by encoded domain', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        branding: { name: 'Customer Portal' },
      }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const result = await portalApi.getBrandingByDomain(
      'customer portal.example',
    );

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/portal/branding/customer%20portal.example',
    );
    expect(result.data).toEqual({ name: 'Customer Portal' });
    vi.unstubAllGlobals();
  });
  ```

- [ ] **Step 2: Run the portal tests and confirm the new flags and destinations are absent.**

  ```bash
  cd apps/portal && npx vitest run src/lib/navItems.test.ts src/lib/landing.test.ts src/lib/nextPath.test.ts src/lib/api.test.ts
  ```

  Expected failure: new navigation entries, landing helper, branding fields, and protected deep links are missing.

- [ ] **Step 3: Implement the API fields, exact nav order, and root redirect.**

  Extend `BrandingConfig`:

  ```ts
  enableDashboard?: boolean;
  enableSecurity?: boolean;
  enableBackups?: boolean;
  enableReports?: boolean;
  enableSupportUsage?: boolean;
  ```

  Add the public-domain API helper beside `portalApi.getBranding`, using the real `apiGet` response shape and configuration type:

  ```ts
  getBrandingByDomain: async (
    domain: string,
    config: ApiRequestConfig = {},
  ): Promise<ApiResponse<BrandingConfig>> => {
    const response = await apiGet<{ branding: BrandingConfig }>(
      `/portal/branding/${encodeURIComponent(domain)}`,
      config,
    );
    if (!response.data) {
      return {
        error: response.error,
        statusCode: response.statusCode,
        headers: response.headers,
      };
    }

    return {
      data: response.data.branding,
      statusCode: response.statusCode,
      headers: response.headers,
    };
  },
  ```

  Replace `loadPortalBranding` in `lib/server.ts` with the concrete session-aware branch below. It uses the real portal-session cookie helper, authenticated exact branding for a session, forwarded host for anonymous requests, and only falls back to public-domain branding when an authenticated request returns 401:

  ```ts
  import { hasPortalSessionCookie } from './session';

  function brandingDomain(request: Request): string {
    const forwardedHost = request.headers
      .get('x-forwarded-host')
      ?.split(',')[0]
      ?.trim();
    const host = forwardedHost
      || request.headers.get('host')
      || new URL(request.url).host;
    return host.split(':')[0] || '';
  }

  export async function loadPortalBranding(
    request: Request,
  ): Promise<BrandingConfig> {
    const config = buildServerApiConfig(request);
    const domain = brandingDomain(request);
    let response = hasPortalSessionCookie(request)
      ? await portalApi.getBranding(config)
      : await portalApi.getBrandingByDomain(domain, config);

    if (!response.data && response.statusCode === 401) {
      response = await portalApi.getBrandingByDomain(domain, config);
    }

    if (!response.data && response.statusCode !== 404) {
      console.error('[portal] branding load failed', {
        statusCode: response.statusCode,
        error: response.error,
      });
    }
    return { ...defaultBranding, ...(response.data ?? {}) };
  }
  ```

  Create `landing.ts`:

  ```ts
  import type { BrandingConfig } from './api';

  export function portalLandingPath(
    branding: Pick<BrandingConfig, 'enableDashboard'>,
  ): '/dashboard' | '/quotes' {
    return branding.enableDashboard === true
      ? '/dashboard'
      : '/quotes';
  }
  ```

  Build navigation in this exact order:

  ```ts
  export function buildPortalNavItems(
    branding: Pick<
      BrandingConfig,
      | 'enableTickets'
      | 'enableAssetCheckout'
      | 'enableSelfService'
      | 'enablePasswordReset'
      | 'enableDashboard'
      | 'enableSecurity'
      | 'enableBackups'
      | 'enableReports'
      | 'enableSupportUsage'
    >,
  ): PortalNavItem[] {
    return [
      branding.enableDashboard === true
        ? { href: '/dashboard', label: 'Dashboard' }
        : null,
      { href: '/quotes', label: 'Proposals' },
      { href: '/invoices', label: 'Invoices' },
      branding.enableTickets !== false
        ? { href: '/tickets', label: 'Support' }
        : null,
      branding.enableSelfService !== false
        ? { href: '/devices', label: 'Devices' }
        : null,
      branding.enableSecurity === true
        ? { href: '/security', label: 'Security' }
        : null,
      branding.enableBackups === true
        ? { href: '/backups', label: 'Backups' }
        : null,
      branding.enableReports === true
        ? { href: '/reports', label: 'Reports' }
        : null,
      branding.enableAssetCheckout === true
        ? { href: '/assets', label: 'Equipment' }
        : null,
      { href: '/profile', label: 'Profile' },
    ].filter((item): item is PortalNavItem => item !== null);
  }
  ```

  Extend the real safe-next allowlist:

  ```ts
  const ALLOWED_PREFIXES = [
    '/quotes',
    '/invoices',
    '/tickets',
    '/devices',
    '/assets',
    '/profile',
    '/dashboard',
    '/security',
    '/backups',
    '/reports',
  ];
  ```

  In `middleware.ts`, import `loadPortalBranding` and `portalLandingPath`, extend the real protected prefix array, remove the fixed `DEFAULT_LANDING`, and replace the redirect branch with:

  ```ts
  const protectedPrefixes = [
    '/devices',
    '/tickets',
    '/assets',
    '/profile',
    '/quotes',
    '/invoices',
    '/dashboard',
    '/security',
    '/backups',
    '/reports',
  ];

  function loginWithNext(pathname: string, search: string): string {
    const target = `${pathname}${search}`;
    if (pathname === '/') return withBase('/login');
    return withBase(`/login?next=${encodeURIComponent(target)}`);
  }

  async function authenticatedLanding(request: Request) {
    return portalLandingPath(await loadPortalBranding(request));
  }

  // Inside onRequest, after `hasSession` is computed:
  if (pathname === '/') {
    if (!hasSession) {
      return context.redirect(withBase('/login'), 302);
    }
    return context.redirect(
      withBase(await authenticatedLanding(context.request)),
      302,
    );
  }

  if (isProtectedPath(pathname) && !hasSession) {
    return context.redirect(
      loginWithNext(pathname, context.url.search),
      302,
    );
  }

  if (hasSession && authOnlyPaths.has(pathname)) {
    return context.redirect(
      withBase(await authenticatedLanding(context.request)),
      302,
    );
  }
  ```

  Change the post-login and post-invite fallbacks, preserving an accepted `next` value:

  ```ts
  await navigateTo(next ?? '/', { replace: true });
  await navigateTo(safeNextPath(nextParam) ?? '/', { replace: true });
  ```

  Do not edit `pages/index.astro`. Astro middleware redirects `/` at `middleware.ts:65-67` before that page executes, so changing the page would be dead code; middleware is the single active root decision point.

- [ ] **Step 4: Run portal navigation, API, redirect, and base-path tests green.**

  ```bash
  cd apps/portal && npx vitest run src/lib/navItems.test.ts src/lib/landing.test.ts src/lib/nextPath.test.ts src/lib/api.test.ts src/lib/basePathCoverage.test.ts src/components/portal/AcceptInviteForm.test.tsx
  ```

  Expected result: navigation order matches the specification, new flags fail closed, explicit `enableSelfService: false` hides Devices, and post-login root redirects to Dashboard only when enabled.

- [ ] **Step 5: Commit the portal navigation and redirect behavior.**

  ```bash
  git add apps/portal/src/lib/api.ts apps/portal/src/lib/api.test.ts apps/portal/src/lib/server.ts apps/portal/src/lib/navItems.ts apps/portal/src/lib/navItems.test.ts apps/portal/src/lib/landing.ts apps/portal/src/lib/landing.test.ts apps/portal/src/lib/nextPath.ts apps/portal/src/lib/nextPath.test.ts apps/portal/src/middleware.ts apps/portal/src/components/portal/LoginForm.tsx apps/portal/src/components/portal/AcceptInviteForm.tsx && git commit -m "feat(portal): gate navigation and landing"
  ```

### Task 3.5: Add MSP visibility controls and bulk enablement

**Files:**

- **Modify:** `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx:8-42,57-111,128-156`
- **Modify:** `apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx:7-115`
- **Modify:** `apps/web/src/locales/en/settings.json:975-1015`
- **Modify:** `apps/web/src/locales/de-DE/settings.json:975-1015`
- **Modify:** `apps/web/src/locales/es-419/settings.json:975-1015`
- **Modify:** `apps/web/src/locales/fr-CA/settings.json:975-1015`
- **Modify:** `apps/web/src/locales/fr-FR/settings.json:975-1015`
- **Modify:** `apps/web/src/locales/it-IT/settings.json:975-1015`
- **Modify:** `apps/web/src/locales/pt-BR/settings.json:975-1015`
- **Modify:** `apps/web/src/locales/tr-TR/settings.json:975-1015`
- **Test:** `apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx`
- **Test:** `apps/web/src/lib/i18n/localeParity.test.ts`
- **Test:** `apps/web/src/lib/i18n/translationCoverage.test.ts`

**Interfaces:**

- **Consumes:** Existing `runAction` mutation wrapper from `apps/web/src/lib/runAction.ts`.
- **Produces:** Five independent visibility toggles and `data-testid="org-portal-enable-all-visibility"`.

- [ ] **Step 1: Write failing editor tests for the five flags and bulk action.**

  Extend the real `SETTINGS` fixture with all five fields set to `false`:

  ```ts
  enableDashboard: false,
  enableSecurity: false,
  enableBackups: false,
  enableReports: false,
  enableSupportUsage: false,
  ```

  Then add:

  ```tsx
  it('enables all visibility flags in the local draft', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor
      orgId={ORG_ID}
      onDirty={onDirty}
      onSave={onSave}
    />);

    fireEvent.click(await screen.findByTestId(
      'org-portal-enable-all-visibility',
    ));

    for (const key of [
      'enableDashboard',
      'enableSecurity',
      'enableBackups',
      'enableReports',
      'enableSupportUsage',
    ]) {
      expect((screen.getByTestId(
        `org-portal-toggle-${key}`,
      ) as HTMLInputElement).checked).toBe(true);
    }

    expect(onDirty).toHaveBeenCalled();
  });

  it('saves all visibility flags through the existing runAction path', async () => {
    mockApi();
    render(<OrgPortalSettingsEditor
      orgId={ORG_ID}
      onDirty={onDirty}
      onSave={onSave}
    />);

    fireEvent.click(await screen.findByTestId(
      'org-portal-enable-all-visibility',
    ));
    fireEvent.click(screen.getByTestId(
      'org-portal-save',
    ));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PATCH',
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall![1]!.body))).toMatchObject({
      enableDashboard: true,
      enableSecurity: true,
      enableBackups: true,
      enableReports: true,
      enableSupportUsage: true,
    });
  });
  ```

- [ ] **Step 2: Run the component test and confirm the bulk control is absent.**

  ```bash
  cd apps/web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx
  ```

  Expected failure: the bulk-enable test ID and the five toggle test IDs cannot be found.

- [ ] **Step 3: Add the five settings, visibility group, bulk action, and all locale keys.**

  Extend `PortalSettings`:

  ```ts
  enableDashboard: boolean;
  enableSecurity: boolean;
  enableBackups: boolean;
  enableReports: boolean;
  enableSupportUsage: boolean;
  ```

  Add a dedicated registry:

  ```ts
  type VisibilityToggleKey =
    | 'enableDashboard'
    | 'enableSecurity'
    | 'enableBackups'
    | 'enableReports'
    | 'enableSupportUsage';

  const VISIBILITY_TOGGLES: Array<{
    key: VisibilityToggleKey;
    labelKey: string;
    descriptionKey: string;
  }> = [
    {
      key: 'enableDashboard',
      labelKey: 'orgPortalSettingsEditor.visibility.toggles.enableDashboard.label',
      descriptionKey: 'orgPortalSettingsEditor.visibility.toggles.enableDashboard.description',
    },
    {
      key: 'enableSecurity',
      labelKey: 'orgPortalSettingsEditor.visibility.toggles.enableSecurity.label',
      descriptionKey: 'orgPortalSettingsEditor.visibility.toggles.enableSecurity.description',
    },
    {
      key: 'enableBackups',
      labelKey: 'orgPortalSettingsEditor.visibility.toggles.enableBackups.label',
      descriptionKey: 'orgPortalSettingsEditor.visibility.toggles.enableBackups.description',
    },
    {
      key: 'enableReports',
      labelKey: 'orgPortalSettingsEditor.visibility.toggles.enableReports.label',
      descriptionKey: 'orgPortalSettingsEditor.visibility.toggles.enableReports.description',
    },
    {
      key: 'enableSupportUsage',
      labelKey: 'orgPortalSettingsEditor.visibility.toggles.enableSupportUsage.label',
      descriptionKey: 'orgPortalSettingsEditor.visibility.toggles.enableSupportUsage.description',
    },
  ];
  ```

  Inside `OrgPortalSettingsEditor`, immediately after the existing `update` function, add:

  ```ts
  const enableAllVisibility = () => update({
    enableDashboard: true,
    enableSecurity: true,
    enableBackups: true,
    enableReports: true,
    enableSupportUsage: true,
  });
  ```

  Render the new group:

  ```tsx
  <section>
    <div className="flex items-start justify-between gap-4">
      <div>
        <h3>{t('orgPortalSettingsEditor.visibility.title')}</h3>
        <p>
          {t('orgPortalSettingsEditor.visibility.description')}
        </p>
      </div>
      <button
        type="button"
        data-testid="org-portal-enable-all-visibility"
        onClick={enableAllVisibility}
      >
        {t('orgPortalSettingsEditor.visibility.enableAll')}
      </button>
    </div>

    <div className="mt-4 space-y-3">
      {VISIBILITY_TOGGLES.map(({
        key,
        labelKey,
        descriptionKey,
      }) => (
        <label
          key={key}
          className="flex items-start gap-3 rounded-md border bg-muted/30 p-3"
        >
          <input
            type="checkbox"
            checked={draft[key]}
            onChange={(e) => update({
              [key]: e.target.checked,
            } as Partial<PortalSettings>)}
            className="mt-0.5"
            data-testid={`org-portal-toggle-${key}`}
          />
          <span>
            <span className="block text-sm font-medium">
              {t(/* i18n-dynamic */ labelKey)}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t(/* i18n-dynamic */ descriptionKey)}
            </span>
          </span>
        </label>
      ))}
    </div>
  </section>
  ```

  Keep the PATCH inside the existing `runAction` call. The real `save()` enumerates its request fields, so add the five exact properties inside the existing `JSON.stringify({ ... })` object:

  ```ts
  enableDashboard: draft.enableDashboard,
  enableSecurity: draft.enableSecurity,
  enableBackups: draft.enableBackups,
  enableReports: draft.enableReports,
  enableSupportUsage: draft.enableSupportUsage,
  ```

  Add this exact key shape to all eight `settings.json` files:

  ```json
  {
    "visibility": {
      "title": "Visibility",
      "description": "Choose which service insights this customer can see in the portal.",
      "enableAll": "Enable all visibility",
      "toggles": {
        "enableDashboard": {
          "label": "Dashboard",
          "description": "Show a service-health summary when customers sign in."
        },
        "enableSecurity": {
          "label": "Security",
          "description": "Show security posture, protection, threats, and vulnerabilities."
        },
        "enableBackups": {
          "label": "Backups",
          "description": "Show backup coverage, verification, restore tests, and readiness."
        },
        "enableReports": {
          "label": "Reports",
          "description": "Allow customers to generate and download approved reports."
        },
        "enableSupportUsage": {
          "label": "Support usage",
          "description": "Show month-to-date billable support-time totals."
        }
      }
    }
  }
  ```

  Use genuine localized values in `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, and `tr-TR`; preserve exactly these keys and nesting so both parity and duplicate-English coverage tests pass.

- [ ] **Step 4: Run the component, parity, and translation suites green.**

  ```bash
  cd apps/web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
  ```

  Expected result: bulk enablement checks exactly five toggles, save submits them through `runAction`, failed PATCH behavior remains toasted, and all eight locales pass parity and translation coverage.

- [ ] **Step 5: Commit the MSP visibility controls.**

  ```bash
  git add apps/web/src/components/settings/OrgPortalSettingsEditor.tsx apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx apps/web/src/locales/*/settings.json && git commit -m "feat(portal): add visibility settings controls"
  ```
