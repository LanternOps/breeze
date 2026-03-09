/**
 * Condition Handler Registry
 *
 * Pluggable registry for condition evaluators. Each handler registers
 * a type (and optional aliases) and provides evaluate + validate methods.
 */

import type { ConditionResult } from './types';

export interface ConditionHandler {
  type: string;
  aliases?: string[];
  evaluate(condition: unknown, deviceId: string): Promise<ConditionResult>;
  validate(condition: unknown, path: string): string[];
}

class ConditionRegistry {
  private handlers = new Map<string, ConditionHandler>();

  register(handler: ConditionHandler): void {
    this.handlers.set(handler.type, handler);
    if (handler.aliases) {
      for (const alias of handler.aliases) {
        this.handlers.set(alias, handler);
      }
    }
  }

  get(type: string): ConditionHandler | undefined {
    return this.handlers.get(type);
  }

  async evaluate(condition: unknown & { type: string }, deviceId: string): Promise<ConditionResult> {
    const cond = condition as { type: string };
    const handler = this.handlers.get(cond.type);
    if (!handler) {
      return {
        passed: false,
        description: `Unknown condition type: ${cond.type}`
      };
    }
    return handler.evaluate(condition, deviceId);
  }

  validate(condition: unknown & { type: string }, path: string): string[] {
    const cond = condition as { type: string };
    const handler = this.handlers.get(cond.type);
    if (!handler) {
      return [`${path}.type: Unknown condition type '${cond.type}'`];
    }
    return handler.validate(condition, path);
  }

  getRegisteredTypes(): string[] {
    return [...new Set([...this.handlers.keys()])];
  }
}

// Singleton registry
export const conditionRegistry = new ConditionRegistry();
