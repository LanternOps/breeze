export interface PostCommitOperation {
  name: string;
  run: () => Promise<unknown>;
}

export interface PostCommitFailure {
  name: string;
  error: unknown;
}

export async function runPostCommitCleanup(
  operations: readonly PostCommitOperation[],
): Promise<{ failures: PostCommitFailure[] }> {
  const settled = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation.run)),
  );
  const failures: PostCommitFailure[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push({ name: operations[index]!.name, error: result.reason });
    }
  });
  return { failures };
}
