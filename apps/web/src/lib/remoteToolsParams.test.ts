import { describe, expect, it } from 'vitest';

import { parseRemoteToolsParams } from './remoteToolsParams';

describe('parseRemoteToolsParams', () => {
  it('returns null when required params are missing', () => {
    expect(parseRemoteToolsParams(new URLSearchParams(''))).toBeNull();
    expect(parseRemoteToolsParams(new URLSearchParams('deviceId=dev-1'))).toBeNull();
    expect(parseRemoteToolsParams(new URLSearchParams('deviceName=Host-1'))).toBeNull();
  });

  it('sanitizes device name and normalizes darwin to macos', () => {
    const params = parseRemoteToolsParams(
      new URLSearchParams('deviceId=dev-1&deviceName=%3Cscript%3EHost%26One%3C/script%3E&os=darwin')
    );

    expect(params).toEqual({
      deviceId: 'dev-1',
      deviceName: 'scriptHostOnescript',
      deviceOs: 'macos'
    });
  });

  it('defaults unsupported os values to windows', () => {
    const params = parseRemoteToolsParams(
      new URLSearchParams('deviceId=dev-2&deviceName=Device%202&os=solaris')
    );

    expect(params?.deviceOs).toBe('windows');
  });
});
