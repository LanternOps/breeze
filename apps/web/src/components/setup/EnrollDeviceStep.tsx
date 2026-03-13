import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, Monitor, Apple, Terminal } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type Platform = 'windows' | 'macos' | 'linux';

interface EnrollDeviceStepProps {
  orgId: string;
  siteId: string;
  onFinish: () => void;
}

export default function EnrollDeviceStep({ orgId, siteId, onFinish }: EnrollDeviceStepProps) {
  const [enrollmentKey, setEnrollmentKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [platform, setPlatform] = useState<Platform>('windows');
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    createEnrollmentKey();
  }, [orgId, siteId]);

  const createEnrollmentKey = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth('/enrollment-keys', {
        method: 'POST',
        body: JSON.stringify({
          orgId,
          siteId,
          name: 'Setup Wizard Key',
        }),
      });

      if (!res.ok) {
        let msg = 'Failed to create enrollment key';
        try {
          const data = await res.json();
          msg = data.error || msg;
        } catch {
          /* ignore parse error */
        }
        setError(msg);
        return;
      }

      const data = await res.json();
      if (data.key) {
        setEnrollmentKey(data.key);
      } else {
        setError('No enrollment key returned from server');
      }
    } catch {
      setError('Failed to create enrollment key. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
    }
  };

  const handleFinish = async () => {
    setFinishing(true);
    try {
      await fetchWithAuth('/system/setup-complete', { method: 'POST' });
    } catch (err) {
      console.warn('[EnrollDeviceStep] Failed to mark setup complete:', err);
    }
    try {
      localStorage.removeItem('breeze-setup-step');
    } catch {
      /* ignore */
    }
    window.location.href = '/';
  };

  const getInstallCommands = (key: string): Record<Platform, string> => ({
    windows: `# Run in PowerShell as Administrator
Invoke-WebRequest -Uri "$env:BREEZE_API_URL/api/v1/agents/download?os=windows&arch=amd64" -OutFile breeze-agent.exe
.\\breeze-agent.exe enroll ${key}`,
    macos: `# Run in Terminal
curl -fsSL "$BREEZE_API_URL/api/v1/agents/download?os=darwin&arch=arm64" -o breeze-agent
chmod +x breeze-agent
sudo ./breeze-agent enroll ${key}`,
    linux: `# Run in Terminal
curl -fsSL "$BREEZE_API_URL/api/v1/agents/download?os=linux&arch=amd64" -o breeze-agent
chmod +x breeze-agent
sudo ./breeze-agent enroll ${key}`,
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={createEnrollmentKey}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={handleFinish}
            className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Skip for now
          </button>
        </div>
      </div>
    );
  }

  const commands = enrollmentKey ? getInstallCommands(enrollmentKey) : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Enroll Your First Device</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Use the enrollment key below to install the Breeze agent on your first device.
        </p>
      </div>

      {/* Enrollment Key */}
      {enrollmentKey && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            Enrollment Key
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs">
              {enrollmentKey}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(enrollmentKey)}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 text-green-500" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  Copy
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Platform Tabs */}
      {commands && (
        <div>
          <div className="flex border-b">
            {([
              { key: 'windows' as Platform, label: 'Windows', icon: Monitor },
              { key: 'macos' as Platform, label: 'macOS', icon: Apple },
              { key: 'linux' as Platform, label: 'Linux', icon: Terminal },
            ]).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setPlatform(key)}
                className={`inline-flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                  platform === key
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          <div className="mt-3 rounded-md bg-muted p-4">
            <div className="flex items-start justify-between gap-2">
              <pre className="flex-1 overflow-x-auto whitespace-pre-wrap text-xs font-mono">
                {commands[platform]}
              </pre>
              <button
                type="button"
                onClick={() => handleCopy(commands[platform])}
                className="shrink-0 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={handleFinish}
          disabled={finishing}
          className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          I'll do this later
        </button>
        <button
          type="button"
          onClick={handleFinish}
          disabled={finishing}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
        >
          {finishing && <Loader2 className="h-4 w-4 animate-spin" />}
          Go to Dashboard
        </button>
      </div>
    </div>
  );
}
