import type { BootStartupItem } from '../db/schema/devices';

const STARTUP_ITEM_TYPES = new Set<BootStartupItem['type']>([
  'service',
  'run_key',
  'startup_folder',
  'login_item',
  'launch_agent',
  'launch_daemon',
  'systemd',
  'cron',
  'init_d',
]);

export type BootStartupItemWithId = BootStartupItem & { itemId: string };

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdentityPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ');
}

function normalizeType(value: unknown): BootStartupItem['type'] {
  const normalized = normalizeIdentityPart(normalizeString(value));
  return STARTUP_ITEM_TYPES.has(normalized as BootStartupItem['type'])
    ? (normalized as BootStartupItem['type'])
    : 'service';
}

function normalizeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

function normalizeBoolean(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

export function computeStartupItemId(item: {
  itemId?: string;
  type?: string;
  path?: string;
  name?: string;
}): string {
  const explicit = normalizeIdentityPart(normalizeString(item.itemId));
  if (explicit) return explicit;

  const type = normalizeIdentityPart(normalizeString(item.type)) || 'service';
  const path = normalizeIdentityPart(normalizeString(item.path));
  if (path) return `${type}|${path}`;

  const name = normalizeIdentityPart(normalizeString(item.name)) || 'unknown';
  return `${type}|name:${name}`;
}

export function normalizeStartupItem(raw: unknown): BootStartupItemWithId | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;
  const name = normalizeString(obj.name) || normalizeString(obj.path) || 'unnamed_startup_item';
  const type = normalizeType(obj.type);
  const path = normalizeString(obj.path);
  const enabled = normalizeBoolean(obj.enabled, true);
  const cpuTimeMs = Math.max(0, Math.trunc(normalizeNumber(obj.cpuTimeMs, 0)));
  const diskIoBytes = Math.max(0, Math.trunc(normalizeNumber(obj.diskIoBytes, 0)));
  const impactScore = Math.max(0, normalizeNumber(obj.impactScore, 0));
  const itemId = computeStartupItemId({ itemId: normalizeString(obj.itemId), type, path, name });

  return {
    itemId,
    name,
    type,
    path,
    enabled,
    cpuTimeMs,
    diskIoBytes,
    impactScore,
  };
}

export function normalizeStartupItems(rawItems: unknown[]): BootStartupItemWithId[] {
  const normalized: BootStartupItemWithId[] = [];
  const seen = new Set<string>();

  for (const raw of rawItems) {
    const item = normalizeStartupItem(raw);
    if (!item) continue;
    if (seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    normalized.push(item);
  }

  return normalized;
}

export interface StartupItemSelector {
  itemId?: string;
  itemName?: string;
  itemType?: string;
  itemPath?: string;
}

export interface StartupItemResolveResult {
  item?: BootStartupItemWithId;
  candidates?: BootStartupItemWithId[];
  error?: string;
}

export function resolveStartupItem(
  items: BootStartupItemWithId[],
  selector: StartupItemSelector
): StartupItemResolveResult {
  const selectedItemID = normalizeIdentityPart(normalizeString(selector.itemId));
  const selectedName = normalizeIdentityPart(normalizeString(selector.itemName));
  const selectedType = normalizeIdentityPart(normalizeString(selector.itemType));
  const selectedPath = normalizeIdentityPart(normalizeString(selector.itemPath));

  if (!selectedItemID && !selectedName && !selectedType && !selectedPath) {
    return { error: 'No startup item selector provided.' };
  }

  let candidates = items;

  if (selectedItemID) {
    candidates = candidates.filter(i => normalizeIdentityPart(i.itemId) === selectedItemID);
    if (candidates.length === 1) {
      return { item: candidates[0] };
    }
  }
  if (selectedName) {
    candidates = candidates.filter(i => normalizeIdentityPart(i.name) === selectedName);
  }
  if (selectedType) {
    candidates = candidates.filter(i => normalizeIdentityPart(i.type) === selectedType);
  }
  if (selectedPath) {
    candidates = candidates.filter(i => normalizeIdentityPart(i.path) === selectedPath);
  }

  if (candidates.length === 0) {
    return { error: 'Startup item not found.' };
  }
  if (candidates.length > 1) {
    return {
      error: 'Startup item selector is ambiguous.',
      candidates,
    };
  }

  return { item: candidates[0] };
}
