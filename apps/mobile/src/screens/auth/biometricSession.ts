import type { User } from '../../services/api';
import { captureSessionGeneration, isCurrentSessionGeneration } from '../../services/sessionGeneration';

export async function readCurrentBiometricSession(
  readToken: () => Promise<string | null>,
  readUser: () => Promise<User | null>,
): Promise<{ token: string; user: User } | null> {
  const generation = captureSessionGeneration();
  const token = await readToken();
  if (!isCurrentSessionGeneration(generation)) return null;
  const user = await readUser();
  if (!isCurrentSessionGeneration(generation) || !token || !user) return null;
  return { token, user };
}
