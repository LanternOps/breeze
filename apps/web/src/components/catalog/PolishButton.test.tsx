import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const polishTextRequest = vi.fn();
vi.mock('../../lib/api/catalog', () => ({
  polishTextRequest: (...a: unknown[]) => polishTextRequest(...a),
}));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));

import PolishButton from './PolishButton';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const fail = (code: string, message: string, status: number) =>
  new Response(JSON.stringify({ code, error: message }), { status });

beforeEach(() => {
  polishTextRequest.mockReset();
  showToast.mockReset();
});

describe('PolishButton', () => {
  it('polishes, previews before→after, and applies on approval', async () => {
    polishTextRequest.mockResolvedValue(ok({
      name: 'APC Back-UPS 600VA', description: 'Battery backup with 7 outlets.', changed: true,
    }));
    const onApply = vi.fn();
    render(
      <PolishButton
        idSuffix="t"
        getText={() => ({ name: 'spl apc back-ups 600va disti', description: 'backup,7 outlets' })}
        onApply={onApply}
      />,
    );

    fireEvent.click(screen.getByTestId('polish-btn-t'));

    await waitFor(() => expect(screen.getByTestId('polish-apply-t')).toBeInTheDocument());
    // Before shows the raw input, after shows the polished text.
    expect(screen.getByTestId('polish-before-name-t').textContent).toContain('spl apc back-ups 600va disti');
    expect(screen.getByTestId('polish-after-name-t').textContent).toContain('APC Back-UPS 600VA');

    fireEvent.click(screen.getByTestId('polish-apply-t'));
    expect(onApply).toHaveBeenCalledWith({
      name: 'APC Back-UPS 600VA', description: 'Battery backup with 7 outlets.',
    });
    // Sends only non-blank fields.
    expect(polishTextRequest).toHaveBeenCalledWith({
      name: 'spl apc back-ups 600va disti', description: 'backup,7 outlets',
    });
  });

  it('skips the preview and toasts when nothing changed', async () => {
    polishTextRequest.mockResolvedValue(ok({ name: 'Already Clean', description: null, changed: false }));
    const onApply = vi.fn();
    render(<PolishButton idSuffix="t" getText={() => ({ name: 'Already Clean' })} onApply={onApply} />);

    fireEvent.click(screen.getByTestId('polish-btn-t'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(screen.queryByTestId('polish-apply-t')).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('does not apply when the user cancels the preview', async () => {
    polishTextRequest.mockResolvedValue(ok({ name: 'Polished', description: null, changed: true }));
    const onApply = vi.fn();
    render(<PolishButton idSuffix="t" getText={() => ({ name: 'polished' })} onApply={onApply} />);

    fireEvent.click(screen.getByTestId('polish-btn-t'));
    await waitFor(() => expect(screen.getByTestId('polish-cancel-t')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('polish-cancel-t'));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByTestId('polish-apply-t')).not.toBeInTheDocument();
  });

  it('refuses to call the API when both fields are blank', () => {
    const onApply = vi.fn();
    render(<PolishButton idSuffix="t" getText={() => ({ name: '  ', description: '' })} onApply={onApply} />);
    fireEvent.click(screen.getByTestId('polish-btn-t'));
    expect(polishTextRequest).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('surfaces the fact-drift error and does not open the preview', async () => {
    polishTextRequest.mockResolvedValue(
      fail('AI_FACT_DRIFT', 'AI could not polish this without changing the product details — left unchanged', 502),
    );
    const onApply = vi.fn();
    render(<PolishButton idSuffix="t" getText={() => ({ name: 'apc 600va' })} onApply={onApply} />);

    fireEvent.click(screen.getByTestId('polish-btn-t'));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(screen.queryByTestId('polish-apply-t')).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });
});
