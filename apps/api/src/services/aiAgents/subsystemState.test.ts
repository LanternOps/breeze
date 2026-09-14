import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AI_AGENTS_ENV_FLAG_NAME,
  aiAgentsEnvFlagEnabled,
  logAiAgentsSubsystemState,
} from './subsystemState';

describe('subsystemState', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BREEZE_AI_AGENTS_ENABLED;
  });

  describe('aiAgentsEnvFlagEnabled', () => {
    it('reads the flag at call time, matching what runService admission checks', () => {
      delete process.env.BREEZE_AI_AGENTS_ENABLED;
      expect(aiAgentsEnvFlagEnabled()).toBe(false);
      process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
      expect(aiAgentsEnvFlagEnabled()).toBe(true);
    });

    it('names the env var so the UI can tell a self-hoster what to set', () => {
      expect(AI_AGENTS_ENV_FLAG_NAME).toBe('BREEZE_AI_AGENTS_ENABLED');
    });
  });

  describe('logAiAgentsSubsystemState', () => {
    it('warns at boot when the subsystem is off, naming the env var (#5381)', () => {
      logAiAgentsSubsystemState('api', false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('DISABLED');
      expect(String(warn.mock.calls[0][0])).toContain('BREEZE_AI_AGENTS_ENABLED');
    });

    it('logs the enabled counterpart at info', () => {
      logAiAgentsSubsystemState('worker', true);
      expect(warn).not.toHaveBeenCalled();
      expect(String(info.mock.calls[0][0])).toContain('ENABLED');
    });
  });
});
