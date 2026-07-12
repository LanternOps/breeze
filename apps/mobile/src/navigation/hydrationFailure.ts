import {
  isCurrentSessionGeneration,
  runAuthStorageExclusive,
} from '../services/sessionGeneration';

/**
 * Apply a failed startup hydration only while it still belongs to the active
 * session. Recheck inside the storage lock and again before Redux logout so a
 * newer login cannot be wiped while an older startup attempt is unwinding.
 */
export async function handleHydrationFailure(
  generation: number,
  clear: () => Promise<void>,
  dispatchLogout: () => void,
): Promise<boolean> {
  if (!isCurrentSessionGeneration(generation)) return false;

  let cleared = false;
  await runAuthStorageExclusive(async () => {
    if (!isCurrentSessionGeneration(generation)) return;
    await clear();
    cleared = true;
  });

  if (!cleared || !isCurrentSessionGeneration(generation)) return false;
  dispatchLogout();
  return true;
}
