// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@/lib/i18n';
import { InheritanceBadge, ResetToInheritedButton, resetToInherited, sourceAfterLocalEdit } from './trustInheritance';

describe('trustInheritance (W02g)', () => {
  it('resetToInherited sends null for exactly that key', () => {
    expect(resetToInherited('showManagedBy')).toEqual({ showManagedBy: null });
    expect(resetToInherited('hiddenControlIds')).toEqual({ hiddenControlIds: null });
  });

  it('the badge names where the value comes from', () => {
    const { rerender } = render(<InheritanceBadge source="template" testId="b" />);
    expect(screen.getByTestId('b')).toHaveTextContent('Partner template');
    expect(screen.getByTestId('b')).toHaveAttribute('data-source', 'template');
    rerender(<InheritanceBadge source="default" testId="b" />);
    expect(screen.getByTestId('b')).toHaveTextContent('Breeze default');
    rerender(<InheritanceBadge source="page" testId="b" />);
    expect(screen.getByTestId('b')).toHaveTextContent('Set for this organization');
  });

  it('reset is offered only for a value the page set itself, and calls back', () => {
    const onReset = vi.fn();
    const { rerender } = render(<ResetToInheritedButton source="template" disabled={false} onReset={onReset} testId="r" />);
    expect(screen.queryByTestId('r')).toBeNull();
    rerender(<ResetToInheritedButton source="page" disabled={false} onReset={onReset} testId="r" />);
    fireEvent.click(screen.getByTestId('r'));
    expect(onReset).toHaveBeenCalledTimes(1);
    rerender(<ResetToInheritedButton source="page" disabled onReset={onReset} testId="r" />);
    expect(screen.getByTestId('r')).toBeDisabled();
  });

  it('a pending local edit reads as set for this organization until the reload lands', () => {
    expect(sourceAfterLocalEdit('template', true)).toBe('page');
    expect(sourceAfterLocalEdit('default', false)).toBe('default');
  });
});
