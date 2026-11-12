import '@/lib/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchMock, toastMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), toastMock: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import RunStep, { runForStep } from './RunStep';
import { RUN_POLL_MS } from './useRunPolling';
import { ORG_A, SOURCE_ID, WINDOW_ID, counters, importRun, json, migrationWindow, sourceDetail } from './testFixtures';
import type { ImportRun } from './ticketImportApi';

const RUN_ID = '55555555-5555-4555-8555-555555555555';
const nameOfOrg = (id: string) => (id === ORG_A ? 'Acme' : id);

type Routes = { run: () => ImportRun; start?: () => Response; issues?: unknown[]; contacts?: unknown[] };
function route(r: Routes) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url === `/ticket-imports/sources/${SOURCE_ID}/runs`) return r.start?.() ?? json(201, { data: r.run() });
    if (method === 'POST' && url.endsWith('/cancel')) return json(200, { data: { ...r.run(), state: 'cancelled' }, alreadyFinished: false });
    if (url === `/ticket-imports/runs/${RUN_ID}`) return json(200, { data: r.run() });
    if (url.startsWith(`/ticket-imports/runs/${RUN_ID}/issues`)) return json(200, { data: r.issues ?? [], next: null });
    if (url.startsWith(`/ticket-imports/sources/${SOURCE_ID}/created-contacts`)) return json(200, { data: r.contacts ?? [], next: null });
    return json(404, { error: `unrouted ${method} ${url}` });
  });
}
const starts = () => fetchMock.mock.calls.filter(([url, init]) => url === `/ticket-imports/sources/${SOURCE_ID}/runs` && (init as { method?: string })?.method === 'POST')
  .map(([, init]) => JSON.parse((init as { body: string }).body));

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function renderStep(over: Partial<Parameters<typeof RunStep>[0]> = {}) {
  const props = {
    kind: 'dry_run' as const,
    source: sourceDetail(),
    runs: [] as ImportRun[],
    openWindow: null,
    nameOfOrg,
    onRunsChanged: vi.fn(),
    onContinue: vi.fn(),
    onOpenWindowStep: vi.fn(),
    ...over,
  };
  return { ...render(<RunStep {...props} />), props };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('RunStep — dry run (#8313 W6)', () => {
  it('starts a dry run, follows it every 5 s and reads the report with its contact predictions', async () => {
    vi.useFakeTimers();
    let state: ImportRun['state'] = 'queued';
    const finalCounters = counters({
      predicted: {
        ...counters().predicted,
        contactsToCreate: { [ORG_A]: 3 },
        contactsToCreateOverCap: 12,
      },
    });
    route({ run: () => importRun({ id: RUN_ID, state, phase: state === 'completed' ? 'done' : 'scan', counters: state === 'completed' ? finalCounters : counters() }) });
    const { props } = renderStep();
    fireEvent.click(screen.getByTestId('ticket-import-run-start'));
    await act(flush);
    expect(starts()).toEqual([{ kind: 'dry_run' }]);
    expect(screen.getByTestId('ticket-import-run-state')).toHaveTextContent('Queued');
    expect(screen.getByTestId('ticket-import-run-cancel')).toBeInTheDocument();

    state = 'completed';
    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS); await flush(); });
    expect(screen.getByTestId('ticket-import-run-state')).toHaveTextContent('Completed');
    expect(screen.getByTestId(`ticket-import-report-contacts-org-${ORG_A}`)).toHaveTextContent('Acme: 3 contacts');
    expect(screen.getByTestId('ticket-import-report-contacts-over-cap')).toHaveTextContent('12');
    expect(screen.getByTestId('ticket-import-report-predicted-creates')).toHaveTextContent('7');
    expect(props.onRunsChanged).toHaveBeenCalled();
    expect(screen.queryByTestId('ticket-import-run-cancel')).toBeNull();
  });

  it('lists issues by kind, including row_unreadable and a ticket_too_large failure', async () => {
    route({
      run: () => importRun({ id: RUN_ID }),
      issues: [
        { id: 'i-1', sourceTicketKey: '17', sourceTicketNumber: '41023', kind: 'failed', code: 'ticket_too_large', count: 1, createdAt: '2026-11-12T09:01:00Z' },
        { id: 'i-2', sourceTicketKey: '18', sourceTicketNumber: '41024', kind: 'row_unreadable', code: 'source_shape_invalid', count: 1, createdAt: '2026-11-12T09:01:00Z' },
      ],
    });
    renderStep({ runs: [importRun({ id: RUN_ID })] });
    expect(await screen.findByTestId('ticket-import-issue-i-1')).toHaveTextContent('41023');
    expect(screen.getByTestId('ticket-import-issue-i-1')).toHaveTextContent('Ticket too large');
    expect(screen.getByTestId('ticket-import-issue-i-2')).toHaveTextContent('Unreadable list row');

    fireEvent.change(screen.getByTestId('ticket-import-issues-kind'), { target: { value: 'row_unreadable' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('kind=row_unreadable'))).toBe(true));
  });

  it('a refused start shows the reason', async () => {
    route({ run: () => importRun({ id: RUN_ID }), start: () => json(409, { error: 'active', code: 'TICKET_IMPORT_RUN_ACTIVE' }) });
    renderStep();
    fireEvent.click(screen.getByTestId('ticket-import-run-start'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'A run of this source is in progress. Wait for it or cancel it.',
    })));
  });

  it('cancels an active run after confirmation', async () => {
    route({ run: () => importRun({ id: RUN_ID, state: 'running', phase: 'scan' }) });
    renderStep({ runs: [importRun({ id: RUN_ID, state: 'running', phase: 'scan' })] });
    fireEvent.click(await screen.findByTestId('ticket-import-run-cancel'));
    fireEvent.click(await screen.findByTestId('ticket-import-run-cancel-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === `/ticket-imports/runs/${RUN_ID}/cancel` && (init as { method?: string }).method === 'POST')).toBe(true));
  });
});

