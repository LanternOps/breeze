import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import SetupStepper from './SetupStepper';
import AccountSetupStep from './AccountSetupStep';
import OrganizationSetupStep from './OrganizationSetupStep';
import EnrollDeviceStep from './EnrollDeviceStep';

const STEPS = [
  { label: 'Account' },
  { label: 'Organization' },
  { label: 'Install Agent' },
];

const STORAGE_KEY = 'breeze-setup-step';
const SETUP_ORG_KEY = 'breeze-setup-org';
const SETUP_SITE_KEY = 'breeze-setup-site';

export default function SetupWizard() {
  const [currentStep, setCurrentStep] = useState(0);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isHydrated, setIsHydrated] = useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);

  // Created org/site IDs passed from step 1 to step 2 (persisted to localStorage)
  const [orgId, setOrgId] = useState<string | null>(() => {
    try { return localStorage.getItem(SETUP_ORG_KEY); } catch { return null; }
  });
  const [siteId, setSiteId] = useState<string | null>(() => {
    try { return localStorage.getItem(SETUP_SITE_KEY); } catch { return null; }
  });

  // Names for completion screen
  const [orgName, setOrgName] = useState('');
  const [siteName, setSiteName] = useState('');

  // Wait for zustand to rehydrate from localStorage before checking auth
  useEffect(() => {
    const timer = setTimeout(() => setIsHydrated(true), 100);
    return () => clearTimeout(timer);
  }, []);

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
    if (!isHydrated || isLoading) return;

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
  }, [isHydrated, isLoading, isAuthenticated]);

  const handleAccountStepComplete = () => {
    setCurrentStep(1);
  };

  const handleOrgStepComplete = (createdOrgId: string, createdSiteId: string, createdOrgName: string, createdSiteName: string) => {
    setOrgId(createdOrgId);
    setSiteId(createdSiteId);
    setOrgName(createdOrgName);
    setSiteName(createdSiteName);
    try { localStorage.setItem(SETUP_ORG_KEY, createdOrgId); } catch { /* ignore */ }
    try { localStorage.setItem(SETUP_SITE_KEY, createdSiteId); } catch { /* ignore */ }
    setCurrentStep(2);
  };

  const handleStepClick = (step: number) => {
    setCurrentStep(step);
  };

  const handleBackToOrg = () => {
    setCurrentStep(1);
  };

  const handleSkipAll = async () => {
    try {
      await fetchWithAuth('/system/setup-complete', { method: 'POST' });
    } catch (err) {
      console.warn('[SetupWizard] Failed to mark setup complete:', err);
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SETUP_ORG_KEY);
      localStorage.removeItem(SETUP_SITE_KEY);
    } catch (err) {
      console.warn('[SetupWizard] Failed to clear localStorage:', err);
    }
    window.location.href = '/';
  };

  const handleEnrollFinish = () => {
    // EnrollDeviceStep handles setup-complete and redirect internally
  };

  if (checkingAuth) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Checking your account...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SetupStepper steps={STEPS} currentStep={currentStep} onStepClick={handleStepClick} />

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        {currentStep === 0 && (
          <AccountSetupStep onNext={handleAccountStepComplete} />
        )}
        {currentStep === 1 && (
          <OrganizationSetupStep onNext={handleOrgStepComplete} />
        )}
        {currentStep === 2 && orgId && siteId && (
          <EnrollDeviceStep
            orgId={orgId}
            siteId={siteId}
            onBack={handleBackToOrg}
            onFinish={handleEnrollFinish}
          />
        )}
      </div>

      {currentStep === 0 && (
        <div className="text-center">
          <button
            onClick={handleSkipAll}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Skip setup — I'll configure this later
          </button>
        </div>
      )}
    </div>
  );
}
