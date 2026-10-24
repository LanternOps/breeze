import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const saveMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/userPreferences', () => ({ saveUserPreferences: saveMock }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

import CharacterKeyShortcutsSettings from './CharacterKeyShortcutsSettings';

beforeEach(() => saveMock.mockReset());

describe('CharacterKeyShortcutsSettings', () => {
  it('defaults to on and persists an off toggle through the preferences API', async () => {
    saveMock.mockResolvedValue({ characterKeyShortcuts: false });
    const onSaved = vi.fn();
    render(<CharacterKeyShortcutsSettings preferences={{}} onSaved={onSaved} />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ characterKeyShortcuts: false }));
    expect(saveMock).toHaveBeenCalledWith({ characterKeyShortcuts: false }, expect.any(String));
  });

  it('toggling back on from a stored false saves true', async () => {
    saveMock.mockResolvedValue({ characterKeyShortcuts: true });
    render(<CharacterKeyShortcutsSettings preferences={{ characterKeyShortcuts: false }} />);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ characterKeyShortcuts: true }, expect.any(String)));
  });

  it('reflects a stored false', () => {
    render(<CharacterKeyShortcutsSettings preferences={{ characterKeyShortcuts: false }} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
});
