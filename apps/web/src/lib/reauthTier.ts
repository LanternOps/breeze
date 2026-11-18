import { useCallback, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';
import { pickReauthTier, type ReauthTier } from '../components/settings/StepUpPrompt';

/**
 * The caller's strongest step-up factor, read live: `GET /users/me` for the
 * MFA method and whether an authenticator app is enrolled (#10650), and
 * `GET /auth/passkeys` for the passkey count. Throws when either read fails or
 * comes back malformed, so the caller can say the prompt could not open.
 */
export async function discoverReauthTier(): Promise<ReauthTier> {
  const [userResponse, passkeyResponse] = await Promise.all([fetchWithAuth('/users/me'), fetchWithAuth('/auth/passkeys')]);
  if (!userResponse.ok || !passkeyResponse.ok) throw new Error('factor discovery failed');
  const user = await userResponse.json() as { mfaMethod?: string | null; totpEnrolled?: boolean } | null;
  const passkeyData = await passkeyResponse.json() as unknown;
  const passkeys = Array.isArray(passkeyData) ? passkeyData : (passkeyData as { passkeys?: unknown[] } | null)?.passkeys;
  if (!user || typeof user !== 'object' || !Array.isArray(passkeys)) throw new Error('factor discovery failed');
  return pickReauthTier(passkeys.length, user.mfaMethod ?? null, user.totpEnrolled);
}

/**
 * The step-up tier for a dialog (#8318 2-3 review): the one its parent already
 * knows (`passkeyCount` and `mfaMethod` both given), or else the one
 * `ensureTier` reads on the first step-up. `ensureTier` resolves true once a
 * tier is known and false when the read failed; the caller shows its own error.
 * `resetTier` forgets a read tier, for a dialog that reopens.
 */
export function useReauthTier(passkeyCount: number | undefined, mfaMethod: string | null | undefined): {
  tier: ReauthTier | null;
  ensureTier: () => Promise<boolean>;
  resetTier: () => void;
} {
  const [discovered, setDiscovered] = useState<ReauthTier | null>(null);
  const tier = passkeyCount === undefined || mfaMethod === undefined
    ? discovered
    : pickReauthTier(passkeyCount, mfaMethod);
  const ensureTier = useCallback(async (): Promise<boolean> => {
    if (tier !== null) return true;
    try {
      setDiscovered(await discoverReauthTier());
      return true;
    } catch {
      return false;
    }
  }, [tier]);
  const resetTier = useCallback(() => setDiscovered(null), []);
  return { tier, ensureTier, resetTier };
}
