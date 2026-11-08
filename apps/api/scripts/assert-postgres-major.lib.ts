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
