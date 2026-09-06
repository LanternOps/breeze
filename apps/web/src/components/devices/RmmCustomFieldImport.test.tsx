import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('./CustomFieldDefinitionImportStep', () => ({
  default: ({ onSkipToValues }: { onSkipToValues?: () => void }) => (
    <div data-testid="mock-definitions-step">
      <button type="button" data-testid="mock-skip-to-values" onClick={onSkipToValues}>
        skip
      </button>
    </div>
  ),
}));

vi.mock('./CustomFieldValueImportStep', () => ({
  default: () => <div data-testid="mock-values-step" />,
}));

import RmmCustomFieldImport from './RmmCustomFieldImport';

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
});

describe('RmmCustomFieldImport', () => {
  it('opens on the definitions step by default', () => {
    render(<RmmCustomFieldImport organizationId="org-1" onClose={vi.fn()} />);
    expect(screen.getByTestId('mock-definitions-step')).toBeInTheDocument();
  });

  it('picks up an existing #import-values hash on mount', () => {
    window.location.hash = 'import-values';
    render(<RmmCustomFieldImport organizationId="org-1" onClose={vi.fn()} />);
    expect(screen.getByTestId('mock-values-step')).toBeInTheDocument();
  });

  it('writes the hash, never a query param, when advancing steps', () => {
    render(<RmmCustomFieldImport organizationId="org-1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mock-skip-to-values'));
    expect(window.location.hash).toBe('#import-values');
    expect(window.location.search).toBe('');
    expect(screen.getByTestId('mock-values-step')).toBeInTheDocument();
  });

  it('calls onClose from the close button', () => {
    const onClose = vi.fn();
    render(<RmmCustomFieldImport organizationId="org-1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('rmm-import-close'));
    expect(onClose).toHaveBeenCalled();
  });
});
