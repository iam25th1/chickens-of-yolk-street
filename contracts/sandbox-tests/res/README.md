`coys_game_v2.wasm` is the version 2 game contract (seasons, ordinary hens minted), byte for byte
the code deployed on the game's account `play.coys-game.testnet` (and on `coys-game.testnet`, the
same code) on 12 November 2026 (code hash `HzWLn4LX75AJwbkgDfR1tnScDiZ8LazengtBZQQjqtsu`, sha256
`fc7645dc2fe83e1670db99e026b754a413af69a838a7114d28ce9452665bd2f4`, 341,943 bytes, read with the
RPC method `view_code`). The sandbox upgrade test deploys it, settles days with ordinary hens,
then deploys the current build over it and calls `migrate`.
