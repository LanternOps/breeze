import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ChangesPanel } from './ChangesPanel';
import type { AppliedChange } from '../approval/approvalStore';

afterEach(cleanup);

function change(overrides: Partial<AppliedChange> = {}): AppliedChange {
  return {
    id: 'chg-1',
    toolUseId: 'tu-1',
    toolName: 'write_range',
    target: 'Sheet1!B2',
    appliedAt: Date.UTC(2026, 5, 13, 17, 30),
    revertible: true,
    reverted: false,
    before: [['original']],
    after: [['hello']],
    ...overrides,
  };
}

describe('ChangesPanel', () => {
  it('shows the empty state when no changes have been applied', () => {
    const { getByTestId } = render(
      <ChangesPanel changes={[]} onRevert={() => {}} onClose={() => {}} />,
    );
    expect(getByTestId('changes-empty')).toBeTruthy();
  });

  it('lists changes with target + tool, and an enabled Undo on revertible rows', () => {
    const { getByTestId } = render(
      <ChangesPanel changes={[change()]} onRevert={() => {}} onClose={() => {}} />,
    );
    const row = getByTestId('change-item-chg-1');
    expect(row.textContent).toContain('Sheet1!B2');
    expect(row.textContent?.toLowerCase()).toContain('write');
    const undo = getByTestId('change-undo-chg-1') as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
  });

  it('calls onRevert with the change id when Undo is clicked', () => {
    const onRevert = vi.fn();
    const { getByTestId } = render(
      <ChangesPanel changes={[change()]} onRevert={onRevert} onClose={() => {}} />,
    );
    fireEvent.click(getByTestId('change-undo-chg-1'));
    expect(onRevert).toHaveBeenCalledWith('chg-1');
  });

  it('shows a non-revertible row WITHOUT an Undo button (marks it not revertible)', () => {
    const { getByTestId, queryByTestId } = render(
      <ChangesPanel
        changes={[
          change({ id: 'chg-2', toolName: 'create_sheet', target: 'Budget', revertible: false, before: undefined, after: undefined }),
        ]}
        onRevert={() => {}}
        onClose={() => {}}
      />,
    );
    expect(queryByTestId('change-undo-chg-2')).toBeNull();
    expect(getByTestId('change-notrevertible-chg-2')).toBeTruthy();
  });

  it('shows a reverted row in its reverted state (no active Undo)', () => {
    const { getByTestId, queryByTestId } = render(
      <ChangesPanel
        changes={[change({ id: 'chg-3', reverted: true })]}
        onRevert={() => {}}
        onClose={() => {}}
      />,
    );
    expect(getByTestId('change-reverted-chg-3')).toBeTruthy();
    // A reverted change cannot be undone again.
    const undo = queryByTestId('change-undo-chg-3') as HTMLButtonElement | null;
    expect(undo === null || undo.disabled).toBe(true);
  });

  it('fires onClose from the close button', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <ChangesPanel changes={[]} onRevert={() => {}} onClose={onClose} />,
    );
    fireEvent.click(getByTestId('changes-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
