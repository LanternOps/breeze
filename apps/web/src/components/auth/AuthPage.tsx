import { useEffect, useState } from 'react';
import LoginPage from './LoginPage';
import PartnerRegisterPage from './PartnerRegisterPage';
import { useRegistrationGate } from '../../stores/featuresStore';

interface AuthPageProps {
  next?: string;
}

type Tab = 'signin' | 'signup';

function getInitialTab(): Tab {
  if (typeof window === 'undefined') return 'signin';
  return window.location.hash === '#signup' ? 'signup' : 'signin';
}

export default function AuthPage({ next }: AuthPageProps) {
  const [tab, setTab] = useState<Tab>(getInitialTab);

  // Runtime registration gate (#1308 / #1979). The server enforces
  // ENABLE_REGISTRATION on /auth/register-partner; mirror it client-side so the
  // signup tab/form is never offered (then dead-ended) when registration is
  // disabled. The gate is read from runtime /config, the same source of truth
  // PartnerRegisterPage and LoginForm consult — not a build-time PUBLIC_ flag.
  const { enabled: registrationEnabled, loaded: gateLoaded } = useRegistrationGate();

  useEffect(() => {
    const onHashChange = () => {
      setTab(window.location.hash === '#signup' ? 'signup' : 'signin');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleTabChange = (newTab: Tab) => {
    window.location.hash = newTab;
    setTab(newTab);
  };

  const wantsSignup = tab === 'signup';

  return (
    <div data-testid="auth-page">
      {/* Only offer the signup tab when self-service registration is open. A
          login-only deployment shows just the sign-in view rather than a
          "Create account" tab that dead-ends into a disabled form (#1979). */}
      {registrationEnabled && (
        <div className="mb-6 flex rounded-lg border bg-muted/40 p-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'signin'}
            data-testid="tab-signin"
            onClick={() => handleTabChange('signin')}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${
              tab === 'signin' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'signup'}
            data-testid="tab-signup"
            onClick={() => handleTabChange('signup')}
            className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${
              tab === 'signup' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Create account
          </button>
        </div>
      )}

      {!wantsSignup ? (
        <LoginPage next={next} />
      ) : registrationEnabled ? (
        <PartnerRegisterPage next={next} />
      ) : gateLoaded ? (
        // Hash points at #signup but registration is disabled. Show a closed
        // notice instead of the form (which would otherwise mount and redirect
        // off-page) so a directly-shared /auth#signup link isn't a dead end.
        <div data-testid="registration-disabled-notice">
          <div className="mb-8">
            <p className="text-sm font-medium text-muted-foreground">Registration closed</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">Sign-ups are disabled</h1>
          </div>
          <div className="mb-6 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200">
            New registrations are currently disabled. Please contact your administrator for an
            invitation.
          </div>
          <button
            type="button"
            data-testid="back-to-signin"
            onClick={() => handleTabChange('signin')}
            className="font-medium text-primary hover:underline"
          >
            Back to sign in
          </button>
        </div>
      ) : (
        // Gate not resolved yet — render nothing rather than flashing the form
        // or the closed notice before /config answers.
        null
      )}
    </div>
  );
}
