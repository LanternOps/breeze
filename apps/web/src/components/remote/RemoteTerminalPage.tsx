import { useState, useEffect } from 'react';
import { ArrowLeft, Monitor, Loader2, AlertCircle } from 'lucide-react';
import RemoteTerminal from './RemoteTerminal';
import { fetchWithAuth } from '@/stores/auth';

type Device = {
  id: string;
  hostname: string;
  osType: string;
  osVersion: string;
  status: string;
  displayName?: string;
};

type RemoteTerminalPageProps = {
  deviceId: string;
};

export default function RemoteTerminalPage({ deviceId }: RemoteTerminalPageProps) {
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    const fetchDevice = async () => {
      try {
        const response = await fetchWithAuth(`/devices/${deviceId}`);

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error('Device not found');
          }
          throw new Error('Failed to fetch device');
        }

        const data = await response.json();
        setDevice(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchDevice();
  }, [deviceId]);

  const handleBack = () => {
    window.history.back();
  };

  const handleSessionCreated = (newSessionId: string) => {
    setSessionId(newSessionId);
  };

  const handleDisconnect = () => {
    setSessionId(null);
  };

  const handleError = (errorMessage: string) => {
    console.error('Terminal error:', errorMessage);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <AlertCircle className="h-12 w-12 text-red-500" />
        <h2 className="text-lg font-semibold">Error</h2>
        <p className="text-muted-foreground">{error}</p>
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <ArrowLeft className="h-4 w-4" />
          Go Back
        </button>
      </div>
    );
  }

  if (!device) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <Monitor className="h-12 w-12 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Device Not Found</h2>
        <p className="text-muted-foreground">The requested device could not be found.</p>
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <ArrowLeft className="h-4 w-4" />
          Go Back
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={handleBack}
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold">Remote Terminal</h1>
          <p className="text-muted-foreground">
            {device.displayName || device.hostname} - {device.osType} {device.osVersion}
          </p>
        </div>
      </div>

      {device.status !== 'online' && (
        <div className="flex items-start gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          <p className="text-sm text-yellow-800">
            Device status is currently <span className="font-medium">{device.status}</span>. Attempting to connect anyway.
          </p>
        </div>
      )}

      <RemoteTerminal
        deviceId={deviceId}
        deviceHostname={device.displayName || device.hostname}
        sessionId={sessionId || undefined}
        onSessionCreated={handleSessionCreated}
        onDisconnect={handleDisconnect}
        onError={handleError}
        className="min-h-[600px]"
      />
    </div>
  );
}
