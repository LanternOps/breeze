/**
 * Guard: in the targeted set, every *mutating* fetchWithAuth call site — direct
 * or reached through an imported `src/lib/api/*` wrapper — must be lexically
 * wrapped by `runAction(...)` OR carry an explicit, reasoned
 * `// runaction-exempt:` marker (for the legitimate aggregate / inline-feedback
 * handlers). Whole-file allowlist entries (typed service layers, transport
 * stores) are still skipped via RUN_ACTION_ALLOWLIST.
 *
 * This is an AST check (TypeScript compiler API), not a regex/substring scan.
 * The previous version asserted only that the *file* contained the string
 * "runAction" somewhere — so a new bare mutation added next to existing
 * runAction usage passed unconditionally, and `{ method: opts.method }` /
 * `{ method }` / parenthesised URL args were never matched at all. It had no
 * teeth for the realistic regression. This one is call-local and conservative:
 * a non-literal `method` is treated as potentially-mutating. Imported API
 * wrappers are resolved through TypeScript symbols, including aliases and
 * re-exports, instead of relying on a hand-maintained wrapper-name list.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { RUN_ACTION_ALLOWLIST, RUN_ACTION_MIGRATION_BACKLOG } from '../runActionAllowlist';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src
const WEB_ROOT = SRC_ROOT;
const REPO_ROOT = resolve(WEB_ROOT, '../../..');
const API_ROOT = resolve(SRC_ROOT, 'lib/api');
const FIXTURE_ROOT = resolve(__dirname, 'fixtures/no-silent-mutations/src');

// WS-A "targeted set": files that have ADOPTED runAction and must not regress
// to silent mutations. Grows as more handlers migrate (see the backlog).
const TARGET_GLOBS = [
  'src/components/alerts/NotificationChannelsPage.tsx',
  'src/components/alerts/AlertsPage.tsx',
  'src/components/alerts/AlertDetailPage.tsx',
  // Alert verdict feedback (P2-1 Task 15): submitVerdictFeedback is the one
  // runAction-wrapped POST both the list row and the detail page call — a
  // future bare mutation added here would ship unguarded to both.
  'src/components/alerts/AlertVerdictBadge.tsx',
  'src/components/settings/PartnerSettingsPage.tsx',
  'src/components/settings/PartnerAiProviderTab.tsx',
  'src/components/settings/OrgSettingsPage.tsx',
  // Adopted in #3989: every mutation here (org create/delete, site save/delete,
  // and the drag-reorder PATCH that was fully silent) now goes through
  // runAction. Note what this guard does and does not enforce: it checks that
  // each mutating fetch is lexically INSIDE a runAction call, so it catches a
  // new mutation added outside one. It does NOT inspect catch blocks, so it
  // cannot by itself stop a handler routing an error back to setError, whose
  // banner renders behind this page's modals.
  'src/components/settings/OrganizationsPage.tsx',
  // Org merge (org-lifecycle Wave 3): both the preview and the actual merge
  // POST are advisory-then-destructive mutations against a partner's tenant
  // tree, so a silent failure here is exactly the class this guard exists for.
  'src/components/settings/MergeOrgModal.tsx',
  // Org archive (org-lifecycle Wave 5), replacing the org delete flow: the
  // archive POST hides an org, uninstalls its agents, and stops its billing —
  // a silent failure here is exactly the class this guard exists for.
  'src/components/settings/ArchiveOrgModal.tsx',
  'src/components/settings/LoginBrandingCard.tsx',
  'src/components/settings/ConnectSsoCard.tsx',
  'src/components/patches/PatchesPage.tsx',
  'src/components/settings/RolesPage.tsx',
  // AI agent policy rows: a bare fetchWithAuth POST here would silently ship
  // an unreported failure on the surface that governs autonomous agents.
  'src/components/settings/AiAgentsPage.tsx',
  'src/components/settings/AiAgentForm.tsx',
  // Sweep schedules (P2-2, #4189): the section writes partner-wide baselines
  // and per-org overrides that decide what runs against customer machines on a
  // cron, unattended. A silent create/update/delete here is invisible until the
  // next occurrence fires — or fails to.
  'src/components/settings/AiAgentSchedulesSection.tsx',
  'src/components/devices/DeviceInfoTab.tsx',
  'src/components/devices/DevicePatchStatusTab.tsx',
  'src/components/dnsSecurity/DnsSecurityIntegrationsTab.tsx',
  'src/components/dnsSecurity/AddDnsIntegrationModal.tsx',
  'src/components/dnsSecurity/DnsSecurityPoliciesTab.tsx',
  'src/components/dnsSecurity/AddDnsPolicyModal.tsx',
  'src/components/devices/DeviceSoftwareInventory.tsx',
  'src/components/devices/DeviceLinkedProfilesTab.tsx',
  'src/components/devices/DeviceWarrantyCard.tsx',
  'src/components/devices/PossibleReplacementBanner.tsx',
  'src/components/pam/PamRespondModal.tsx',
  'src/components/pam/PamRevokeModal.tsx',
  'src/components/pam/PamRuleModal.tsx',
  'src/components/pam/PamRulesTab.tsx',
  'src/components/settings/TicketCategoriesPage.tsx',
  'src/components/settings/TicketStatusesTab.tsx',
  'src/components/settings/TicketPrioritiesTab.tsx',
  'src/components/settings/InboundEmailCard.tsx',
  'src/components/settings/M365MailboxCard.tsx',
  'src/components/settings/OrgPortalSettingsEditor.tsx',
  'src/components/settings/OrgTicketSettingsEditor.tsx',
  'src/components/alerts/CreateTicketFromAlertDialog.tsx',
  'src/lib/timerActions.ts',
  'src/components/time/TimerWidget.tsx',
  'src/components/time/TimesheetPage.tsx',
  'src/components/tickets/TicketTimeBilling.tsx',
  'src/components/tickets/TicketPartsCard.tsx',
  'src/components/clientAi/OrgsTab.tsx',
  'src/components/clientAi/PolicyEditor.tsx',
  'src/components/clientAi/SessionsTab.tsx',
  'src/components/clientAi/TemplatesTab.tsx',
  'src/components/settings/CatalogItemsTab.tsx',
  'src/components/billing/InvoicesPage.tsx',
  'src/components/billing/InvoiceEditor.tsx',
  'src/components/billing/InvoiceDetail.tsx',
  'src/components/billing/PartnerBillingSettings.tsx',
  'src/components/billing/OrgBillingSettings.tsx',
  'src/components/contracts/ContractEditor.tsx',
  'src/components/contracts/ContractDetail.tsx',
  'src/components/billing/quotes/QuotesPage.tsx',
  'src/components/billing/quotes/QuoteEditor.tsx',
  'src/components/alerts/CorrelatedAlertGroups.tsx',
  'src/components/integrations/SecurityIntegration.tsx',
  // QuickBooks entity mapping workbench: confirm/create/unlink/sync decisions
  // and the income-account save all mutate a partner's accounting linkage —
  // a bare fetchWithAuth here would silently fail a mapping the operator
  // believes was saved.
  'src/components/integrations/QuickbooksMappingWorkbench.tsx',
  'src/components/devices/DeviceVulnerabilitiesTab.tsx',
  'src/components/vulnerabilities/VulnerabilityFleetPage.tsx',
  'src/components/vulnerabilities/SoftwareGroupDrawer.tsx',
  'src/components/vulnerabilities/CveDrawer.tsx',
  'src/components/vulnerabilities/CreateVulnTicketModal.tsx',
  'src/components/vulnerabilities/VulnBulkActionModal.tsx',
  'src/lib/api/vulnerabilities.ts',
  'src/components/settings/TdSynnexEcExpressPanel.tsx',
  'src/components/settings/PartnerServicePrincipalsPage.tsx',
  'src/components/settings/TdSynnexSftpPanel.tsx',
  'src/lib/edr.ts',
  'src/lib/incidents.ts',
  'src/lib/intentApprovals.ts',
  'src/components/approvals/ApprovalsInbox.tsx',
  'src/pages/approvals.astro',
  'src/components/devices/DeviceEdrPanel.tsx',
  'src/components/security/S1ThreatList.tsx',
  'src/components/security/HuntressIncidentList.tsx',
  // Ticket intake/creation: both already route every mutation through
  // runAction, but were never guarded, so a future bare mutation would have
  // shipped with zero CI signal while sibling ticket files stayed covered (#2429).
  'src/components/settings/TicketFormsCard.tsx',
  'src/components/tickets/CreateTicketPage.tsx',
  // Quotes/proposals + contracts send-polish surface: every mutation already
  // routes through runAction (or a typed API wrapper), but these files were
  // never guarded, so a future bare mutation would ship with no CI signal.
  'src/components/billing/quotes/QuoteActions.tsx',
  'src/components/billing/quotes/QuoteDocument.tsx',
  'src/components/contracts/TemplateEditor.tsx',
  'src/components/contracts/DocumentsTab.tsx',
  'src/components/contracts/ContractDocumentsSection.tsx',
  'src/components/contracts/TemplatesTab.tsx',
  'src/components/settings/PartnerCompanyTab.tsx',
  // Invoice/quote money-moment hosts (issue / send / delete / title / line
  // mutations): every mutation already routes through runAction, but the files
  // sat outside the guarded set — a future bare mutation on the highest-stakes
  // billing surfaces would have shipped with zero CI signal (PR #2829 review).
  'src/components/billing/InvoiceActions.tsx',
  'src/components/billing/quotes/QuoteHeaderMeta.tsx',
  'src/components/billing/quotes/QuoteLineRows.tsx',
  // Config-policy delete migrated to runAction (#2950). Its confirmation modal
  // is a fixed full-screen overlay that stays open on failure, so the old
  // page-level error banner was painted behind the scrim — an unrecoverable
  // silent failure, not merely an unguarded one.
  'src/components/configurationPolicies/ConfigurationPoliciesPage.tsx',
  // Quick Support: the create/end mutations mint and revoke live remote-access
  // codes, so a silent failure would leave a tech reading out a dead code or
  // believing a session was torn down when it wasn't.
  'src/components/remote/QuickSupportPage.tsx',
  // PSA connections: create/update/delete/status/test all mutate stored PSA
  // credentials or a live connection's state. They were rewritten with bare
  // fetchWithAuth + setError, which the page's error banner only renders when
  // the connection list is empty — so a failed save on a populated page was
  // silent (#3291 review).
  'src/components/psa/PsaConnectionsPage.tsx',
  // CIS hardening: the whole directory has exactly two mutations (baseline
  // create/update, trigger scan) and both now route through runAction. The scan
  // queues work that changes nothing on screen — the results land minutes later
  // on another tab — so before the migration a queued scan and a no-op looked
  // identical to the tech.
  'src/components/cisHardening/CisBaselineForm.tsx',
  'src/components/cisHardening/CisBaselinesTab.tsx',
  // PSA company import (#3246): the commit creates organizations and sites in
  // the partner's tenant tree from a remote list. A silent failure would leave
  // the tech believing a tenant tree was provisioned when nothing was written.
  'src/components/psa/PsaCompanyImport.tsx',
  // Fleet findings: the lifecycle PATCH (acknowledge/dismiss/reopen) lives in
  // the service, and the two components must not grow their own bare mutations
  // alongside it.
  'src/services/fleetFindings.ts',
  'src/components/fleet/FindingsFeed.tsx',
  'src/components/fleet/FindingDrawer.tsx',
  'src/components/fleet/FixPickerModal.tsx',
  'src/components/fleet/RunProgressPanel.tsx',
  // SSO providers (2026-08-28 pre-release sweep): save already routed through
  // runAction but with no successMessage, while delete and the status toggle
  // bypassed runAction entirely — create/save/delete/toggle all succeeded at
  // the API with no visible confirmation to the admin.
  'src/components/settings/SsoProvidersPage.tsx',
  // Report builder (2026-08-28 pre-release sweep): the create/update POST/PUT
  // returned 201/200 with zero feedback — no toast, redirect, or form reset —
  // so a slow response invited a duplicate-creating double click. The mount at
  // /reports/builder passed no onSubmit, the only success path.
  'src/components/reports/ReportBuilder.tsx',
];

const absoluteFiles: string[] = TARGET_GLOBS.map((rel) => resolve(WEB_ROOT, '..', rel));
const allowAbsolute = new Set(RUN_ACTION_ALLOWLIST.map((a) => resolve(REPO_ROOT, a.file)));

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type Violation = { line: number; snippet: string };
type TypeAwareContext = {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  apiRoot: string;
};

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/**
 * Classify the options argument of a fetchWithAuth call.
 * Returns true if the call is (or might be) a mutation. Conservative: a
 * non-string-literal `method`, a `{ method }` shorthand, a spread with no
 * explicit safe method, or a non-object options arg all count as mutating.
 */
