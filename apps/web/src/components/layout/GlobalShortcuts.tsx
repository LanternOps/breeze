import { useGlobalShortcuts } from '../../lib/keyboard/useGlobalShortcuts';
import { useRecentsRecorder } from './useRecentsRecorder';
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';

/**
 * One persisted island per authenticated page (DashboardLayout): app-wide
 * keyboard shortcuts, the recents recorder behind the sidebar's recent
 * devices and Cmd+K's recent sections, and the "?" cheat sheet.
 */
export default function GlobalShortcuts() {
  useGlobalShortcuts();
  useRecentsRecorder();
  return <KeyboardShortcutsHelp />;
}
