import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MergeTicketDialog, { type MergeSource } from './MergeTicketDialog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, statusText: String(status), json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const SOURCE: MergeSource = {
  id: 'src-1',
  internalNumber: 'T-2026-0009',
  orgId: 'org-1',
  deviceId: 'dev-src',
  deviceHostname: 'LAPTOP-SRC',
  submittedBy: null,
  submitterName: 'Pat',
  submitterEmail: 'pat@example.com',
};

const row = (id: string, internalNumber: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  id, internalNumber, subject: `Subject ${internalNumber}`, status: 'open', statusName: null, createdAt,
  deviceId: null, deviceHostname: null, ...extra,
});

const OLDER = row('tk-old', 'T-2026-0001', '2026-01-01T00:00:00.000Z', { deviceId: 'dev-old', deviceHostname: 'DESK-OLD' });
const NEWER = row('tk-new', 'T-2026-0005', '2026-03-01T00:00:00.000Z');

const ZERO_COUNTS = {
  ticket_comments: 0, time_entries: 0, ticket_parts: 0, ticket_alert_links: 0, ticket_attachments: 0,
  ticket_email_links: 0, ticket_checklist_items: 0, ticket_external_refs: 0, ticket_links: 0,
  device_vulnerabilities: 0, organization_key_dates: 0, service_deliverable_occurrences: 0,
  ai_operator_task_targets: 0, ticket_drafts: 0,
};

const preview = (overrides: Record<string, unknown> = {}) => ({
  eligible: true,
  refusals: [],
  counts: { ...ZERO_COUNTS, ticket_comments: 3, time_entries: 2, ticket_drafts: 1 },
  droppedLinks: [],
  retainedExternalRefs: [],
  deviceDifference: { source: null, survivor: null, result: null },
  requestersDiffer: false,
  sourceRequesterGainsAccess: false,
  suggestedSurvivorId: 'tk-old',
  ...overrides,
});

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function mockApi(opts: { list?: unknown[]; preview?: Record<string, unknown> | ((into: string) => Record<string, unknown>); merge?: Handler } = {}) {
  const list = opts.list ?? [NEWER, SOURCE_ROW, OLDER];
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/tickets?')) return json({ data: list });
    const pm = url.match(/^\/tickets\/src-1\/merge-preview\?into=(.+)$/);
    if (pm) {
      const p = typeof opts.preview === 'function' ? opts.preview(pm[1]) : (opts.preview ?? preview());
      return json({ data: p });
    }
    if (url === '/tickets/src-1/merge' && init?.method === 'POST') {
      return opts.merge?.(url, init) ?? json({ data: { survivorId: 'tk-old', counts: ZERO_COUNTS, droppedLinks: [] } });
    }
    return json({ error: 'unexpected' }, 500);
  });
}

const SOURCE_ROW = row('src-1', 'T-2026-0009', '2026-05-01T00:00:00.000Z');

function renderDialog(source: MergeSource = SOURCE) {
  const onMerged = vi.fn();
  const onClose = vi.fn();
  render(<MergeTicketDialog open source={source} onClose={onClose} onMerged={onMerged} />);
  return { onMerged, onClose };
}

async function pick(id: string) {
  fireEvent.click(await screen.findByTestId(`ticket-merge-option-${id}`));
  await screen.findByTestId('ticket-merge-preview');
}

const previewCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/merge-preview'));
const mergeCalls = () => fetchMock.mock.calls.filter(([u, i]) => String(u) === '/tickets/src-1/merge' && i?.method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MergeTicketDialog — picker', () => {
  it('lists open tickets of the same org, older first, without the source', async () => {
    mockApi();
    renderDialog();
    const picker = await screen.findByTestId('ticket-merge-picker');
    await within(picker).findByTestId('ticket-merge-option-tk-old');

    const listUrl = String(fetchMock.mock.calls.find(([u]) => String(u).startsWith('/tickets?'))![0]);
    const params = new URLSearchParams(listUrl.split('?')[1]);
    expect(params.get('orgId')).toBe('org-1');
    expect(params.get('statusGroup')).toBe('open');
    expect(params.get('sort')).toBe('oldest');
    expect(params.get('limit')).toBe('100');

    const ids = within(picker).getAllByTestId(/^ticket-merge-option-/).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['ticket-merge-option-tk-old', 'ticket-merge-option-tk-new']);
    expect(within(picker).getByTestId('ticket-merge-option-tk-old')).toHaveTextContent('T-2026-0001');
    expect(within(picker).getByTestId('ticket-merge-option-tk-old')).toHaveTextContent('Subject T-2026-0001');
  });

  it('searches the candidate list', async () => {
    mockApi();
    renderDialog();
    await screen.findByTestId('ticket-merge-option-tk-old');
    fireEvent.change(screen.getByTestId('ticket-merge-search'), { target: { value: 'printer' } });
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/tickets?'));
      expect(urls.some((u) => new URLSearchParams(u.split('?')[1]).get('search') === 'printer')).toBe(true);
    });
  });

  it('confirm is disabled until a target is previewed', async () => {
    mockApi();
    renderDialog();
    await screen.findByTestId('ticket-merge-option-tk-old');
    expect(screen.getByTestId('ticket-merge-confirm')).toBeDisabled();
  });
});

