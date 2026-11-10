import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BTN_SECONDARY } from './ui';

interface MicrosoftSignInButtonProps {
  onClick: () => void;
  label?: string;
  busy?: boolean;
  testId?: string;
}

function MicrosoftLogo() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 21 21" className="shrink-0">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export function MicrosoftSignInButton({
  onClick,
  label = 'Sign in with Microsoft',
  busy = false,
  testId = 'portal-login-microsoft'
}: MicrosoftSignInButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={busy}
      className={cn(BTN_SECONDARY, 'w-full')}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MicrosoftLogo />}
      {label}
    </button>
  );
}

export default MicrosoftSignInButton;
