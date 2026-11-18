import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT } from '@breeze/shared';

/** Upper bound the installer route's `count` query param accepts. */
export const INSTALLER_MAX_DEVICE_COUNT = 100000;

export type InstallerPlatform = 'windows' | 'macos';

export interface InstallerDownloadTarget {
  keyId: string;
  keyName: string;
  platform: InstallerPlatform;
  /** The key's own remaining enrollments, or null for an unlimited key. */
  remainingUses: number | null;
}

interface Props {
  target: InstallerDownloadTarget | null;
  downloading: boolean;
  onCancel: () => void;
  onConfirm: (target: InstallerDownloadTarget, count: number) => void;
}

/**
 * Asks how many devices the installer built from an enrollment-key row
 * should enroll (#9615). The installer route sizes the embedded credential
 * from `count` and falls back to a single device without it, so the row must
 * always send one — the same device-count question Add Device asks.
 *
 * The default is the key's remaining uses, and a limited key cannot be
 * stretched past them here; an unlimited key defaults to the product default
 * device count, bounded only by the route's own maximum.
 */
export default function InstallerDownloadDialog({ target, ...rest }: Props) {
  if (!target) return null;
  // Keyed so every open starts from THIS key's default — never a value left
  // over from the previous key's dialog, not even for one render.
  return <InstallerDownloadForm key={`${target.keyId}:${target.platform}`} target={target} {...rest} />;
}

function InstallerDownloadForm({
  target,
  downloading,
  onCancel,
  onConfirm,
}: Omit<Props, 'target'> & { target: InstallerDownloadTarget }) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState(() =>
    String(target.remainingUses ?? PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT),
  );

  const max = target.remainingUses ?? INSTALLER_MAX_DEVICE_COUNT;
  const count = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  const valid = Number.isInteger(count) && count >= 1 && count <= max;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || downloading) return;
    onConfirm(target, count);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !downloading) onCancel();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="installer-download-title"
        aria-describedby="installer-download-description"
        onKeyDown={handleKeyDown}
        className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs"
      >
        <h2 id="installer-download-title" className="text-lg font-semibold">
          {t('enrollmentKeys.installerDialogTitle', { name: target.keyName })}
        </h2>
        <p id="installer-download-description" className="mt-2 text-sm text-muted-foreground">
          {t('enrollmentKeys.installerDialogDescription')}
        </p>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor="installer-device-count" className="text-sm font-medium">
              {t('enrollmentKeys.installerDeviceCount')}
            </label>
            <input
              id="installer-device-count"
              data-testid="installer-device-count"
              type="number"
              inputMode="numeric"
              autoFocus
              min={1}
              max={max}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={!valid}
              aria-describedby="installer-device-count-help"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary"
            />
            <p id="installer-device-count-help" className="mt-1 text-xs text-muted-foreground">
              {target.remainingUses !== null
                ? t('enrollmentKeys.installerDeviceCountRemaining', { count: target.remainingUses })
                : t('enrollmentKeys.installerDeviceCountUnlimited')}
            </p>
            {!valid && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {t('enrollmentKeys.installerDeviceCountRange', { max })}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              data-testid="installer-download-cancel"
              onClick={onCancel}
              disabled={downloading}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="submit"
              data-testid="installer-download-confirm"
              disabled={!valid || downloading}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {downloading ? t('enrollmentKeys.downloading') : t('common:actions.download')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
