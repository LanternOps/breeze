import { create } from 'zustand';

interface UiState {
  isMobileMenuOpen: boolean;
  toggleMobileMenu: () => void;
  closeMobileMenu: () => void;

  // Cmd+K / "/" search palette. Lives here (not in CommandPalette's local
  // state) so the global shortcut hook and any other island can open it.
  isCommandPaletteOpen: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;

  // "?" keyboard-shortcuts cheat sheet.
  isShortcutsHelpOpen: boolean;
  openShortcutsHelp: () => void;
  closeShortcutsHelp: () => void;
  toggleShortcutsHelp: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  isMobileMenuOpen: false,
  toggleMobileMenu: () => set((s) => ({ isMobileMenuOpen: !s.isMobileMenuOpen })),
  closeMobileMenu: () => set({ isMobileMenuOpen: false }),

  isCommandPaletteOpen: false,
  openCommandPalette: () => set({ isCommandPaletteOpen: true, isShortcutsHelpOpen: false }),
  closeCommandPalette: () => set({ isCommandPaletteOpen: false }),
  toggleCommandPalette: () =>
    set((s) => ({ isCommandPaletteOpen: !s.isCommandPaletteOpen, isShortcutsHelpOpen: false })),

  isShortcutsHelpOpen: false,
  openShortcutsHelp: () => set({ isShortcutsHelpOpen: true, isCommandPaletteOpen: false }),
  closeShortcutsHelp: () => set({ isShortcutsHelpOpen: false }),
  toggleShortcutsHelp: () =>
    set((s) => ({ isShortcutsHelpOpen: !s.isShortcutsHelpOpen, isCommandPaletteOpen: false })),
}));
