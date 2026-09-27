import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('checkAgentWsMessageBudget', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.AGENT_WS_MESSAGE_BUDGET_CAPACITY;
    delete process.env.AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND;
    delete process.env.AGENT_WS_MESSAGE_BUDGET_CLOSE_THRESHOLD;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows a burst well under the default capacity (300) instantly', async () => {
    const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
    const socket = {};
    const now = Date.now();
    for (let i = 0; i < 100; i += 1) {
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('allow');
    }
  });

  it('allows a sustained 30fps desktop stream (the real ceiling) for many seconds without dropping', async () => {
    const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
    const socket = {};
    let now = Date.now();
    // 30 frames/sec for 20 seconds = 600 frames, well past the 300 burst
    // capacity, but the 60/sec refill rate keeps up with a steady 30/sec load
    // indefinitely — this must never drop for a genuinely healthy agent.
    for (let sec = 0; sec < 20; sec += 1) {
      for (let frame = 0; frame < 30; frame += 1) {
        now += 1000 / 30;
        expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('allow');
      }
    }
  });

  it('drops once the burst capacity is exhausted within a single instant', async () => {
    process.env.AGENT_WS_MESSAGE_BUDGET_CAPACITY = '10';
    process.env.AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND = '1';
    const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
    const socket = {};
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('allow');
    }
    expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('drop');
  });

  it('refills over elapsed time and allows again', async () => {
    process.env.AGENT_WS_MESSAGE_BUDGET_CAPACITY = '5';
    process.env.AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND = '5';
    const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
    const socket = {};
    let now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('allow');
    }
    expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('drop');

    // One second later, the bucket has fully refilled.
    now += 1000;
    expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('allow');
  });

  it('closes the connection after sustained consecutive drops, not on a single burst', async () => {
    process.env.AGENT_WS_MESSAGE_BUDGET_CAPACITY = '2';
    process.env.AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND = '0';
    process.env.AGENT_WS_MESSAGE_BUDGET_CLOSE_THRESHOLD = '5';
    const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
    const socket = {};
    const now = Date.now();

    expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('allow');
    expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('allow');

    // 4 drops: still just dropping, not closing.
    for (let i = 0; i < 4; i += 1) {
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('drop');
    }
    // 5th consecutive drop crosses the threshold.
    expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('close');
  });

  it('keys the budget per socket — two connections never share a bucket', async () => {
    process.env.AGENT_WS_MESSAGE_BUDGET_CAPACITY = '1';
    process.env.AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND = '0';
    const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
    const socketA = {};
    const socketB = {};
    const now = Date.now();

    expect(checkAgentWsMessageBudget(socketA, 'agent-1', now)).toBe('allow');
    expect(checkAgentWsMessageBudget(socketA, 'agent-1', now)).toBe('drop');
    // A different socket for the SAME agent id starts with its own full bucket.
    expect(checkAgentWsMessageBudget(socketB, 'agent-1', now)).toBe('allow');
  });

  it('reports throttled/closed counts via the metrics getter', async () => {
    process.env.AGENT_WS_MESSAGE_BUDGET_CAPACITY = '1';
    process.env.AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND = '0';
    process.env.AGENT_WS_MESSAGE_BUDGET_CLOSE_THRESHOLD = '2';
    const { checkAgentWsMessageBudget, getAgentWsMessageBudgetMetrics, __resetAgentWsMessageBudgetMetricsForTest } =
      await import('./agentWsMessageBudget');
    __resetAgentWsMessageBudgetMetricsForTest();
    const socket = {};
    const now = Date.now();

    checkAgentWsMessageBudget(socket, 'agent-1', now); // allow
    checkAgentWsMessageBudget(socket, 'agent-1', now); // drop 1
    checkAgentWsMessageBudget(socket, 'agent-1', now); // drop 2 -> close

    const metrics = getAgentWsMessageBudgetMetrics();
    expect(metrics.throttled).toBe(2);
    expect(metrics.closed).toBe(1);
  });

  describe('command_result and update_status lanes', () => {
    beforeEach(() => {
      delete process.env.AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_CAPACITY;
      delete process.env.AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_REFILL_PER_SECOND;
      delete process.env.AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_CAPACITY;
      delete process.env.AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_REFILL_PER_SECOND;
    });

    it('command_result, update_status and general are three INDEPENDENT budgets on the same socket', async () => {
      process.env.AGENT_WS_MESSAGE_BUDGET_CAPACITY = '1';
      process.env.AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND = '0';
      const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
      const socket = {};
      const now = Date.now();

      // Exhaust the general bucket.
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('allow');
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now)).toBe('drop');

      // command_result and update_status each have their own, untouched budget.
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'command_result')).toBe('allow');
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'update_status')).toBe('allow');
    });

    it('the update_status lane never exceeds the general lane\'s own capacity by default', async () => {
      const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
      const generalSocket = {};
      const updateStatusSocket = {};
      const now = Date.now();

      // Drain the default general capacity (300) exactly.
      for (let i = 0; i < 300; i += 1) {
        expect(checkAgentWsMessageBudget(generalSocket, 'agent-1', now)).toBe('allow');
      }
      expect(checkAgentWsMessageBudget(generalSocket, 'agent-1', now)).toBe('drop');

      // update_status must drop at or before that same point — it must never
      // get MORE burst room than general, since it is the frame type that
      // serializes most on the devices row and must not be widened.
      for (let i = 0; i < 300; i += 1) {
        checkAgentWsMessageBudget(updateStatusSocket, 'agent-1', now, 'update_status');
      }
      expect(checkAgentWsMessageBudget(updateStatusSocket, 'agent-1', now, 'update_status')).toBe('drop');
    });

    it('the command_result lane is sized for a realistic reconnect/bulk-result burst, not an unbounded escape hatch', async () => {
      const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
      const socket = {};
      const now = Date.now();
      let allowed = 0;
      for (let i = 0; i < 5000; i += 1) {
        if (checkAgentWsMessageBudget(socket, 'agent-1', now, 'command_result') !== 'allow') break;
        allowed += 1;
      }
      // Generous enough for a real reconnect flush of queued results, but a
      // bounded, specific ceiling — not the old 1000-capacity/never-closes lane.
      expect(allowed).toBeGreaterThan(300);
      expect(allowed).toBeLessThan(1000);
    });

    it('closes the connection on sustained abuse on the command_result lane, same as general', async () => {
      process.env.AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_CAPACITY = '2';
      process.env.AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_REFILL_PER_SECOND = '0';
      process.env.AGENT_WS_MESSAGE_BUDGET_CLOSE_THRESHOLD = '5';
      const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
      const socket = {};
      const now = Date.now();

      expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'command_result')).toBe('allow');
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'command_result')).toBe('allow');
      for (let i = 0; i < 4; i += 1) {
        expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'command_result')).toBe('drop');
      }
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'command_result')).toBe('close');
    });

    it('closes the connection on sustained abuse on the update_status lane, same as general', async () => {
      process.env.AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_CAPACITY = '2';
      process.env.AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_REFILL_PER_SECOND = '0';
      process.env.AGENT_WS_MESSAGE_BUDGET_CLOSE_THRESHOLD = '5';
      const { checkAgentWsMessageBudget } = await import('./agentWsMessageBudget');
      const socket = {};
      const now = Date.now();

      expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'update_status')).toBe('allow');
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'update_status')).toBe('allow');
      for (let i = 0; i < 4; i += 1) {
        expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'update_status')).toBe('drop');
      }
      expect(checkAgentWsMessageBudget(socket, 'agent-1', now, 'update_status')).toBe('close');
    });
  });
});
