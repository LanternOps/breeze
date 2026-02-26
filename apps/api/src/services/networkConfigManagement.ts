import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  discoveredAssetTypeEnum,
  discoveredAssets,
  networkConfigDiffs,
  networkConfigRiskLevelEnum,
  networkConfigTypeEnum,
  networkDeviceConfigs,
  networkDeviceFirmware
} from '../db/schema';
import { decryptSecret, encryptSecret } from './secretCrypto';
import { publishEvent } from './eventBus';

export type NetworkConfigType = typeof networkConfigTypeEnum.enumValues[number];
export type NetworkConfigRiskLevel = typeof networkConfigRiskLevelEnum.enumValues[number];

const NETWORK_MANAGED_ASSET_TYPES = new Set<typeof discoveredAssetTypeEnum.enumValues[number]>([
  'router',
  'switch',
  'firewall',
  'access_point'
]);

const MAX_CONFIG_SNAPSHOT_BYTES = 1_000_000;
const MAX_DIFF_DP_LINES = 4_000;
const DEFAULT_UNCHANGED_SNAPSHOT_MIN_INTERVAL_MINUTES = 0;

type DiffOp = {
  kind: 'context' | 'add' | 'remove';
  line: string;
};

type DiffAssessment = {
  riskLevel: NetworkConfigRiskLevel;
  summary: string;
  matchedSignals: string[];
};

type RiskSignal = {
  label: string;
  regex: RegExp;
  score: number;
  appliesTo?: 'add' | 'remove' | 'both';
};

const RISK_SIGNALS: RiskSignal[] = [
  { label: 'Telnet enabled on management plane', regex: /\btransport\s+input\s+telnet\b/i, score: 4, appliesTo: 'add' },
  { label: 'SNMP read-write community exposed', regex: /\bsnmp-server\s+community\s+\S+\s+rw\b/i, score: 4, appliesTo: 'add' },
  { label: 'Plaintext local password configured', regex: /\busername\s+\S+\s+password\s+\S+/i, score: 4, appliesTo: 'add' },
  { label: 'Insecure enable password configured', regex: /\benable\s+password\s+\S+/i, score: 3, appliesTo: 'add' },
  { label: 'Open ACL permit any-any', regex: /\bpermit\s+ip\s+any\s+any\b/i, score: 4, appliesTo: 'add' },
  { label: 'Unencrypted management HTTP enabled', regex: /\bip\s+http\s+server\b/i, score: 2, appliesTo: 'add' },
  { label: 'Password encryption disabled', regex: /\bno\s+service\s+password-encryption\b/i, score: 4, appliesTo: 'add' },
  { label: 'SSH-only management removed', regex: /\btransport\s+input\s+ssh\b/i, score: 3, appliesTo: 'remove' },
  { label: 'Login-local requirement removed', regex: /\blogin\s+local\b/i, score: 3, appliesTo: 'remove' }
];

export interface BackupNetworkConfigInput {
  orgId: string;
  assetId: string;
  configType: NetworkConfigType;
  configText: string;
  capturedAt?: Date;
  metadata?: Record<string, unknown> | null;
  unchangedSnapshotMinIntervalMinutes?: number;
}

export interface BackupNetworkConfigResult {
  config: typeof networkDeviceConfigs.$inferSelect;
  diff: typeof networkConfigDiffs.$inferSelect | null;
  skipped: boolean;
  changed: boolean;
}

export interface NetworkConfigCollector {
  id: string;
  supports: (asset: typeof discoveredAssets.$inferSelect) => boolean;
  collect: (
    asset: typeof discoveredAssets.$inferSelect,
    configType: NetworkConfigType
  ) => Promise<{ configText: string; metadata?: Record<string, unknown> } | null>;
}

const collectors: NetworkConfigCollector[] = [];

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function syntheticFallbackEnabled(): boolean {
  return envFlag('ENABLE_SYNTHETIC_NETWORK_CONFIG_COLLECTOR', (process.env.NODE_ENV ?? 'development') === 'test');
}

