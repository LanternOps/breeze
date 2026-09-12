import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { remoteSessions } from './remote';

describe('remoteSessions desktop command binding', () => {
  it('declares the command generation, prompt mode, and database checks', () => {
    const config = getTableConfig(remoteSessions);
    const columnNames = config.columns.map((column) => column.name);
    const checkNames = config.checks.map((constraint) => constraint.name);

    expect(columnNames).toEqual(expect.arrayContaining([
      'desktop_start_command_id',
      'desktop_prompt_mode',
    ]));
    expect(checkNames).toEqual(expect.arrayContaining([
      'remote_sessions_desktop_prompt_mode_check',
      'remote_sessions_desktop_start_binding_check',
    ]));
  });
});
