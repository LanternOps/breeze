import { describe, it, expect } from 'vitest';
import {
  SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS,
  SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS,
  SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS,
  SOFTWARE_INSTALL_SERVER_TIMEOUT_MS,
} from './softwareInstallTimeouts';

const MIN = 60 * 1000;

describe('software install timeouts', () => {
  it('pins the server timeout at 75 min and the script timeout at 10 min', () => {
    expect(SOFTWARE_INSTALL_SERVER_TIMEOUT_MS).toBe(75 * MIN);
    expect(SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS).toBe(10 * MIN);
  });

  it('server timeout exceeds the agent worst case (download + installer + 2 scripts + 1 min settle)', () => {
    const worst =
      SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS +
      SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS +
      2 * SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS +
      MIN;
    expect(worst).toBe(66 * MIN);
    expect(SOFTWARE_INSTALL_SERVER_TIMEOUT_MS).toBeGreaterThan(worst);
  });
});