const fallbackCollector: NetworkConfigCollector = {
  id: 'fallback-network-snapshot',
  supports: () => true,
  collect: async (asset, configType) => {
    const lines = [
      `! source=fallback-snapshot`,
      `! config_type=${configType}`,
      `hostname ${asset.hostname ?? 'unknown-host'}`,
      `interface mgmt0`,
      ` ip address ${asset.ipAddress}`,
      ` no shutdown`,
      `! asset_type=${asset.assetType ?? 'unknown'}`
    ];
    if (asset.manufacturer) lines.push(`! manufacturer=${asset.manufacturer}`);
    if (asset.model) lines.push(`! model=${asset.model}`);
    return {
      configText: lines.join('\n'),
      metadata: {
        collector: 'fallback-network-snapshot',
        generated: true
      }
    };
  }
};

if (syntheticFallbackEnabled()) {
  collectors.push(fallbackCollector);
}

export function registerNetworkConfigCollector(collector: NetworkConfigCollector): void {
  const existingIndex = collectors.findIndex((entry) => entry.id === collector.id);
  if (existingIndex >= 0) {
    collectors.splice(existingIndex, 1, collector);
    return;
  }
  collectors.unshift(collector);
}

export async function collectNetworkDeviceConfig(
  asset: typeof discoveredAssets.$inferSelect,
  configType: NetworkConfigType
): Promise<{ configText: string; metadata?: Record<string, unknown>; collector: string } | null> {
  for (const collector of collectors) {
    if (!collector.supports(asset)) continue;
    const collected = await collector.collect(asset, configType);
    if (collected?.configText) {
      return {
        configText: normalizeConfig(collected.configText),
        metadata: collected.metadata,
        collector: collector.id
      };
    }
  }
  return null;
}

export function normalizeConfig(configText: string): string {
  return configText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export function hashConfig(configText: string): string {
  return createHash('sha256').update(configText).digest('hex');
}

function diffLines(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (before[i] === after[j]) {
        dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'context', line: before[i]! });
      i++;
      j++;
      continue;
    }

    if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'remove', line: before[i]! });
      i++;
      continue;
    }

    ops.push({ kind: 'add', line: after[j]! });
    j++;
  }

  while (i < n) {
    ops.push({ kind: 'remove', line: before[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'add', line: after[j]! });
    j++;
  }

  return ops;
}

function summarizeLineDelta(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();

  for (const line of before) {
    beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
  }
  for (const line of after) {
    afterCounts.set(line, (afterCounts.get(line) ?? 0) + 1);
  }

  const added: string[] = [];
  const removed: string[] = [];
  const keys = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);

  for (const key of keys) {
    const beforeCount = beforeCounts.get(key) ?? 0;
    const afterCount = afterCounts.get(key) ?? 0;
    if (afterCount > beforeCount) {
      for (let i = 0; i < afterCount - beforeCount; i++) added.push(key);
    } else if (beforeCount > afterCount) {
      for (let i = 0; i < beforeCount - afterCount; i++) removed.push(key);
    }
  }

  return { added, removed };
}

function redactLine(line: string): string {
  if (!line.trim()) return line;

  const patterns = [
    /(\b(password|secret|community|key|string)\b\s+)(\S+)/i,
    /(\b(pre-shared-key|shared-secret|auth-password|priv-password)\b\s+)(\S+)/i
  ];

  let output = line;
  for (const pattern of patterns) {
    output = output.replace(pattern, (_match, prefix) => `${prefix}<redacted>`);
  }
  return output;
}

