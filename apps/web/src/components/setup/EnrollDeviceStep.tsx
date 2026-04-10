import { useEffect, useState, useCallback } from 'react';
import { Check, Copy, Loader2, Download, Link, ArrowLeft, Info } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

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
  const userPlatform = detectPlatform();

  // Tab state
  const [activeTab, setActiveTab] = useState<'installer' | 'cli'>(
    userPlatform === 'linux' ? 'cli' : 'installer',
  );

  // Installer state
  const [selectedPlatform, setSelectedPlatform] = useState<'windows' | 'macos'>(
    userPlatform === 'macos' ? 'macos' : 'windows',
  );
  const [deviceCount, setDeviceCount] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  // Generate link state
  const [generatedLink, setGeneratedLink] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const [linkCopied, setLinkCopied] = useState(false);

  // CLI state (lazy-loaded)
  const [cliInitialized, setCliInitialized] = useState(false);
  const [onboardingToken, setOnboardingToken] = useState('');
  const [enrollmentSecret, setEnrollmentSecret] = useState('');
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string>();
  const [tokenCopied, setTokenCopied] = useState(false);
  const [selectedOS, setSelectedOS] = useState<Platform>(userPlatform);

  const [finishing, setFinishing] = useState(false);

  const initializeCli = useCallback(async () => {
    if (cliInitialized) return;
    setCliInitialized(true);
    setTokenLoading(true);
    setOnboardingToken('');
    setEnrollmentSecret('');
    setTokenError(undefined);

    try {
      const res = await fetchWithAuth('/devices/onboarding-token', { method: 'POST' });
      if (!res.ok) {
        let msg = 'Failed to generate installation token';
        try { const data = await res.json(); msg = data.error || data.message || msg; } catch { /* ignore */ }
        setTokenError(msg);
        return;
      }
      const data = await res.json();
      if (!data.token) {
        setTokenError('Server returned empty token. Please try again.');
        return;
      }
      setOnboardingToken(data.token);
      if (data.enrollmentSecret) setEnrollmentSecret(data.enrollmentSecret);
    } catch {
      setTokenError('Failed to generate token. Check your connection.');
    } finally {
      setTokenLoading(false);
    }
  }, [cliInitialized]);

  // Auto-init CLI if that's the default tab
  useEffect(() => {
    if (activeTab === 'cli') void initializeCli();
  }, [activeTab, initializeCli]);

  const handleTabChange = (tab: 'installer' | 'cli') => {
    setActiveTab(tab);
    if (tab === 'cli') void initializeCli();
  };

  // --- Installer download ---
  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(undefined);
    setDownloadSuccess(false);

    try {
      // Create enrollment key scoped to the setup site
      const keyRes = await fetchWithAuth('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Setup installer (${new Date().toISOString().slice(0, 10)})`,
          siteId,
          orgId,
        }),
      });

      if (!keyRes.ok) {
        const body = await keyRes.json().catch(() => ({}));
        setDownloadError(body.error || `Failed to create enrollment key (${keyRes.status})`);
        return;
      }

      const keyData = await keyRes.json();

      // Download installer
      const dlController = new AbortController();
      const dlTimeout = setTimeout(() => dlController.abort(), 120_000);
      let dlRes: Response;
      try {
        dlRes = await fetchWithAuth(
          `/enrollment-keys/${keyData.id}/installer/${selectedPlatform}?count=${deviceCount}`,
          { signal: dlController.signal },
        );
      } finally {
        clearTimeout(dlTimeout);
      }

      if (!dlRes.ok) {
        const body = await dlRes.json().catch(() => ({}));
        setDownloadError(body.error || `Download failed (${dlRes.status})`);
        return;
      }

      const blob = await dlRes.blob();
      const filename = selectedPlatform === 'windows' ? 'breeze-agent.msi' : 'breeze-agent-macos.zip';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDownloadSuccess(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setDownloadError('Download timed out. Please check your connection and try again.');
      } else {
        setDownloadError(err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      setDownloading(false);
    }
  };

  // --- Generate public link ---
  const handleGenerateLink = async () => {
    if (linkLoading) return;
    setLinkLoading(true);
    setLinkError(undefined);
    setGeneratedLink('');

    try {
      const keyRes = await fetchWithAuth('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Setup link (${new Date().toISOString().slice(0, 10)})`,
          siteId,
          orgId,
        }),
      });

      if (!keyRes.ok) {
        const body = await keyRes.json().catch(() => ({}));
        setLinkError(body.error || `Failed to create enrollment key (${keyRes.status})`);
        return;
      }

      const keyData = await keyRes.json();

      const linkRes = await fetchWithAuth(`/enrollment-keys/${keyData.id}/installer-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: selectedPlatform, count: deviceCount }),
      });

      if (!linkRes.ok) {
        const body = await linkRes.json().catch(() => ({}));
        setLinkError(body.error || `Failed to generate link (${linkRes.status})`);
        return;
      }

      const linkData = await linkRes.json();
      setGeneratedLink(linkData.shortUrl ?? linkData.url);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLinkLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (!generatedLink) return;
    try {
      await navigator.clipboard.writeText(generatedLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      showToast({ type: 'success', message: 'Link copied to clipboard' });
    } catch {
      showToast({ type: 'error', message: 'Failed to copy link' });
    }
  };

  const handleCopyToken = async () => {
    if (!onboardingToken) return;
    try {
      await navigator.clipboard.writeText(onboardingToken);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      showToast({ type: 'error', message: 'Failed to copy token' });
    }
  };

  const handleCopyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      showToast({ type: 'success', message: 'Command copied to clipboard' });
    } catch {
      showToast({ type: 'error', message: 'Failed to copy command' });
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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Install the Breeze agent</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Download an installer or use the command line to set up your first device.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b">
        {(['installer', 'cli'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => handleTabChange(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
              activeTab === tab
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab === 'installer' ? 'Download Installer' : 'CLI Commands'}
          </button>
        ))}
      </div>

      {/* Installer tab */}
      {activeTab === 'installer' && (
        <div className="space-y-5">
          {/* Platform selector */}
          <div>
            <label className="block text-sm font-medium mb-1.5">Platform</label>
            <div className="flex gap-2">
              {(['windows', 'macos'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setSelectedPlatform(p)}
                  className={`flex-1 rounded-md px-4 py-2.5 text-sm font-medium transition border ${
                    selectedPlatform === p
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground border-border'
                  }`}
                >
                  {p === 'windows' ? 'Windows (.msi)' : 'macOS (.zip)'}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              For Linux, use the CLI Commands tab.
            </p>
          </div>

          {/* Device count */}
          <div>
            <label htmlFor="setup-device-count" className="block text-sm font-medium mb-1.5">
              Number of devices
            </label>
            <input
              id="setup-device-count"
              type="number"
              value={deviceCount}
              onChange={(e) => setDeviceCount(Math.min(1000, Math.max(1, Number(e.target.value) || 1)))}
              min={1}
              max={1000}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              How many devices will use this installer.
            </p>
          </div>

          {/* Download button */}
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading}
            className="w-full h-10 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {downloading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Generating installer...</>
            ) : downloadSuccess ? (
              <><Check className="h-4 w-4" /> Downloaded</>
            ) : (
              <><Download className="h-4 w-4" /> Download Installer</>
            )}
          </button>

          {/* Generate Link button */}
          <button
            type="button"
            onClick={handleGenerateLink}
            disabled={linkLoading}
            className="w-full h-10 rounded-md border border-primary text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {linkLoading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Generating link...</>
            ) : (
              <><Link className="h-4 w-4" /> Generate Shareable Link</>
            )}
          </button>

          {/* Generated link display */}
          {generatedLink && (
            <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 space-y-2">
              <p className="text-xs font-medium text-green-700 dark:text-green-300">
                Share this link to download the installer from any computer:
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={generatedLink}
                  className="flex-1 h-9 rounded-md border bg-background px-3 text-xs font-mono focus:outline-none"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 flex items-center gap-1.5"
                >
                  {linkCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {linkCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Valid for {deviceCount > 1 ? `${deviceCount} downloads` : '1 download'}.
                No login required.
              </p>
            </div>
          )}

          {/* Errors */}
          {downloadError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {downloadError}
              <button type="button" onClick={handleDownload} className="ml-2 underline hover:no-underline">Retry</button>
            </div>
          )}
          {linkError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {linkError}
              <button type="button" onClick={handleGenerateLink} className="ml-2 underline hover:no-underline">Retry</button>
            </div>
          )}

          {/* Success */}
          {downloadSuccess && (
            <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300">
              Installer downloaded. Run it on {deviceCount > 1 ? `up to ${deviceCount} devices` : 'the target device'} to enroll.
            </div>
          )}
        </div>
      )}

      {/* CLI tab */}
      {activeTab === 'cli' && (
        <div className="space-y-5">
          {/* Token */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
              Step 1 — Copy your installation token
            </p>
            <div className="rounded-lg border bg-muted/30 p-4">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium">Installation Token</label>
                <button
                  type="button"
                  onClick={handleCopyToken}
                  disabled={tokenLoading || !onboardingToken}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                >
                  <Copy className="h-3 w-3" />
                  {tokenCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              {tokenLoading ? (
                <div className="flex items-center gap-2 py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm text-muted-foreground">Generating token...</span>
                </div>
              ) : tokenError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {tokenError}
                  <button
                    type="button"
                    onClick={() => { setCliInitialized(false); void initializeCli(); }}
                    className="ml-2 underline hover:no-underline"
                  >
                    Retry
                  </button>
                </div>
              ) : (
                <code className="block rounded-md bg-background p-3 text-sm font-mono break-all">
                  {onboardingToken || 'No token available'}
                </code>
              )}
            </div>
          </div>

          {/* Commands */}
          {(() => {
            const apiUrl = (import.meta.env.PUBLIC_API_URL || window.location.origin).replace(/\/$/, '');
            const ghBase = (import.meta.env.PUBLIC_AGENT_DOWNLOAD_URL || 'https://github.com/lanternops/breeze/releases/latest/download').replace(/\/$/, '');
            const token = onboardingToken || '<TOKEN>';
            const secretFlag = enrollmentSecret ? ` --enrollment-secret "${enrollmentSecret}"` : '';

            const commands: Record<Platform, string> = {
              windows: `Invoke-WebRequest -Uri "${ghBase}/breeze-agent-windows-amd64.exe" -OutFile breeze-agent.exe; .\\breeze-agent.exe service install; .\\breeze-agent.exe enroll "${token}" --server "${apiUrl}"${secretFlag}; .\\breeze-agent.exe service start`,
              macos: `curl -fsSL -o /tmp/breeze-agent.pkg "${apiUrl}/api/v1/agents/download/darwin/$(uname -m | sed 's/x86_64/amd64/;s/arm64/arm64/')/pkg" && sudo installer -pkg /tmp/breeze-agent.pkg -target / && sudo breeze-agent enroll "${token}" --server "${apiUrl}"${secretFlag} && sudo launchctl kickstart -k system/com.breeze.agent`,
              linux: `curl -fsSL -o breeze-agent "${ghBase}/breeze-agent-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" && chmod +x breeze-agent && sudo mv breeze-agent /usr/local/bin/ && sudo breeze-agent service install && sudo breeze-agent enroll "${token}" --server "${apiUrl}"${secretFlag} && sudo breeze-agent service start`,
            };

            return (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                  Step 2 — Run the install command
                </p>
                <div className="flex gap-1 mb-3">
                  {(['windows', 'macos', 'linux'] as const).map((os) => (
                    <button
                      key={os}
                      type="button"
                      onClick={() => setSelectedOS(os)}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                        selectedOS === os
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      {os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : 'Linux'}
                    </button>
                  ))}
                </div>
                <div className="rounded-lg border bg-muted/30 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <code className="text-xs font-mono text-muted-foreground break-all">
                      {commands[selectedOS]}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopyCommand(commands[selectedOS])}
                      className="flex-shrink-0 p-1 hover:bg-muted rounded"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {selectedOS === 'windows' ? 'Run as Administrator in PowerShell' : 'Run in Terminal'}
                </p>
              </div>
            );
          })()}
        </div>
      )}

      {/* Token expiration notice */}
      <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-4 py-3 text-sm">
        <div className="flex gap-2">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-blue-600" />
          <p className="text-blue-700 dark:text-blue-300 text-xs">
            Installers and tokens expire in 24 hours. Need to enroll many devices?
            Generate bulk enrollment keys from <span className="font-medium">Settings &rarr; Enrollment Keys</span> after setup.
          </p>
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
