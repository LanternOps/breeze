/**
 * In-memory stand-in for `@react-native-async-storage/async-storage`, aliased
 * in for Vitest only (see apps/mobile/vitest.config.ts).
 *
 * The published ESM build imports `./createAsyncStorage` without an extension,
 * which Node cannot resolve, so ANY suite that transitively reaches the package
 * dies at import time — including suites that never touch storage themselves.
 * `services/auth.ts` clears the unsent time-entry queue on sign-out, which puts
 * the package on the import graph of every auth-adjacent test.
 *
 * A suite that cares about storage behaviour still declares its own
 * `vi.mock('@react-native-async-storage/async-storage', …)`, which takes
 * precedence over this alias.
 */

const store = new Map<string, string>();

const asyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return store.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    store.delete(key);
  },
  async clear(): Promise<void> {
    store.clear();
  },
  async getAllKeys(): Promise<string[]> {
    return [...store.keys()];
  },
  async multiRemove(keys: readonly string[]): Promise<void> {
    for (const key of keys) store.delete(key);
  },
};

export default asyncStorage;
