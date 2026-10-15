import { describe, it, expect } from 'vitest';
import { blankComments, handlerWindow } from './aiToolScopeScan';

/**
 * `handlerWindow` is the window the OPTIONAL-argument scans of
 * `aiToolsDeviceScope.contract.test.ts` and `aiToolsSiteScope.contract.test.ts`
 * read. A window that stops at `handler: someIdentifier` makes a guarded
 * module-level handler read as unguarded (#8600, `run_script`), and one that
 * follows the WRONG body makes an unguarded handler read as guarded — so both
 * directions are pinned here.
 */
describe('handlerWindow', () => {
  const at = (src: string) => {
    const handlerIdx = src.indexOf('handler:');
    const end = src.indexOf('});', handlerIdx);
    return handlerWindow(src, handlerIdx, end);
  };

  it('an inline handler window is unchanged', () => {
    const src = `registerTool({ handler: async (input, auth) => { return verifyDeviceAccess(x, auth); }, });`;
    const handlerIdx = src.indexOf('handler:');
    const end = src.indexOf('});', handlerIdx);
    expect(handlerWindow(src, handlerIdx, end)).toBe(src.slice(handlerIdx, end));
  });

  it('follows `handler: <identifier>` to a same-file arrow const', () => {
    const src = `
      const runIt: AiTool['handler'] = async (input, auth, context) => {
        const access = await verifyDeviceAccess(input.deviceId, auth);
        return 'ok';
      };
      registerTool({ definition: { name: 't' }, handler: runIt, });
    `;
    expect(at(src)).toContain('verifyDeviceAccess(input.deviceId, auth)');
  });

  it('follows an expression-bodied arrow const', () => {
    const src = `
      const runIt = async (input, auth) => verifyDeviceAccess(input.deviceId, auth);
      registerTool({ handler: runIt });
    `;
    expect(at(src)).toContain('verifyDeviceAccess(input.deviceId, auth)');
  });

  it('follows `handler: <identifier>` to a same-file function declaration', () => {
    const src = `
      async function runIt(input: { deviceId?: string }, auth: AuthContext): Promise<string> {
        return verifyDeviceAccess(input.deviceId, auth);
      }
      registerTool({ handler: runIt });
    `;
    expect(at(src)).toContain('verifyDeviceAccess(input.deviceId, auth)');
  });

  it('includes ONLY the referenced body, not a neighbour', () => {
    const src = `
      const guarded = async (input, auth) => verifyDeviceAccess(input.deviceId, auth);
      const runIt = async (input, auth) => { return db.select().from(alerts); };
      registerTool({ handler: runIt });
    `;
    const w = at(src);
    expect(w).toContain('db.select().from(alerts)');
    expect(w).not.toContain('verifyDeviceAccess');
  });

  it('does not treat a prefix-named identifier as the referenced one', () => {
    const src = `
      const runItGuarded = async (input, auth) => verifyDeviceAccess(input.deviceId, auth);
      const runIt = async (input, auth) => { return 'nothing'; };
      registerTool({ handler: runIt });
    `;
    expect(at(src)).not.toContain('verifyDeviceAccess');
  });

  it('a reference with no same-file definition adds nothing', () => {
    const src = `registerTool({ handler: importedHandler });`;
    const handlerIdx = src.indexOf('handler:');
    const end = src.indexOf('});', handlerIdx);
    expect(handlerWindow(src, handlerIdx, end)).toBe(src.slice(handlerIdx, end));
  });

  it('a referenced body whose only marker is in a COMMENT is not guarded once comments are blanked', () => {
    const src = blankComments(`
      const runIt = async (input, auth) => {
        // verifyDeviceAccess runs upstream
        return 'ok';
      };
      registerTool({ handler: runIt });
    `);
    expect(at(src)).not.toContain('verifyDeviceAccess');
  });
});
