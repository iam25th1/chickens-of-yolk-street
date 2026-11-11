// Version and commit of this build, for /healthz. build.mjs defines __COYS_BUILD__ when it bundles the
// server; running from source (tsx) reports a dev build.
declare const __COYS_BUILD__: { version: string; commit: string | null } | undefined;

export const BUILD: { version: string; commit: string | null } = typeof __COYS_BUILD__ !== 'undefined' ? __COYS_BUILD__ : { version: 'dev', commit: null };
