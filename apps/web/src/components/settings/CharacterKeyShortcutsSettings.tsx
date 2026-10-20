import { useCallback, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { UserPreferences } from '../../stores/auth';
import { saveUserPreferences } from '@/lib/userPreferences';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';

type Props = {
  preferences?: UserPreferences | null;
  onSaved?: (preferences: UserPreferences) => void;
};

/** Anchor the keyboard-shortcuts help dialog links to. */
export const CHARACTER_KEY_SHORTCUTS_ANCHOR = 'character-key-shortcuts';

/**
 * #9348 (WCAG 2.1.4): per-user switch for single-character shortcuts.
 * Home: user profile. Level: user. Resolver: `characterKeyShortcuts !== false`
 * (default on) — see `areCharacterKeyShortcutsEnabled`.
 */
export default function CharacterKeyShortcutsSettings({ preferences, onSaved }: Props) {
  const { t } = useTranslation('settings');
  const [isSaving, setIsSaving] = useState(false);
  const enabled = preferences?.characterKeyShortcuts !== false;

  const toggle = useCallback(async (next: boolean) => {
    setIsSaving(true);
    try {
      const saved = await saveUserPreferences(
        { characterKeyShortcuts: next },
        t('characterKeyShortcuts.saveFailed'),
      );
      onSaved?.(saved);
      showToast({
        type: 'success',
        message: t(next ? 'characterKeyShortcuts.enabledToast' : 'characterKeyShortcuts.disabledToast'),
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('characterKeyShortcuts.saveFailed') });
      }
    } finally {
      setIsSaving(false);
    }
  }, [onSaved, t]);

  return (
    <div
      id={CHARACTER_KEY_SHORTCUTS_ANCHOR}
      className="rounded-lg border bg-card p-6 shadow-xs"
      data-testid="character-key-shortcuts-settings"
    >
      <div className="flex items-center gap-2">
        <Keyboard className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{t('characterKeyShortcuts.title')}</h2>
      </div>
      <p id="character-key-shortcuts-desc" className="mt-1 mb-4 text-sm text-muted-foreground">
        {t('characterKeyShortcuts.description')}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={isSaving}
          aria-describedby="character-key-shortcuts-desc"
          onChange={(e) => void toggle(e.target.checked)}
        />
        {t('characterKeyShortcuts.label')}
      </label>
    </div>
  );
}
