import { describe, expect, it } from 'vitest';

import { openApiSpec } from './openapi';

describe('script admission OpenAPI contract', () => {
  it('documents the exact canonical 201 response instead of terminal success', () => {
    const response = openApiSpec.paths['/scripts/{id}/execute'].post.responses['201'];
    expect(response.description).toBe('Per-target queue admission result');
    expect(response.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ScriptAdmissionResult',
    });

    expect(openApiSpec.components.schemas.ScriptAdmissionResult).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['requestId', 'status', 'targets'],
      properties: {
        requestId: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['queued', 'partially_queued', 'rejected'] },
        targets: {
          type: 'array',
          items: { $ref: '#/components/schemas/ScriptAdmissionTarget' },
        },
      },
    });
  });
});
