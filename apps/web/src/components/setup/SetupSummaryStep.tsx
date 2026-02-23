import { useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

interface SetupSummaryStepProps {
  stepsVisited: boolean[];
}

const STEP_LABELS = ['Account', 'Organization', 'Config Review'];

export default function SetupSummaryStep({ stepsVisited }: SetupSummaryStepProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const handleFinish = async () => {
    setLoading(true);
    setError(undefined);

    try {
      const res = await fetchWithAuth('/system/setup-complete', { method: 'POST' });
      if (!res.ok) {
        let msg = 'Failed to complete setup';
        try { const data = await res.json(); msg = data.error || msg; } catch { /* ignore parse error */ }
        setError(msg);
        setLoading(false);
        return;
      }
      try { localStorage.removeItem('breeze-setup-step'); } catch { /* ignore */ }
      window.location.href = '/';
    } catch {
      setError('An unexpected error occurred');
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Setup Complete</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Here's a summary of the setup steps you completed.
        </p>
      </div>

      <div className="space-y-2">
        {STEP_LABELS.map((label, index) => (
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
                {stepsVisited[index] ? 'Completed' : 'Skipped'}
              </p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        You can always change these settings later from the Settings page.
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
          className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          Go to Dashboard
        </button>
      </div>
    </div>
  );
}
