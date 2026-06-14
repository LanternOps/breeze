import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { Composer } from './Composer';
import type { WorkbookContextKind } from '../api/types';

afterEach(cleanup);

/**
 * Composer is host-NEUTRAL: it takes the selection fns
 * (`captureSelectionAddress` / `subscribeSelectionChanged`) as props (threaded
 * from ChatPane via the Excel adapter) and never imports `Excel.*` or the
 * concrete `excelHostAdapter` itself. The selection chip is driven by the
 * injected `useSelectionAddress` rhythm.
 */
function selectionProps(address: string | undefined) {
  return {
    captureSelectionAddress: vi.fn(async () => address),
    subscribeSelectionChanged: vi.fn(() => () => undefined),
  };
}

const baseProps = {
  draft: '',
  busy: false,
  contextKind: 'selection' as WorkbookContextKind,
  onDraftChange: () => {},
  onContextKindChange: () => {},
  onSend: () => {},
};

describe('Composer', () => {
  it('renders the composer input and send button', () => {
    render(<Composer {...baseProps} {...selectionProps(undefined)} />);
    expect(screen.getByTestId('composer-input')).toBeTruthy();
    expect(screen.getByTestId('composer-send')).toBeTruthy();
  });

  it('reads the injected selection address and shows it in the context chip', async () => {
    const props = selectionProps('Sheet1!B2');
    render(<Composer {...baseProps} {...props} />);
    await waitFor(() =>
      expect(screen.getByTestId('context-chip').textContent).toContain('B2'),
    );
    expect(props.captureSelectionAddress).toHaveBeenCalled();
    expect(props.subscribeSelectionChanged).toHaveBeenCalled();
  });

  it('shows the sheet name in the chip when contextKind is sheet', async () => {
    render(
      <Composer {...baseProps} contextKind="sheet" {...selectionProps('Budget!A1:B2')} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('context-chip').textContent).toContain('Budget'),
    );
  });

  it('shows "No workbook data" when contextKind is none', () => {
    render(<Composer {...baseProps} contextKind="none" {...selectionProps('Sheet1!B2')} />);
    expect(screen.getByTestId('context-chip').textContent).toContain('No workbook data');
  });

  it('calls onSend when the form is submitted', () => {
    const onSend = vi.fn();
    render(
      <Composer
        {...baseProps}
        draft="hello"
        onSend={onSend}
        {...selectionProps(undefined)}
      />,
    );
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('calls onDraftChange as the user types', () => {
    const onDraftChange = vi.fn();
    render(
      <Composer {...baseProps} onDraftChange={onDraftChange} {...selectionProps(undefined)} />,
    );
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'hi' } });
    expect(onDraftChange).toHaveBeenCalledWith('hi');
  });
});
