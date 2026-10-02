import type { AiConnectionRowKind } from '@breeze/shared';

/** Kinds the "Add connection" chooser offers, in order. W07 appends 'bedrock' | 'vertex' | 'foundry'. */
export const ADDABLE_CONNECTION_KINDS = ['anthropic_byok', 'openai_compatible'] as const satisfies readonly AiConnectionRowKind[];
export type AddableConnectionKind = (typeof ADDABLE_CONNECTION_KINDS)[number];

/** Literal key map (the i18n keyUsage test cannot check template keys). */
export const ADD_KIND_LABEL_KEYS: Record<AddableConnectionKind, string> = {
  anthropic_byok: 'aiModels.connections.addKind.anthropic_byok',
  openai_compatible: 'aiModels.connections.addKind.openai_compatible',
};

export const ADD_KIND_TEST_IDS: Record<AddableConnectionKind, string> = {
  anthropic_byok: 'ai-connection-add-kind-anthropic',
  openai_compatible: 'ai-connection-add-kind-openai',
};
