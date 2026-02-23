import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import SetupStepper from './SetupStepper';
import AccountSetupStep from './AccountSetupStep';
import OrganizationSetupStep from './OrganizationSetupStep';
import ConfigReviewStep from './ConfigReviewStep';
import SetupSummaryStep from './SetupSummaryStep';

const STEPS = [
  { label: 'Account' },
  { label: 'Organization' },
  { label: 'Config' },
  { label: 'Summary' }
];

const STORAGE_KEY = 'breeze-setup-step';

export default function SetupWizard() {
  const [currentStep, setCurrentStep] = useState(0);
  const [stepsVisited, setStepsVisited] = useState([false, false, false]);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);

  // Restore step from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const step = parseInt(saved, 10);
        if (step >= 0 && step < STEPS.length) {
          setCurrentStep(step);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // Persist step to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(currentStep));
    } catch {
      // ignore
    }
  }, [currentStep]);

  // Auth guard: redirect non-setup users away
  useEffect(() => {
    if (!isAuthenticated) {
      window.location.href = '/login';
      return;
    }

    // Check if this user actually needs setup
    const checkSetup = async () => {
      try {
        const res = await fetchWithAuth('/users/me');
        if (res.ok) {
          const data = await res.json();
          if (!data.requiresSetup) {
            window.location.href = '/';
            return;
          }
        }
      } catch {
        // API check failed — redirect to home rather than allowing unauthorized wizard access
        window.location.href = '/';
        return;
      }
      setCheckingAuth(false);
    };

    checkSetup();
  }, [isAuthenticated]);

  const goToNext = (stepIndex: number) => {
    setStepsVisited((prev) => {
      const next = [...prev];
      next[stepIndex] = true;
      return next;
    });
    setCurrentStep((prev) => Math.min(prev + 1, STEPS.length - 1));
  };

  const handleSkipAll = async () => {
    try {
      await fetchWithAuth('/system/setup-complete', { method: 'POST' });
    } catch (err) {
      console.warn('[SetupWizard] Failed to mark setup complete:', err);
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.warn('[SetupWizard] Failed to clear localStorage:', err);
    }
    window.location.href = '/';
  };

  if (checkingAuth) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SetupStepper steps={STEPS} currentStep={currentStep} />

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        {currentStep === 0 && <AccountSetupStep onNext={() => goToNext(0)} />}
        {currentStep === 1 && <OrganizationSetupStep onNext={() => goToNext(1)} />}
        {currentStep === 2 && <ConfigReviewStep onNext={() => goToNext(2)} />}
        {currentStep === 3 && <SetupSummaryStep stepsVisited={stepsVisited} />}
      </div>

      {currentStep < 3 && (
        <div className="text-center">
          <button
            onClick={handleSkipAll}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Skip Setup
          </button>
        </div>
      )}
    </div>
  );
}
