import { createHash, createPublicKey, verify } from 'node:crypto';
import { ensureActiveSigningKey, signBytesWithActiveKey } from './manifestSigning';

export type RollbackComponent = 'agent' | 'helper' | 'user-helper' | 'watchdog' | 'backup';

export interface RollbackArtifactV1 {
  component: RollbackComponent;
  currentVersion: string;
  targetVersion: string;
  downloadUrl: string;
  sha256: string;
  size: number;
}

export interface AgentRollbackDirectiveV1 {
  schemaVersion: 1;
  rollbackId: string;
  deviceId: string;
  orgId: string;
  platform: 'windows' | 'macos' | 'linux';
  architecture: 'amd64' | 'arm64';
  currentVersion: string;
  targetVersion: string;
  componentVersions: Record<string, { current: string; target: string }>;
  releaseManifest: string;
  manifestSignature: string;
  manifestSigningKeyId: string;
  artifacts: RollbackArtifactV1[];
  reason: string;
  authorizedBy: string;
  approvedAt: string;
  expiresAt: string;
  directiveSigningKeyId: string;
  directiveSignature: string;
}

export type UnsignedAgentRollbackDirectiveV1 = Omit<AgentRollbackDirectiveV1, 'directiveSignature'>;

const DOMAIN = 'breeze-agent-rollback-directive-v1';
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('rollback directive contains an unsupported value');
  return encoded;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireSecondPrecisionTimestamp(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be a second-precision UTC timestamp`);
  }
}

function rejectLineSeparators(value: unknown): void {
  if (typeof value === 'string') {
    if (/[\r\n]/.test(value)) throw new Error('rollback directive field contains a newline');
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) rejectLineSeparators(child);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) rejectLineSeparators(child);
  }
}

export function canonicalRollbackDirectiveBytes(
  directive: UnsignedAgentRollbackDirectiveV1,
): Buffer {
  if (directive.schemaVersion !== 1) throw new Error('unsupported rollback directive schema');
  requireSecondPrecisionTimestamp(directive.approvedAt, 'approvedAt');
  requireSecondPrecisionTimestamp(directive.expiresAt, 'expiresAt');
  rejectLineSeparators(directive);
  const lines = [
    DOMAIN,
    directive.rollbackId,
    directive.deviceId,
    directive.orgId,
    directive.platform,
    directive.architecture,
    directive.currentVersion,
    directive.targetVersion,
    sha256(canonicalJson(directive.componentVersions)),
    sha256(directive.releaseManifest),
    directive.manifestSignature,
    directive.manifestSigningKeyId,
    sha256(canonicalJson(directive.artifacts)),
    sha256(directive.reason),
    directive.authorizedBy,
    directive.approvedAt,
    directive.expiresAt,
    directive.directiveSigningKeyId,
  ];
  for (const line of lines) {
    if (/[\r\n]/.test(line)) throw new Error('rollback directive field contains a newline');
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function verifyRollbackDirectiveSignature(
  directive: AgentRollbackDirectiveV1,
  publicKeyB64: string,
): boolean {
  try {
    const rawKey = Buffer.from(publicKeyB64, 'base64');
    const signature = Buffer.from(directive.directiveSignature, 'base64');
    if (rawKey.length !== 32 || signature.length !== 64) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, rawKey]),
      format: 'der',
      type: 'spki',
    });
    const { directiveSignature: _signature, ...unsigned } = directive;
    return verify(null, canonicalRollbackDirectiveBytes(unsigned), publicKey, signature);
  } catch {
    return false;
  }
}

export async function signAgentRollbackDirective(
  directive: Omit<UnsignedAgentRollbackDirectiveV1, 'directiveSigningKeyId'>,
): Promise<AgentRollbackDirectiveV1> {
  // The key id is covered by the signature, so discover it first and sign the
  // final record. A rotation between these two calls fails closed: the signing
  // result's key id would differ and we refuse to emit a mismatched record.
  const active = await ensureActiveSigningKey();
  const unsigned: UnsignedAgentRollbackDirectiveV1 = {
    ...directive,
    directiveSigningKeyId: active.keyId,
  };
  const signed = await signBytesWithActiveKey(canonicalRollbackDirectiveBytes(unsigned));
  if (signed.keyId !== active.keyId) {
    throw new Error('active manifest signing key rotated while signing rollback directive');
  }
  return { ...unsigned, directiveSignature: signed.signature };
}