function isMutatingCall(call: ts.CallExpression): boolean {
  const optionsArg = call.arguments[1];
  if (!optionsArg) return false; // single-arg fetchWithAuth(url) === GET

  if (!ts.isObjectLiteralExpression(optionsArg)) {
    // fetchWithAuth(url, opts) — opts could carry any method. Flag it.
    return true;
  }

  let sawSpread = false;
  for (const prop of optionsArg.properties) {
    if (ts.isSpreadAssignment(prop)) {
      sawSpread = true;
      continue;
    }
    const name =
      prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ? prop.name.text
        : null;
    if (name !== 'method') continue;

    if (ts.isShorthandPropertyAssignment(prop)) return true; // { method }
    if (ts.isPropertyAssignment(prop)) {
      const init = prop.initializer;
      if (ts.isStringLiteralLike(init)) {
        const verb = init.text.toUpperCase();
        if (SAFE_METHODS.has(verb)) return false;
        return MUTATING_METHODS.has(verb) ? true : true; // any explicit non-safe verb → flag
      }
      // method: opts.method / cond ? 'PATCH' : 'POST' / `${x}` — can't prove safe.
      return true;
    }
  }
  // No explicit `method`. A spread might inject one → conservative flag;
  // otherwise it defaults to GET (safe).
  return sawSpread;
}