export function buildRedactedUnifiedDiff(previousConfig: string, currentConfig: string): {
  diff: string;
  addedLines: string[];
  removedLines: string[];
  truncated: boolean;
} {
  const before = normalizeConfig(previousConfig).split('\n');
  const after = normalizeConfig(currentConfig).split('\n');
  const tooLargeForDp = before.length > MAX_DIFF_DP_LINES || after.length > MAX_DIFF_DP_LINES;

  if (tooLargeForDp) {
    const summary = summarizeLineDelta(before, after);
    const addedLines = summary.added.map(redactLine);
    const removedLines = summary.removed.map(redactLine);
    return {
      diff: [
        '--- previous',
        '+++ current',
        `# large-config-summary: detailed line-by-line diff disabled (before=${before.length} lines, after=${after.length} lines)`,
        `# approx_added=${addedLines.length}, approx_removed=${removedLines.length}`
      ].join('\n'),
      addedLines,
      removedLines,
      truncated: true
    };
  }

  const ops = diffLines(before, after);

  const addedLines: string[] = [];
  const removedLines: string[] = [];
  const rendered = [
    '--- previous',
    '+++ current',
    ...ops.map((op) => {
      const value = redactLine(op.line);
      if (op.kind === 'add') {
        addedLines.push(value);
        return `+${value}`;
      }
      if (op.kind === 'remove') {
        removedLines.push(value);
        return `-${value}`;
      }
      return ` ${value}`;
    })
  ];

  return {
    diff: rendered.join('\n'),
    addedLines,
    removedLines,
    truncated: false
  };
}

export function assessDiffRisk(addedLines: string[], removedLines: string[]): DiffAssessment {
  let score = 0;
  const matchedSignals: string[] = [];

  for (const line of addedLines) {
    for (const signal of RISK_SIGNALS) {
      if (signal.appliesTo === 'remove') continue;
      if (signal.regex.test(line)) {
        score += signal.score;
        matchedSignals.push(signal.label);
      }
    }
  }

  for (const line of removedLines) {
    for (const signal of RISK_SIGNALS) {
      if (signal.appliesTo === 'add') continue;
      if (signal.regex.test(line)) {
        score += signal.score;
        matchedSignals.push(signal.label);
      }
    }
  }

  let riskLevel: NetworkConfigRiskLevel = 'low';
  if (score >= 8) riskLevel = 'critical';
  else if (score >= 5) riskLevel = 'high';
  else if (score >= 2) riskLevel = 'medium';

  const summary = `${addedLines.length} line(s) added, ${removedLines.length} line(s) removed${
    matchedSignals.length > 0 ? `; signals: ${Array.from(new Set(matchedSignals)).join(', ')}` : ''
  }`;

  return { riskLevel, summary, matchedSignals: Array.from(new Set(matchedSignals)) };
}

async function emitConfigEvents(args: {
  orgId: string;
  assetId: string;
  configId: string;
  diffId: string | null;
  riskLevel: NetworkConfigRiskLevel;
  summary: string | null;
}) {
  try {
    await publishEvent(
      'network.config_changed',
      args.orgId,
      {
        assetId: args.assetId,
        configId: args.configId,
        diffId: args.diffId,
        riskLevel: args.riskLevel,
        summary: args.summary
      },
      'network-config-management',
      { priority: args.riskLevel === 'critical' || args.riskLevel === 'high' ? 'high' : 'normal' }
    );
  } catch (error) {
    console.warn('[networkConfigManagement] Failed to publish network.config_changed:', error);
  }

  if (args.riskLevel !== 'high' && args.riskLevel !== 'critical') {
    return;
  }

  try {
    await publishEvent(
      'network.config_high_risk_diff',
      args.orgId,
      {
        assetId: args.assetId,
        configId: args.configId,
        diffId: args.diffId,
        riskLevel: args.riskLevel,
        summary: args.summary
      },
      'network-config-management',
      { priority: args.riskLevel === 'critical' ? 'critical' : 'high' }
    );
  } catch (error) {
    console.warn('[networkConfigManagement] Failed to publish network.config_high_risk_diff:', error);
  }
}

