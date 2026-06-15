/**
 * Entra ID access-token acquisition (spec §3):
 *   1. Office SSO — OfficeRuntime.auth.getAccessToken({ allowSignInPrompt: false }).
 *      Works when the MSP centrally deployed the add-in and pre-authorized the
 *      Office client app (Task 2 prerequisite d). Silent, no UI ever.
 *   2. MSAL popup fallback — first-run consent / sideload / SSO error path.
 *      Popups must originate from a user gesture, so the silent boot path
 *      (App.tsx) uses getEntraTokenSilent and only the sign-in button uses
 *      getEntraTokenInteractive.
 * D4: swapping the fallback to NAA (createNestablePublicClientApplication)
 * later only touches this file.
 */
import { getEntraClientId } from '../config';

export type EntraTokenDeps = {
  getSsoToken: () => Promise<string>;
  getMsalToken: () => Promise<string>;
};

/** Scope on the add-in's own app registration (matches the manifest's WebApplicationInfo Resource). */
export function msalScopes(): string[] {
  return [`api://${window.location.host}/${getEntraClientId()}/access_as_user`];
}

async function officeSsoToken(): Promise<string> {
  const officeRuntime = (
    globalThis as {
      OfficeRuntime?: { auth?: { getAccessToken?: (opts: object) => Promise<string> } };
    }
  ).OfficeRuntime;
  if (!officeRuntime?.auth?.getAccessToken) throw new Error('Office SSO unavailable');
  return officeRuntime.auth.getAccessToken({ allowSignInPrompt: false });
}

let msalInstancePromise: Promise<
  import('@azure/msal-browser').PublicClientApplication
> | null = null;

function getMsalInstance() {
  if (!msalInstancePromise) {
    msalInstancePromise = (async () => {
      const { PublicClientApplication } = await import('@azure/msal-browser');
      const pca = new PublicClientApplication({
        auth: {
          clientId: getEntraClientId(),
          authority: 'https://login.microsoftonline.com/organizations',
          redirectUri: `${window.location.origin}/taskpane.html`,
        },
        cache: { cacheLocation: 'sessionStorage' },
      });
      await pca.initialize();
      return pca;
    })();
  }
  return msalInstancePromise;
}

async function msalPopupToken(): Promise<string> {
  const pca = await getMsalInstance();
  const scopes = msalScopes();
  const account = pca.getAllAccounts()[0];
  if (account) {
    try {
      const silent = await pca.acquireTokenSilent({ scopes, account });
      return silent.accessToken;
    } catch {
      /* fall through to the popup */
    }
  }
  const popup = await pca.acquireTokenPopup({ scopes });
  return popup.accessToken;
}

export const defaultEntraTokenDeps: EntraTokenDeps = {
  getSsoToken: officeSsoToken,
  getMsalToken: msalPopupToken,
};

/** Silent only — never opens UI. Throws when Office SSO is unavailable or fails. */
export async function getEntraTokenSilent(
  deps: EntraTokenDeps = defaultEntraTokenDeps,
): Promise<string> {
  return deps.getSsoToken();
}

/** Full chain: silent Office SSO, then MSAL popup. Call from a user gesture. */
export async function getEntraTokenInteractive(
  deps: EntraTokenDeps = defaultEntraTokenDeps,
): Promise<string> {
  try {
    return await deps.getSsoToken();
  } catch {
    return deps.getMsalToken();
  }
}
