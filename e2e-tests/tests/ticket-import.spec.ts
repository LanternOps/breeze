import type { Page, Route } from '@playwright/test';
import { test, expect } from '../fixtures';
import { TicketImportPage } from '../pages/TicketImportPage';
import { TicketsPage } from '../pages/TicketsPage';

/**
 * The ticket import wizard end to end (#8313 W6; spec 2026-10-19 §5.11, §7,
 * §8 row W6): connect, preflight, mappings, dry run, window, bulk run, delta
 * run, close — every step of the cutover runbook through the UI.
 *
 * The source side is a fake: the API can only reach a help desk over the SSRF
 * guard (loopback and private addresses are refused), so a fake Zammad on the
 * test host is unreachable from the API container. Instead the import and
 * window routes are answered in the browser (page.route) by a small stateful
 * fake that keeps the shapes the API returns (routes/ticketImports,
 * routes/migrationWindows). The route-level behaviour is covered by the API
 * suites; this spec covers the wizard driving them. The ticket list's
 * Imported filter at the end goes to the real API.
 */

const SOURCE_ID = '6f1c2b0a-5d4e-4f3a-8b2c-1d0e9f8a7b6c';
const PRINCIPAL_ID = '0a7d9c1e-2b3f-4a5d-8e6f-7a8b9c0d1e2f';
const WINDOW_ID = '33333333-3333-4333-8333-333333333333';

type Json = Record<string, unknown>;

function counters(over: Json = {}): Json {
  return {
    tickets: { seen: 12, created: 0, resumed: 0, unchanged: 0, skipped: 1, failed: 0 },
    comments: { written: 0, skipped: 0, systemSkipped: 3 },
    attachments: { written: 0, skipped: 0, bytes: 0, alternativesIgnored: 0 },
    linksWritten: 0, linksAsNotes: 0, statusKept: 0, contentTruncated: 0, clockClamped: 0,
    deletedInSource: 0, hiddenInSource: 0, removedInBreeze: 0, mergedInBreeze: 0,
    ownersUnmatched: 1, requestersWithoutContact: 0, contactsCreated: 0,
    commentsChangedInSource: 0, commentsMissingInSource: 0, requestersChangedInSource: 0, orgsChangedInSource: 0,
    customAttributes: {}, moduleCounts: {}, issuesWritten: 1, issuesDropped: 0,
    predicted: { creates: 11, resumes: 0, comments: 40, attachments: 2, attachmentBytes: 1024, attachmentsSkipped: 0, invalid: 0, contactsToCreate: {}, contactsToCreateOverCap: 0 },
    ...over,
  };
}

/** A stateful stand-in for the import and window routes. */
class FakeImportApi {
  source: Json | null = null;
  mappings: Json = { orgs: [], categories: [] };
  options: Json = {};
  runs: Json[] = [];
  windows: Json[] = [];
  /** Each run reads as queued once, then completed. */
  private reads = new Map<string, number>();
  received: Record<string, unknown[]> = {};

  constructor(private page: Page) {}

  private record(key: string, body: unknown) {
    (this.received[key] ??= []).push(body);
  }

  private view(): Json {
    return { ...this.source!, options: this.options, activeRunId: null, mappings: this.mappings };
  }

  async install() {
    await this.page.route(/\/api\/v1\/partner-service-principals(\?.*)?$/, (route) => this.principals(route));
    await this.page.route(/\/api\/v1\/ticket-imports\/.*/, (route) => this.imports(route));
    await this.page.route(/\/api\/v1\/migration-windows(\/[^?]*)?(\?.*)?$/, (route) => this.migrationWindows(route));
  }

