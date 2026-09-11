// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentLibrary } from './DocumentLibrary';

vi.mock('@/lib/api', () => ({
  portalApi: { documentContentUrl: (id: string) => `/api/v1/portal/documents/${id}/content` },
}));

const dto = {
  asOf: '2026-10-15T12:00:00.000Z',
  timezone: 'America/Denver',
  groups: [{
    category: 'runbook' as const,
    documents: [{
      id: 'doc1', title: 'Firewall runbook', description: 'How we manage the edge',
      category: 'runbook' as const, contentType: 'application/pdf', byteSize: 204800,
      originalFilename: 'firewall.pdf', createdAt: '2026-10-01T00:00:00.000Z',
    }],
  }],
};

describe('DocumentLibrary', () => {
  it('groups by a human category name and links the download', () => {
    render(<DocumentLibrary documents={dto} />);
    expect(screen.getByTestId('portal-documents-group-runbook')).toHaveTextContent('Runbooks');
    expect(screen.getByTestId('portal-document-download-doc1'))
      .toHaveAttribute('href', '/api/v1/portal/documents/doc1/content');
  });

  it('shows a readable size rather than a byte count', () => {
    render(<DocumentLibrary documents={dto} />);
    expect(screen.getByTestId('portal-document-row-doc1')).toHaveTextContent('200 KB');
  });

  it('says so honestly when nothing has been shared', () => {
    render(<DocumentLibrary documents={{ ...dto, groups: [] }} />);
    expect(screen.getByTestId('portal-documents-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('portal-documents-groups')).toBeNull();
  });
});
