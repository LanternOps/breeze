export type RemoteToolsOs = 'windows' | 'macos' | 'linux';

export type RemoteToolsRouteParams = {
  deviceId: string;
  deviceName: string;
  deviceOs: RemoteToolsOs;
};

const sanitizeDeviceName = (value: string): string => value.replace(/[<>"'&/\\]/g, '').trim();

export function parseRemoteToolsParams(searchParams: URLSearchParams): RemoteToolsRouteParams | null {
  const deviceId = searchParams.get('deviceId')?.trim() ?? '';
  const rawDeviceName = searchParams.get('deviceName')?.trim() ?? '';

  if (!deviceId || !rawDeviceName) {
    return null;
  }

  const deviceName = sanitizeDeviceName(rawDeviceName);
  if (!deviceName) {
    return null;
  }

  const osParam = searchParams.get('os')?.trim().toLowerCase() ?? '';
  const normalizedOs = osParam === 'darwin' ? 'macos' : osParam;
  const deviceOs: RemoteToolsOs =
    normalizedOs === 'windows' || normalizedOs === 'macos' || normalizedOs === 'linux'
      ? normalizedOs
      : 'windows';

  return {
    deviceId,
    deviceName,
    deviceOs
  };
}
