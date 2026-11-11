// #11553: user-facing strings that rendered as the humanized key name
// ("Delete Channel Confirm", "Wake Sent Watching") in every locale. The en
// baseline test only guards en; the other seven locales carried a machine
// translation of the placeholder, so each pinned key must be real copy in all
// eight locales.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHumanizedKeyPlaceholder } from '../../../../scripts/i18n-humanized-key-lib.mjs';

const localesDir = dirname(fileURLToPath(import.meta.url));
const locales = readdirSync(localesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

const PINNED: Array<[ns: string, key: string]> = [
  ['alerts', 'notificationChannelsPage.deleteChannelConfirm'],
  ['devices', 'devicesPage.toasts.wakeSentWatching'],
  ['devices', 'devicesPage.toasts.alreadyPendingTail'],
  ['devices', 'devicesPage.toasts.scriptQueuedOneOffline'],
  ['remote', 'remoteFilesPage.deviceNotFoundTitle'],
  ['remote', 'remoteFilesPage.deviceNotFoundDescription'],
  ['remote', 'remoteFilesPage.deviceOfflineTitle'],
  ['remote', 'remoteTerminalPage.deviceNotFoundTitle'],
  ['remote', 'remoteTerminalPage.deviceNotFoundDescription'],
  ['remote', 'servicesManager.agentRestartConfirm'],
  ['remote', 'servicesManager.agentStopBlocked'],
  ['remote', 'deleteConfirmDialog.recycleBinNotice'],
];

function lookup(locale: string, ns: string, key: string): unknown {
  let node: unknown = JSON.parse(readFileSync(join(localesDir, locale, `${ns}.json`), 'utf8'));
  for (const part of key.split('.')) {
    node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined;
  }
  return node;
}

describe('pinned user-facing copy is real, not a humanized key (#11553)', () => {
  it.each(locales)('%s', (locale) => {
    const bad: string[] = [];
    for (const [ns, key] of PINNED) {
      const value = lookup(locale, ns, key);
      const leaf = key.split('.').pop()!;
      if (typeof value !== 'string' || value.trim() === '') bad.push(`${ns}.${key}: missing`);
      else if (isHumanizedKeyPlaceholder(leaf, value)) bad.push(`${ns}.${key}: "${value}" is a humanized key`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