  private async principals(route: Route) {
    if (route.request().method() === 'POST') {
      this.record('principal', route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { data: { id: PRINCIPAL_ID } } });
    }
    return route.fulfill({ json: { data: [] } });
  }

  private async imports(route: Route) {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(/^\/api\/v1/, '');

    if (path === '/ticket-imports/modules') return route.fulfill({ json: { data: [{ id: 'zammad', label: 'Zammad 7.2', optionsSchema: null }] } });
    if (path === '/ticket-imports/sources' && method === 'GET') return route.fulfill({ json: { data: this.source ? [this.view()] : [] } });
    if (path === '/ticket-imports/sources' && method === 'POST') {
      const body = request.postDataJSON() as Json;
      this.record('source', body);
      this.source = {
        id: SOURCE_ID, partnerId: 'partner', module: body.module, label: body.label, baseUrl: body.baseUrl,
        principalId: body.principalId, ownerUserId: await this.ownerId(), hasCredentials: true, revokedAt: null, revokedBy: null,
        createdBy: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      return route.fulfill({ status: 201, json: { data: this.view(), connect: { warnings: [] } } });
    }
    if (path === `/ticket-imports/sources/${SOURCE_ID}` && method === 'GET') return route.fulfill({ json: { data: this.view() } });
    if (path === `/ticket-imports/sources/${SOURCE_ID}/preflight`) {
      return route.fulfill({
        json: {
          data: {
            connect: {
              identity: { key: '7', name: 'Breeze Import', email: 'import@example.com' },
              permissions: ['ticket.agent'],
              warnings: [{ code: 'group_inactive', detail: 'Archive' }, { code: 'token_not_read_only' }],
              clockSkewMs: 800,
              sourceVersion: '7.2.2',
            },
            catalog: {
              orgs: [{ key: '1', name: 'Fake Customer One' }, { key: '2', name: 'Fake Customer Two' }],
              groups: [{ key: '10', name: 'Support', active: true, readable: true }, { key: '11', name: 'Archive', active: false }],
              priorities: [{ key: '1', name: '1 low' }, { key: '2', name: '2 normal' }, { key: '3', name: '3 high' }],
              states: [{ key: '1', name: 'new (new)' }, { key: '4', name: 'closed (closed)' }],
              attributes: [],
              counts: { users: 25 },
            },
            objectStorage: { configured: true },
          },
        },
      });
    }
    if (path === `/ticket-imports/sources/${SOURCE_ID}/mappings` && method === 'PUT') {
      const body = request.postDataJSON() as Json;
      this.record('mappings', body);
      this.mappings = { orgs: body.orgs, categories: body.categories };
      this.options = body.options as Json;
      return route.fulfill({ json: { data: this.view() } });
    }
    if (path === `/ticket-imports/sources/${SOURCE_ID}/runs` && method === 'POST') {
      const body = request.postDataJSON() as Json;
      this.record('run', body);
      const fallback = (this.mappings.orgs as Array<{ orgId: string }>)[0]?.orgId ?? 'org';
      const run = {
        id: `7777777${this.runs.length}-7777-4777-8777-777777777777`, sourceId: SOURCE_ID, kind: body.kind,
        windowId: body.kind === 'import' ? body.windowId : null, state: 'queued', stopReason: null, phase: 'scan',
        counters: counters(body.kind === 'dry_run'
          ? { predicted: { ...(counters().predicted as Json), contactsToCreate: { [fallback]: 4 } } }
          : { tickets: { seen: 12, created: 11, resumed: 0, unchanged: 0, skipped: 1, failed: 0 }, contactsCreated: 4 }),
        startedBy: null, startedAt: new Date().toISOString(), heartbeatAt: null, finishedAt: null,
      };
      this.runs.unshift(run);
      return route.fulfill({ status: 201, json: { data: run } });
    }
    if (path === `/ticket-imports/sources/${SOURCE_ID}/runs`) return route.fulfill({ json: { data: this.runs } });
    if (path === `/ticket-imports/sources/${SOURCE_ID}/created-contacts`) return route.fulfill({ json: { data: [], next: null } });
    const issues = path.match(/^\/ticket-imports\/runs\/([^/]+)\/issues$/);
    if (issues) {
      return route.fulfill({ json: { data: [{ id: 'issue-1', sourceTicketKey: '99', sourceTicketNumber: '41099', kind: 'skipped_no_org', code: 'no_org', count: 1, createdAt: new Date().toISOString() }], next: null } });
    }
    const one = path.match(/^\/ticket-imports\/runs\/([^/]+)$/);
    if (one) {
      const run = this.runs.find((r) => r.id === one[1]);
      if (!run) return route.fulfill({ status: 404, json: { error: 'not found' } });
      const reads = (this.reads.get(run.id as string) ?? 0) + 1;
      this.reads.set(run.id as string, reads);
      if (reads > 1) Object.assign(run, { state: 'completed', phase: 'done', finishedAt: new Date().toISOString() });
      return route.fulfill({ json: { data: run } });
    }
    return route.fulfill({ status: 404, json: { error: `fake: unrouted ${method} ${path}` } });
  }

  private async migrationWindows(route: Route) {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(/^\/api\/v1/, '');
    if (path === '/migration-windows' && method === 'GET') return route.fulfill({ json: { data: this.windows } });
    if (path === '/migration-windows' && method === 'POST') {
      const body = request.postDataJSON() as Json;
      this.record('window', body);
      const orgIds = body.orgIds as string[];
      const win = {
        id: WINDOW_ID, partnerId: 'partner', principalId: body.principalId, sourceLabel: body.sourceLabel, status: 'open',
        openedAt: new Date().toISOString(), endsAt: body.endsAt, writesPerHour: body.writesPerHour, openedBy: null,
        closedBy: null, closedReason: null, closedAt: null, orgIds,
        counts: { orgs: orgIds.map((orgId) => ({ orgId, ticketsImported: 11, commentsImported: 40, attachmentsImported: 2 })), ticketsImported: 11 * orgIds.length, commentsImported: 40 * orgIds.length, attachmentsImported: 2 * orgIds.length },
      };
      this.windows = [win];
      return route.fulfill({ status: 201, json: { data: win } });
    }
    if (path === `/migration-windows/${WINDOW_ID}/close` && method === 'POST') {
      this.record('close', null);
      Object.assign(this.windows[0]!, { status: 'closed', closedReason: 'closed_by_admin', closedAt: new Date().toISOString() });
      return route.fulfill({ json: { data: this.windows[0], alreadyClosed: false } });
    }
    return route.fulfill({ status: 404, json: { error: `fake: unrouted ${method} ${path}` } });
  }

  /** The signed-in admin's id, so the wizard treats them as the principal's owner. */
  private async ownerId(): Promise<string> {
    return this.page.evaluate(() => {
      const raw = window.localStorage.getItem('breeze-auth');
      try {
        return (JSON.parse(raw ?? '{}') as { state?: { user?: { id?: string } } }).state?.user?.id ?? '';
      } catch {
        return '';
      }
    });
  }
}

