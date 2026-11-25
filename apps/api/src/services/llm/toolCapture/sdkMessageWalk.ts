// One content walk over SDK message `content`, shared by the eval harness's
// stream observer (streamObserver.ts) and the production tool-discovery
// observer (services/aiToolDiscoveryObserver.ts, #12421), so both agree on
// what "a search", "a result" and "a call" are.
//
// Pre-order, depth-first: an array is walked item by item at the same depth;
// a block is visited, then its `content` is walked one level deeper. Strings
// and other non-object values are skipped.

export interface SdkContentVisitor {
  onBlock(block: Record<string, unknown>, ctx: { assistant: boolean; depth: number }): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function walk(content: unknown, assistant: boolean, visitor: SdkContentVisitor, depth: number): void {
  if (Array.isArray(content)) {
    for (const item of content) walk(item, assistant, visitor, depth);
    return;
  }
  const block = asRecord(content);
  if (!block) return;
  visitor.onBlock(block, { assistant, depth });
  walk(block.content, assistant, visitor, depth + 1);
}

export function walkSdkMessageContent(content: unknown, assistant: boolean, visitor: SdkContentVisitor): void {
  walk(content, assistant, visitor, 0);
}
