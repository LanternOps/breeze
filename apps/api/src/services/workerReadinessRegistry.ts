import type { Worker } from 'bullmq';

export type ConsumerLifecycleState =
  | 'expected'
  | 'running'
  | 'redis_disconnected'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'disabled';

export interface ConsumerReadinessState {
  name: string;
  required: boolean;
  state: ConsumerLifecycleState;
  running: boolean;
  redisConnected: boolean;
  transitionedAt: string;
  lastSuccessfulJobAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
}

export interface PublicConsumerReadinessSummary {
  required: number;
  runnable: number;
  unavailable: number;
  optionalRunning: number;
  optionalDisabled: number;
}

export interface WorkerReadinessRegistry {
  expect(name: string, required: boolean): void;
  disable(name: string, reasonCode: string): void;
  attach(name: string, worker: Worker): void;
  recordInitializationFailure(name: string, error: unknown): void;
  snapshot(): Readonly<Record<string, ConsumerReadinessState>>;
  requiredConsumersRunnable(): boolean;
}

const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function sanitizeErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : null;
  return name && ERROR_CODE_PATTERN.test(name) ? name : 'worker_error';
}

function isRunnable(state: ConsumerReadinessState): boolean {
  return state.state === 'running' && state.running && state.redisConnected;
}

export function summarizeConsumerReadiness(
  consumers: Readonly<Record<string, ConsumerReadinessState>>,
): PublicConsumerReadinessSummary {
  let required = 0;
  let runnable = 0;
  let optionalRunning = 0;
  let optionalDisabled = 0;

  for (const consumer of Object.values(consumers)) {
    if (consumer.required) {
      required += 1;
      if (isRunnable(consumer)) runnable += 1;
    } else if (isRunnable(consumer)) {
      optionalRunning += 1;
    } else if (consumer.state === 'disabled') {
      optionalDisabled += 1;
    }
  }

  return {
    required,
    runnable,
    unavailable: required - runnable,
    optionalRunning,
    optionalDisabled,
  };
}

