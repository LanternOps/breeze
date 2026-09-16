export class TopologyOperationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 503,
    message: string = code,
  ) {
    super(message);
    this.name = 'TopologyOperationError';
  }
}
