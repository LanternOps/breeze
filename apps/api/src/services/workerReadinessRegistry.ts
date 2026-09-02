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

  const recordError = (name: string, error: unknown, stopConsumer: boolean): void => {
    const consumer = getExpected(name);
    if (terminallyFailed.has(name)) return;
    const errorAt = timestamp();
    const errorCode = sanitizeErrorCode(error);
    const lifecycleChanged = stopConsumer && (
      consumer.state !== 'redis_disconnected'
      || consumer.running
      || consumer.redisConnected
    );
    const errorChanged = consumer.lastErrorAt !== errorAt
      || consumer.lastErrorCode !== errorCode;

    if (!lifecycleChanged && !errorChanged) return;

    if (lifecycleChanged) {
      consumer.state = 'redis_disconnected';
      consumer.running = false;
      consumer.redisConnected = false;
      consumer.transitionedAt = errorAt;
    }
    consumer.lastErrorAt = errorAt;
    consumer.lastErrorCode = errorCode;
    notify();
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
      const runtime = worker as unknown as {
        client?: Promise<{ status: string }>;
        isRunning?: () => boolean;
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

      worker.on('ready', () => {
        updateLifecycle(name, 'running', true, true);
      });
      worker.on('error', (error) => {
        recordError(name, error, true);
      });
      worker.on('completed', () => {
        const consumer = getExpected(name);
        if (terminallyFailed.has(name)) return;
        const completedAt = timestamp();
        if (consumer.lastSuccessfulJobAt === completedAt) return;
        consumer.lastSuccessfulJobAt = completedAt;
        notify();
      });
      worker.on('failed', (_job, error) => {
        recordError(name, error, false);
      });
      worker.on('closing', () => {
        updateLifecycle(name, 'stopping', false, false);
      });
      worker.on('closed', () => {
        updateLifecycle(name, 'stopped', false, false);
      });

      // Listeners are installed before touching the client promise so a ready
      // event racing this initial status check cannot be missed.
      const initialState = getExpected(name).state;
      void runtime.client.then((client) => {
        if (
          getExpected(name).state === initialState
          && initialState === 'expected'
          && runtime.isRunning?.()
          && client.status === 'ready'
        ) {
          updateLifecycle(name, 'running', true, true);
        }
      }).catch((error: unknown) => {
        if (getExpected(name).state === initialState && initialState === 'expected') {
          recordError(name, error, true);
        }
      });
    },

    recordInitializationFailure(name, error): void {
      recordInitializationFailure(name, error);
    },

    snapshot(): Readonly<Record<string, ConsumerReadinessState>> {
      return Object.fromEntries(
        Array.from(consumers, ([name, consumer]) => [name, { ...consumer }]),
      );
    },

    requiredConsumersRunnable(): boolean {
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
