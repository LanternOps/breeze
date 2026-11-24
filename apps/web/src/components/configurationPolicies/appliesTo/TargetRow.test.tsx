import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import TargetRow from './TargetRow';
import type { DraftRow } from './appliesToDraft';

const A1 = '11111111-1111-4111-8111-111111111111';
const SITE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const existing = (over: Partial<Extract<DraftRow, { kind: 'existing' }>> = {}): DraftRow => ({
  kind: 'existing',
  key: A1,
  assignment: { id: A1, level: 'site', targetId: SITE, priority: 4, roleFilter: null, osFilter: ['linux'] },
  ...over,
});

const handlers = () => ({ onEdit: vi.fn(), onRemove: vi.fn(), onRestore: vi.fn() });

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('TargetRow', () => {
  it('shows the level, the name and the filters, and edits a filter in place', () => {
    const h = handlers();
    render(<TargetRow row={existing()} name="HQ" {...h} />);
    const row = screen.getByTestId(`applies-to-row-${A1}`);
    expect(row).toHaveTextContent('Site');
    expect(row).toHaveTextContent('HQ');
    fireEvent.click(screen.getByRole('button', { name: 'Windows' }));
    expect(h.onEdit).toHaveBeenCalledWith({ osFilter: ['linux', 'windows'] });
  });

  it('keeps priority under Advanced', () => {
    const h = handlers();
    render(<TargetRow row={existing()} name="HQ" {...h} />);
    const priority = screen.getByTestId(`applies-to-row-priority-${A1}`);
    expect(priority.closest('details')).not.toBeNull();
    expect(priority).toHaveValue(4);
    fireEvent.change(priority, { target: { value: '9' } });
    expect(h.onEdit).toHaveBeenCalledWith({ priority: 9 });
  });

  it('ignores a priority outside 0 to 1000', () => {
    const h = handlers();
    render(<TargetRow row={existing()} name="HQ" {...h} />);
    fireEvent.change(screen.getByTestId(`applies-to-row-priority-${A1}`), { target: { value: '1001' } });
    fireEvent.change(screen.getByTestId(`applies-to-row-priority-${A1}`), { target: { value: '' } });
    expect(h.onEdit).not.toHaveBeenCalled();
  });

  it('marks a changed row, and a removed row offers Undo instead of editing', () => {
    const h = handlers();
    const { rerender } = render(<TargetRow row={existing({ edits: { priority: 1 } })} name="HQ" {...h} />);
    expect(screen.getByTestId(`applies-to-row-${A1}`)).toHaveAttribute('data-state', 'changed');
    fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
    expect(h.onRemove).toHaveBeenCalled();

    rerender(<TargetRow row={existing({ removed: true })} name="HQ" {...h} />);
    expect(screen.getByTestId(`applies-to-row-${A1}`)).toHaveAttribute('data-state', 'removed');
    expect(screen.queryByTestId(`applies-to-row-priority-${A1}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`applies-to-row-restore-${A1}`));
    expect(h.onRestore).toHaveBeenCalled();
  });

  it('names a partner row All organizations', () => {
    render(
      <TargetRow
        row={{ kind: 'added', key: 'added-1', level: 'partner', targetId: '', name: null, priority: 0, roleFilter: null, osFilter: null }}
        name={null}
        {...handlers()}
      />,
    );
    const row = screen.getByTestId('applies-to-row-added-1');
    expect(row).toHaveAttribute('data-state', 'added');
    expect(row).toHaveTextContent('All organizations');
  });

  it('a row the API refused says why', () => {
    render(<TargetRow row={existing()} name="HQ" problem="Assignment not found" {...handlers()} />);
    expect(screen.getByTestId(`applies-to-row-${A1}`)).toHaveTextContent('Assignment not found');
  });
});
