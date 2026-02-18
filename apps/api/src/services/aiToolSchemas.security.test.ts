/**
 * Security tests for AI Tool Schema path traversal defense and computer_control validation.
 *
 * Test 1: isBlockedPath / safePath - path traversal defense
 * Test 2: computer_control - superRefine conditional validation
 */
import { describe, expect, it } from 'vitest';
import {
  isBlockedPath,
  normalizePath,
  safePath,
  toolInputSchemas,
  validateToolInput,
} from './aiToolSchemas';

const TEST_UUID = '00000000-0000-0000-0000-000000000001';

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: isBlockedPath path traversal defense
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizePath', () => {
  it('normalizes backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Windows\\System32')).toBe('c:/windows/system32');
  });

  it('collapses redundant separators', () => {
    expect(normalizePath('/etc///shadow')).toBe('/etc/shadow');
  });

  it('removes dot components', () => {
    expect(normalizePath('/etc/./shadow')).toBe('/etc/shadow');
  });

  it('lowercases the entire path', () => {
    expect(normalizePath('/ETC/Shadow')).toBe('/etc/shadow');
  });

  it('handles trailing dot component', () => {
    expect(normalizePath('/etc/.')).toBe('/etc/');
  });
});

describe('isBlockedPath', () => {
  describe('direct path traversal', () => {
    it('blocks /etc/shadow', () => {
      expect(isBlockedPath('/etc/shadow')).toBe(true);
    });

    it('blocks /etc/passwd', () => {
      expect(isBlockedPath('/etc/passwd')).toBe(true);
    });

    it('blocks /etc/sudoers', () => {
      expect(isBlockedPath('/etc/sudoers')).toBe(true);
    });

    it('blocks /proc/cpuinfo', () => {
      expect(isBlockedPath('/proc/cpuinfo')).toBe(true);
    });

    it('blocks /proc (bare)', () => {
      expect(isBlockedPath('/proc')).toBe(true);
    });

    it('blocks /sys', () => {
      expect(isBlockedPath('/sys')).toBe(true);
    });

    it('blocks /dev', () => {
      expect(isBlockedPath('/dev')).toBe(true);
    });

    it('blocks /var/run', () => {
      expect(isBlockedPath('/var/run')).toBe(true);
    });

    it('blocks /var/lib/docker', () => {
      expect(isBlockedPath('/var/lib/docker')).toBe(true);
    });
  });

  describe('Windows blocked paths', () => {
    it('blocks C:\\Windows\\System32\\config', () => {
      expect(isBlockedPath('C:\\Windows\\System32\\config')).toBe(true);
    });

    it('blocks C:\\Windows\\SAM', () => {
      expect(isBlockedPath('C:\\Windows\\SAM')).toBe(true);
    });

    it('blocks C:\\Users\\*\\AppData variant', () => {
      expect(isBlockedPath('C:\\Users\\admin\\AppData')).toBe(true);
    });

    it('blocks C:\\Users\\anyone\\AppData\\Roaming', () => {
      expect(isBlockedPath('C:\\Users\\anyone\\AppData\\Roaming')).toBe(true);
    });
  });

  describe('wildcard path blocking', () => {
    it('blocks /home/user/.ssh/id_rsa', () => {
      expect(isBlockedPath('/home/user/.ssh/id_rsa')).toBe(true);
    });

    it('blocks /home/admin/.ssh/authorized_keys', () => {
      expect(isBlockedPath('/home/admin/.ssh/authorized_keys')).toBe(true);
    });

    it('blocks /root/.ssh/id_rsa', () => {
      expect(isBlockedPath('/root/.ssh/id_rsa')).toBe(true);
    });

    it('blocks /root/.ssh (bare)', () => {
      expect(isBlockedPath('/root/.ssh')).toBe(true);
    });
  });

  describe('path normalization bypass attempts', () => {
    it('blocks /etc/./shadow (dot component bypass)', () => {
      expect(isBlockedPath('/etc/./shadow')).toBe(true);
    });

    it('blocks /etc///shadow (redundant separators)', () => {
      expect(isBlockedPath('/etc///shadow')).toBe(true);
    });

    it('blocks mixed slashes: /etc\\shadow', () => {
      expect(isBlockedPath('/etc\\shadow')).toBe(true);
    });

    it('blocks case variation: /ETC/SHADOW', () => {
      expect(isBlockedPath('/ETC/SHADOW')).toBe(true);
    });

    it('blocks case variation: /Proc/CpuInfo', () => {
      expect(isBlockedPath('/Proc/CpuInfo')).toBe(true);
    });

    it('blocks chained dot components: /etc/./././shadow', () => {
      expect(isBlockedPath('/etc/./././shadow')).toBe(true);
    });
  });

  describe('allowed paths that should pass', () => {
    it('allows /tmp/myfile.txt', () => {
      expect(isBlockedPath('/tmp/myfile.txt')).toBe(false);
    });

    it('allows /home/user/documents/file.txt', () => {
      expect(isBlockedPath('/home/user/documents/file.txt')).toBe(false);
    });

    it('allows /var/log/syslog', () => {
      expect(isBlockedPath('/var/log/syslog')).toBe(false);
    });

    it('allows /opt/breeze/data/config.json', () => {
      expect(isBlockedPath('/opt/breeze/data/config.json')).toBe(false);
    });

    it('allows C:\\Users\\admin\\Documents\\report.docx', () => {
      expect(isBlockedPath('C:\\Users\\admin\\Documents\\report.docx')).toBe(false);
    });
  });
});

