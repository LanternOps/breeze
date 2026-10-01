/**
 * Mock state + vi.mock module factories that route the LEGACY functions' DB
 * and catalog reads to one parity fixture (#7600 W02; W03 Tasks 1/7 reuse).
 * Dependency-free on purpose: vi.mock factories import it.
 * Every read the oracle triggers is a single-row lookup for the fixture's one
 * partner, keyed by the Drizzle table object passed to .from().
 */
export const legacyFixtureState: { rows: Map<unknown, unknown[]>; catalogProvider: unknown } = {
  rows: new Map(),
  catalogProvider: null,
};

export function legacyDbMockModule() {
  const select = () => ({
    from: (table: unknown) => {
      const rows = legacyFixtureState.rows.get(table) ?? [];
      const chain: Record<string, unknown> = {};
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(rows);
      chain.then = (resolve: (r: unknown[]) => unknown) => resolve(rows);
      return chain;
    },
  });
  return {
    db: { select, update: () => { throw new Error('parity oracle must not write'); } },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
}

export function legacyCatalogMockModule() {
  return { getListedProviderByEntryId: async () => legacyFixtureState.catalogProvider };
}
