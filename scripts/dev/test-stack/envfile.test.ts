import { describe, expect, it } from 'vitest';
import { GENERATED_MARKER, isGeneratedEnvTest, parseProjectFromEnvTest, renderEnvTest } from './envfile';

describe('renderEnvTest', () => {
  it('emits every var the integration env chain needs, on the given ports', () => {
    const body = renderEnvTest({ pgPort: 54321, redisPort: 61234, project: 'breeze-test-x' });
    expect(body.startsWith(GENERATED_MARKER)).toBe(true);
    expect(body).toContain('DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:54321/breeze_test');
    expect(body).toContain('DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:54321/breeze_test');
    expect(body).toContain('BREEZE_APP_DB_PASSWORD=breeze_test');
    expect(body).toContain('POSTGRES_PASSWORD=breeze_test');
    expect(body).toContain('REDIS_URL=redis://localhost:61234');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('round-trips through isGeneratedEnvTest', () => {
    expect(isGeneratedEnvTest(renderEnvTest({ pgPort: 1, redisPort: 2, project: 'p' }))).toBe(true);
    expect(isGeneratedEnvTest('DATABASE_URL=postgresql://hand:written@localhost:5433/breeze_test\n')).toBe(false);
  });

  it('round-trips the compose project so `down` tears down what `up` created', () => {
    const body = renderEnvTest({ pgPort: 1, redisPort: 2, project: 'breeze-test-old-branch' });
    expect(parseProjectFromEnvTest(body)).toBe('breeze-test-old-branch');
    expect(parseProjectFromEnvTest('')).toBeUndefined();
    expect(parseProjectFromEnvTest('DATABASE_URL=x\n')).toBeUndefined();
  });
});