export function createWorkerReadinessRegistry(options: {
  now?: () => number;
  onTransition?: () => void;
} = {}): WorkerReadinessRegistry {
  const now = options.now ?? Date.now;
  const consumers = new Map<string, ConsumerReadinessState>();
  const attached = new Set<string>();
  const refreshers = new Map<string, () => void>();
  // An initialization failure is terminal for the process lifetime: the
  // initializer never completed, so its repeatables were never scheduled and
  // no later event can make the consumer trustworthy again. This has to be a
  // separate set rather than a `state === 'failed'` check because the
  // dominant initializer shape attaches BEFORE the throwable work, so a
  // failed consumer still has live BullMQ listeners: `error` would otherwise
  // move it off `failed` to `redis_disconnected` and the next `ready` (BullMQ
  // re-emits one on every Redis reconnect) would flip it back to `running`,
  // fail-opening /ready for a process whose worker never initialized.
  const terminallyFailed = new Set<string>();

  const timestamp = (): string => new Date(now()).toISOString();

  const notify = (): void => {
    options.onTransition?.();
  };

  const getExpected = (name: string): ConsumerReadinessState => {
    const consumer = consumers.get(name);
    if (!consumer) {
      throw new Error(`Worker readiness consumer was not expected: ${name}`);
    }
    return consumer;
  };

  const createExpected = (name: string, required: boolean): ConsumerReadinessState => {
    if (consumers.has(name)) {
      throw new Error(`Duplicate worker readiness consumer name: ${name}`);
    }
    const consumer: ConsumerReadinessState = {
      name,
      required,
      state: 'expected',
      running: false,
      redisConnected: false,
      transitionedAt: timestamp(),
      lastSuccessfulJobAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
    };
    consumers.set(name, consumer);
    notify();
    return consumer;
  };

  const updateLifecycle = (
    name: string,
    state: ConsumerLifecycleState,
    running: boolean,
    redisConnected: boolean,
  ): void => {
    const consumer = getExpected(name);
    if (terminallyFailed.has(name)) return;
    if (
      consumer.state === state
      && consumer.running === running
      && consumer.redisConnected === redisConnected
    ) {
      return;
    }
    consumer.state = state;
    consumer.running = running;
    consumer.redisConnected = redisConnected;
    consumer.transitionedAt = timestamp();
    notify();
  };

  const recordError = (name: string, error: unknown): void => {
    const consumer = getExpected(name);
    if (terminallyFailed.has(name)) return;
    consumer.lastErrorAt = timestamp();
    consumer.lastErrorCode = sanitizeErrorCode(error);
    // Job/error metadata is internal. Invalidating the dependency-probe cache
    // here would turn ordinary queue traffic into repeated DB/Redis probes.
  };

  const recordInitializationFailure = (name: string, error: unknown): void => {
    const consumer = getExpected(name);
    const failedAt = timestamp();
    terminallyFailed.add(name);
    consumer.state = 'failed';
    consumer.running = false;
    consumer.redisConnected = false;
    consumer.transitionedAt = failedAt;
    consumer.lastErrorAt = failedAt;
    consumer.lastErrorCode = sanitizeErrorCode(error);
    notify();
  };

  return {
    expect(name, required): void {
      createExpected(name, required);
    },

    disable(name, reasonCode): void {
      const consumer = getExpected(name);
      if (terminallyFailed.has(name)) return;
      const disabledAt = timestamp();
      const sanitizedReason = ERROR_CODE_PATTERN.test(reasonCode)
        ? reasonCode
        : 'worker_error';
      if (
        consumer.state === 'disabled'
        && !consumer.running
        && !consumer.redisConnected
        && consumer.lastErrorCode === sanitizedReason
      ) {
        return;
      }
      consumer.state = 'disabled';
      consumer.running = false;
      consumer.redisConnected = false;
      consumer.transitionedAt = disabledAt;
      consumer.lastErrorCode = sanitizedReason;
      notify();
    },

    attach(name, worker): void {
      if (!consumers.has(name)) {
        // Task 2 declares the complete manifest before initialization. Keeping
        // attachment fail-closed here also makes this task safe in isolation:
        // an already-instrumented worker cannot become invisible to readiness.
        createExpected(name, true);
      }
      type ReadinessClient = {
        status: string;
        on?: (event: string, listener: () => void) => unknown;
      };
      const runtime = worker as unknown as {
        client?: Promise<ReadinessClient>;
        waitUntilReady?: () => Promise<ReadinessClient>;
        isRunning?: () => boolean;
        isPaused?: () => boolean;
      };
      if (
        !runtime.client
        || typeof runtime.client.then !== 'function'
        || typeof runtime.isRunning !== 'function'
      ) {
        recordInitializationFailure(
          name,
          new TypeError('Worker runtime readiness probes are unavailable'),
        );
        return;
      }
      if (attached.has(name)) {
        throw new Error(`Worker readiness consumer already attached: ${name}`);
      }
      attached.add(name);

      const clients = new Set<ReadinessClient>();
      const disconnected = new Set<ReadinessClient>();
      let resolvedClients = 0;
      let shuttingDown = false;
      // BullMQ's public waitUntilReady() returns its BLOCKING client, whereas
      // client returns the command client. The webhook adapter exposes its
      // blocking client directly and does not implement waitUntilReady().
      const expectedClients = runtime.waitUntilReady ? 2 : 1;
      const reconcile = (): void => {
        if (shuttingDown || terminallyFailed.has(name) || resolvedClients < expectedClients) return;
        const connected = [...clients].every((client) => client.status === 'ready' && !disconnected.has(client));
        const running = runtime.isRunning!() && !runtime.isPaused?.();
        updateLifecycle(name, !connected ? 'redis_disconnected' : running ? 'running' : 'stopped', running && connected, connected);
      };
      refreshers.set(name, reconcile);

      worker.on('ready', () => {
        if (!runtime.waitUntilReady) {
          // The webhook adapter replaces an ended blocking connection. Its
          // successful BRPOP reports ready on the new client, so follow it.
          observeClient(runtime.client!, true);
        }
        reconcile();
      });
      worker.on('resumed', reconcile);
      worker.on('paused', reconcile);
      worker.on('ioredis:close', reconcile);
      worker.on('error', (error) => {
        // BullMQ also emits `error` for lost job locks and processing errors.
        // Only actual connection status or lifecycle proves unavailability.
        recordError(name, error);
        reconcile();
      });
      worker.on('completed', () => {
        const consumer = getExpected(name);
        if (terminallyFailed.has(name)) return;
        consumer.lastSuccessfulJobAt = timestamp();
        reconcile();
      });
      worker.on('failed', (_job, error) => {
        recordError(name, error);
        reconcile();
      });
      worker.on('closing', () => {
        shuttingDown = true;
        updateLifecycle(name, 'stopping', false, false);
      });
      worker.on('closed', () => {
        shuttingDown = true;
        updateLifecycle(name, 'stopped', false, false);
      });

      const observeClient = (promise: Promise<ReadinessClient>, replace = false): void => {
        void promise.then((client) => {
          if (!clients.has(client)) {
            if (replace) { clients.clear(); disconnected.clear(); }
            clients.add(client);
            for (const event of ['close', 'end', 'reconnecting']) {
              client.on?.(event, () => { disconnected.add(client); reconcile(); });
            }
            client.on?.('ready', () => { disconnected.delete(client); reconcile(); });
          }
          if (!replace) resolvedClients += 1;
          reconcile();
        }).catch((error: unknown) => {
          recordError(name, error);
          if (!shuttingDown) updateLifecycle(name, 'redis_disconnected', false, false);
        });
      };
      // Install worker listeners before resolving either connection. Readiness
      // never infers both connections (or the run loop) from a `ready` event.
      observeClient(runtime.client);
      if (runtime.waitUntilReady) observeClient(runtime.waitUntilReady());
    },

    recordInitializationFailure(name, error): void {
      recordInitializationFailure(name, error);
    },

    snapshot(): Readonly<Record<string, ConsumerReadinessState>> {
      for (const refresh of refreshers.values()) refresh();
      return Object.fromEntries(
        Array.from(consumers, ([name, consumer]) => [name, { ...consumer }]),
      );
    },

    requiredConsumersRunnable(): boolean {
      for (const refresh of refreshers.values()) refresh();
      for (const consumer of consumers.values()) {
        if (consumer.required && !isRunnable(consumer)) return false;
      }
      return true;
    },
  };
}

let workerReadinessTransitionHandler: (() => void) | undefined;

export function setWorkerReadinessTransitionHandler(handler: () => void): void {
  workerReadinessTransitionHandler = handler;
}

export const workerReadinessRegistry: WorkerReadinessRegistry =
  createWorkerReadinessRegistry({
    onTransition: () => workerReadinessTransitionHandler?.(),
  });
