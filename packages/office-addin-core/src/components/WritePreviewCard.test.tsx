import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { WritePreviewCard } from './WritePreviewCard';
import type { PendingApproval } from '../approval/approvalStore';
import type { WritePreview } from '../api/types';

afterEach(cleanup);

function approval(preview: WritePreview): PendingApproval {
  return {
    toolUseId: 'tu-1',
    toolName: preview.toolName,
    input: {},
    preview,
    requestedAt: Date.UTC(2026, 5, 14, 12, 0),
  };
}

describe('WritePreviewCard', () => {
  it('renders the header with tool name and target', () => {
    const { getByTestId } = render(
      <WritePreviewCard
        approval={approval({
          kind: 'summary',
          toolName: 'create_sheet',
          target: 'Budget',
          description: 'Create a sheet named Budget',
        })}
        onApply={() => {}}
        onReject={() => {}}
      />,
    );
    const card = getByTestId('write-preview-card');
    expect(card.textContent).toContain('create_sheet');
    expect(card.textContent).toContain('Budget');
  });

  it('renders a summary variant as a one-line description', () => {
    const { getByTestId, queryByTestId } = render(
      <WritePreviewCard
        approval={approval({
          kind: 'summary',
          toolName: 'create_sheet',
          target: 'Budget',
          description: 'Create a sheet named Budget',
        })}
        onApply={() => {}}
        onReject={() => {}}
      />,
    );
    expect(getByTestId('write-preview-card').textContent).toContain('Create a sheet named Budget');
    expect(queryByTestId('write-preview-text')).toBeNull();
  });

  it('renders a grid variant with the after matrix and changed-cell count', () => {
    const { getByTestId, queryByTestId } = render(
      <WritePreviewCard
        approval={approval({
          kind: 'grid',
          toolName: 'write_range',
          target: 'Sheet1!A1:A2',
          before: [['old'], ['keep']],
          after: [['new'], ['keep']],
          changedCount: 1,
        })}
        onApply={() => {}}
        onReject={() => {}}
      />,
    );
    const card = getByTestId('write-preview-card');
    expect(card.textContent).toContain('new');
    // before of a changed cell is shown struck-through
    expect(card.textContent).toContain('old');
    expect(card.textContent).toContain('1 cell(s) will change');
    expect(queryByTestId('write-preview-text')).toBeNull();
  });

  it('renders a text variant showing the full after body (new draft, no before)', () => {
    const body = 'Hi Sam,\n\nThanks for reaching out. I will follow up tomorrow.\n\nBest,\nAlex';
    const { getByTestId, queryByTestId } = render(
      <WritePreviewCard
        approval={approval({
          kind: 'text',
          toolName: 'draft_reply',
          target: 'Reply',
          after: body,
        })}
        onApply={() => {}}
        onReject={() => {}}
      />,
    );
    expect(getByTestId('write-preview-text')).toBeTruthy();
    expect(getByTestId('write-preview-text-after').textContent).toContain('Thanks for reaching out');
    // No existing draft → no before block.
    expect(queryByTestId('write-preview-text-before')).toBeNull();
  });

  it('renders before AND after blocks for a text variant revising an existing draft', () => {
    const { getByTestId } = render(
      <WritePreviewCard
        approval={approval({
          kind: 'text',
          toolName: 'draft_reply',
          target: 'Reply all',
          before: 'Old draft text.',
          after: 'Revised draft text.',
        })}
        onApply={() => {}}
        onReject={() => {}}
      />,
    );
    expect(getByTestId('write-preview-text-before').textContent).toContain('Old draft text.');
    expect(getByTestId('write-preview-text-after').textContent).toContain('Revised draft text.');
  });

  it('renders text content as plain text (no HTML injection)', () => {
    const { getByTestId } = render(
      <WritePreviewCard
        approval={approval({
          kind: 'text',
          toolName: 'draft_reply',
          target: 'Reply',
          after: '<img src=x onerror="alert(1)">hello',
        })}
        onApply={() => {}}
        onReject={() => {}}
      />,
    );
    const after = getByTestId('write-preview-text-after');
    // The angle-bracket payload is rendered as escaped text, not a live <img> node.
    expect(after.querySelector('img')).toBeNull();
    expect(after.textContent).toContain('<img src=x onerror="alert(1)">hello');
  });

  it('fires onApply / onReject from the buttons', () => {
    const onApply = vi.fn();
    const onReject = vi.fn();
    const { getByTestId } = render(
      <WritePreviewCard
        approval={approval({
          kind: 'text',
          toolName: 'draft_reply',
          target: 'Reply',
          after: 'Body',
        })}
        onApply={onApply}
        onReject={onReject}
      />,
    );
    fireEvent.click(getByTestId('approval-apply'));
    fireEvent.click(getByTestId('approval-reject'));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('disables Apply/Reject when busy', () => {
    const { getByTestId } = render(
      <WritePreviewCard
        approval={approval({
          kind: 'text',
          toolName: 'draft_reply',
          target: 'Reply',
          after: 'Body',
        })}
        onApply={() => {}}
        onReject={() => {}}
        busy
      />,
    );
    expect((getByTestId('approval-apply') as HTMLButtonElement).disabled).toBe(true);
    expect((getByTestId('approval-reject') as HTMLButtonElement).disabled).toBe(true);
  });
});
