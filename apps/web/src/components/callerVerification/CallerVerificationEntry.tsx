import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { useHashState } from '@/lib/useHashState';
import { useCallerVerificationEnabled } from '@/lib/useCallerVerificationEnabled';
import { VerifyCallerModal, type VerifyCallerModalProps } from './VerifyCallerModal';

type Props = Omit<VerifyCallerModalProps, 'onClose'> & {
  /**
   * Hash (without '#') that represents the open modal on this page, so it can
   * be deep-linked. Omit it on pages whose hash belongs to someone else (the
   * /tickets split view keeps the queue selection there): the modal then
   * opens from local state and the URL is never touched.
   */
  hash?: string;
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
  const [hashOpen, setHashOpen] = useHashState(false, (raw) => hash !== undefined && raw === hash);
  const [localOpen, setLocalOpen] = useState(false);
  const open = hash === undefined ? localOpen : hashOpen;
  const previous = useRef<string | null>(null);
  const openModal = () => {
    if (hash === undefined) { setLocalOpen(true); return; }
    previous.current = window.location.hash.replace(/^#/, '');
    window.location.hash = hash;
    setHashOpen(true);
  };
  const close = () => {
    if (hash === undefined) { setLocalOpen(false); return; }
    setHashOpen(false);
    if (window.location.hash.replace(/^#/, '') === hash) {
      if (previous.current) window.location.hash = previous.current;
      // No prior hash: drop the fragment entirely instead of leaving a bare '#'.
      else history.replaceState(history.state, '', window.location.pathname + window.location.search);
    }
  };
  return (
    <>
      <button type="button" data-testid="cv-entry"
        className={className ?? 'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted'}
        onClick={openModal}>
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {t('open')}
      </button>
      {open && <VerifyCallerModal {...modal} onClose={close} />}
    </>
  );
}
