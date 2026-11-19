// Pure half of assert-postgres-major.ts (#11417): every CI leg that runs on a
// non-default Postgres major proves which major it actually reached, so a tag
// drift or a default overriding the image can never silently test 16.

const USAGE = 'usage: assert-postgres-major.ts <expected-major>   (connects to $DATABASE_URL)';

/** `server_version_num` is MMmmpp for 10+ (e.g. 180006 = 18.6). */
export function serverMajorFromVersionNum(raw: string): number {
  const s = raw.trim();
  if (!/^[1-9]\d{5}$/.test(s)) {
    throw new Error(`unrecognised server_version_num ${JSON.stringify(raw)} (expected six digits, Postgres 10+)`);
  }
  return Math.floor(Number(s) / 10_000);
}

export function parseExpectedMajor(argv: readonly string[]): number {
  if (argv.length !== 1 || !/^[1-9]\d$/.test(argv[0] ?? '')) throw new Error(USAGE);
  return Number(argv[0]);
}

export function checkPostgresMajor(input: { expected: number; versionNum: string; version: string }): {
  ok: boolean;
  message: string;
} {
  const actual = serverMajorFromVersionNum(input.versionNum);
  if (actual === input.expected) {
    return { ok: true, message: `Postgres server is ${input.version} (major ${actual}), as expected` };
  }
  return {
    ok: false,
    message: `expected major ${input.expected}, but the server is ${input.version} (major ${actual}) — the image tag or a compose default is not what this leg claims to test`,
  };
}

const LOG = '[assert-postgres-major]';

export type VersionRow = { server_version_num: string; server_version: string };

/**
 * The whole CLI minus the driver: 0 the major matches; 1 another major; 2 bad
 * usage, no DATABASE_URL, no connection or an unreadable version. Prints the
 * server version only — never the connection string.
 */
export async function runAssertPostgresMajor(input: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  readVersion: (url: string) => Promise<VersionRow | undefined>;
  out: { log: (m: string) => void; error: (m: string) => void };
}): Promise<0 | 1 | 2> {
  const { out } = input;
  let expected: number;
  try {
    expected = parseExpectedMajor(input.argv);
  } catch (err) {
    out.error(`${LOG} ${(err as Error).message}`);
    return 2;
  }
  const url = input.env.DATABASE_URL;
  if (!url) {
    out.error(`${LOG} DATABASE_URL is not set`);
    return 2;
  }
  let row: VersionRow | undefined;
  try {
    row = await input.readVersion(url);
  } catch (err) {
    // A driver or socket error can embed the connection details, so print its
    // class and code only.
    const e = err as { name?: string; code?: string };
    out.error(`${LOG} could not read the server version: ${e.name ?? 'Error'}${e.code ? ` (${e.code})` : ''}`);
    return 2;
  }
  if (!row) {
    out.error(`${LOG} could not read the server version: the query returned no row`);
    return 2;
  }
  let result: { ok: boolean; message: string };
  try {
    result = checkPostgresMajor({ expected, versionNum: row.server_version_num, version: row.server_version });
  } catch (err) {
    out.error(`${LOG} ${(err as Error).message}`);
    return 2;
  }
  if (result.ok) {
    out.log(`${LOG} ${result.message}`);
    return 0;
  }
  out.error(`${LOG} ${result.message}`);
  return 1;
}