describe('MergeTicketDialog — preview', () => {
  it('fetches the preview for the picked target and renders the non-zero counts', async () => {
    mockApi();
    renderDialog();
    await pick('tk-old');
    expect(previewCalls().map(([u]) => String(u))).toEqual(['/tickets/src-1/merge-preview?into=tk-old']);
    const pv = screen.getByTestId('ticket-merge-preview');
    expect(within(pv).getByTestId('ticket-merge-count-ticket_comments')).toHaveTextContent('Comments: 3');
    expect(within(pv).getByTestId('ticket-merge-count-time_entries')).toHaveTextContent('Time entries: 2');
    // Drafts are deleted by the merge, not moved.
    expect(within(pv).getByTestId('ticket-merge-count-ticket_drafts')).toHaveTextContent('Drafts discarded: 1');
    expect(within(pv).queryByTestId('ticket-merge-count-ticket_parts')).toBeNull();
    expect(screen.getByTestId('ticket-merge-confirm')).toBeEnabled();
  });

  it('renders dropped links, retained external refs, the device and requester differences', async () => {
    mockApi({
      preview: preview({
        droppedLinks: [
          { linkId: 'l1', linkType: 'related', otherTicketId: 'tk-old', reason: 'between_pair' },
          { linkId: 'l2', linkType: 'duplicate', otherTicketId: 'tk-x', reason: 'cycle' },
        ],
        retainedExternalRefs: [{ id: 'r1', principalName: 'Acme PSA' }, { id: 'r2', principalName: null }],
        deviceDifference: { source: 'dev-src', survivor: 'dev-old', result: 'dev-old' },
        requestersDiffer: true,
        sourceRequesterGainsAccess: true,
      }),
    });
    renderDialog();
    await pick('tk-old');
    expect(screen.getByTestId('ticket-merge-dropped-l1')).toHaveTextContent('link between the two tickets');
    expect(screen.getByTestId('ticket-merge-dropped-l2')).toHaveTextContent('would create a cycle');
    expect(screen.getByTestId('ticket-merge-retained-r1')).toHaveTextContent('Stays on T-2026-0009: Acme PSA');
    expect(screen.getByTestId('ticket-merge-retained-r2')).toHaveTextContent('Stays on T-2026-0009: an integration');
    expect(screen.getByTestId('ticket-merge-device')).toHaveTextContent('The merged ticket keeps DESK-OLD');
    expect(screen.getByTestId('ticket-merge-requester-access')).toHaveTextContent(
      'The requester of T-2026-0009 will see the public thread of T-2026-0001 in the portal and can reply there.',
    );
  });

  it('says the survivor takes the source device when the target has none', async () => {
    mockApi({ preview: preview({ deviceDifference: { source: 'dev-src', survivor: null, result: 'dev-src' } }) });
    renderDialog();
    await pick('tk-new');
    expect(screen.getByTestId('ticket-merge-device')).toHaveTextContent('The merged ticket takes LAPTOP-SRC');
  });

  it('hides the device line when both tickets have the same device', async () => {
    mockApi({ preview: preview({ deviceDifference: { source: 'dev-1', survivor: 'dev-1', result: 'dev-1' } }) });
    renderDialog();
    await pick('tk-old');
    expect(screen.queryByTestId('ticket-merge-device')).toBeNull();
  });

  it('hints at the older ticket when the chosen target is not the suggested survivor', async () => {
    mockApi({ preview: preview({ suggestedSurvivorId: 'src-1' }) });
    renderDialog();
    await pick('tk-new');
    expect(screen.getByTestId('ticket-merge-suggested')).toHaveTextContent('T-2026-0009 is older; it is usually the one to keep');
  });

  it('shows no hint when the target is the suggested survivor', async () => {
    mockApi();
    renderDialog();
    await pick('tk-old');
    expect(screen.queryByTestId('ticket-merge-suggested')).toBeNull();
  });

  it('renders every refusal code as copy with its side and disables confirm', async () => {
    mockApi({
      preview: preview({
        eligible: false,
        refusals: [
          { code: 'MERGE_APPROVAL_STATE', side: 'survivor', message: 'server text 1' },
          { code: 'MERGE_PENDING_INTENTS', side: 'source', message: 'server text 2' },
          { code: 'MERGE_SOMETHING_NEW', side: 'both', message: 'A brand new server refusal.' },
        ],
      }),
    });
    renderDialog();
    await pick('tk-old');
    expect(screen.getByTestId('ticket-merge-refusal-MERGE_APPROVAL_STATE')).toHaveTextContent(
      'The target: Tickets with approval requests or a budget cannot be merged.',
    );
    expect(screen.getByTestId('ticket-merge-refusal-MERGE_PENDING_INTENTS')).toHaveTextContent(
      'This ticket: This ticket has pending AI actions. Wait for them to finish or cancel them.',
    );
    // Unknown code → the server message is the fallback.
    expect(screen.getByTestId('ticket-merge-refusal-MERGE_SOMETHING_NEW')).toHaveTextContent('Both tickets: A brand new server refusal.');
    expect(screen.getByTestId('ticket-merge-confirm')).toBeDisabled();
  });

  it('shows an inline error and keeps confirm disabled when the preview fails', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/tickets?')) return json({ data: [OLDER] });
      return json({ error: 'Ticket not found', code: 'NOT_FOUND' }, 404);
    });
    renderDialog();
    fireEvent.click(await screen.findByTestId('ticket-merge-option-tk-old'));
    expect(await screen.findByTestId('ticket-merge-preview-error')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-merge-confirm')).toBeDisabled();
  });
});

