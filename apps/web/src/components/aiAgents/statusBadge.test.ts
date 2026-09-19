import { describe, expect, it } from 'vitest';
import { badgeClass, graduationTone, modeTone, runStatusTone, verdictTone, type BadgeTone } from './statusBadge';

const ALL_TONES: BadgeTone[] = ['neutral', 'info', 'success', 'warning', 'danger', 'accent', 'muted'];

describe('badgeClass', () => {
  it('includes a dark: class for every tone', () => {
    for (const tone of ALL_TONES) {
      expect(badgeClass(tone)).toContain('dark:');
    }
  });

  it('includes the base pill structure classes', () => {
    const cls = badgeClass('info');
    expect(cls).toContain('inline-flex');
    expect(cls).toContain('rounded');
    expect(cls).toContain('text-xs');
    expect(cls).toContain('font-medium');
  });

  it('never returns a class containing -700 without a dark: counterpart', () => {
    for (const tone of ALL_TONES) {
      for (const size of ['sm', 'md'] as const) {
        const cls = badgeClass(tone, { size });
        if (/-700\b/.test(cls)) {
          expect(cls).toContain('dark:');
        }
      }
    }
  });

  it('supports sm and md sizes with different output', () => {
    expect(badgeClass('neutral', { size: 'sm' })).not.toEqual(badgeClass('neutral', { size: 'md' }));
  });
});

describe('runStatusTone', () => {
  it('assigns non-neutral tones for every status RunsListPage colours', () => {
    expect(runStatusTone('completed')).not.toBe('neutral');
    expect(runStatusTone('failed')).not.toBe('neutral');
    expect(runStatusTone('running')).not.toBe('neutral');
    expect(runStatusTone('awaiting_approval')).not.toBe('neutral');
  });

  it('maps queued and running to info', () => {
    expect(runStatusTone('queued')).toBe('info');
    expect(runStatusTone('running')).toBe('info');
  });

  it('maps awaiting_approval to warning', () => {
    expect(runStatusTone('awaiting_approval')).toBe('warning');
  });

  it('maps completed/succeeded to success', () => {
    expect(runStatusTone('completed')).toBe('success');
    expect(runStatusTone('succeeded')).toBe('success');
  });

  it('maps failed/errored to danger', () => {
    expect(runStatusTone('failed')).toBe('danger');
    expect(runStatusTone('errored')).toBe('danger');
  });

  // Review fix (#4187 UI critique, P2): `cancelled` is an operator-initiated
  // stop, not a failure — main renders it neutral, and the danger tone this
  // branch briefly carried made a deliberate cancel read as an error.
  it('maps cancelled to neutral, not danger', () => {
    expect(runStatusTone('cancelled')).toBe('neutral');
  });

  it('covers every value in RunsListPage status enum without throwing, defaulting unknowns to neutral', () => {
    for (const status of ['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired', 'skipped']) {
      expect(typeof runStatusTone(status)).toBe('string');
    }
    expect(runStatusTone('expired')).toBe('neutral');
    expect(runStatusTone('skipped')).toBe('neutral');
    expect(runStatusTone('totally-unknown')).toBe('neutral');
  });
});

describe('verdictTone', () => {
  it('maps remediated to success', () => {
    expect(verdictTone('remediated')).toBe('success');
  });

  it('maps partial to warning', () => {
    expect(verdictTone('partial')).toBe('warning');
  });

  it('maps needs_attention to danger', () => {
    expect(verdictTone('needs_attention')).toBe('danger');
  });

  it('defaults no_action and unknown verdicts to neutral', () => {
    expect(verdictTone('no_action')).toBe('neutral');
    expect(verdictTone('unknown')).toBe('neutral');
  });
});

describe('graduationTone', () => {
  it('maps every AI_AGENT_GRADUATION_STATES value', () => {
    expect(graduationTone('tracking')).toBe('neutral');
    expect(graduationTone('eligible')).toBe('info');
    expect(graduationTone('promoted')).toBe('success');
    expect(graduationTone('demoted')).toBe('danger');
  });

  it('defaults unknown state to neutral', () => {
    expect(graduationTone('unknown')).toBe('neutral');
  });
});

describe('modeTone', () => {
  it('maps AI_AGENT_MODES values', () => {
    expect(modeTone('off')).toBe('muted');
    expect(modeTone('shadow')).toBe('info');
    expect(modeTone('act')).toBe('warning');
  });

  it('defaults unknown mode to neutral', () => {
    expect(modeTone('unknown')).toBe('neutral');
  });
});
