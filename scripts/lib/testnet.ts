// Guards shared by the testnet scripts: they refuse anything that could reach mainnet before a key
// is touched.

/** Throws for anything that is not a testnet account id (a .testnet name or a 64-hex implicit id). */
export function assertTestnetId(id: string): void {
  if (/(^|\.)near$/.test(id)) throw new Error(`refusing mainnet account ${id}`);
  if (!/^[0-9a-f]{64}$/.test(id) && !/^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*\.testnet$/.test(id)) {
    throw new Error(`refusing ${id}: not a .testnet account`);
  }
}

/** Throws unless the RPC URL is a testnet endpoint. */
export function assertTestnetRpc(url: string): void {
  if (!/test/i.test(new URL(url).hostname)) throw new Error(`refusing RPC ${url}: not a testnet endpoint`);
}