describe('RunStep — bulk and delta (#8313 W6)', () => {
  it('needs an open window before an import can start', () => {
    route({ run: () => importRun({ id: RUN_ID }) });
    const { props } = renderStep({ kind: 'bulk' });
    expect(screen.getByTestId('ticket-import-run-needs-window')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-run-start')).toBeDisabled();
    fireEvent.click(screen.getByTestId('ticket-import-run-go-window'));
    expect(props.onOpenWindowStep).toHaveBeenCalled();
  });

  it('starts an import through the open window and shows the created contacts', async () => {
    route({
      run: () => importRun({ id: RUN_ID, kind: 'import', windowId: WINDOW_ID, state: 'running', phase: 'scan' }),
      contacts: [{ contactId: 'c-1', orgId: ORG_A, name: 'Ana Souza', email: 'ana@example.com', sourceUserKey: '9', createdAt: '2026-11-12T09:00:00Z', keptBecause: [] }],
    });
    renderStep({ kind: 'bulk', openWindow: migrationWindow() });
    fireEvent.click(screen.getByTestId('ticket-import-run-start'));
    await waitFor(() => expect(starts()).toEqual([{ kind: 'import', windowId: WINDOW_ID }]));
    expect(await screen.findByTestId('ticket-import-contact-c-1')).toHaveTextContent('Ana Souza');
  });

  it('asks for the freeze before a delta run', () => {
    route({ run: () => importRun({ id: RUN_ID }) });
    renderStep({ kind: 'delta', openWindow: migrationWindow() });
    expect(screen.getByTestId('ticket-import-run-start')).toBeDisabled();
    fireEvent.click(screen.getByTestId('ticket-import-run-frozen'));
    expect(screen.getByTestId('ticket-import-run-start')).not.toBeDisabled();
  });

  it('shows the newest run of the step: an import in the open window, a dry run for the dry run', () => {
    const dry = importRun({ id: 'dry' });
    const oldImport = importRun({ id: 'old', kind: 'import', windowId: 'w-old' });
    const current = importRun({ id: 'cur', kind: 'import', windowId: WINDOW_ID });
    const runs = [current, dry, oldImport];
    expect(runForStep('dry_run', runs, null)?.id).toBe('dry');
    expect(runForStep('bulk', runs, migrationWindow())?.id).toBe('cur');
    expect(runForStep('delta', [oldImport, dry], migrationWindow())).toBeNull();
    expect(runForStep('bulk', [oldImport], null)?.id).toBe('old');
  });
});
