import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, post } from './api.ts';

export const passkeysSupported = () => browserSupportsWebAuthn();

/** Registers a passkey after a valid setup or recovery code; leaves the browser signed in. */
export async function registerPasskey(context: string): Promise<void> {
  const options = await api(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`);
  const response = await startRegistration({ optionsJSON: options });
  await post('/api/auth/passkey/verify-registration', { response, createSession: true });
}

/**
 * Signs in with a passkey. On the login page of an authorization request the signed query goes
 * along, and the server answers with where the authorization continues.
 */
export async function signInWithPasskey(oauthQuery?: string): Promise<{ url?: string }> {
  const options = await api('/api/auth/passkey/generate-authenticate-options');
  const response = await startAuthentication({ optionsJSON: options });
  const out = await post<{ url?: string; redirect?: boolean } | null>('/api/auth/passkey/verify-authentication', oauthQuery ? { response, oauth_query: oauthQuery } : { response });
  return { url: out?.url };
}

export async function signOut(): Promise<void> {
  await post('/api/auth/sign-out', {});
}