function isWrappedByRunAction(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isCallExpression(cur) && calleeName(cur.expression) === 'runAction') return true;
    cur = cur.parent;
  }
  return false;
}

function resolvedSymbolAt(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  const seen = new Set<ts.Symbol>();
  while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
    seen.add(symbol);
    const target = checker.getAliasedSymbol(symbol);
    if (target === symbol) break;
    symbol = target;
  }
  return symbol;
}

function isInside(root: string, file: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedFile = resolve(file);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${sep}`);
}

/** Whether an imported lib/api export's implementation issues a mutation. */
function isMutatingApiWrapper(call: ts.CallExpression, context: TypeAwareContext): boolean {
  const symbol = resolvedSymbolAt(call.expression, context.checker);
  if (!symbol) return false;

  return (symbol.declarations ?? []).some((declaration) => {
    if (!isInside(context.apiRoot, declaration.getSourceFile().fileName)) return false;

    let mutates = false;
    const visit = (node: ts.Node): void => {
      if (mutates) return;
      if (
        ts.isCallExpression(node) &&
        calleeName(node.expression) === 'fetchWithAuth' &&
        isMutatingCall(node) &&
        !isWrappedByRunAction(node) &&
        !isExempt(declaration.getSourceFile().text, node)
      ) {
        mutates = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
    return mutates;
  });
}

function enclosingStatementStart(node: ts.Node): number {
  let cur: ts.Node = node;
  while (
    cur.parent &&
    !ts.isBlock(cur.parent) &&
    !ts.isSourceFile(cur.parent) &&
    !ts.isModuleBlock(cur.parent) &&
    !ts.isCaseClause(cur.parent) &&
    !ts.isDefaultClause(cur.parent)
  ) {
    cur = cur.parent;
  }
  return cur.getFullStart();
}

function isExempt(src: string, node: ts.Node): boolean {
  // Any `runaction-exempt` marker in the trivia/text between the start of the
  // enclosing statement and the call itself counts. Robust to exact comment
  // attribution (leading-comment-range edge cases) and to the for-loop case.
  const from = enclosingStatementStart(node);
  const window = src.slice(from, node.getStart());
  return /runaction-exempt/i.test(window);
}

function findViolations(
  src: string,
  label = 'sample.tsx',
  context?: TypeAwareContext,
): Violation[] {
  const sf = context?.sourceFile ??
    ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const directMutation =
        calleeName(node.expression) === 'fetchWithAuth' && isMutatingCall(node);
      const wrapperMutation = Boolean(context && isMutatingApiWrapper(node, context));
      if (
        (directMutation || wrapperMutation) &&
        !isWrappedByRunAction(node) &&
        !isExempt(src, node)
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        violations.push({
          line: line + 1,
          snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

// ─── Self-check: the analyzer itself has teeth ──────────────────────────────
describe('guard self-checks (AST analyzer)', () => {
  it('flags a bare mutating call not wrapped by runAction', () => {
    expect(findViolations(`fetchWithAuth('/x', { method: 'POST', body: '{}' });`)).toHaveLength(1);
  });

  it('does NOT flag a call wrapped by runAction', () => {
    const src = `runAction({ request: () => fetchWithAuth('/x', { method: 'POST' }), errorFallback: 'e' });`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('does NOT flag a GET (explicit or single-arg)', () => {
    expect(findViolations(`fetchWithAuth('/x', { method: 'GET' });`)).toHaveLength(0);
    expect(findViolations(`fetchWithAuth('/x');`)).toHaveLength(0);
    expect(findViolations(`fetchWithAuth('/x', { headers: { a: '1' } });`)).toHaveLength(0);
  });

  it('flags a non-literal method (the old regex missed `{ method: opts.method }`)', () => {
    expect(findViolations(`fetchWithAuth(u, { method: opts.method, body: b });`)).toHaveLength(1);
  });

  it('flags a shorthand `{ method }` (old regex missed it)', () => {
    expect(findViolations(`const method='PUT'; fetchWithAuth(u, { method });`)).toHaveLength(1);
  });

  it('flags a parenthesised-URL mutation (old `[^)]*` regex could not cross `)`)', () => {
    expect(findViolations('fetchWithAuth(`/x/${build(id)}`, { method: \'DELETE\' });')).toHaveLength(1);
  });

  it('flags a non-object options arg conservatively', () => {
    expect(findViolations(`fetchWithAuth(u, opts);`)).toHaveLength(1);
  });

  it('honours an explicit runaction-exempt marker on the enclosing statement', () => {
    const src = `// runaction-exempt: aggregate\nconst r = await fetchWithAuth('/x', { method: 'POST' });`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('honours a runaction-exempt marker inside a for-loop body', () => {
    const src = `for (const id of ids) {\n  // runaction-exempt: inline UI\n  const r = await fetchWithAuth(\`/x/\${id}\`, { method: 'POST' });\n}`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('still flags a NEW bare mutation added next to existing runAction usage (the realistic regression)', () => {
    const src = `
      await runAction({ request: () => fetchWithAuth('/a', { method: 'POST' }), errorFallback: 'e' });
      await fetchWithAuth('/sneaky', { method: 'DELETE' });
    `;
    // The file "contains runAction" — the OLD substring check passed this.
    const v = findViolations(src);
    expect(v).toHaveLength(1);
    expect(v[0].snippet).toContain('/sneaky');
  });

  it('allowlisted path is present in the allowlist Set', () => {
    const entry = RUN_ACTION_ALLOWLIST[0];
    expect(entry).toBeDefined();
    expect(allowAbsolute.has(resolve(REPO_ROOT, entry.file))).toBe(true);
  });

  it('flags an imported typed mutation wrapper through aliases and API re-exports', () => {
    const componentPath = resolve(FIXTURE_ROOT, 'components/QuoteActions.tsx');
    const apiRoot = resolve(FIXTURE_ROOT, 'lib/api');
    const program = ts.createProgram({
      rootNames: [componentPath],
      options: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    const sourceFile = program.getSourceFile(componentPath);
    expect(sourceFile).toBeDefined();
    expect(
      findViolations(sourceFile!.text, componentPath, {
        sourceFile: sourceFile!,
        checker: program.getTypeChecker(),
        apiRoot,
      }),
    ).toHaveLength(1);
  });
});

