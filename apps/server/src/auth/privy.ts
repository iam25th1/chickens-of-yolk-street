// Verifies Privy access tokens (ES256 JWTs; iss privy.io, aud = app id, sub = the user's Privy DID).
// Uses the dashboard verification key when PRIVY_VERIFICATION_KEY is set, otherwise the app's JWKS.
// No Privy app secret is needed or held by this server.
import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface PrivyVerifier {
  verify(accessToken: string): Promise<{ did: string }>;
}

export function createPrivyVerifier(appId: string, verificationKey?: string): PrivyVerifier {
  let keyPromise: Promise<CryptoKey | JWTVerifyGetKey> | null = null;
  const key = (): Promise<CryptoKey | JWTVerifyGetKey> => {
    keyPromise ??= verificationKey
      ? importSPKI(verificationKey.replace(/\\n/g, '\n'), 'ES256')
      : Promise.resolve(createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`)));
    return keyPromise;
  };
  return {
    async verify(accessToken) {
      const k = await key();
      const options = { issuer: 'privy.io', audience: appId, algorithms: ['ES256'] };
      const { payload } = typeof k === 'function' ? await jwtVerify(accessToken, k, options) : await jwtVerify(accessToken, k, options);
      if (typeof payload.sub !== 'string' || !payload.sub.startsWith('did:privy:')) throw new Error('token has no Privy user id');
      return { did: payload.sub };
    },
  };
}