export async function backupNetworkConfig(input: BackupNetworkConfigInput): Promise<BackupNetworkConfigResult> {
  if (Buffer.byteLength(input.configText, 'utf8') > MAX_CONFIG_SNAPSHOT_BYTES) {
    throw new Error(`Network config snapshot exceeds maximum size (${MAX_CONFIG_SNAPSHOT_BYTES} bytes)`);
  }

  const normalizedConfig = normalizeConfig(input.configText);
  const configHash = hashConfig(normalizedConfig);
  const capturedAt = input.capturedAt ?? new Date();

  const [previousConfig] = await db
    .select()
    .from(networkDeviceConfigs)
    .where(
      and(
        eq(networkDeviceConfigs.orgId, input.orgId),
        eq(networkDeviceConfigs.assetId, input.assetId),
        eq(networkDeviceConfigs.configType, input.configType)
      )
    )
    .orderBy(desc(networkDeviceConfigs.capturedAt))
    .limit(1);

  const changedFromPrevious = previousConfig ? previousConfig.hash !== configHash : false;
  const unchangedSnapshotMinIntervalMinutes = Math.max(
    0,
    Math.floor(input.unchangedSnapshotMinIntervalMinutes ?? DEFAULT_UNCHANGED_SNAPSHOT_MIN_INTERVAL_MINUTES)
  );

  if (previousConfig && !changedFromPrevious && unchangedSnapshotMinIntervalMinutes > 0) {
    const elapsedMs = capturedAt.getTime() - previousConfig.capturedAt.getTime();
    if (elapsedMs < unchangedSnapshotMinIntervalMinutes * 60 * 1000) {
      return {
        config: previousConfig,
        diff: null,
        skipped: true,
        changed: false
      };
    }
  }

  const encryptedConfig = encryptSecret(normalizedConfig);
  if (!encryptedConfig) {
    throw new Error('Failed to encrypt network config snapshot');
  }

  const [createdConfig] = await db
    .insert(networkDeviceConfigs)
    .values({
      orgId: input.orgId,
      assetId: input.assetId,
      configType: input.configType,
      configEncrypted: encryptedConfig,
      hash: configHash,
      changedFromPrevious,
      capturedAt,
      metadata: input.metadata ?? null
    })
    .returning();

  if (!createdConfig) {
    throw new Error('Failed to persist network config snapshot');
  }

  let createdDiff: typeof networkConfigDiffs.$inferSelect | null = null;
  let riskLevel: NetworkConfigRiskLevel = 'low';
  let summary: string | null = null;

  if (previousConfig && changedFromPrevious) {
    const previousConfigPlaintext = decryptSecret(previousConfig.configEncrypted) ?? '';
    const { diff, addedLines, removedLines, truncated } = buildRedactedUnifiedDiff(previousConfigPlaintext, normalizedConfig);
    const assessment = assessDiffRisk(addedLines, removedLines);
    riskLevel = assessment.riskLevel;
    summary = assessment.summary;

    const [diffRecord] = await db
      .insert(networkConfigDiffs)
      .values({
        orgId: input.orgId,
        assetId: input.assetId,
        previousConfigId: previousConfig.id,
        currentConfigId: createdConfig.id,
        summary: truncated
          ? `${assessment.summary}; diff_truncated=true`
          : assessment.summary,
        diff,
        riskLevel: assessment.riskLevel
      })
      .returning();

    createdDiff = diffRecord ?? null;
  }

  if (changedFromPrevious) {
    await emitConfigEvents({
      orgId: input.orgId,
      assetId: input.assetId,
      configId: createdConfig.id,
      diffId: createdDiff?.id ?? null,
      riskLevel,
      summary
    });
  }

  return {
    config: createdConfig,
    diff: createdDiff,
    skipped: false,
    changed: changedFromPrevious
  };
}

