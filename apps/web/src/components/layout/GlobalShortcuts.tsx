import { useGlobalShortcuts } from '../../lib/keyboard/useGlobalShortcuts';
import { useRecentsRecorder } from './useRecentsRecorder';
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';
import ChordIndicator from './ChordIndicator';

/**
 * One persisted island per authenticated page (DashboardLayout): app-wide
 * keyboard shortcuts, the recents recorder behind the sidebar's recent
 * devices and Cmd+K's recent sections, the "?" cheat sheet, and the hint
 * shown while a `g` / `c` chord waits for its second key.
 */
export default function GlobalShortcuts() {
  const pendingChord = useGlobalShortcuts();
  useRecentsRecorder();
  return (
    <>
      <KeyboardShortcutsHelp />
      <ChordIndicator prefix={pendingChord} />
    </>
  );
}
