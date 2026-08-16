import { describe, it, expect, vi } from 'vitest';
import { makeApplyHandler } from './scriptBuilderTools';

/**
 * Pins the wiring between normalizeScriptCode and the editor delivery path:
 * makeApplyHandler must hand the NORMALIZED args to onPostToolUse, because
 * that exact object is what aiAgentSdk.createSessionPostToolUse re-attaches
 * into the SSE tool_result the editor reads (scriptAiStore). If a refactor
 * ever passes the raw SDK args instead, typographic Unicode reaches devices
 * again -- and for bash/python the agent-side BOM layer does not cover it.
 */
describe('apply_script_code normalization wiring', () => {
  it('delivers normalized code to onPostToolUse', async () => {
    const spy = vi.fn();
    const handler = makeApplyHandler('apply_script_code', spy);

    const rawCode = 'Write-Host \u201cdone \u2014 ok\u201d';
    await handler({ code: rawCode, language: 'powershell' });

    expect(spy).toHaveBeenCalledTimes(1);
    const [, args] = spy.mock.calls[0]!;
    expect((args as { code: string }).code).toBe('Write-Host "done - ok"');
  });

  it('delivers the status glyphs from the real failure transliterated', async () => {
    const spy = vi.fn();
    const handler = makeApplyHandler('apply_script_code', spy);

    // Verbatim from the payload that produced the reported parse errors.
    await handler({
      code: 'Write-Host "✓ Download completed successfully ($fileSizeRounded MB)"',
      language: 'powershell',
    });

    const [, args] = spy.mock.calls[0]!;
    expect((args as { code: string }).code).toBe(
      'Write-Host "[OK] Download completed successfully ($fileSizeRounded MB)"'
    );
  });

  it('reports codeChars for the normalized code', async () => {
    const spy = vi.fn();
    const handler = makeApplyHandler('apply_script_code', spy);

    // Ellipsis expands 1 -> 3 chars, so raw and normalized lengths differ.
    await handler({ code: 'echo hi\u2026', language: 'bash' });

    const [, , output] = spy.mock.calls[0]!;
    expect(String(output)).toContain('"codeChars":10');
  });

  it('leaves non-code args untouched', async () => {
    const spy = vi.fn();
    const handler = makeApplyHandler('apply_script_metadata', spy);

    await handler({ name: 'Disk cleanup \u2014 weekly' });

    const [, args] = spy.mock.calls[0]!;
    expect((args as { name: string }).name).toBe('Disk cleanup \u2014 weekly');
  });
});
