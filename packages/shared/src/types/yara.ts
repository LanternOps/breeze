/**
 * YARA rule-set contract shared by the API and web (#6263 W03).
 *
 * The bundle format is owned by the agent (W02 plan §C1–C5,
 * `agent/internal/yarascan/testdata/bundle-v1.golden.json`). Changing any of
 * these values needs a `v` bump handled on both sides.
 */

/** W02 §C2 `format`. */
export const YARA_BUNDLE_FORMAT = 'breeze-yara-bundle' as const;
/** W02 §C2 `v`. */
export const YARA_BUNDLE_FORMAT_VERSION = 1 as const;
/** W02 §C2 response content type. */
export const YARA_BUNDLE_CONTENT_TYPE = 'application/vnd.breeze.yara-bundle+json' as const;

/** Spec §5.3 / W02 §C1: at most this many rule sets per policy / payload. */
export const YARA_MAX_RULE_SETS_PER_POLICY = 20;
/** Spec §5.3 / W02 §C5 caps (yarac enforces the compile-time ones too). */
export const YARA_MAX_RULES_PER_SET = 500;
export const YARA_MAX_RULE_SOURCE_BYTES = 64 * 1024;

/** The single built-in pack's fixed id (W03b upserts it at boot). */
export const YARA_BUILTIN_RULE_SET_ID = '00000000-0000-4000-8000-00000000b001';

export const YARA_RULE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type YaraRuleSeverity = (typeof YARA_RULE_SEVERITIES)[number];

/** Rule identifier rule, mirrored by the DB CHECK `yara_rules_name_chk`. */
export const YARA_RULE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface YaraBundleRuleInput {
  id: string;
  name: string;
  severity: YaraRuleSeverity;
  source: string;
}

export interface YaraBundleInput {
  ruleSetId: string;
  version: number;
  autoQuarantine: boolean;
  rules: readonly YaraBundleRuleInput[];
}

/** W02 §C1 — one entry of the `security_scan` payload's `ruleSets`. */
export interface YaraRuleSetRef {
  id: string;
  version: number;
  /** sha256 (64 lowercase hex) of the exact bundle response body bytes. */
  sha256: string;
  /** Server-relative `/api/v1/agents/<agentId>/yara/rule-sets/<id>/<version>`. */
  url: string;
}

/**
 * Per-set failure codes recorded on `security_scans.rule_set_errors`.
 * Dispatch-time (server) codes plus the agent's W02 §C3 codes.
 */
export const YARA_DISPATCH_ERROR_CODES = ['not_found', 'disabled', 'not_published', 'agent_too_old'] as const;
export type YaraDispatchErrorCode = (typeof YARA_DISPATCH_ERROR_CODES)[number];

export interface YaraRuleSetError {
  /** Rule set id, or `*` for an error that applies to the whole scan. */
  id: string;
  version?: number;
  code: string;
  detail?: string;
}

export type SecurityScanEngine = 'yara' | 'legacy';

// ---------------------------------------------------------------------------
// W04 (#6267): IOC import and rule test upload
// ---------------------------------------------------------------------------

/** IOC kinds the importer understands (W04-1). Anything unclassified is `string`. */
export const YARA_IOC_KINDS = ['md5', 'sha1', 'sha256', 'filename', 'filepath', 'domain', 'ip', 'string'] as const;
export type YaraIocKind = (typeof YARA_IOC_KINDS)[number];

export interface YaraIoc {
  kind: YaraIocKind;
  value: string;
}

export type YaraIocErrorCode =
  | 'empty'
  | 'unknown_kind'
  | 'bad_hash'
  | 'too_short'
  | 'too_long'
  | 'bad_path'
  | 'bad_ip'
  | 'bad_domain'
  | 'duplicate';

/** At most this many IOCs per import batch. */
export const YARA_IOC_MAX_PER_BATCH = 1000;
/** Pasted IOC text is capped at this many UTF-8 bytes (`parseIocText`). */
export const YARA_IOC_MAX_TEXT_BYTES = 256 * 1024;
/** A false-positive floor for string-like IOCs, not YARA's slow-pattern threshold. */
export const YARA_IOC_STRING_MIN_BYTES = 4;
export const YARA_IOC_STRING_MAX_BYTES = 256;
/** filename IOCs: one path component. */
export const YARA_IOC_FILENAME_MAX_BYTES = 255;
/** filepath IOCs. */
export const YARA_IOC_PATH_MAX_BYTES = 512;
/** Longest accepted IOC value in the import request body, in characters. */
export const YARA_IOC_VALUE_MAX_CHARS = 512;
export const YARA_IOC_LABEL_MAX = 64;
/** Each generated rule's source stays under this (W03's per-rule cap is 64 KiB). */
export const YARA_IOC_RULE_SOURCE_BUDGET = 60 * 1024;

/**
 * `name.ext` values whose extension is here classify as `filename`; other
 * dotted names classify as `domain`. `com` is deliberately absent.
 */
export const YARA_IOC_FILE_EXTENSIONS = [
  'exe', 'dll', 'sys', 'scr', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'hta', 'lnk',
  'msi', 'jar', 'bin', 'sh', 'py', 'elf', 'so', 'dylib', 'docm', 'xlsm', 'pptm', 'iso', 'img', 'zip', 'rar', '7z',
] as const;

export interface YaraGeneratedRule {
  name: string;
  source: string;
  severity: YaraRuleSeverity;
  tags: string[];
  kind: YaraIocKind;
  iocCount: number;
}

/** Largest sample `POST /security/yara/rule-sets/:id/test` accepts. */
export const YARA_TEST_SAMPLE_MAX_BYTES = 10 * 1024 * 1024;

export interface YaraTestMatchedString {
  id: string;
  offset: number;
  data: string;
}

export interface YaraTestMatch {
  ruleId: string;
  ruleName: string;
  severity: string;
  tags: string[];
  matchedStrings: YaraTestMatchedString[];
}

/** `data` of a 200 from the rule test route. */
export interface YaraTestResult {
  sha256: string;
  size: number;
  filename: string;
  filepath: string;
  durationMs: number;
  /** The draft that was tested: the set's `current_version` (min 1). */
  testedVersion: number;
  /** What devices run now (0 = never published). */
  publishedVersion: number;
  /** sha256 of the exact bundle bytes that were tested. */
  testedDigest: string;
  matches: YaraTestMatch[];
}
