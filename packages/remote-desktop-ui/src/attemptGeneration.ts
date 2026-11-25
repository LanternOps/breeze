/**
 * Ownership of an async connect attempt (#8947).
 *
 * A connect attempt resolves seconds after it starts (ICE gathering, offer,
 * answer poll). By then its owner may have moved on: the connect effect re-ran,
 * the user disconnected, or a newer attempt started. The result of such an
 * attempt must not be installed, and it must not tear down whatever the newer
 * owner installed.
 *
 * `begin()` starts an attempt and makes every older one stale. `invalidate()`
 * makes the in-flight attempt stale without starting one (the owner was
 * cancelled). `adopt()` returns the result when the attempt is still current;
 * otherwise it closes the result and returns null.
 */
export interface Attempt {
  isStale(): boolean;
  adopt<T extends { close(): void }>(result: T | null): T | null;
}

export interface AttemptGeneration {
  begin(): Attempt;
  invalidate(): void;
}

export function createAttemptGeneration(): AttemptGeneration {
  let current = 0;
  return {
    begin() {
      const mine = ++current;
      const isStale = () => current !== mine;
      return {
        isStale,
        adopt(result) {
          if (!result) return null;
          if (!isStale()) return result;
          result.close();
          return null;
        },
      };
    },
    invalidate() {
      current += 1;
    },
  };
}
