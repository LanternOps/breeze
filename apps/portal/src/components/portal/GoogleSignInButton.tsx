import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Google's sign-in button branding: only these three texts may sit beside the
 * G mark, so the label is typed to them rather than free text.
 */
export type GoogleButtonLabel = 'Sign in with Google' | 'Continue with Google' | 'Sign up with Google';

interface GoogleSignInButtonProps {
  onClick: () => void;
  label?: GoogleButtonLabel;
  busy?: boolean;
  testId?: string;
}

/** The standard four-colour G, unmodified, as an inline SVG (no remote asset or script). */
function GoogleLogo() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48" className="shrink-0">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/**
 * Google's button colours (light: white fill, #747775 stroke, #1F1F1F text;
 * dark: #131314 fill, #8E918F stroke, #E3E3E3 text), 14px medium text, 10px
 * between mark and text. The height keeps the portal's 44px phone tap target.
 * Roboto is named but never fetched: the portal loads no remote font.
 */
const GOOGLE_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center gap-2.5 rounded-md border border-[#747775] bg-white px-3 py-2 sm:min-h-10 text-sm font-medium text-[#1F1F1F] transition-colors hover:bg-[#F8F8F8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#8E918F] dark:bg-[#131314] dark:text-[#E3E3E3] dark:hover:bg-[#1F1F20]';

export function GoogleSignInButton({
  onClick,
  label = 'Sign in with Google',
  busy = false,
  testId = 'portal-login-google'
}: GoogleSignInButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={busy}
      className={cn(GOOGLE_BUTTON)}
      style={{ fontFamily: "Roboto, 'Segoe UI', Arial, sans-serif" }}
    >
      {busy ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <GoogleLogo />}
      {label}
    </button>
  );
}

export default GoogleSignInButton;
