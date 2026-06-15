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

  it('shows "(none)" when contextKind is none', () => {
    render(<Composer {...baseProps} contextKind="none" {...selectionProps('Sheet1!B2')} />);
    expect(screen.getByTestId('context-chip').textContent).toContain('(none)');
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

  it('uses the Excel default context options and placeholder when none are provided', () => {
    render(<Composer {...baseProps} {...selectionProps(undefined)} />);
    const options = Array.from(
      screen.getByTestId('context-select').querySelectorAll('option'),
    ).map((o) => o.textContent);
    expect(options).toEqual(['Selection', 'Whole sheet', '(none)']);
    expect(screen.getByTestId('composer-input').getAttribute('placeholder')).toBe(
      'Ask anything about this workbook…',
    );
  });

  it('does not crash when the selection label is not an Excel address (Excel default)', async () => {
    // Regression: a host that inherits the Excel default chip but whose label is
    // a "Slide 2"/text snippet (e.g. PowerPoint missing formatContextChip) used
    // to throw `Unsupported address` inside parseAddress → blank pane. The chip
    // must render the snippet instead of throwing.
    const props = selectionProps('Slide 2');
    expect(() => render(<Composer {...baseProps} {...props} />)).not.toThrow();
    await waitFor(() =>
      expect(screen.getByTestId('context-chip').textContent).toContain('Slide 2'),
    );
  });

  it('uses a host-supplied formatContextChip instead of the Excel address default', async () => {
    // Word's label is a free-text snippet, not a range — the host formatter must
    // win so the chip shows the snippet verbatim (no `parseAddress`/`stripSheet`).
    const formatContextChip = vi.fn(
      (kind: WorkbookContextKind, label: string | undefined) =>
        kind === 'none' ? 'No document data' : label ? `Selection: ${label}` : 'Selection',
    );
    render(
      <Composer
        {...baseProps}
        {...selectionProps('Hello! World')}
        formatContextChip={formatContextChip}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('context-chip').textContent).toBe('Selection: Hello! World'),
    );
    // The Excel default would have stripped everything before the `!` → "World".
    expect(screen.getByTestId('context-chip').textContent).not.toContain('Sheet');
    expect(formatContextChip).toHaveBeenCalledWith('selection', 'Hello! World');
  });

  it('puts an explanatory tooltip on the context picker and chip', () => {
    render(<Composer {...baseProps} {...selectionProps(undefined)} />);
    const title = screen.getByTestId('context-select').getAttribute('title');
    expect(title).toMatch(/assistant can see/i);
    expect(screen.getByTestId('context-chip').getAttribute('title')).toBe(title);
  });

  it('hides the context-source dropdown when hideContextPicker is set (chip stays)', async () => {
    render(
      <Composer
        {...baseProps}
        {...selectionProps('Re: Q3 budget')}
        hideContextPicker
        formatContextChip={(kind, label) => (kind === 'none' ? 'No email data' : label ?? 'This email')}
      />,
    );
    expect(screen.queryByTestId('context-select')).toBeNull();
    // The live context chip is still rendered.
    await waitFor(() =>
      expect(screen.getByTestId('context-chip').textContent).toContain('Re: Q3 budget'),
    );
  });

  it('renders host-supplied contextOptions and composerPlaceholder when provided', () => {
    const contextOptions = [
      { value: 'selection' as WorkbookContextKind, label: 'This email' },
      { value: 'none' as WorkbookContextKind, label: 'No email data' },
    ];
    render(
      <Composer
        {...baseProps}
        {...selectionProps(undefined)}
        contextOptions={contextOptions}
        composerPlaceholder="Ask about this email…"
      />,
    );
    const options = Array.from(
      screen.getByTestId('context-select').querySelectorAll('option'),
    ).map((o) => o.textContent);
    expect(options).toEqual(['This email', 'No email data']);
    expect(screen.getByTestId('composer-input').getAttribute('placeholder')).toBe(
      'Ask about this email…',
    );
  });
});
