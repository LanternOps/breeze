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
