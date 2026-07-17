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
  ownerScope: 'organization',
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

  it('clears dirty and re-enables Publish after saving a body the sanitizer normalizes', async () => {
    // The server sanitizer can canonicalize a saved body (here a link's rel attr)
    // so the stored form differs from the editor buffer. A raw string compare would
    // keep `dirty` true forever after such a save, permanently disabling Publish and
    // minting duplicate versions on retry — the force-reseed clears it. (RichTextEditor
    // now emits the sanitizer's exact rel; this synthetic diff still guards the
    // general normalization case.)
    const normalizedLinkBody = '<p><a href="https://ex.com" rel="noopener noreferrer">L</a></p>';
    const tiptapLinkBody = '<p><a href="https://ex.com" rel="noopener noreferrer nofollow">L</a></p>';
    const linkVersion = { ...draftVersion, bodyHtml: normalizedLinkBody };
    api.getContractTemplate.mockResolvedValue(resp({ data: activeTemplate({ versions: [linkVersion] }) }));
    api.createTemplateVersion.mockResolvedValue(resp({ data: { ...linkVersion, id: 'ver-2', versionNumber: 2 } }));

    render(<TemplateEditor templateId="tpl-1" />);
    await screen.findByTestId('contract-template-editor');

    // Seeded from the server-normalized body → not dirty → Publish enabled.
    expect(screen.getByTestId('template-version-publish')).not.toBeDisabled();

    // TipTap re-emits the same link WITH nofollow → dirty → Publish disabled.
    const editor = screen.getByTestId('template-body-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: tiptapLinkBody } });
    expect(screen.getByTestId('template-version-publish')).toBeDisabled();

    // Save draft → force-reseed from the stored body clears dirty.
    fireEvent.click(screen.getByTestId('template-save-draft-btn'));
    await waitFor(() => expect(api.createTemplateVersion).toHaveBeenCalledWith('tpl-1', { bodyHtml: tiptapLinkBody }));
    await waitFor(() => expect(screen.getByTestId('template-version-publish')).not.toBeDisabled());
  });

  it('confirms before New Version discards unsaved edits, and preserves the body on cancel', async () => {
    render(<TemplateEditor templateId="tpl-1" />);
    await screen.findByTestId('contract-template-editor');

    const editor = screen.getByTestId('template-body-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<p>Precious unsaved draft</p>' } });

    // Dirty → New Version must not clear immediately; it opens a confirm dialog.
    fireEvent.click(screen.getByTestId('template-add-version-btn'));
    const confirmBtn = await screen.findByTestId('template-new-version-confirm');
    expect(confirmBtn).toBeInTheDocument();
    // Body is untouched while the dialog is open.
    expect((screen.getByTestId('template-body-editor') as HTMLTextAreaElement).value).toBe(
      '<p>Precious unsaved draft</p>',
    );

    // Cancel → the typed text survives.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByTestId('template-new-version-confirm')).not.toBeInTheDocument(),
    );
    expect((screen.getByTestId('template-body-editor') as HTMLTextAreaElement).value).toBe(
      '<p>Precious unsaved draft</p>',
    );
  });

  it('clears the body when New Version is confirmed', async () => {
    render(<TemplateEditor templateId="tpl-1" />);
    await screen.findByTestId('contract-template-editor');

    const editor = screen.getByTestId('template-body-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: '<p>Discard me</p>' } });

    fireEvent.click(screen.getByTestId('template-add-version-btn'));
    fireEvent.click(await screen.findByTestId('template-new-version-confirm'));

    await waitFor(() =>
      expect((screen.getByTestId('template-body-editor') as HTMLTextAreaElement).value).toBe(''),
    );
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
