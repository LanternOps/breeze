import {
  revokeAllUserSessionFamilies,
  withAuthLifecycleSystemTransaction,
} from './authLifecycle';
import { revokeAllUserTokens, revokeRefreshTokenJti } from './tokenRevocation';

const TERMINAL_LOGOUT_REASON = 'cf-access-terminal-logout';

/**
 * Revoke every durable browser-session family for each independently verified
 * subject before updating the Redis accelerators. Access middleware checks the
 * family row on every request, so this closes the same-second `iat` gap in the
 * user-wide Redis cutoff as well as sibling-family refresh reuse.
 */
export async function revokeTerminalLogoutSubjects(input: {
  subjectIds: readonly string[];
  refreshJti?: string;
}): Promise<void> {
  const subjectIds = [...new Set(input.subjectIds.filter(Boolean))].sort();
  if (subjectIds.length === 0) throw new Error('Terminal logout requires a verified subject');

  await withAuthLifecycleSystemTransaction(async (tx) => {
    for (const userId of subjectIds) {
      await revokeAllUserSessionFamilies(tx, userId, TERMINAL_LOGOUT_REASON);
    }
  });

  for (const userId of subjectIds) {
    await revokeAllUserTokens(userId);
  }
  if (input.refreshJti) await revokeRefreshTokenJti(input.refreshJti);
}
