/** A header talk action failed before it could prepare the composer. */
export class WispTalkError extends Error {
  readonly status?: number;
  readonly alreadyToasted: boolean;

  constructor(
    readonly code: 'session_create_failed' | 'focus_failed' | 'pin_failed',
    serverMessage: string,
    options: { status?: number; alreadyToasted?: boolean } = {},
  ) {
    super(serverMessage);
    this.name = 'WispTalkError';
    this.status = options.status;
    this.alreadyToasted = options.alreadyToasted ?? false;
  }
}