export async function listManagedNetworkDevices(input: {
  orgId: string;
  limit: number;
  offset: number;
}) {
  const conditions: SQL[] = [eq(discoveredAssets.orgId, input.orgId)];
  const managedAssetTypes = Array.from(NETWORK_MANAGED_ASSET_TYPES);
  conditions.push(inArray(discoveredAssets.assetType, managedAssetTypes));

  const assets = await db
    .select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      hostname: discoveredAssets.hostname,
      ipAddress: discoveredAssets.ipAddress,
      assetType: discoveredAssets.assetType,
      approvalStatus: discoveredAssets.approvalStatus,
      isOnline: discoveredAssets.isOnline,
      manufacturer: discoveredAssets.manufacturer,
      model: discoveredAssets.model,
      lastSeenAt: discoveredAssets.lastSeenAt,
      createdAt: discoveredAssets.createdAt
    })
    .from(discoveredAssets)
    .where(and(...conditions))
    .orderBy(desc(discoveredAssets.lastSeenAt), desc(discoveredAssets.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(discoveredAssets)
    .where(and(...conditions));

  const assetIds = assets.map((asset) => asset.id);
  if (assetIds.length === 0) {
    return { data: [], total: Number(countRow?.count ?? 0) };
  }

  const [configRows, firmwareRows] = await Promise.all([
    db
      .select()
      .from(networkDeviceConfigs)
      .where(
        and(
          eq(networkDeviceConfigs.orgId, input.orgId),
          inArray(networkDeviceConfigs.assetId, assetIds)
        )
      )
      .orderBy(desc(networkDeviceConfigs.capturedAt)),
    db
      .select()
      .from(networkDeviceFirmware)
      .where(
        and(
          eq(networkDeviceFirmware.orgId, input.orgId),
          inArray(networkDeviceFirmware.assetId, assetIds)
        )
      )
  ]);

  const latestConfigByAsset = new Map<string, typeof networkDeviceConfigs.$inferSelect>();
  for (const row of configRows) {
    if (!latestConfigByAsset.has(row.assetId)) {
      latestConfigByAsset.set(row.assetId, row);
    }
  }

  const firmwareByAsset = new Map(firmwareRows.map((row) => [row.assetId, row]));

  return {
    data: assets.map((asset) => {
      const latestConfig = latestConfigByAsset.get(asset.id);
      const firmware = firmwareByAsset.get(asset.id);
      return {
        ...asset,
        lastSeenAt: asset.lastSeenAt?.toISOString() ?? null,
        createdAt: asset.createdAt.toISOString(),
        latestBackupAt: latestConfig?.capturedAt.toISOString() ?? null,
        latestBackupType: latestConfig?.configType ?? null,
        latestBackupChanged: latestConfig?.changedFromPrevious ?? false,
        firmware: firmware
          ? {
            currentVersion: firmware.currentVersion,
            latestVersion: firmware.latestVersion,
            eolDate: firmware.eolDate?.toISOString() ?? null,
            cveCount: firmware.cveCount,
            lastCheckedAt: firmware.lastCheckedAt?.toISOString() ?? null
          }
          : null
      };
    }),
    total: Number(countRow?.count ?? 0)
  };
}

export async function listConfigBackups(input: {
  orgId: string;
  assetId?: string;
  configType?: NetworkConfigType;
  changedOnly?: boolean;
  limit: number;
  offset: number;
}) {
  const conditions: SQL[] = [eq(networkDeviceConfigs.orgId, input.orgId)];
  if (input.assetId) conditions.push(eq(networkDeviceConfigs.assetId, input.assetId));
  if (input.configType) conditions.push(eq(networkDeviceConfigs.configType, input.configType));
  if (input.changedOnly) conditions.push(eq(networkDeviceConfigs.changedFromPrevious, true));

  const where = and(...conditions);
  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(networkDeviceConfigs)
      .where(where)
      .orderBy(desc(networkDeviceConfigs.capturedAt))
      .limit(input.limit)
      .offset(input.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(networkDeviceConfigs)
      .where(where)
      .then((result) => result[0])
  ]);

  return {
    data: rows.map((row) => {
      const { configEncrypted: _configEncrypted, ...safeRow } = row;
      return {
        ...safeRow,
        capturedAt: row.capturedAt.toISOString(),
        metadata: row.metadata ?? null
      };
    }),
    total: Number(countRow?.count ?? 0)
  };
}

export async function listConfigDiffs(input: {
  orgId: string;
  assetId?: string;
  riskLevel?: NetworkConfigRiskLevel;
  limit: number;
  offset: number;
}) {
  const conditions: SQL[] = [eq(networkConfigDiffs.orgId, input.orgId)];
  if (input.assetId) conditions.push(eq(networkConfigDiffs.assetId, input.assetId));
  if (input.riskLevel) conditions.push(eq(networkConfigDiffs.riskLevel, input.riskLevel));

  const where = and(...conditions);

  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(networkConfigDiffs)
      .where(where)
      .orderBy(desc(networkConfigDiffs.createdAt))
      .limit(input.limit)
      .offset(input.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(networkConfigDiffs)
      .where(where)
      .then((result) => result[0])
  ]);

  return {
    data: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString()
    })),
    total: Number(countRow?.count ?? 0)
  };
}

