import { describe, expect, it } from 'vitest';
import { extractServiceNameFromAlert } from './alertServiceName';

describe('extractServiceNameFromAlert', () => {
  it('reads the exact prose the service alert condition writes', () => {
    // Verbatim from `alertConditions/handlers/service.ts`.
    expect(extractServiceNameFromAlert({
      message: 'Service spooler stopped (3 consecutive failures, threshold: 3)',
    })).toBe('spooler');
  });

  it('reads the "is running" phrasing too', () => {
    expect(extractServiceNameFromAlert({ message: 'Service W32Time is running' })).toBe('W32Time');
  });

  it('falls back to the title when the message has no match', () => {
    expect(extractServiceNameFromAlert({
      title: 'Service MSSQLSERVER stopped',
      message: 'A monitored condition changed state.',
    })).toBe('MSSQLSERVER');
  });

  it('prefers a structured context value over parsed prose', () => {
    expect(extractServiceNameFromAlert({
      message: 'Service spooler stopped',
      context: { serviceName: 'Spooler' },
    })).toBe('Spooler');
  });

  it('returns null rather than guessing when nothing matches', () => {
    // The dialog then asks the operator, which is the only honest outcome —
    // a wrong prefill would be a different operation under a different digest.
    expect(extractServiceNameFromAlert({ message: 'CPU above 90% for 10 minutes' })).toBeNull();
    expect(extractServiceNameFromAlert({})).toBeNull();
    expect(extractServiceNameFromAlert({ message: null, title: null })).toBeNull();
  });

  it('never returns a filler word as a service name', () => {
    expect(extractServiceNameFromAlert({ message: 'Service is not reachable' })).toBeNull();
  });

  it('bounds the name to the column width', () => {
    const long = 'a'.repeat(400);
    const got = extractServiceNameFromAlert({ context: { serviceName: long } });
    expect(got).toHaveLength(255);
  });
});