describe('safePath Zod validator', () => {
  it('rejects paths containing null bytes', () => {
    const result = safePath.safeParse('/tmp/file\0.txt');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('null bytes'))).toBe(true);
    }
  });

  it('rejects path traversal with ..', () => {
    const result = safePath.safeParse('../../etc/shadow');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('..'))).toBe(true);
    }
  });

  it('rejects direct .. component', () => {
    const result = safePath.safeParse('..');
    expect(result.success).toBe(false);
  });

  it('rejects /etc/shadow (blocked path)', () => {
    const result = safePath.safeParse('/etc/shadow');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('blocked'))).toBe(true);
    }
  });

  it('rejects /proc/cpuinfo (blocked system path)', () => {
    const result = safePath.safeParse('/proc/cpuinfo');
    expect(result.success).toBe(false);
  });

  it('rejects encoded traversal with null byte at start', () => {
    const result = safePath.safeParse('\0/etc/shadow');
    expect(result.success).toBe(false);
  });

  it('allows /tmp/myfile.txt', () => {
    const result = safePath.safeParse('/tmp/myfile.txt');
    expect(result.success).toBe(true);
  });

  it('allows /home/user/documents/file.txt', () => {
    const result = safePath.safeParse('/home/user/documents/file.txt');
    expect(result.success).toBe(true);
  });

  it('rejects paths exceeding 4096 chars', () => {
    const result = safePath.safeParse('/tmp/' + 'a'.repeat(4100));
    expect(result.success).toBe(false);
  });
});

