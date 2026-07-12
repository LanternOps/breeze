export interface PostCommitOperation {
  name: string;
  run: () => Promise<unknown>;
}

export interface PostCommitFailure {
  name: string;
  error: unknown;
}

export type CleanupStatus = 'complete' | 'partial';

export interface PostCommitCleanupResult {
  cleanupStatus: CleanupStatus;
  cleanupFailures: string[];
  failures: PostCommitFailure[];
}

export async function runPostCommitCleanup(
  operations: readonly PostCommitOperation[],
): Promise<PostCommitCleanupResult> {
  const settled = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation.run)),
  );
  const failures: PostCommitFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push({ name: operations[index]!.name, error: result.reason });
    }
  });
  return {
    cleanupStatus: failures.length === 0 ? 'complete' : 'partial',
    cleanupFailures: failures.map((failure) => failure.name),
    failures,
  };
}
