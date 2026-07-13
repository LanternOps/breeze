import {
  AuthBindingRotationRequiredError,
  beginAuthIssuance,
  finishAuthIssuance,
  resolveAuthBinding,
  type AuthBindingSource,
} from '../../services/authBrowserTransition';

function freshBrowserBinding(): Extract<AuthBindingSource, { kind: 'browser' }> {
  try {
    resolveAuthBinding(undefined);
  } catch (error) {
    if (error instanceof AuthBindingRotationRequiredError && error.replacement.kind === 'browser') {
      return error.replacement;
    }
    throw error;
  }
  throw new Error('Expected a replacement browser binding');
}

/** Reproduce the completed primary-login transition that owns pending MFA. */
export async function createMfaBrowserTransitionFixture() {
  const authBinding = freshBrowserBinding();
  const capability = await beginAuthIssuance(authBinding);
  await finishAuthIssuance(capability, async () => undefined);
  return {
    authBinding,
    cookieHeader: `breeze_csrf_token=${encodeURIComponent(authBinding.value)}`,
    browserTransitionId: capability.transitionId,
    browserGeneration: capability.generation,
  };
}
