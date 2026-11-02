import { createHash } from 'node:crypto';
import { windowsInstallerIntegritySchema } from '@breeze/shared';
import { onboardingServerUrl } from './onboardingServerUrl';
import { generateWindowsInstallScript } from './windowsInstallScript';

export function getWindowsInstaller(serverUrl = onboardingServerUrl()) {
  if (!serverUrl) return null;
  const script = generateWindowsInstallScript(serverUrl).replace(/\r\n?/g, '\n');
  const body = new TextEncoder().encode(script);
  const integrity = windowsInstallerIntegritySchema.safeParse({
    url: `${serverUrl}/api/v1/agents/install.ps1`,
    sha256: createHash('sha256').update(body).digest('hex'),
  });
  return integrity.success ? { body, integrity: integrity.data } : null;
}
