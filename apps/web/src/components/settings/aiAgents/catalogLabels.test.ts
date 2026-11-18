import { describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import { formatToolName } from '@/lib/utils';
import {
  catalogActionLabel,
  catalogCapabilityDescription,
  catalogCapabilityLabel,
  catalogToolLabel,
  sentenceCase,
} from './catalogLabels';

describe('catalogLabels (#10194)', () => {
  const t = i18n.getFixedT('en', 'settings') as unknown as (key: string, options?: Record<string, unknown>) => string;

  it('resolves shipped copy for tools, actions and capabilities through the settings namespace', () => {
    expect(catalogToolLabel(t, 'manage_alerts')).toBe('Manage alerts');
    expect(catalogActionLabel(t, 'manage_alerts', 'acknowledge')).toBe('Acknowledge an alert');
    expect(catalogCapabilityLabel(t, 'alerts_monitoring')).not.toBe(sentenceCase('alerts_monitoring'));
    expect(catalogCapabilityDescription(t, 'alerts_monitoring').length).toBeGreaterThan(0);
  });

  it('labels a bare operation by its tool', () => {
    expect(catalogActionLabel(t, 'manage_alerts', null)).toBe(catalogToolLabel(t, 'manage_alerts'));
  });

  it('a per-organization flow tool never reaches the translation lookup', () => {
    const spy = vi.fn((key: string) => key);
    expect(catalogToolLabel(spy, 'flow__restart_print_spooler')).toBe('Flow restart print spooler');
    expect(catalogActionLabel(spy, 'flow__restart_print_spooler', null)).toBe('Flow restart print spooler');
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to a humanized id when a server ships a tool ahead of this bundle', () => {
    expect(catalogToolLabel(t, 'not_a_shipped_tool_yet')).toBe(formatToolName('not_a_shipped_tool_yet'));
    expect(catalogActionLabel(t, 'not_a_shipped_tool_yet', 'do_thing')).toBe('Do thing');
  });
});