// ─── Backlog integrity check ─────────────────────────────────────────────────
describe('migration backlog integrity', () => {
  it('backlog is non-empty (debt is tracked)', () => {
    expect(RUN_ACTION_MIGRATION_BACKLOG.length).toBeGreaterThan(0);
  });

  it('every backlog entry is a string path under apps/web/src/', () => {
    for (const entry of RUN_ACTION_MIGRATION_BACKLOG) {
      expect(typeof entry).toBe('string');
      expect(entry.startsWith('apps/web/src/')).toBe(true);
    }
  });
});

// ─── Main guard ─────────────────────────────────────────────────────────────
describe('no silent mutations in targeted set', () => {
  const configPath = resolve(WEB_ROOT, '..', 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  // .astro files aren't a script kind the TS compiler recognizes, so it never
  // includes them in the program — only feed it files TS can natively parse
  // (.ts/.tsx). Anything else (e.g. .astro) falls back to the legacy
  // no-program, no-wrapper-resolution scan below.
  const TS_NATIVE_EXTENSIONS = new Set(['.ts', '.tsx']);
  const programFiles = absoluteFiles.filter((f) => TS_NATIVE_EXTENSIONS.has(extname(f)));
  const program = ts.createProgram({ rootNames: programFiles, options: parsedConfig.options });
  const checker = program.getTypeChecker();

  it('finds files to scan', () => {
    // 104: 99 since #3989 added OrganizationsPage.tsx, plus MergeOrgModal.tsx
    // (org-lifecycle Wave 3), plus ArchiveOrgModal.tsx (org-lifecycle Wave 5),
    // plus SsoProvidersPage.tsx and ReportBuilder.tsx (2026-08-28 pre-release sweep),
    // plus AlertVerdictBadge.tsx (P2-1 Task 15), plus
    // AiAgentSchedulesSection.tsx (P2-2 Task 13, #4189), plus
    // QuickbooksMappingWorkbench.tsx (QuickBooks entity mapping, Task 6).
    expect(absoluteFiles.length).toBe(104);
    for (const f of absoluteFiles) {
      expect(() => statSync(f)).not.toThrow();
    }
  });

  for (const absPath of absoluteFiles) {
    const webRelLabel = absPath.startsWith(WEB_ROOT) ? 'src' + absPath.slice(WEB_ROOT.length) : absPath;
    if (allowAbsolute.has(absPath)) continue; // whole-file allowlisted — skip

    it(`${webRelLabel}: every mutating fetchWithAuth is wrapped by runAction or explicitly exempt`, () => {
      const sourceFile = program.getSourceFile(absPath);
      // Files the TS compiler doesn't natively parse (e.g. .astro) are never
      // in the program — fall back to the legacy standalone-parse scan
      // (direct fetchWithAuth calls only, no lib/api wrapper resolution).
      const violations = sourceFile
        ? findViolations(sourceFile.text, webRelLabel, { sourceFile, checker, apiRoot: API_ROOT })
        : findViolations(readFileSync(absPath, 'utf8'), webRelLabel);
      expect(
        violations,
        violations.length
          ? `Silent mutation(s) in ${webRelLabel}:\n` +
              violations.map((v) => `  L${v.line}: ${v.snippet}`).join('\n') +
              `\nWrap in runAction(), or add "// runaction-exempt: <reason>" if it is a ` +
              `legitimate aggregate/inline-feedback handler.`
          : undefined
      ).toEqual([]);
    });
  }
});
