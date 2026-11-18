import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapturedInstructionDto } from '@breeze/shared';

const store = vi.hoisted(() => ({ keep: vi.fn(), forget: vi.fn(), keepForOrg: vi.fn() }));
vi.mock('@/stores/wispInstructionCaptureStore', () => ({
  useWispInstructionCaptureStore: (sel: (s: unknown) => unknown) => sel(store),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/components/shared/Toast', () => toast);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts ? `${key}|${Object.values(opts).join('|')}` : key),
  }),
}));

import WispInstructionChip from './WispInstructionChip';
import { ActionError } from '@/lib/runAction';

const dto = (over: Partial<CapturedInstructionDto> = {}): CapturedInstructionDto => ({
  instructionId: 'i-1', captureId: 'c-1', capturedAt: '2026-11-08T10:00:00.000Z', text: "don't reboot PC-01 and PC-02",
  status: 'unconfirmed', enforceable: true, verb: 'reboot', targetLabels: ['PC-01', 'PC-02'], until: null,
  orgId: 'o-1', orgName: 'Acme', unmatched: false, keptForOrg: false, ...over,
});

beforeEach(() => {
  store.keep.mockReset().mockResolvedValue(undefined);
  store.forget.mockReset().mockResolvedValue(undefined);
  store.keepForOrg.mockReset().mockResolvedValue(undefined);
  toast.showToast.mockReset();
});

describe('WispInstructionChip', () => {
  it('shows the remembered text and, when enforceable, the enforced form', () => {
    render(<WispInstructionChip sessionId="s1" instruction={dto()} />);
    const chip = screen.getByTestId('wisp-instruction-chip');
    expect(chip.textContent).toContain('wisp.instruction.remembered');
    expect(chip.textContent).toContain('wisp.instruction.enforcedForm');
    expect(chip.textContent).toContain('PC-01, PC-02');
    expect(chip.textContent).toContain('wisp.instruction.noEnd');
  });

  it('omits the enforced form when not enforceable', () => {
    render(<WispInstructionChip sessionId="s1" instruction={dto({ enforceable: false, verb: null })} />);
    expect(screen.getByTestId('wisp-instruction-chip').textContent).not.toContain('enforcedForm');
  });

  it('shows the unmatched note', () => {
    render(<WispInstructionChip sessionId="s1" instruction={dto({ unmatched: true })} />);
    expect(screen.getByTestId('wisp-instruction-chip').textContent).toContain('wisp.instruction.unmatched');
  });

  it('hides keep-for-org when there is no org', () => {
    render(<WispInstructionChip sessionId="s1" instruction={dto({ orgId: null, orgName: null })} />);
    expect(screen.getByTestId('wisp-instruction-chip-keep')).toBeTruthy();
    expect(screen.queryByTestId('wisp-instruction-chip-keep-org')).toBeNull();
  });

  it('renders nothing when retracted', () => {
    const { container } = render(<WispInstructionChip sessionId="s1" instruction={dto({ status: 'retracted' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('has no buttons once confirmed and says kept', () => {
    render(<WispInstructionChip sessionId="s1" instruction={dto({ status: 'confirmed' })} />);
    expect(screen.queryByTestId('wisp-instruction-chip-keep')).toBeNull();
    expect(screen.queryByTestId('wisp-instruction-chip-forget')).toBeNull();
    expect(screen.getByTestId('wisp-instruction-chip').textContent).toContain('wisp.instruction.kept');
  });

  it('says kept for the org when keptForOrg', () => {
    render(<WispInstructionChip sessionId="s1" instruction={dto({ status: 'confirmed', keptForOrg: true })} />);
    expect(screen.getByTestId('wisp-instruction-chip').textContent).toContain('wisp.instruction.keptForOrg|Acme');
  });

  it('calls the store actions', async () => {
    render(<WispInstructionChip sessionId="s1" instruction={dto()} />);
    fireEvent.click(screen.getByTestId('wisp-instruction-chip-keep'));
    await waitFor(() => expect(store.keep).toHaveBeenCalledWith('s1', 'i-1'));
    fireEvent.click(screen.getByTestId('wisp-instruction-chip-keep-org'));
    await waitFor(() => expect(store.keepForOrg).toHaveBeenCalledWith('s1', 'i-1'));
    fireEvent.click(screen.getByTestId('wisp-instruction-chip-forget'));
    await waitFor(() => expect(store.forget).toHaveBeenCalledWith('s1', 'i-1'));
  });

  it('disables the buttons while a mutation is in flight', async () => {
    let done!: () => void;
    store.keep.mockReturnValue(new Promise<void>((r) => { done = r; }));
    render(<WispInstructionChip sessionId="s1" instruction={dto()} />);
    fireEvent.click(screen.getByTestId('wisp-instruction-chip-keep'));
    await waitFor(() => expect((screen.getByTestId('wisp-instruction-chip-forget') as HTMLButtonElement).disabled).toBe(true));
    done();
    await waitFor(() => expect((screen.getByTestId('wisp-instruction-chip-forget') as HTMLButtonElement).disabled).toBe(false));
  });

  it('toasts an unexpected error but not an ActionError', async () => {
    store.keep.mockRejectedValueOnce(new Error('boom'));
    render(<WispInstructionChip sessionId="s1" instruction={dto()} />);
    fireEvent.click(screen.getByTestId('wisp-instruction-chip-keep'));
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledTimes(1));
    store.forget.mockRejectedValueOnce(new ActionError('x', 409));
    fireEvent.click(screen.getByTestId('wisp-instruction-chip-forget'));
    await waitFor(() => expect(store.forget).toHaveBeenCalled());
    expect(toast.showToast).toHaveBeenCalledTimes(1);
  });
});
