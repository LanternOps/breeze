import { useState } from 'react';

type RecoveryCodesProps = {
  codes: string[];
  onContinue?: () => void;
};

export default function RecoveryCodes({ codes, onContinue }: RecoveryCodesProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = codes.join('\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const separator = '='.repeat(30);
    const text = 'Breeze RMM Recovery Codes\n' + separator + '\n\n' + codes.join('\n') + '\n\nGenerated: ' + new Date().toISOString() + '\n\nStore these codes safely. Each code can only be used once.';
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'breeze-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Save your recovery codes</h2>
        <p className="text-sm text-muted-foreground">
          These codes can be used to access your account if you lose your authenticator device.
          Each code can only be used once.
        </p>
      </div>

      <div className="rounded-md border bg-muted p-4">
        <div className="grid grid-cols-2 gap-2 font-mono text-sm">
          {codes.map((code, index) => (
            <div
              key={'recovery-code-' + index}
              className="rounded bg-background px-3 py-2 text-center"
            >
              {code}
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md border text-sm font-medium transition hover:bg-muted"
        >
          {copied ? (
            <>
              <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy
            </>
          )}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md border text-sm font-medium transition hover:bg-muted"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download
        </button>
      </div>

      <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-600 dark:text-yellow-400">
        <strong>Important:</strong> Store these codes in a secure location. You will not be able to see them again.
      </div>

      {onContinue && (
        <button
          type="button"
          onClick={onContinue}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          I have saved my codes
        </button>
      )}
    </div>
  );
}