export async function upsertFirmwareStatus(input: {
  orgId: string;
  assetId: string;
  currentVersion?: string | null;
  latestVersion?: string | null;
  eolDate?: Date | null;
  cveCount?: number;
  metadata?: Record<string, unknown> | null;
}) {
  const now = new Date();
  const [existing] = await db
    .select()
    .from(networkDeviceFirmware)
    .where(
      and(
        eq(networkDeviceFirmware.orgId, input.orgId),
        eq(networkDeviceFirmware.assetId, input.assetId)
      )
    )
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(networkDeviceFirmware)
      .set({
        currentVersion: input.currentVersion ?? existing.currentVersion,
        latestVersion: input.latestVersion ?? existing.latestVersion,
        eolDate: input.eolDate ?? existing.eolDate,
        cveCount: input.cveCount ?? existing.cveCount ?? 0,
        metadata: input.metadata ?? existing.metadata,
        lastCheckedAt: now
      })
      .where(eq(networkDeviceFirmware.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [created] = await db
    .insert(networkDeviceFirmware)
    .values({
      orgId: input.orgId,
      assetId: input.assetId,
      currentVersion: input.currentVersion ?? null,
      latestVersion: input.latestVersion ?? null,
      eolDate: input.eolDate ?? null,
      cveCount: input.cveCount ?? 0,
      metadata: input.metadata ?? null,
      lastCheckedAt: now
    })
    .returning();

  if (!created) {
    throw new Error('Failed to upsert firmware status');
  }
  return created;
}

function compareVersions(current?: string | null, latest?: string | null): number | null {
  if (!current || !latest) return null;
  const currentParts = current.split(/[^\d]+/).filter(Boolean).map(Number);
  const latestParts = latest.split(/[^\d]+/).filter(Boolean).map(Number);
  const maxLen = Math.max(currentParts.length, latestParts.length);
  for (let i = 0; i < maxLen; i++) {
    const c = currentParts[i] ?? 0;
    const l = latestParts[i] ?? 0;
    if (c === l) continue;
    return c < l ? -1 : 1;
  }
  return 0;
}

export function evaluateFirmwarePosture(input: {
  currentVersion?: string | null;
  latestVersion?: string | null;
  eolDate?: Date | null;
  cveCount?: number | null;
  now?: number;
}): { isBehind: boolean; isEol: boolean; vulnerable: boolean } {
  const now = input.now ?? Date.now();
  const versionCompare = compareVersions(input.currentVersion, input.latestVersion);
  const isBehind = versionCompare === -1;
  const isEol = input.eolDate ? input.eolDate.getTime() <= now : false;
  const vulnerable = (input.cveCount ?? 0) > 0 || isEol || isBehind;
  return { isBehind, isEol, vulnerable };
}

export async function listFirmwareStatus(input: {
  orgId: string;
  assetId?: string;
  vulnerableOnly?: boolean;
  eolBefore?: Date;
  limit: number;
  offset: number;
}) {
  const conditions: SQL[] = [eq(networkDeviceFirmware.orgId, input.orgId)];
  if (input.assetId) conditions.push(eq(networkDeviceFirmware.assetId, input.assetId));
  if (input.eolBefore) conditions.push(lte(networkDeviceFirmware.eolDate, input.eolBefore));

  const where = and(...conditions);

  if (input.vulnerableOnly) {
    const allRows = await db
      .select()
      .from(networkDeviceFirmware)
      .where(where)
      .orderBy(desc(networkDeviceFirmware.lastCheckedAt));

    const vulnerableRows = allRows.filter((row) =>
      evaluateFirmwarePosture({
        currentVersion: row.currentVersion,
        latestVersion: row.latestVersion,
        eolDate: row.eolDate,
        cveCount: row.cveCount
      }).vulnerable
    );

    const paged = vulnerableRows.slice(input.offset, input.offset + input.limit);
    return {
      data: paged.map((row) => ({
        ...row,
        eolDate: row.eolDate?.toISOString() ?? null,
        lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
        posture: evaluateFirmwarePosture({
          currentVersion: row.currentVersion,
          latestVersion: row.latestVersion,
          eolDate: row.eolDate,
          cveCount: row.cveCount
        })
      })),
      total: vulnerableRows.length
    };
  }

  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(networkDeviceFirmware)
      .where(where)
      .orderBy(desc(networkDeviceFirmware.lastCheckedAt))
      .limit(input.limit)
      .offset(input.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(networkDeviceFirmware)
      .where(where)
      .then((result) => result[0])
  ]);

  return {
    data: rows.map((row) => ({
      ...row,
      eolDate: row.eolDate?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      posture: evaluateFirmwarePosture({
        currentVersion: row.currentVersion,
        latestVersion: row.latestVersion,
        eolDate: row.eolDate,
        cveCount: row.cveCount
      })
    })),
    total: Number(countRow?.count ?? 0)
  };
}

export async function refreshFirmwarePostureForOrg(orgId: string): Promise<{ checked: number; vulnerable: number }> {
  const assets = await db
    .select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      hostname: discoveredAssets.hostname,
      assetType: discoveredAssets.assetType,
      snmpData: discoveredAssets.snmpData
    })
    .from(discoveredAssets)
    .where(
      and(
        eq(discoveredAssets.orgId, orgId),
        inArray(discoveredAssets.assetType, Array.from(NETWORK_MANAGED_ASSET_TYPES))
      )
    );

  let vulnerable = 0;
  for (const asset of assets) {
    const snmpData = (asset.snmpData ?? {}) as Record<string, unknown>;
    const currentVersion = typeof snmpData.sysDescr === 'string'
      ? snmpData.sysDescr.slice(0, 80)
      : null;
    const latestVersion = typeof snmpData.recommendedVersion === 'string'
      ? snmpData.recommendedVersion.slice(0, 80)
      : currentVersion;
    const cveCount = typeof snmpData.cveCount === 'number'
      ? Math.max(0, Math.floor(snmpData.cveCount))
      : 0;
    const eolDate = typeof snmpData.eolDate === 'string'
      ? new Date(snmpData.eolDate)
      : null;

    const record = await upsertFirmwareStatus({
      orgId: asset.orgId,
      assetId: asset.id,
      currentVersion,
      latestVersion,
      cveCount,
      eolDate: eolDate && !Number.isNaN(eolDate.getTime()) ? eolDate : null,
      metadata: { source: 'snmp_data' }
    });

    const posture = evaluateFirmwarePosture({
      currentVersion: record.currentVersion,
      latestVersion: record.latestVersion,
      eolDate: record.eolDate,
      cveCount: record.cveCount
    });
    const isVulnerable = posture.vulnerable;
    if (isVulnerable) {
      vulnerable++;
      try {
        await publishEvent(
          'network.firmware_vulnerable',
          orgId,
          {
            assetId: asset.id,
            hostname: asset.hostname,
            currentVersion: record.currentVersion,
            latestVersion: record.latestVersion,
            cveCount: record.cveCount,
            eolDate: record.eolDate?.toISOString() ?? null
          },
          'network-config-management',
          { priority: (record.cveCount ?? 0) > 0 || posture.isEol ? 'high' : 'normal' }
        );
      } catch (error) {
        console.warn('[networkConfigManagement] Failed to publish network.firmware_vulnerable:', error);
      }
    }
  }

  return { checked: assets.length, vulnerable };
}

export async function getManagedNetworkAssets(orgId: string): Promise<Array<typeof discoveredAssets.$inferSelect>> {
  return db
    .select()
    .from(discoveredAssets)
    .where(
      and(
        eq(discoveredAssets.orgId, orgId),
        inArray(discoveredAssets.assetType, Array.from(NETWORK_MANAGED_ASSET_TYPES))
      )
    );
}
