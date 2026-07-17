import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Replace the tiptap editor with a plain textarea — this test targets the
// editor shell (versions, publish, attach affordances), not rich-text editing.
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

const draftVersion = {
  id: 'ver-draft',
  templateId: 'tpl-1',
  orgId: 'org-1',
  partnerId: null,
  versionNumber: 1,
  status: 'draft',
  sourceType: 'authored',
  bodyHtml: '<p>Hello {{client.name}} — pay {{invoice.custom_ref}}</p>',
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

describe('TemplateEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getContractTemplate.mockResolvedValue(resp({ data: activeTemplate() }));
    api.publishTemplateVersion.mockResolvedValue(resp({ data: { ...draftVersion, status: 'published' } }));
    api.createTemplateVersion.mockResolvedValue(resp({ data: { ...draftVersion, id: 'ver-2', versionNumber: 2 } }));
  });

  it('publishes a draft version via the API', async () => {
    render(<TemplateEditor templateId="tpl-1" />);
    await screen.findByTestId('contract-template-editor');

    const publishBtn = await screen.findByTestId('template-version-publish');
    fireEvent.click(publishBtn);

    await waitFor(() => expect(api.publishTemplateVersion).toHaveBeenCalledWith('tpl-1', 'ver-draft'));
  });

  it('blocks Publish while the body has un-saved edits and never destroys the typed text', async () => {
    render(<TemplateEditor templateId="tpl-1" />);
    await screen.findByTestId('contract-template-editor');

    const editor = screen.getByTestId('template-body-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<p>My unsaved contract text</p>' } });

    const publishBtn = screen.getByTestId('template-version-publish');
    expect(publishBtn).toBeDisabled();
    // Attempting the click must not publish the OLD stored draft…
    fireEvent.click(publishBtn);
    expect(api.publishTemplateVersion).not.toHaveBeenCalled();
    // …and the typed buffer is still intact (not clobbered by a reload re-seed).
    expect((screen.getByTestId('template-body-editor') as HTMLTextAreaElement).value).toBe('<p>My unsaved contract text</p>');
  });

  it('lists manual variables detected live in the body', async () => {
    render(<TemplateEditor templateId="tpl-1" />);
    await screen.findByTestId('contract-template-editor');
    // invoice.custom_ref is not an AUTO variable → shown as a manual variable.
    expect(await screen.findByText('invoice.custom_ref')).toBeInTheDocument();
  });

  it('hides attach affordances when the template is archived', async () => {
    api.getContractTemplate.mockResolvedValue(resp({ data: activeTemplate({ status: 'archived' }) }));
    render(<TemplateEditor templateId="tpl-1" />);
    await screen.findByTestId('contract-template-editor');

    expect(screen.queryByTestId('template-add-version-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('template-upload-btn')).not.toBeInTheDocument();
    // A draft can no longer be published on an archived template either.
    expect(screen.queryByTestId('template-version-publish')).not.toBeInTheDocument();
    expect(screen.getByTestId('template-archived-notice')).toBeInTheDocument();
  });
});