describe('validateToolInput with file_operations (safePath integration)', () => {
  it('rejects file_operations with path traversal', () => {
    const result = validateToolInput('file_operations', {
      deviceId: TEST_UUID,
      action: 'read',
      path: '../../etc/shadow',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('..');
    }
  });

  it('rejects file_operations with blocked system path', () => {
    const result = validateToolInput('file_operations', {
      deviceId: TEST_UUID,
      action: 'read',
      path: '/etc/shadow',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('blocked');
    }
  });

  it('rejects file_operations with null byte in path', () => {
    const result = validateToolInput('file_operations', {
      deviceId: TEST_UUID,
      action: 'read',
      path: '/tmp/file\0.txt',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('null');
    }
  });

  it('accepts file_operations with safe path', () => {
    const result = validateToolInput('file_operations', {
      deviceId: TEST_UUID,
      action: 'read',
      path: '/tmp/myfile.txt',
    });
    expect(result.success).toBe(true);
  });

  it('rejects file_operations with blocked newPath on rename', () => {
    const result = validateToolInput('file_operations', {
      deviceId: TEST_UUID,
      action: 'rename',
      path: '/tmp/safe.txt',
      newPath: '/etc/shadow',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('blocked');
    }
  });
});

describe('validateToolInput with unknown tools', () => {
  it('returns success for unknown tool names (no schema registered)', () => {
    const result = validateToolInput('nonexistent_tool', { anything: 'goes' });
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: computer_control Zod superRefine validation
// ═══════════════════════════════════════════════════════════════════════════

describe('computer_control schema superRefine validation', () => {
  const schema = toolInputSchemas['computer_control']!;

  function parse(input: unknown) {
    return schema.safeParse(input);
  }

  describe('mouse actions require x,y coordinates', () => {
    const mouseActions = ['left_click', 'right_click', 'middle_click', 'double_click', 'mouse_move', 'scroll'];

    it.each(mouseActions)('%s requires x and y', (action) => {
      const result = parse({ deviceId: TEST_UUID, action });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.message.includes('coordinates'))).toBe(true);
      }
    });

    it.each(mouseActions)('%s succeeds with x and y', (action) => {
      const result = parse({ deviceId: TEST_UUID, action, x: 100, y: 200 });
      expect(result.success).toBe(true);
    });

    it('left_click fails when only x is provided', () => {
      const result = parse({ deviceId: TEST_UUID, action: 'left_click', x: 100 });
      expect(result.success).toBe(false);
    });

    it('left_click fails when only y is provided', () => {
      const result = parse({ deviceId: TEST_UUID, action: 'left_click', y: 200 });
      expect(result.success).toBe(false);
    });
  });

  describe('key action requires key field', () => {
    it('fails without key field', () => {
      const result = parse({ deviceId: TEST_UUID, action: 'key' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.message.includes('key'))).toBe(true);
      }
    });

    it('succeeds with key field', () => {
      const result = parse({ deviceId: TEST_UUID, action: 'key', key: 'Enter' });
      expect(result.success).toBe(true);
    });

    it('succeeds with key and modifiers', () => {
      const result = parse({
        deviceId: TEST_UUID,
        action: 'key',
        key: 'c',
        modifiers: ['ctrl'],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('type action requires text field', () => {
    it('fails without text field', () => {
      const result = parse({ deviceId: TEST_UUID, action: 'type' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(i => i.message.includes('text'))).toBe(true);
      }
    });

    it('succeeds with text field', () => {
      const result = parse({ deviceId: TEST_UUID, action: 'type', text: 'Hello World' });
      expect(result.success).toBe(true);
    });
  });

  describe('screenshot action', () => {
    it('does not require coordinates', () => {
      const result = parse({ deviceId: TEST_UUID, action: 'screenshot' });
      expect(result.success).toBe(true);
    });

    it('accepts optional monitor field', () => {
      const result = parse({ deviceId: TEST_UUID, action: 'screenshot', monitor: 1 });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid action values', () => {
    it('rejects unknown action', () => {
      const result = parse({ deviceId: TEST_UUID, action: 'hover' });
      expect(result.success).toBe(false);
    });

    it('rejects empty action', () => {
      const result = parse({ deviceId: TEST_UUID, action: '' });
      expect(result.success).toBe(false);
    });

    it('rejects missing action', () => {
      const result = parse({ deviceId: TEST_UUID });
      expect(result.success).toBe(false);
    });

    it('rejects missing deviceId', () => {
      const result = parse({ action: 'screenshot' });
      expect(result.success).toBe(false);
    });

    it('rejects non-UUID deviceId', () => {
      const result = parse({ deviceId: 'not-a-uuid', action: 'screenshot' });
      expect(result.success).toBe(false);
    });
  });

  describe('optional fields', () => {
    it('accepts modifiers array', () => {
      const result = parse({
        deviceId: TEST_UUID,
        action: 'key',
        key: 'a',
        modifiers: ['ctrl', 'shift'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid modifier', () => {
      const result = parse({
        deviceId: TEST_UUID,
        action: 'key',
        key: 'a',
        modifiers: ['super'],
      });
      expect(result.success).toBe(false);
    });

    it('accepts captureAfter boolean', () => {
      const result = parse({
        deviceId: TEST_UUID,
        action: 'screenshot',
        captureAfter: true,
      });
      expect(result.success).toBe(true);
    });

    it('accepts captureDelayMs within range', () => {
      const result = parse({
        deviceId: TEST_UUID,
        action: 'screenshot',
        captureDelayMs: 1500,
      });
      expect(result.success).toBe(true);
    });

    it('rejects captureDelayMs above max', () => {
      const result = parse({
        deviceId: TEST_UUID,
        action: 'screenshot',
        captureDelayMs: 5000,
      });
      expect(result.success).toBe(false);
    });

    it('accepts scrollDelta for scroll action', () => {
      const result = parse({
        deviceId: TEST_UUID,
        action: 'scroll',
        x: 500,
        y: 300,
        scrollDelta: -5,
      });
      expect(result.success).toBe(true);
    });

    it('rejects scrollDelta outside range', () => {
      const result = parse({
        deviceId: TEST_UUID,
        action: 'scroll',
        x: 500,
        y: 300,
        scrollDelta: -200,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('validateToolInput integration', () => {
    it('rejects computer_control with missing key for key action', () => {
      const result = validateToolInput('computer_control', {
        deviceId: TEST_UUID,
        action: 'key',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('key');
      }
    });

    it('accepts valid computer_control screenshot', () => {
      const result = validateToolInput('computer_control', {
        deviceId: TEST_UUID,
        action: 'screenshot',
      });
      expect(result.success).toBe(true);
    });
  });
});