describe('MergeTicketDialog — notify checkbox (D6)', () => {
  it('defaults to checked iff the requesters differ, re-defaulting per target', async () => {
    mockApi({ preview: (into) => preview({ requestersDiffer: into === 'tk-old' }) });
    renderDialog();
    await pick('tk-old');
    expect(screen.getByTestId('ticket-merge-notify')).toBeChecked();
    expect(screen.getByTestId('ticket-merge-notify')).toHaveAccessibleName(
      'Email the requester of T-2026-0009 that their request was merged',
    );
    fireEvent.click(screen.getByTestId('ticket-merge-option-tk-new'));
    await waitFor(() => expect(screen.getByTestId('ticket-merge-notify')).not.toBeChecked());
  });

  it('is disabled and unchecked when the source has no requester', async () => {
    mockApi({ preview: preview({ requestersDiffer: true }) });
    renderDialog({ ...SOURCE, submittedBy: null, submitterEmail: null, submitterName: null });
    await pick('tk-old');
    expect(screen.getByTestId('ticket-merge-notify')).toBeDisabled();
    expect(screen.getByTestId('ticket-merge-notify')).not.toBeChecked();
  });
});

describe('MergeTicketDialog — confirm', () => {
  it('shows the irreversible warning and posts the explicit notify value', async () => {
    mockApi({ preview: preview({ requestersDiffer: true }) });
    const { onMerged } = renderDialog();
    await pick('tk-old');
    expect(screen.getByTestId('ticket-merge-warning')).toHaveTextContent(
      'This cannot be undone. T-2026-0009 becomes read-only and points at T-2026-0001.',
    );
    fireEvent.click(screen.getByTestId('ticket-merge-notify')); // opt out
    fireEvent.click(screen.getByTestId('ticket-merge-confirm'));

    await waitFor(() => expect(onMerged).toHaveBeenCalledWith({ id: 'tk-old', internalNumber: 'T-2026-0001' }));
    const [, init] = mergeCalls()[0];
    expect(JSON.parse(String(init?.body))).toEqual({ intoTicketId: 'tk-old', notifyRequester: false });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Merged into T-2026-0001' }));
  });

  it('on a 409 refusal: one toast (runAction), dialog stays open, preview re-fetched', async () => {
    mockApi({
      merge: () => json({ error: 'server says no', code: 'MERGE_SURVIVOR_INELIGIBLE', details: { side: 'survivor' } }, 409),
    });
    const { onMerged, onClose } = renderDialog();
    await pick('tk-old');
    expect(previewCalls()).toHaveLength(1);
    fireEvent.click(screen.getByTestId('ticket-merge-confirm'));

    await waitFor(() => expect(previewCalls()).toHaveLength(2));
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'The target cannot receive a merge (it is closed, deleted or already merged).',
    }));
    expect(onMerged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('ticket-merge-dialog')).toBeInTheDocument();
  });

  it('turns MFA_REQUIRED into friendly copy', async () => {
    mockApi({ merge: () => json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403) });
    renderDialog();
    await pick('tk-old');
    fireEvent.click(screen.getByTestId('ticket-merge-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: 'Merging tickets requires multi-factor authentication. Sign in again with MFA and retry.',
    })));
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('turns TICKET_MERGED and CONCURRENT_MODIFICATION into friendly copy', async () => {
    let code = 'TICKET_MERGED';
    mockApi({ merge: () => json({ error: 'raw', code, details: { mergedIntoTicketId: 'x' } }, 409) });
    renderDialog();
    await pick('tk-old');
    fireEvent.click(screen.getByTestId('ticket-merge-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'One of these tickets was already merged. Pick another target.',
    })));
    code = 'CONCURRENT_MODIFICATION';
    await waitFor(() => expect(screen.getByTestId('ticket-merge-confirm')).toBeEnabled());
    fireEvent.click(screen.getByTestId('ticket-merge-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'These tickets changed while merging. Try again.',
    })));
  });

  it('a 401 redirects to sign-in without a toast', async () => {
    mockApi({ merge: () => json({ error: 'Unauthorized' }, 401) });
    const { onMerged } = renderDialog();
    await pick('tk-old');
    fireEvent.click(screen.getByTestId('ticket-merge-confirm'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalled();
    expect(onMerged).not.toHaveBeenCalled();
  });
});
