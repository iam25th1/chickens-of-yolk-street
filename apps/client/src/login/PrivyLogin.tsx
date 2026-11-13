// Privy email sign-in, loaded only when PRIVY_APP_ID is set. After sign-in the server gets the
// Privy access token (it verifies it and issues a game session), and a NEAR testnet wallet is
// created silently with Privy's extended-chains API, following docs.near.org social login.
// The player sees none of this: no wallet prompt, no chain words. The email never leaves this
// browser: the server gets only a hash of the email name (to refuse farm names that contain it).
import { PrivyProvider, useLogin, usePrivy } from '@privy-io/react-auth';
import { useCreateWallet } from '@privy-io/react-auth/extended-chains';
import { useEffect, useRef } from 'react';
import { api, nameGuardFor } from '../net/api';
import { rememberEmailName } from '../state/emailName';
import type { SignedIn } from '../screens/LoginScreen';

interface Props {
  appId: string;
  onSignedIn: (s: SignedIn) => void;
  onError: (message: string) => void;
}

function Inner({ onSignedIn, onError }: Omit<Props, 'appId'>) {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { login } = useLogin();
  const { createWallet } = useCreateWallet();
  const started = useRef(false);

  useEffect(() => {
    if (!ready || !authenticated || !user || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('Sign-in expired, try again');
        const emailName = user.email?.address?.split('@')[0] ?? '';
        // kept in memory for this visit only, so the naming screen can warn before the server refuses
        rememberEmailName(emailName);
        const session = await api.loginPrivy(token, await nameGuardFor(emailName));
        // A user may have other chains linked; pick the NEAR wallet explicitly, create it if missing.
        const existing = user.linkedAccounts.find((a) => a.type === 'wallet' && 'chainType' in a && a.chainType === 'near');
        let accountId = existing && 'address' in existing ? existing.address : null;
        if (!accountId) {
          try {
            accountId = (await createWallet({ chainType: 'near' })).wallet.address;
          } catch {
            accountId = null; // the farm works without it; linking retries next sign-in
          }
        }
        onSignedIn({ login: session, accountId });
      } catch (e) {
        started.current = false;
        onError(e instanceof Error ? e.message : 'Could not sign in');
      }
    })();
  }, [ready, authenticated, user, getAccessToken, createWallet, onSignedIn, onError]);

  return (
    <button className="btn red" disabled={!ready} onClick={() => login({ loginMethods: ['email'] })}>
      {ready ? 'CONTINUE WITH EMAIL' : 'OPENING SIGN-IN'}
    </button>
  );
}

export default function PrivyLogin({ appId, ...rest }: Props) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email'],
        appearance: { theme: 'light', accentColor: '#b8321f', landingHeader: 'Start your farm', showWalletLoginFirst: false },
      }}
    >
      <Inner {...rest} />
    </PrivyProvider>
  );
}
