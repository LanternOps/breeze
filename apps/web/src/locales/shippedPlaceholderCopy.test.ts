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

// [namespace, key, interpolation tokens every locale must keep, min length].
// The English-only humanized heuristic cannot see a machine-translated
// placeholder ("Hinweis zum Papierkorb"), so sentence keys also need a
// language-neutral floor: their tokens and a minimum length.
const PINNED: Array<[ns: string, key: string, tokens: string[], minLength: number]> = [
  ['alerts', 'notificationChannelsPage.deleteChannelConfirm', ['{{name}}'], 40],
  ['devices', 'devicesPage.toasts.wakeSentWatching', ['{{hostname}}', '{{relay}}', '{{broadcast}}'], 40],
  ['devices', 'devicesPage.toasts.alreadyPendingTail', ['{{count}}'], 0],
  ['devices', 'devicesPage.toasts.scriptQueuedOneOffline', ['{{script}}', '{{hostname}}'], 40],
  ['remote', 'remoteFilesPage.deviceNotFoundTitle', [], 0],
  ['remote', 'remoteFilesPage.deviceNotFoundDescription', [], 30],
  ['remote', 'remoteFilesPage.deviceOfflineTitle', [], 0],
  ['remote', 'remoteTerminalPage.deviceNotFoundTitle', [], 0],
  ['remote', 'remoteTerminalPage.deviceNotFoundDescription', [], 30],
  ['remote', 'servicesManager.agentRestartConfirm', [], 40],
  ['remote', 'servicesManager.agentStopBlocked', [], 40],
  ['remote', 'deleteConfirmDialog.recycleBinNotice', [], 40],
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
    for (const [ns, key, tokens, minLength] of PINNED) {
      const value = lookup(locale, ns, key);
      const leaf = key.split('.').pop()!;
      if (typeof value !== 'string' || value.trim() === '') bad.push(`${ns}.${key}: missing`);
      else if (isHumanizedKeyPlaceholder(leaf, value)) bad.push(`${ns}.${key}: "${value}" is a humanized key`);
      else {
        for (const token of tokens) if (!value.includes(token)) bad.push(`${ns}.${key}: dropped ${token}`);
        if (value.length < minLength) bad.push(`${ns}.${key}: "${value}" is too short to be real copy`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
