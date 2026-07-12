import { describe, expect, it } from 'vitest';
import { advanceSessionGeneration } from '../../services/sessionGeneration';
import { readCurrentBiometricSession } from './biometricSession';

describe('biometric session generation fence', () => {
  it('does not return credentials when the boundary changes between token and user reads', async () => {
    let releaseToken!: (token: string | null) => void;
    const token = new Promise<string | null>((resolve) => { releaseToken = resolve; });
    const result = readCurrentBiometricSession(() => token, async () => ({
      id: 'old', email: 'old@example.com', name: 'Old', role: 'admin',
    }));

    advanceSessionGeneration();
    releaseToken('old-token');

    await expect(result).resolves.toBeNull();
  });
});
