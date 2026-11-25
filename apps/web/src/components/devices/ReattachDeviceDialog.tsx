import { useTranslation } from 'react-i18next';
import { RefreshCcw } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import ReattachDeviceForm from './ReattachDeviceForm';
import type { ReattachCandidate, ReattachRequestedIntent, ReinstallCandidatesView } from '../../lib/deviceReattach';
import '../../lib/i18n';

export interface ReattachDeviceDialogProps {
  open: boolean;
  source: ReinstallCandidatesView['source'];
  candidate: ReattachCandidate;
  passkeyCount?: number;
  mfaMethod?: string | null;
  /** Whether an authenticator app is enrolled (`GET /users/me`), as primary or backup. */
  totpEnrolled?: boolean;
  onClose: () => void;
  onRequested: (intent: ReattachRequestedIntent) => void;
  onTargetChanged?: () => void;
  onConflict?: (code: string | undefined) => void;
}

/**
 * The reattach request (#8318 §8) as its own dialog, for surfaces that are not
 * already a dialog (the possible-replacement banner). The holding-area assign
 * dialog renders the same ReattachDeviceForm inside its own panel instead.
 */
export default function ReattachDeviceDialog({
  open,
  source,
  candidate,
  passkeyCount,
  mfaMethod,
  totpEnrolled,
  onClose,
  onRequested,
  onTargetChanged,
  onConflict,
}: ReattachDeviceDialogProps) {
  const { t } = useTranslation('devices');
  const title = t('reattachDialog.title', { target: candidate.hostname });
  return (
    <Dialog open={open} onClose={onClose} title={title} maxWidth="2xl" className="p-6">
      <div data-testid="reattach-dialog">
        <div className="flex gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <RefreshCcw className="h-5 w-5 text-primary" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('reattachDialog.description', { source: source.hostname, target: candidate.hostname })}
            </p>
          </div>
        </div>
        <ReattachDeviceForm
          source={source}
          candidate={candidate}
          passkeyCount={passkeyCount}
          mfaMethod={mfaMethod}
          totpEnrolled={totpEnrolled}
          onClose={onClose}
          onRequested={onRequested}
          onTargetChanged={onTargetChanged}
          onConflict={onConflict}
        />
      </div>
    </Dialog>
  );
}
