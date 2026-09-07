import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

type MockCommitSummary = { created: unknown[]; errors: unknown[] };

vi.mock('./CustomFieldDefinitionImportStep', () => ({
  default: ({
    onSkipToValues,
    onCommitted,
  }: {
    onSkipToValues?: () => void;
    onCommitted?: (summary: MockCommitSummary) => void;
  }) => (
    <div data-testid="mock-definitions-step">
      <button type="button" data-testid="mock-skip-to-values" onClick={onSkipToValues}>
        skip
      </button>
      <button
        type="button"
        data-testid="mock-commit-success"
        onClick={() => onCommitted?.({ created: [{ id: 'def-1' }], errors: [] })}
      >
        commit success
      </button>
      <button
        type="button"
        data-testid="mock-commit-all-refused"
        onClick={() => onCommitted?.({ created: [], errors: [{ code: 'type-conflict' }] })}
      >
        commit all-refused
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

  it('advances to the values step after a definitions commit that created something', () => {
    render(<RmmCustomFieldImport organizationId="org-1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mock-commit-success'));
    expect(screen.getByTestId('mock-values-step')).toBeInTheDocument();
    expect(window.location.hash).toBe('#import-values');
  });

  it('stays on the definitions step when every row was refused, so the operator can fix the file', () => {
    render(<RmmCustomFieldImport organizationId="org-1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mock-commit-all-refused'));
    expect(screen.getByTestId('mock-definitions-step')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-values-step')).toBeNull();
  });
});
