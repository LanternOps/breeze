import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AutomationList from './AutomationList';

describe('AutomationList', () => {
  it('renders the empty state outside the table so it is not centered across a table wider than the screen (#7155)', () => {
    render(
      <AutomationList
        automations={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onRun={vi.fn()}
        onToggle={vi.fn()}
        onViewHistory={vi.fn()}
      />
    );

    const emptyMessage = screen.getByText('No automations found. Try adjusting your search or filters.');
    expect(emptyMessage.closest('table')).toBeNull();
  });
});
