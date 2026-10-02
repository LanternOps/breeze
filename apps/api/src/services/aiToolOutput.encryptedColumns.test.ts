import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(),
}));

import { compactToolResultForChat } from './aiToolOutput';
import { encryptedColumnRegistry } from './encryptedColumnRegistry';

/**
 * Every column the encrypted-column registry seals is, by definition, secret.
 * If a tool returns one under its own name, the tool-output chokepoint must
 * mask it by name — so a column added to the registry is covered here without
 * anyone remembering to touch the redactor.
 *
 * The exceptions are columns whose name is too generic to mask everywhere it
 * appears in tool output (`url`, `value`, `settings`, ...). Masking every `url`
 * would wipe ordinary data from dozens of tools. A tool that returns one of
 * these columns must mask it itself.
 */
const GENERIC_NAME_COLUMNS = new Set([
  'webhooks.url',
  'webhooks.headers',
  'notification_channel_configs.config',
  'automations.trigger',
  'organizations.settings',
  'partners.settings',
  'sites.settings',
  'tenant_variables.value',
  // manage_backup_configs masks it with redactProviderConfig.
  'backup_configs.provider_config',
]);

/** Secret columns stored outside the registry that tools must still never show. */
const UNREGISTERED_SECRET_COLUMNS = [
  'backup_configs.encryption_key',
  'storage_encryption_keys.key_hash',
  'api_keys.key_hash',
];

const REDACTED = '[REDACTED]';
const camel = (column: string) => column.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function maskedByName(key: string): boolean {
  const out = JSON.parse(
    compactToolResultForChat('some_tool', JSON.stringify({ row: { [key]: 'value-under-test' } }))
  );
  return out.row[key] === REDACTED;
}

describe('compactToolResultForChat — encrypted-column registry names are masked', () => {
  const registered = encryptedColumnRegistry.map((spec) => `${spec.table}.${spec.column}`);

  it.each(
    [...registered.filter((name) => !GENERIC_NAME_COLUMNS.has(name)), ...UNREGISTERED_SECRET_COLUMNS]
  )('%s is masked under its snake and camel names', (qualified) => {
    const column = qualified.split('.')[1]!;
    expect(maskedByName(column)).toBe(true);
    expect(maskedByName(camel(column))).toBe(true);
  });

  it('every generic-name exception is still a registered column', () => {
    for (const name of GENERIC_NAME_COLUMNS) {
      expect(registered).toContain(name);
    }
  });
});
