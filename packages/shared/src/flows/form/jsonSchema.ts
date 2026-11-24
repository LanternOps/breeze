import { z } from 'zod';
import { flowDocumentV1Schema } from '../../validators/flows';

/** The flow document's JSON Schema (input side, so defaulted fields are optional), for the editor's Document tab. */
export function flowDocumentJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(flowDocumentV1Schema, { io: 'input' }) as Record<string, unknown>;
}
