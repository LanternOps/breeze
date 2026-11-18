import { describe, expect, it } from 'vitest';
import source from './DesktopViewer.tsx?raw';

// Match the existing source-derived component wiring guards: this viewer has
// no React harness. Runtime propagation is covered in lib/webrtc.test.ts.
describe('session switching preserves relay refusal', () => {
  const start = source.indexOf('const handleSwitchSession = useCallback(');
  const body = source.slice(start, source.indexOf('\n  }, [', start));

  it('surfaces a relay refusal before attempting recovery', () => {
    const initialCatch = body.slice(body.indexOf('} catch (err) {'), body.indexOf('const prevId'));
    expect(initialCatch).toContain('err instanceof RelayRequiredError');
    expect(initialCatch).toContain('setErrorMessage(err.message)');
    expect(initialCatch).toContain("setStatus('error')");
    expect(initialCatch).toContain('return;');
  });

  it('surfaces a relay refusal if isolation changes during recovery', () => {
    const recovery = body.slice(body.indexOf('const prevId'));
    const catchBody = recovery.slice(recovery.indexOf('} catch'));
    expect(catchBody).toContain('err instanceof RelayRequiredError');
    expect(catchBody).toContain('setErrorMessage(err.message)');
    expect(catchBody).toContain("setStatus('error')");
    expect(catchBody.indexOf('return;')).toBeLessThan(catchBody.indexOf('startReconnectRef.current()'));
  });
});
