import { useCallback, useState, useEffect } from 'react';
import { ArrowLeft, X, Key, Copy, Check } from 'lucide-react';
import VncViewer from './VncViewer';
import { fetchWithAuth } from '@/stores/auth';

interface Props {
  tunnelId: string;
  wsUrl: string;
  password?: string;
}

export default function VncViewerPage({ tunnelId, wsUrl, password: initialPassword }: Props) {
  const [copied, setCopied] = useState(false);
  const [password, setPassword] = useState(initialPassword || '');

  // Read password from sessionStorage (set by ConnectDesktopButton before navigation)
  useEffect(() => {
    const key = `vnc-pwd-${tunnelId}`;
    const pwd = sessionStorage.getItem(key);
    if (pwd) {
      setPassword(pwd);
      sessionStorage.removeItem(key);
    }
  }, [tunnelId]);

  const handleDisconnect = useCallback(() => {
    fetchWithAuth(`/tunnels/${tunnelId}`, { method: 'DELETE' }).catch((err) => {
      console.error(`[VncViewerPage] Failed to close tunnel ${tunnelId}:`, err);
    });
    window.location.href = '/remote';
  }, [tunnelId]);

  const handleCopyPassword = useCallback(async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be blocked
    }
  }, [password]);

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-4 py-2">
        <div className="flex items-center gap-3">
          <a
            href="/remote"
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </a>
          <span className="text-sm text-gray-500">|</span>
          <span className="text-sm font-medium text-gray-200">
            VNC Session
          </span>
          <span className="text-xs text-gray-500">{tunnelId.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-2">
          {password && (
            <button
              type="button"
              onClick={handleCopyPassword}
              className="flex items-center gap-1.5 rounded-md bg-gray-800 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-700 transition"
              title="Copy VNC password"
            >
              <Key className="h-3 w-3" />
              <span className="font-mono">{password}</span>
              {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
            </button>
          )}
          <button
            type="button"
            onClick={handleDisconnect}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition"
          >
            <X className="h-4 w-4" />
            Disconnect
          </button>
        </div>
      </div>
      <div className="flex-1">
        <VncViewer
          wsUrl={wsUrl}
          tunnelId={tunnelId}
          password={password}
          onDisconnect={handleDisconnect}
        />
      </div>
    </div>
  );
}
