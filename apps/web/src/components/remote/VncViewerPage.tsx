import { useCallback } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import VncViewer from './VncViewer';
import { fetchWithAuth } from '@/stores/auth';

interface Props {
  tunnelId: string;
  wsUrl: string;
}

/**
 * Full-page VNC viewer wrapper. Shown when the user opens a VNC session
 * in the browser (fallback from Tauri deep link or direct navigation).
 */
export default function VncViewerPage({ tunnelId, wsUrl }: Props) {
  const handleDisconnect = useCallback(() => {
    fetchWithAuth(`/tunnels/${tunnelId}`, { method: 'DELETE' }).catch(() => {});
    window.close();
    // If window.close() doesn't work (not opened via script), navigate back
    setTimeout(() => {
      window.location.href = '/remote';
    }, 200);
  }, [tunnelId]);

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
        <button
          type="button"
          onClick={handleDisconnect}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition"
        >
          <X className="h-4 w-4" />
          Disconnect
        </button>
      </div>
      <div className="flex-1">
        <VncViewer
          wsUrl={wsUrl}
          tunnelId={tunnelId}
          onDisconnect={handleDisconnect}
        />
      </div>
    </div>
  );
}
