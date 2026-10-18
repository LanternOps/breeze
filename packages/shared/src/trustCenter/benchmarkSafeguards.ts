// (device OS, agent CIS check id) → CIS Controls v8 safeguard identifiers (Trust Center W3e; spec §5.5).
//
// Licensing (spec §18.13): identifiers only. No Benchmark recommendation title, check title or setting value
// appears here or in the public payload; labels for the safeguards live in FRAMEWORK_CROSSWALK (Breeze's own
// words). Rendering sits behind BREEZE_TRUST_CIS_FRAMEWORK_VIEW (default off) until the written CIS confirmation.
//
// Keyed by the AGENT's check ids (agent/internal/cis/checks_*.go), not the API catalog's: findings carry the
// agent's id, and the two differ (Windows firewall is `9.1.1` in the agent, `9.1` in the catalog).
// `cisBenchmarkSafeguards.contract.test.ts` reads the Go sources and fails on any id missing from, or extra in,
// this table. An empty array is an explicit "not mapped" — the check still counts toward the pass rate, it just
// evidences no named safeguard.
//
// macOS caveat: the agent's macOS ids (e.g. 5.1.1 firewall, 5.2.1 SSH root login, 2.1.1.1 AirDrop) may follow an
// older Benchmark numbering than macOS 14's. Whoever verifies matches each check by what it tests, not by its id.
//
// VERIFICATION STATUS: every OS below is status 'candidate' (verifiedAt null). The mappings were derived from the
// check intent and the W3 plan's candidate table; the Benchmark PDFs sit behind CIS's registration wall and were
// NOT opened when this was written. A human confirms each entry against the PDF named in
// CIS_BENCHMARK_MAPPING_SOURCES, then sets `verifiedAt` and `status: 'verified'`. Checks whose mapping was not
// even a credible candidate ship as [].

export type BenchmarkOs = 'windows' | 'macos' | 'linux';

export interface BenchmarkMappingSource {
  /** The Benchmark the agent's checks follow (matches the API catalog's `benchmarkVersion` family). */
  benchmark: string;
  version: string;
  /** ISO date a human confirmed the mapping against the Benchmark PDF; null while unconfirmed. */
  verifiedAt: string | null;
  verifiedBy: string | null;
  status: 'verified' | 'candidate';
  /** Per mapped check: where the entry came from. Identifiers/paraphrase only, never Benchmark text. */
  checkNotes: Readonly<Record<string, string>>;
}

const CANDIDATE = 'candidate: W3 plan §W03e candidate table, derived from check intent; not yet confirmed against the Benchmark PDF';
const REASONED = 'candidate: derived from check intent (not in the W3 plan table); not yet confirmed against the Benchmark PDF';

const note = (ids: readonly string[], text: string): Record<string, string> =>
  Object.fromEntries(ids.map((id) => [id, text]));

const WINDOWS: Readonly<Record<string, readonly string[]>> = {
  // Password policy.
  '1.1.1': ['5.2'], '1.1.2': ['5.2'], '1.1.3': ['5.2'], '1.1.4': ['5.2'],
  // Guest account.
  '2.3.1': ['4.7'],
  // Host firewall, all profiles. 4.5 only: 4.4 is the server-firewall safeguard and this is the end-user benchmark.
  '9.1.1': ['4.5'],
  // Audit credential validation. The plan also listed 8.2; narrowed to the detailed-logging safeguard (review).
  '17.1.1': ['8.5'],
  // Plan lists these as "verify; likely 4.1 / 5.4": no credible candidate without the PDF.
  '2.3.7': [], '18.4.1': [], '18.9.4': [],
};

const LINUX: Readonly<Record<string, readonly string[]>> = {
  // Unused filesystem module, IP forwarding.
  '1.1.1.1': ['4.8'], '3.3.1': ['4.8'],
  // ASLR.
  '1.5.3': ['10.5'],
  // Firewall utility.
  '3.4.1': ['4.4', '4.5'],
  // sshd_config permissions.
  '5.2.1': ['3.3'],
  // SSH root login.
  '5.2.5': ['5.4'],
  // Plan lists these as "verify".
  '1.4.1': [], '1.5.4': [], '5.2.13': [], '5.4.1': [],
};

