import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { useHashState } from '@/lib/useHashState';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import { VerifyCallerModal, type VerifyCallerModalProps } from './VerifyCallerModal';

type Props = Omit<VerifyCallerModalProps, 'onClose'> & {
  /** Hash (without '#') that represents the open modal on this page. */
  hash: string;
  className?: string;
};

/**
 * "Verify caller" launcher. Renders nothing — and mounts no data-fetching
 * child — unless the runtime flag is on, even if the hash is deep-linked.
 */
export function CallerVerificationEntry(props: Props) {
  return useCallerVerificationEnabled() ? <Entry {...props} /> : null;
}

function Entry({ hash, className, ...modal }: Props) {
  const { t } = useTranslation('callerVerificationTech');
  const [open, setOpen] = useHashState(false, (raw) => raw === hash);
  const previous = useRef<string | null>(null);
  const close = () => {
    setOpen(false);
    if (window.location.hash.replace(/^#/, '') === hash) {
      window.location.hash = previous.current ?? '';
    }
  };
  return (
    <>
      <button type="button" data-testid="cv-entry"
        className={className ?? 'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted'}
        onClick={() => { previous.current = window.location.hash.replace(/^#/, ''); window.location.hash = hash; setOpen(true); }}>
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {t('open')}
      </button>
      {open && <VerifyCallerModal {...modal} onClose={close} />}
    </>
  );
}
