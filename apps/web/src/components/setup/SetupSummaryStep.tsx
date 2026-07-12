import { useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '@/lib/apiError';

interface SetupSummaryStepProps {
  stepsVisited: boolean[];
}

export default function SetupSummaryStep({ stepsVisited }: SetupSummaryStepProps) {
  const { t } = useTranslation('auth');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const stepLabels = [
    t('setup.steps.account'),
    t('setup.steps.organization'),
    t('setup.steps.configReview')
  ];

  const handleFinish = async () => {
    setLoading(true);
    setError(undefined);

    try {
      const res = await fetchWithAuth('/system/setup-complete', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(extractApiError(data, t('setup.summary.errors.completeFailed')));
        setLoading(false);
        return;
      }
      try { localStorage.removeItem('breeze-setup-step'); } catch { /* ignore */ }
      window.location.href = '/';
    } catch {
      setError(t('setup.common.unexpectedError'));
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t('setup.summary.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('setup.summary.description')}
        </p>
      </div>

      <div className="space-y-2">
        {stepLabels.map((label, index) => (
          <div
            key={label}
            className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3"
          >
            <CheckCircle
              className={
                stepsVisited[index]
                  ? 'h-5 w-5 text-green-600 dark:text-green-400'
                  : 'h-5 w-5 text-muted-foreground'
              }
            />
            <div className="flex-1">
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-muted-foreground">
                {stepsVisited[index] ? t('setup.summary.completed') : t('setup.summary.skipped')}
              </p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        {t('setup.summary.settingsLater')}
      </p>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex justify-end pt-2">
        <button
          onClick={handleFinish}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('setup.summary.goToDashboard')}
        </button>
      </div>
    </div>
  );
}