const MACOS_SERVICES_OFF = ['2.1.1.1', '2.3.3.1', '2.3.3.2', '2.3.3.3', '2.3.3.4', '2.3.3.5', '2.3.3.6', '2.3.3.7', '2.3.3.8', '2.3.3.9', '2.4.1'];
const MACOS: Readonly<Record<string, readonly string[]>> = {
  // FileVault.
  '2.2.1': ['3.6'],
  // Application firewall, stealth mode.
  '5.1.1': ['4.5'], '5.1.3': ['4.5'],
  // Password on wake.
  '6.1.3': ['4.3'],
  // Automatic update check / download / critical updates (operating-system patching only).
  '1.2': ['7.3'], '1.3': ['7.3'], '1.5': ['7.3'],
  // Sharing and remote services off.
  ...Object.fromEntries(MACOS_SERVICES_OFF.map((id) => [id, ['4.8']])),
  // SSH root login.
  '5.2.1': ['5.4'],
  // System Integrity Protection — an anti-exploitation feature (added in review; not in the plan table).
  '5.1.2': ['10.5'],
  // Plan lists these as "verify"; Gatekeeper, auto-login and Safari have no confident candidate.
  '2.5.1': [], '6.1.2': [], '6.3.1': [],
};

export const CIS_BENCHMARK_CHECK_SAFEGUARDS: Readonly<Record<BenchmarkOs, Readonly<Record<string, readonly string[]>>>> = {
  windows: WINDOWS,
  linux: LINUX,
  macos: MACOS,
};

const mappedIds = (table: Readonly<Record<string, readonly string[]>>, planIds: readonly string[]) =>
  Object.entries(table).filter(([, refs]) => refs.length > 0).map(([id]) => id).filter((id) => planIds.includes(id));

const WINDOWS_PLAN = ['1.1.1', '1.1.2', '1.1.3', '1.1.4', '2.3.1', '9.1.1', '17.1.1'];
const LINUX_PLAN = ['1.1.1.1', '3.3.1', '1.5.3', '3.4.1', '5.2.1', '5.2.5'];
const MACOS_PLAN = ['2.2.1', '5.1.1', '5.1.3', '6.1.3', '1.2', '1.3', '1.5', ...MACOS_SERVICES_OFF, '5.2.1'];
const MACOS_REASONED = ['1.2', '1.3', '1.5', '5.1.2'];

export const CIS_BENCHMARK_MAPPING_SOURCES: Readonly<Record<BenchmarkOs, BenchmarkMappingSource>> = {
  windows: {
    benchmark: 'CIS Microsoft Windows 11 Enterprise Benchmark', version: 'v2.0.0',
    verifiedAt: null, verifiedBy: null, status: 'candidate',
    checkNotes: note(mappedIds(WINDOWS, WINDOWS_PLAN), CANDIDATE),
  },
  linux: {
    benchmark: 'CIS Ubuntu Linux 22.04 LTS Benchmark', version: 'v2.0.0',
    verifiedAt: null, verifiedBy: null, status: 'candidate',
    checkNotes: note(mappedIds(LINUX, LINUX_PLAN), CANDIDATE),
  },
  macos: {
    benchmark: 'CIS Apple macOS 14.0 Benchmark', version: 'v1.0.0',
    verifiedAt: null, verifiedBy: null, status: 'candidate',
    checkNotes: {
      ...note(mappedIds(MACOS, MACOS_PLAN), CANDIDATE),
      // The plan's candidate table also lists 7.4 for the update checks; only OS patching (7.3) is claimed here.
      // 5.1.2 (SIP → 10.5) came out of the mapping review, not the plan.
      ...note(MACOS_REASONED, REASONED),
    },
  },
};

/** Safeguard refs the agent's check `checkId` evidences on `os`; [] for an unmapped or unknown check. */
export function safeguardsForCheck(os: string, checkId: string): readonly string[] {
  const table = (CIS_BENCHMARK_CHECK_SAFEGUARDS as Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>)[os];
  return table?.[checkId] ?? [];
}
