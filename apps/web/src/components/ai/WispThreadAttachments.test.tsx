import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const runAction = vi.fn();
const real = vi.hoisted(() => ({ runAction: null as null | ((o: unknown) => Promise<unknown>) }));
vi.mock('@/lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runAction')>();
  real.runAction = actual.runAction as (o: unknown) => Promise<unknown>;
  return { ...actual, runAction: (o: { request: () => Promise<unknown> }) => runAction(o) };
});
const showToast = vi.fn();
vi.mock('@/components/shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import WispThreadAttachments from './WispThreadAttachments';
import { useWispThreadAttachmentList } from './useWispThreadAttachmentList';
import type { WispState } from '@/stores/aiStore';

type Wisp = NonNullable<WispState>;

/** As the composer paperclip mounts it: the list loaded by the hook, passed in. */
function Attachments({ wisp: w, showTitle }: { wisp: Wisp; showTitle?: boolean }) {
  const list = useWispThreadAttachmentList(w.threadId);
  return <WispThreadAttachments wisp={w} list={list} showTitle={showTitle} />;
}
const wisp = { threadId: 't1', scopeOrgId: 'o1', focusOrgId: 'o1' } as unknown as Wisp;
const item = (id: string, label: string) => ({
  id, threadId: 't1', orgId: 'o1', artifactId: 'a' + id, label, addedByUserId: null,
  contentType: 'text/plain', bytes: 2048, expiresAt: '2026-12-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z',
});
const listRes = (data: unknown[]) => ({ ok: true, status: 200, json: async () => ({ data }) });
const isPost = (c: unknown[]) => (c[1] as { method?: string } | undefined)?.method === 'POST';

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockImplementation(async (o: { request: () => Promise<unknown> }) => { await o.request(); return {}; });
  fetchWithAuth.mockResolvedValue(listRes([]));
});

describe('WispThreadAttachments', () => {
  it('lists attachments and shows the empty state when none', async () => {
    fetchWithAuth.mockResolvedValueOnce(listRes([item('1', 'Invoice mail'), { bogus: true }]));
    const { unmount } = render(<Attachments wisp={wisp} />);
    const rows = await screen.findAllByTestId('wisp-attachment-item');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Invoice mail');
    expect(fetchWithAuth).toHaveBeenCalledWith('/wisp/thread/t1/attachments');
    unmount();
    render(<Attachments wisp={wisp} />);
    expect(await screen.findByTestId('wisp-attachments-empty')).toBeTruthy();
  });

  it('dropping a text file POSTs multipart through runAction and reloads', async () => {
    render(<Attachments wisp={wisp} />);
    await screen.findByTestId('wisp-attachments-empty');
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    fireEvent.drop(screen.getByTestId('wisp-attachment-drop'), { dataTransfer: { files: [file] } });
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    const post = fetchWithAuth.mock.calls.find(isPost)!;
    expect(post[0]).toBe('/wisp/thread/t1/attachments');
    const body = (post[1] as { body: FormData }).body;
    expect(body).toBeInstanceOf(FormData);
    expect((body.get('file') as File).name).toBe('a.txt');
    await waitFor(() => expect(fetchWithAuth.mock.calls.filter((c) => !c[1]).length).toBe(2));
  });

  it('pasted text POSTs JSON { text, label } through runAction', async () => {
    render(<Attachments wisp={wisp} />);
    await screen.findByTestId('wisp-attachments-empty');
    const add = screen.getByTestId('wisp-attachment-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('wisp-attachment-paste'), { target: { value: 'some text' } });
    fireEvent.change(screen.getByTestId('wisp-attachment-label'), { target: { value: ' Notes ' } });
    fireEvent.click(add);
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    const post = fetchWithAuth.mock.calls.find(isPost)!;
    expect(JSON.parse((post[1] as { body: string }).body)).toEqual({ text: 'some text', label: 'Notes' });
    await waitFor(() => expect((screen.getByTestId('wisp-attachment-paste') as HTMLTextAreaElement).value).toBe(''));
  });

  it('refuses a 6 MB file client-side with the too-large toast and no request', async () => {
    render(<Attachments wisp={wisp} />);
    await screen.findByTestId('wisp-attachments-empty');
    const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByTestId('wisp-attachment-file'), { target: { files: [big] } });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'That file is over 5 MB' }));
    expect(runAction).not.toHaveBeenCalled();
    expect(fetchWithAuth.mock.calls.some(isPost)).toBe(false);
  });

  it('is disabled with focus-required copy for a partner-wide thread with no focus', async () => {
    const w = { ...wisp, scopeOrgId: null, focusOrgId: null } as unknown as Wisp;
    const list = { items: [], loaded: true, loadFailed: false, reload: vi.fn(async () => {}) };
    render(<WispThreadAttachments wisp={w} list={list} reasonId="reason-1" />);
    await screen.findByTestId('wisp-attachments-empty');
    expect(screen.getByTestId('wisp-attachments-focus-required').textContent).toBe('Pick a customer focus before attaching');
    // The paperclip's popover names this line as its description.
    expect(screen.getByTestId('wisp-attachments-focus-required').id).toBe('reason-1');
    expect((screen.getByTestId('wisp-attachment-paste') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId('wisp-attachment-add') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.drop(screen.getByTestId('wisp-attachment-drop'), { dataTransfer: { files: [new File(['x'], 'a.txt')] } });
    expect(runAction).not.toHaveBeenCalled();
  });

  it('a failed list load shows the load-error line, not the empty state', async () => {
    fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(<Attachments wisp={wisp} />);
    expect((await screen.findByTestId('wisp-attachments-load-error')).textContent).toBe('Could not load attachments');
    expect(screen.queryByTestId('wisp-attachments-empty')).toBeNull();
  });

  it.each([
    [413, 'too_large', 'That file is over 5 MB'],
    [415, 'unsupported_type', 'Only text files can be attached'],
    [409, 'focus_required', 'Pick a customer focus before attaching'],
  ])('a %s %s from the server toasts its own copy once (real runAction)', async (status, code, message) => {
    runAction.mockImplementation((o: unknown) => real.runAction!(o));
    fetchWithAuth.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? { ok: false, status, json: async () => ({ error: 'server prose', code }) } : listRes([]));
    render(<Attachments wisp={wisp} />);
    await screen.findByTestId('wisp-attachments-empty');
    fireEvent.change(screen.getByTestId('wisp-attachment-paste'), { target: { value: 'From: a@b.c' } });
    fireEvent.click(screen.getByTestId('wisp-attachment-add'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message })));
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('showTitle=false drops its own title (the composer popover is already labelled)', async () => {
    render(<Attachments wisp={wisp} showTitle={false} />);
    await screen.findByTestId('wisp-attachments-empty');
    expect(screen.queryByText('Attached to this thread')).toBeNull();
  });

  it('renders the list it is given without fetching it again; an attach reloads through it', async () => {
    const reload = vi.fn(async () => {});
    const list = { items: [{ id: '1', label: 'Invoice mail', bytes: 2048, expiresAt: '2026-12-01T00:00:00Z' }], loaded: true, loadFailed: false, reload };
    render(<WispThreadAttachments wisp={wisp} list={list} />);
    expect(screen.getAllByTestId('wisp-attachment-item')[0]).toHaveTextContent('Invoice mail');
    expect(fetchWithAuth).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('wisp-attachment-paste'), { target: { value: 'some text' } });
    fireEvent.click(screen.getByTestId('wisp-attachment-add'));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});
