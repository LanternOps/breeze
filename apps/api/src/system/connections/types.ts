/**
 * Types for the System → Connections report (spec:
 * docs/superpowers/specs/platform-ci/2026-09-23-system-connections-page-design.md).
 *
 * Group ids are kebab-case and shared with the W02 web page, which localizes
 * them by id.
 */

export const CONNECTION_GROUPS = [
  'core',
  'email',
  'storage-backups',
  'ai',
  'billing',
  'microsoft-365',
  'identity-sso',
  'remote-access',
  'agent-releases',
  'observability',
  'security-abuse',
  'integrations',
] as const;

export type ConnectionGroup = (typeof CONNECTION_GROUPS)[number];

export const CONNECTION_STATUSES = ['enabled', 'disabled', 'misconfigured', 'required_missing'] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** A read-only env snapshot. `process.env` satisfies it. */
export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

export type ConnectionVar = {
  /** Env var name. */
  name: string;
  /** Default true (D8). `false` means the value may be displayed. */
  secret?: boolean;
  /** Part of the "fully configured" set used by the default status helper. */
  required?: boolean;
};

export type StatusResult = {
  status: ConnectionStatus;
  /** Names env vars, never values (invariant 4). */
  reason?: string;
};

export type ConnectionEntry = {
  /** Stable kebab-case id; the web page localizes by id. */
  id: string;
  group: ConnectionGroup;
  /** English source label. */
  label: string;
  /** Path on the docs site, e.g. `/deploy/turn-server/`. A test asserts the page exists. */
  docsUrl?: string;
  /** Core services: unset => required_missing, never "disabled". */
  core?: boolean;
  vars: readonly ConnectionVar[];
  status(env: EnvSnapshot): StatusResult;
};

export type ConnectionsReportVar = {
  name: string;
  secret: boolean;
  set: boolean;
  /** Present only when `secret === false` and the value passed the value-shape guard. */
  value?: string;
};

export type ConnectionsReportEntry = {
  id: string;
  label: string;
  docsUrl?: string;
  status: ConnectionStatus;
  reason?: string;
  vars: ConnectionsReportVar[];
};

export type ConnectionsReport = {
  version: string;
  deployMode: 'hosted' | 'self_host';
  scope: 'api';
  summary: Record<ConnectionStatus, number>;
  groups: Array<{ group: ConnectionGroup; entries: ConnectionsReportEntry[] }>;
};
