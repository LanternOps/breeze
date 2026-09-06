import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../shared/ConfirmDialog';

export interface BulkPurgeTarget {
  hostname: string;
  orgId?: string | null;
}

export interface BulkPurgeDialogProps {
  open: boolean;
  targets: BulkPurgeTarget[];
  onClose: () => void;
  onConfirm: () => void;
  isLoading?: boolean;
}

/** How many hostnames are listed before collapsing into "and N more". */
const MAX_LISTED_HOSTNAMES = 5;

/**
 * Confirm dialog for bulk permanent delete (#2787).
 *
 * This is the ONLY irreversible bulk action in the product: the device row and
 * every record referencing it are gone, across up to 500 machines, with no undo
 * and (unlike single Remove) no 5-second undo window. So it asks for the COUNT
 * to be typed, not just a click — a "type the number" gate is the cheapest
 * control that fails an accidental select-all, which is precisely how a
 * 500-device purge gets started by mistake.
 *
 * It also names what is being deleted rather than only counting it: the first
 * few hostnames, and a warning when the selection spans more than one
 * organization, since a cross-org selection is usually an unnoticed
 * "All organizations" scope rather than an intent.
 */
export function BulkPurgeDialog({
  open,
  targets,
  onClose,
  onConfirm,
  isLoading = false,
}: BulkPurgeDialogProps) {
  const { t } = useTranslation('devices');
  const [typedCount, setTypedCount] = useState('');

  // Reset between openings, so a previously-typed count cannot arm the confirm
  // button for a DIFFERENT selection the next time the dialog opens.
  useEffect(() => {
    if (open) setTypedCount('');
  }, [open, targets.length]);

  const count = targets.length;
  const listed = targets.slice(0, MAX_LISTED_HOSTNAMES);
  const remaining = count - listed.length;
  const orgCount = new Set(targets.map((tgt) => tgt.orgId ?? null)).size;
  const confirmed = typedCount.trim() === String(count);

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title={t('devicesPage.bulkPurge.title', { count })}
      message={t('devicesPage.bulkPurge.message', { count })}
      confirmLabel={t('devicesPage.bulkPurge.confirm')}
      variant="destructive"
      isLoading={isLoading}
      confirmDisabled={!confirmed}
      confirmTestId="confirm-bulk-purge"
    >
      <div className="space-y-3">
        <ul
          data-testid="bulk-purge-targets"
          className="max-h-32 space-y-0.5 overflow-y-auto text-sm text-foreground"
        >
          {listed.map((target, index) => (
            <li key={`${target.hostname}-${index}`} className="truncate font-mono text-xs">
              {target.hostname}
            </li>
          ))}
          {remaining > 0 && (
            <li className="text-xs text-muted-foreground">
              {t('devicesPage.bulkPurge.andMore', { count: remaining })}
            </li>
          )}
        </ul>

        {orgCount > 1 && (
          <p data-testid="bulk-purge-org-warning" className="text-sm text-warning">
            {t('devicesPage.bulkPurge.multipleOrgs', { count: orgCount })}
          </p>
        )}

        <label className="block text-sm">
          <span className="text-muted-foreground">
            {t('devicesPage.bulkPurge.typeCount', { count })}
          </span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={typedCount}
            onChange={(e) => setTypedCount(e.target.value)}
            data-testid="bulk-purge-count"
            aria-label={t('devicesPage.bulkPurge.typeCount', { count })}
            className="mt-1 w-24 rounded-md border bg-background px-2 py-1 text-sm"
          />
        </label>
      </div>
    </ConfirmDialog>
  );
}

export default BulkPurgeDialog;