test.describe('ticket import wizard', () => {
  test('connect, preflight, map, dry run, window, bulk, delta and close (#8313)', async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const fake = new FakeImportApi(page);
    await fake.install();

    const tickets = new TicketsPage(page);
    await page.goto(tickets.url);
    await tickets.heading().waitFor();
    await page.getByTestId('tickets-import-button').click();

    const wizard = new TicketImportPage(page);
    await wizard.heading().waitFor();

    // 1. Connect: a new principal, then the source; the token is never shown again.
    await wizard.connectNew().click();
    await wizard.connectLabel().fill('Zammad');
    await wizard.connectBaseUrl().fill('https://helpdesk.example.com');
    await wizard.connectToken().fill('fake-token-for-e2e');
    await wizard.connectSubmit().click();
    await expect(page).toHaveURL(new RegExp(`#source=${SOURCE_ID}&step=preflight$`));
    expect(fake.received.principal?.[0]).toMatchObject({ name: 'Import: Zammad', scopes: ['tickets:write'] });
    expect(fake.received.source?.[0]).toMatchObject({ credentials: { token: 'fake-token-for-e2e' }, principalId: PRINCIPAL_ID });

    // 2. Preflight.
    await wizard.preflightRun().click();
    await expect(wizard.preflightResult()).toBeVisible();
    await expect(wizard.preflightWarning('group_inactive')).toBeVisible();
    await expect(wizard.preflightGroup('11')).toBeVisible();
    await wizard.preflightContinue().click();

    // 3. Mappings: a fallback org, contacts on with "updated since".
    await expect(page).toHaveURL(/step=mappings$/);
    await wizard.mappingsFallback().selectOption({ index: 1 });
    const fallbackOrgId = await wizard.mappingsFallback().inputValue();
    await expect(wizard.mappingsCreateContacts()).not.toBeChecked();
    await wizard.mappingsCreateContacts().check();
    await wizard.mappingsUpdatedSince().fill('2025-01-01');
    await wizard.mappingsSave().click();
    await expect(page).toHaveURL(/step=dry-run$/);
    expect(fake.received.mappings?.[0]).toMatchObject({
      orgs: expect.arrayContaining([{ sourceOrgKey: null, sourceOrgName: null, orgId: fallbackOrgId }]),
      options: { createRequesterContacts: true, createRequesterContactsUpdatedSince: '2025-01-01' },
    });

    // 4. Dry run: polled until it completes; its report predicts the contacts.
    await wizard.runStart().click();
    await expect(wizard.runState()).toBeVisible();
    await expect(page.getByTestId('ticket-import-run-status')).toHaveAttribute('data-state', 'completed', { timeout: 15_000 });
    await expect(wizard.reportContactsForOrg(fallbackOrgId)).toBeVisible();
    await expect(wizard.issue('issue-1')).toBeVisible();
    await wizard.runContinue().click();

    // 5. Window over the mapped orgs. (The fake asks for no step-up; the
    // step-up path is covered by WindowStep.test.tsx.)
    await expect(page).toHaveURL(/step=window$/);
    await wizard.windowOpenSubmit().click();
    await expect(wizard.windowOpen()).toBeVisible();
    expect(fake.received.window?.[0]).toMatchObject({ principalId: PRINCIPAL_ID, orgIds: [fallbackOrgId], sourceLabel: 'Zammad' });
    await wizard.windowContinue().click();

    // 6. Bulk run through the window.
    await expect(page).toHaveURL(/step=bulk$/);
    await wizard.runStart().click();
    await expect(page.getByTestId('ticket-import-run-status')).toHaveAttribute('data-state', 'completed', { timeout: 15_000 });
    expect(fake.received.run?.[1]).toEqual({ kind: 'import', windowId: WINDOW_ID });
    await wizard.runContinue().click();

    // 7. Delta run, after the freeze.
    await expect(page).toHaveURL(/step=delta$/);
    await expect(wizard.runStart()).toBeDisabled();
    await wizard.runFrozen().check();
    await wizard.runStart().click();
    await expect.poll(() => fake.received.run?.length).toBe(3);
    await expect(page.getByTestId('ticket-import-run-status')).toHaveAttribute('data-state', 'completed', { timeout: 15_000 });
    await wizard.runContinue().click();

    // 8. Close the window and read its summary.
    await expect(page).toHaveURL(/step=close$/);
    await wizard.windowClose(WINDOW_ID).first().click();
    await wizard.windowCloseConfirm().click();
    await expect(wizard.closeSummary()).toBeVisible();
    await expect(wizard.windowRow(WINDOW_ID)).toBeVisible();
  });

  test('the ticket list filters imported tickets through the hash (#8313)', async ({ authedPage: page }) => {
    const tickets = new TicketsPage(page);
    const listRequest = page.waitForRequest((request) => /\/api\/v1\/tickets\?/.test(request.url()) && request.url().includes('imported=true'));
    await page.goto(`${tickets.url}#imported=1`);
    await tickets.heading().waitFor();
    await listRequest;
    await expect(page.getByTestId('ticket-list-imported-only')).toBeChecked();
    await page.getByTestId('ticket-list-imported-only').uncheck();
    await expect(page).not.toHaveURL(/imported=1/);
  });
});
