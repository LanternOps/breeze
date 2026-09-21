import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const promoteScriptProposal = vi.fn();
vi.mock('@/lib/api/scriptProposals', () => ({
  promoteScriptProposal: (...a: unknown[]) => promoteScriptProposal(...a),
}));

import SaveProposalToLibraryDialog from './SaveProposalToLibraryDialog';
import { ActionError } from '@/lib/runAction';

beforeEach(() => {
  vi.clearAllMocks();
  promoteScriptProposal.mockResolvedValue({ scriptId: 's1', versionId: 'v1' });
});

describe('SaveProposalToLibraryDialog', () => {
  it('prefills the name from the proposal goal', () => {
    render(<SaveProposalToLibraryDialog proposalId="p1" goal="Restart the print spooler" onClose={vi.fn()} />);
    expect(screen.getByTestId('promote-name-input')).toHaveValue('Restart the print spooler');
  });

  it('defaults the owner scope to organization', () => {
    render(<SaveProposalToLibraryDialog proposalId="p1" goal="g" onClose={vi.fn()} />);
    expect(screen.getByTestId('promote-owner-scope-organization')).toBeChecked();
  });

  it('submits through promoteScriptProposal with the chosen scope', async () => {
    render(<SaveProposalToLibraryDialog proposalId="p1" goal="g" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('promote-owner-scope-partner'));
    fireEvent.click(screen.getByTestId('promote-submit'));
    await waitFor(() =>
      expect(promoteScriptProposal).toHaveBeenCalledWith('p1', { name: 'g', ownerScope: 'partner' }),
    );
  });

  it('requires a name', () => {
    render(<SaveProposalToLibraryDialog proposalId="p1" goal="" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('promote-submit'));
    expect(promoteScriptProposal).not.toHaveBeenCalled();
    expect(screen.getByTestId('promote-name-error')).toBeInTheDocument();
  });

  it('surfaces a 403 from the server instead of closing silently', async () => {
    const onClose = vi.fn();
    promoteScriptProposal.mockRejectedValue(new ActionError('denied', 403, 'forbidden'));
    render(<SaveProposalToLibraryDialog proposalId="p1" goal="g" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('promote-submit'));
    await waitFor(() => expect(promoteScriptProposal).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
});
