let generation = 0;
let commitQueue: Promise<unknown> = Promise.resolve();

export function currentSessionGeneration(): number {
  return generation;
}

export function advanceSessionGeneration(): number {
  generation += 1;
  return generation;
}

/**
 * Serialize session-owned persistence and discard work captured before logout.
 * The second generation check prevents callers from treating an in-flight
 * write as committed after logout invalidated the session.
 */
export async function commitIfCurrent<T>(
  capturedGeneration: number,
  write: () => Promise<T>,
): Promise<T | undefined> {
  const commit = commitQueue.then(async () => {
    if (capturedGeneration !== generation) return undefined;
    const value = await write();
    return capturedGeneration === generation ? value : undefined;
  });
  commitQueue = commit.catch(() => undefined);
  return commit;
}
