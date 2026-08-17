import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// Same house pattern as TemplateEditor.test.tsx: swap the tiptap-backed
// RichTextEditor for a plain textarea so this test targets saveDraft's
// warning-toast wiring, not rich-text editing internals.
vi.mock('../common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const api = vi.hoisted(() => ({
  getContractTemplate: vi.fn(),
  createTemplateVersion: vi.fn(),
  uploadTemplateVersion: vi.fn(),
  publishTemplateVersion: vi.fn(),
  getTemplateVersion: vi.fn(),
}));
vi.mock('../../lib/api/contractTemplates', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/api/contractTemplates')>();
  return { ...orig, ...api };
});

import TemplateEditor from './TemplateEditor';

const resp = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// okRes mirrors what a real version write now returns per issue #3520: a
// top-level `warnings` array alongside `data`, not just `{ data }`.
const okRes = (data: unknown, warnings?: unknown[]) =>
  resp(warnings === undefined ? { data } : { data, warnings });

const removedTagsWarning = (removedTags: string[]) => [{
  code: 'UNSUPPORTED_HTML_TAGS_REMOVED',
  field: 'bodyHtml',
  removedTags,
}];

const draftVersion = {
  id: 'ver-draft',
  templateId: 'tpl-1',
  ownerScope: 'organization',
  orgId: 'org-1',
  partnerId: null,
  versionNumber: 1,
  status: 'draft',
  sourceType: 'authored',
  bodyHtml: '<p>Hello {{client.name}}</p>',
  mime: null,
  byteSize: null,
  sha256: null,
  declaredVariables: [],
  publishedAt: null,
  createdBy: 'u1',
  createdAt: '2026-01-01T00:00:00Z',
};

function activeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tpl-1',
    ownerScope: 'organization',
    orgId: 'org-1',
    partnerId: null,
    name: 'Acme SOW',
    description: null,
    status: 'active',
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    versions: [draftVersion],
    ...overrides,
  };
}

describe('TemplateEditor — stripped-markup warning toast (#3520)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getContractTemplate.mockResolvedValue(okRes(activeTemplate()));
  });

  it('saving a draft whose response carries warnings fires the warning toast naming the removed tags, not the success toast', async () => {
    api.createTemplateVersion.mockResolvedValue(
      okRes({ ...draftVersion, id: 'ver-2', versionNumber: 2 }, removedTagsWarning(['blockquote', 'table'])),
    );

    render(<TemplateEditor templateId="tpl-1" />);
    await screen.findByTestId('contract-template-editor');

    const editor = screen.getByTestId('template-body-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<table><tr><td>x</td></tr></table>' } });
    fireEvent.click(screen.getByTestId('template-save-draft-btn'));

    await waitFor(() => expect(api.createTemplateVersion).toHaveBeenCalled());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      message: expect.stringContaining('table'),
    })));
    const warningCall = showToast.mock.calls.find((c) => (c[0] as { type: string }).type === 'warning');
    expect(warningCall?.[0]).toEqual(expect.objectContaining({ message: expect.stringContaining('blockquote') }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('saving a draft whose response has an empty warnings array fires the success toast and no warning toast', async () => {
    api.createTemplateVersion.mockResolvedValue(
      okRes({ ...draftVersion, id: 'ver-3', versionNumber: 2 }, []),
    );

    render(<TemplateEditor templateId="tpl-1" />);
    await screen.findByTestId('contract-template-editor');

    const editor = screen.getByTestId('template-body-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<p>Clean text</p>' } });
    fireEvent.click(screen.getByTestId('template-save-draft-btn'));

    await waitFor(() => expect(api.createTemplateVersion).toHaveBeenCalled());
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  });
});
