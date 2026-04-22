import { useState, useEffect, useCallback, useMemo } from 'react';
import { Download, Copy, Loader2, Check, Link } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { showToast } from '../shared/Toast';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { navigateTo } from '@/lib/navigation';

function detectUserOS(): 'windows' | 'macos' | 'linux' {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

interface AddDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function AddDeviceModal({ isOpen, onClose }: AddDeviceModalProps) {
  const userOS = detectUserOS();
  const { currentOrgId, currentSiteId, sites } = useOrgStore();
  const orgSites = useMemo(
    () => sites.filter((s) => s.orgId === currentOrgId),
    [sites, currentOrgId],
  );

  // Tab state
  const [activeTab, setActiveTab] = useState<'installer' | 'cli'>(
    userOS === 'linux' ? 'cli' : 'installer',
  );

  // Installer tab state
  const [selectedPlatform, setSelectedPlatform] = useState<'windows' | 'macos'>(
    userOS === 'macos' ? 'macos' : 'windows',
  );
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [deviceCount, setDeviceCount] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  // Generate link state
  const [generatedLink, setGeneratedLink] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string>();
  const [linkCopied, setLinkCopied] = useState(false);

  // CLI tab state (lazy-loaded)
  const [cliInitialized, setCliInitialized] = useState(false);
  const [onboardingToken, setOnboardingToken] = useState('');
  const [enrollmentSecret, setEnrollmentSecret] = useState('');
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string>();
  const [tokenCopied, setTokenCopied] = useState(false);
  const [selectedOS, setSelectedOS] = useState<'windows' | 'macos' | 'linux'>(userOS);
  const [sha256s, setSha256s] = useState<Record<string, string>>({});

  // Fetch published SHA256SUMS so users can verify uninstall scripts before running
  useEffect(() => {
    fetch('/scripts/SHA256SUMS')
      .then((r) => r.text())
      .then((t) => {
        const map: Record<string, string> = {};
        for (const line of t.trim().split('\n')) {
          const [hash, name] = line.split(/\s+/, 2);
          if (hash && name) map[name] = hash;
        }
        setSha256s(map);
      })
      .catch(() => {});
  }, []);

  // Initialize site selection
  useEffect(() => {
    if (!isOpen) return;
    if (currentSiteId && orgSites.some((s) => s.id === currentSiteId)) {
      setSelectedSiteId(currentSiteId);
    } else if (orgSites.length > 0) {
      setSelectedSiteId(orgSites[0].id);
    }
  }, [isOpen, currentSiteId, orgSites]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setDownloadError(undefined);
      setDownloadSuccess(false);
      setDeviceCount(1);
      setCliInitialized(false);
      setOnboardingToken('');
      setTokenError(undefined);
      setGeneratedLink('');
      setLinkError(undefined);
      setLinkCopied(false);
    }
  }, [isOpen]);

  // Lazy-load CLI token when CLI tab is first opened
  const initializeCli = useCallback(async () => {
    if (cliInitialized) return;
    setCliInitialized(true);
    setTokenLoading(true);
    setOnboardingToken('');
    setEnrollmentSecret('');
    setTokenError(undefined);

    try {
      const response = await fetchWithAuth('/devices/onboarding-token', { method: 'POST' });

      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        let errorMessage = 'Failed to generate installation token';
        try {
          const errorData = await response.json();
          const rawMessage = errorData.message || errorData.error || '';
          if (response.status === 403 && rawMessage.toLowerCase().includes('mfa required')) {
            errorMessage = 'MFA_REQUIRED';
          } else {
            errorMessage = rawMessage || errorMessage;
          }
        } catch {
          if (response.status === 404) {
            errorMessage = 'Token generation service not available. Please contact support.';
          } else if (response.status >= 500) {
            errorMessage = 'Server error. Please try again later.';
          }
        }
        setTokenError(errorMessage);
        return;
      }

      const data = await response.json();
      if (!data.token) {
        setTokenError('Server returned an unexpected response. Please try again.');
        return;
      }
      setOnboardingToken(data.token);
      if (data.enrollmentSecret) {
        setEnrollmentSecret(data.enrollmentSecret);
      }
    } catch (err) {
      setTokenError(
        err instanceof Error ? err.message : 'Network error. Please check your connection.',
      );
    } finally {
      setTokenLoading(false);
    }
  }, [cliInitialized]);

  // Exchange a raw enrollment key token for a short-lived one-time handle, then
  // navigate to the public-download URL. This keeps the raw token out of browser
  // history, server logs, and referrer headers.
  async function downloadInstaller(keyId: string, rawToken: string, platform: 'windows' | 'macos') {
    const res = await fetchWithAuth(`/enrollment-keys/${keyId}/download-handle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawToken }),
    });
    if (!res.ok) throw new Error('Failed to prepare download');
    const { handle } = (await res.json()) as { handle: string };
    window.location.href = `/api/v1/enrollment-keys/public-download/${platform}?h=${encodeURIComponent(handle)}`;
  }

  const handleTabChange = (tab: 'installer' | 'cli') => {
    setActiveTab(tab);
    if (tab === 'cli') {
      void initializeCli();
    }
  };

  // --- Installer download ---
  const handleDownload = async () => {
    if (downloading || !selectedSiteId) return;
    setDownloading(true);
    setDownloadError(undefined);
    setDownloadSuccess(false);

    let parentKeyId: string | undefined;

    try {
      // Step 1: Create parent enrollment key (template — child key handles actual enrollment count)
      const keyRes = await fetchWithAuth('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Add device installer (${new Date().toISOString().slice(0, 10)})`,
          siteId: selectedSiteId,
          orgId: currentOrgId,
        }),
      });

      if (!keyRes.ok) {
        const body = await keyRes.json().catch(() => ({ error: 'Failed to create enrollment key' }));
        const rawMessage = body.message || body.error || '';
        if (keyRes.status === 403 && rawMessage.toLowerCase().includes('mfa required')) {
          setDownloadError('MFA_REQUIRED');
        } else {
          setDownloadError(rawMessage || `Failed to create enrollment key (${keyRes.status})`);
        }
        return;
      }

      const keyData = await keyRes.json();
      parentKeyId = keyData.id;

      // Step 2: Download installer (use longer timeout — binary can be large)
      const dlController = new AbortController();
      const dlTimeout = setTimeout(() => dlController.abort(), 120_000);
      let dlRes: Response;
      try {
        dlRes = await fetchWithAuth(
          `/enrollment-keys/${parentKeyId}/installer/${selectedPlatform}?count=${deviceCount}`,
          { signal: dlController.signal },
        );
      } finally {
        clearTimeout(dlTimeout);
      }

      if (!dlRes.ok) {
        const body = await dlRes.json().catch(() => ({ error: 'Download failed' }));
        setDownloadError(body.error || `Download failed (${dlRes.status})`);
        return;
      }

      const blob = await dlRes.blob();
      const filename =
        selectedPlatform === 'windows' ? 'breeze-agent.msi' : 'breeze-agent-macos.zip';
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
        const message = err instanceof Error ? err.message : 'Unknown error';
        setDownloadError(`Failed to download installer: ${message}`);
      }
    } finally {
      setDownloading(false);
    }
  };

  // --- Generate public link ---
  const handleGenerateLink = async () => {
    if (linkLoading || !selectedSiteId) return;
    setLinkLoading(true);
    setLinkError(undefined);
    setGeneratedLink('');

    try {
      // Step 1: Create parent enrollment key
      const keyRes = await fetchWithAuth('/enrollment-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Add device link (${new Date().toISOString().slice(0, 10)})`,
          siteId: selectedSiteId,
          orgId: currentOrgId,
        }),
      });

      if (!keyRes.ok) {
        const body = await keyRes.json().catch(() => ({ error: 'Failed to create enrollment key' }));
        const rawMessage = body.message || body.error || '';
        if (keyRes.status === 403 && rawMessage.toLowerCase().includes('mfa required')) {
          setLinkError('MFA_REQUIRED');
        } else {
          setLinkError(rawMessage || `Failed to create enrollment key (${keyRes.status})`);
        }
        return;
      }

      const keyData = await keyRes.json();

      // Step 2: Generate public link
      const linkRes = await fetchWithAuth(`/enrollment-keys/${keyData.id}/installer-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: selectedPlatform, count: deviceCount }),
      });

      if (!linkRes.ok) {
        const body = await linkRes.json().catch(() => ({ error: 'Failed to generate link' }));
        setLinkError(body.error || `Failed to generate link (${linkRes.status})`);
        return;
      }

      const linkData = await linkRes.json();
      setGeneratedLink(linkData.shortUrl ?? linkData.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setLinkError(`Failed to generate link: ${message}`);
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

  // --- CLI helpers ---
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

  return (
    <Dialog open={isOpen} onClose={onClose} title="Add New Device" maxWidth="2xl">
      <div className="p-6">
        <h2 className="text-lg font-semibold mb-4">Add New Device</h2>

        {/* Tab bar */}
        <div className="flex gap-1 mb-6 border-b">
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
            {orgSites.length === 0 ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700">
                No sites available. Please{' '}
                <a href="/settings/organizations" className="font-medium underline hover:no-underline">
                  create a site
                </a>{' '}
                first.
              </div>
            ) : (
              <>
                {/* Site selector */}
                <div>
                  <label htmlFor="installer-site" className="block text-sm font-medium mb-1.5">
                    Site
                  </label>
                  <select
                    id="installer-site"
                    value={selectedSiteId}
                    onChange={(e) => setSelectedSiteId(e.target.value)}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {orgSites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </select>
                </div>

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
                  <label htmlFor="device-count" className="block text-sm font-medium mb-1.5">
                    Number of devices
                  </label>
                  <input
                    id="device-count"
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
                  disabled={downloading || !selectedSiteId}
                  className="w-full h-10 rounded-md bg-primary text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {downloading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Generating installer...
                    </>
                  ) : downloadSuccess ? (
                    <>
                      <Check className="h-4 w-4" />
                      Downloaded
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4" />
                      Download Installer
                    </>
                  )}
                </button>

                {/* Generate Link button */}
                <button
                  type="button"
                  onClick={handleGenerateLink}
                  disabled={linkLoading || !selectedSiteId}
                  className="w-full h-10 rounded-md border border-primary text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {linkLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Generating link...
                    </>
                  ) : (
                    <>
                      <Link className="h-4 w-4" />
                      Generate Link
                    </>
                  )}
                </button>

                {/* Generated link display */}
                {generatedLink && (
                  <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 space-y-2">
                    <p className="text-xs font-medium text-green-700">
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

                {/* Link errors */}
                {linkError === 'MFA_REQUIRED' && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
                    Multi-factor authentication is required to generate links.{' '}
                    <a
                      href="/settings/profile"
                      className="font-medium underline hover:no-underline"
                    >
                      Set up MFA in your profile settings
                    </a>{' '}
                    and sign in again, then retry.
                  </div>
                )}

                {linkError && linkError !== 'MFA_REQUIRED' && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {linkError}
                    <button
                      type="button"
                      onClick={handleGenerateLink}
                      className="ml-2 underline hover:no-underline"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {/* MFA error */}
                {downloadError === 'MFA_REQUIRED' && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
                    Multi-factor authentication is required to generate installers.{' '}
                    <a
                      href="/settings/profile"
                      className="font-medium underline hover:no-underline"
                    >
                      Set up MFA in your profile settings
                    </a>{' '}
                    and sign in again, then retry.
                  </div>
                )}

                {/* Other errors */}
                {downloadError && downloadError !== 'MFA_REQUIRED' && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {downloadError}
                    <button
                      type="button"
                      onClick={handleDownload}
                      className="ml-2 underline hover:no-underline"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {/* Success message */}
                {downloadSuccess && (
                  <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm text-green-700">
                    Installer downloaded. Run it on{' '}
                    {deviceCount > 1
                      ? `up to ${deviceCount} devices`
                      : 'the target device'}{' '}
                    to enroll.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* CLI Commands tab */}
        {activeTab === 'cli' && (
          <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
              Install the Breeze agent on your device using the command line. Use the installation
              token and commands below.
            </p>

            {/* Token section */}
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
                ) : tokenError === 'MFA_REQUIRED' ? (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700">
                    Multi-factor authentication is required to generate installation tokens.{' '}
                    <a
                      href="/settings/profile"
                      className="font-medium underline hover:no-underline"
                    >
                      Set up MFA in your profile settings
                    </a>{' '}
                    and sign in again, then retry.
                  </div>
                ) : tokenError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {tokenError}
                    <button
                      type="button"
                      onClick={() => {
                        setCliInitialized(false);
                        void initializeCli();
                      }}
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

            {/* Commands section */}
            {(() => {
              const apiUrl = (
                import.meta.env.PUBLIC_API_URL || window.location.origin
              ).replace(/\/$/, '');
              const ghBase = (
                import.meta.env.PUBLIC_AGENT_DOWNLOAD_URL ||
                'https://github.com/lanternops/breeze/releases/latest/download'
              ).replace(/\/$/, '');
              const token = onboardingToken || '<TOKEN>';
              const secretFlag = enrollmentSecret
                ? ` --enrollment-secret "${enrollmentSecret}"`
                : '';

              const winCmd = `Invoke-WebRequest -Uri "${ghBase}/breeze-agent-windows-amd64.exe" -OutFile breeze-agent.exe; .\\breeze-agent.exe service install; .\\breeze-agent.exe enroll "${token}" --server "${apiUrl}"${secretFlag}; .\\breeze-agent.exe service start`;
              const macCmd = `curl -fsSL -o /tmp/breeze-agent.pkg "${apiUrl}/api/v1/agents/download/darwin/$(uname -m | sed 's/x86_64/amd64/;s/arm64/arm64/')/pkg" && sudo installer -pkg /tmp/breeze-agent.pkg -target / && sudo breeze-agent enroll "${token}" --server "${apiUrl}"${secretFlag} && sudo launchctl kickstart -k system/com.breeze.agent`;
              const linuxCmd = `curl -fsSL -o breeze-agent "${ghBase}/breeze-agent-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" && chmod +x breeze-agent && sudo mv breeze-agent /usr/local/bin/ && sudo breeze-agent service install && sudo breeze-agent enroll "${token}" --server "${apiUrl}"${secretFlag} && sudo breeze-agent service start`;

              const commands = { windows: winCmd, macos: macCmd, linux: linuxCmd };

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

            {/* Wait for connection */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Step 3 — Wait for connection
              </p>
              <div className="rounded-md border border-blue-500/40 bg-blue-500/10 p-4 text-sm">
                <p className="text-blue-600 text-xs">
                  The installation token expires in 24 hours. Your device will appear in the list
                  once the agent connects.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 flex items-start justify-between gap-4">
          <div className="text-xs text-muted-foreground">
            <p>
              Need to uninstall?{' '}
              <a
                href="/scripts/uninstall-darwin.sh"
                download
                className="underline hover:text-foreground"
              >
                macOS
              </a>
              {' · '}
              <a
                href="/scripts/uninstall-linux.sh"
                download
                className="underline hover:text-foreground"
              >
                Linux
              </a>
            </p>
            {sha256s['uninstall-darwin.sh'] && (
              <p className="mt-1 font-mono text-[10px] leading-tight">
                macOS SHA256: {sha256s['uninstall-darwin.sh']}
                <br />
                Verify: <code>shasum -a 256 uninstall-darwin.sh</code>
              </p>
            )}
            {sha256s['uninstall-linux.sh'] && (
              <p className="mt-1 font-mono text-[10px] leading-tight">
                Linux SHA256: {sha256s['uninstall-linux.sh']}
                <br />
                Verify: <code>shasum -a 256 uninstall-linux.sh</code>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-10 shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}
