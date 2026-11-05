import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The screens are React Native and not renderable under vitest, so pin the
// user-facing copy at the source level.
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');

describe('Ask Breeze AI copy', () => {
  it('HomeScreen input placeholder says "Ask Breeze AI"', () => {
    expect(read('HomeScreen.tsx')).toContain('placeholder="Ask Breeze AI"');
  });

  it('Onboarding chat step says "Ask Breeze AI about your devices"', () => {
    expect(read('../onboarding/OnboardingScreen.tsx')).toContain(
      'body="Ask Breeze AI about your devices, alerts, or recent activity.',
    );
  });
});
