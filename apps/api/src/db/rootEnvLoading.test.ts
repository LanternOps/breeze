/**
 * #9344: API unit runs never read the developer's root `.env`.
 *
 * db/index.ts loads `../../.env` (and the cwd `.env`) at import so a server,
 * worker or script started from apps/api picks up the monorepo settings. Under
 * vitest that leaked a developer's local values into the unit suite: a local
 * `IS_HOSTED=false` or `DATABASE_URL` changed what tests did, and the two
 * contract-renewal tests ran against the dev database. CI has no root
 * `.env`, so local and CI results differed.
 *
 * The integration and RLS-coverage configs load `.env.test` themselves, so
 * they do not need db/index.ts to read anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock } = vi.hoisted(() => ({ configMock: vi.fn() }));
vi.mock('dotenv', () => ({ config: configMock, default: { config: configMock } }));

// A cold import of db/index.ts pulls in a large module graph.
describe('db/index.ts .env loading (#9344)', { timeout: 60_000 }, () => {
  const vitestFlag = process.env.VITEST;

  beforeEach(() => {
    vi.resetModules();
    configMock.mockClear();
  });

  afterEach(() => {
    if (vitestFlag === undefined) delete process.env.VITEST;
    else process.env.VITEST = vitestFlag;
  });

  it('reads no .env file under vitest', async () => {
    expect(process.env.VITEST).toBeTruthy();
    await import('./index');
    expect(configMock).not.toHaveBeenCalled();
  });

  it('still loads the root .env and the cwd .env outside vitest, as servers and scripts need', async () => {
    delete process.env.VITEST;
    await import('./index');
    expect(configMock).toHaveBeenCalledWith({ path: '../../.env', quiet: true });
    expect(configMock).toHaveBeenCalledWith({ quiet: true });
  });
});
