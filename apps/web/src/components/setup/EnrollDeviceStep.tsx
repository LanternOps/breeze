import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, Monitor, Apple, Terminal, ArrowLeft, Info } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type Platform = 'windows' | 'macos' | 'linux';

interface EnrollDeviceStepProps {
  orgId: string;
  siteId: string;
  onBack?: () => void;
  onFinish: () => void;
}

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'windows';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('linux')) return 'linux';
  return 'windows';
}

export default function EnrollDeviceStep({ orgId, siteId, onBack, onFinish: _onFinish }: EnrollDeviceStepProps) {
  const [onboardingToken, setOnboardingToken] = useState<string | null>(null);
  const [enrollmentSecret, setEnrollmentSecret] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [copiedToken, setCopiedToken] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<Platform | null>(null);
  const [platform, setPlatform] = useState<Platform>(detectPlatform);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    createOnboardingToken();
  }, [orgId, siteId]);

  const createOnboardingToken = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth('/devices/onboarding-token', {
        method: 'POST',
      });

      if (!res.ok) {
        let msg = 'Failed to generate installation token';
        try {
          const data = await res.json();
          msg = data.message || data.error || msg;
        } catch { /* ignore */ }
        setError(msg);
        return;
      }

      const data = await res.json();
      const token = data.token ?? data.onboardingToken ?? data.data?.token;
      if (!token) {
        setError('Server returned empty token. Please try again.');
        return;
      }
      setOnboardingToken(token);
      if (data.enrollmentSecret) {
        setEnrollmentSecret(data.enrollmentSecret);
      }
    } catch {
      setError('Failed to generate token. Check your connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (text: string, type: 'token' | Platform) => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === 'token') {
        setCopiedToken(true);
        setTimeout(() => setCopiedToken(false), 2000);
      } else {
        setCopiedCmd(type);
        setTimeout(() => setCopiedCmd(null), 2000);
      }
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
      localStorage.removeItem('breeze-setup-org');
      localStorage.removeItem('breeze-setup-site');
    } catch { /* ignore */ }
    window.location.href = '/';
  };

  const getInstallCommands = (token: string): Record<Platform, { label: string; cmd: string }> => {
    const apiUrl = (import.meta.env.PUBLIC_API_URL || window.location.origin).replace(/\/$/, '');
    const ghBase = (import.meta.env.PUBLIC_AGENT_DOWNLOAD_URL || 'https://github.com/lanternops/breeze/releases/latest/download').replace(/\/$/, '');
    const secretFlag = enrollmentSecret ? ` --enrollment-secret "${enrollmentSecret}"` : '';

    return {
      windows: {
        label: 'Windows (PowerShell — Run as Administrator)',
        cmd: `Invoke-WebRequest -Uri "${ghBase}/breeze-agent-windows-amd64.exe" -OutFile breeze-agent.exe; .\\breeze-agent.exe service install; .\\breeze-agent.exe enroll "${token}" --server "${apiUrl}"${secretFlag}; .\\breeze-agent.exe service start`,
      },
      macos: {
        label: 'macOS (Terminal)',
        cmd: `curl -fsSL -o /tmp/breeze-agent.pkg "${apiUrl}/api/v1/agents/download/darwin/$(uname -m | sed 's/x86_64/amd64/;s/arm64/arm64/')/pkg" && sudo installer -pkg /tmp/breeze-agent.pkg -target / && sudo breeze-agent enroll "${token}" --server "${apiUrl}"${secretFlag} && sudo launchctl kickstart -k system/com.breeze.agent`,
      },
      linux: {
        label: 'Linux (Terminal)',
        cmd: `curl -fsSL -o breeze-agent "${ghBase}/breeze-agent-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" && chmod +x breeze-agent && sudo mv breeze-agent /usr/local/bin/ && sudo breeze-agent service install && sudo breeze-agent enroll "${token}" --server "${apiUrl}"${secretFlag} && sudo breeze-agent service start`,
      },
    };
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Generating installation token...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
        <div className="flex justify-between">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          )}
          <div className="flex gap-3 ml-auto">
            <button
              type="button"
              onClick={createOnboardingToken}
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
      </div>
    );
  }

  const commands = onboardingToken ? getInstallCommands(onboardingToken) : null;
  const platformOrder: Platform[] = [platform, ...(['windows', 'macos', 'linux'] as Platform[]).filter(p => p !== platform)];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Install the Breeze agent</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Run one of the commands below to install the agent on your first device.
          The device will appear in your dashboard once connected.
        </p>
      </div>

      {/* Installation Token */}
      {onboardingToken && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            Installation Token
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs">
              {onboardingToken}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(onboardingToken, 'token')}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              {copiedToken ? (
                <>
                  <Check className="h-3 w-3 text-emerald-500" />
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

      {/* Platform Commands */}
      {commands && (
        <div className="space-y-4">
          {platformOrder.map((key) => {
            const { label, cmd } = commands[key];
            const Icon = key === 'windows' ? Monitor : key === 'macos' ? Apple : Terminal;
            const isCopied = copiedCmd === key;

            return (
              <div key={key}>
                <h3 className="flex items-center gap-1.5 text-sm font-semibold mb-2">
                  <Icon className="h-4 w-4" />
                  {label}
                  {key === platform && (
                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      Detected
                    </span>
                  )}
                </h3>
                <div className="rounded-lg border bg-muted/30 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <code className="flex-1 overflow-x-auto text-xs font-mono text-muted-foreground break-all">
                      {cmd}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopy(cmd, key)}
                      className="flex-shrink-0 inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
                    >
                      {isCopied ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-500" />
                          Copied
                        </>
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Token expiration notice */}
      <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm">
        <div className="flex gap-2">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-blue-600" />
          <div>
            <p className="text-blue-700 dark:text-blue-300">
              This token expires in 24 hours. Need to enroll many devices? You can generate
              bulk enrollment keys from <span className="font-medium">Settings &rarr; Enrollment Keys</span> after setup.
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        <div>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={handleFinish}
          disabled={finishing}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
        >
          {finishing && <Loader2 className="h-4 w-4 animate-spin" />}
          Continue to Dashboard
        </button>
      </div>
    </div>
  );
}
