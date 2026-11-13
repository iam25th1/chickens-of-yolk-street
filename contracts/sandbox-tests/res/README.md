`coys_game_v2.wasm` is the version 2 game contract (seasons, ordinary hens minted), byte for byte
the code deployed on the game's account `play.coys-game.testnet` (and on `coys-game.testnet`, the
same code) on 12 November 2026 (code hash `HzWLn4LX75AJwbkgDfR1tnScDiZ8LazengtBZQQjqtsu`, sha256
`fc7645dc2fe83e1670db99e026b754a413af69a838a7114d28ce9452665bd2f4`, 341,943 bytes, read with the
RPC method `view_code`). The sandbox upgrade test deploys it, settles days, then deploys the current
build over it and calls `migrate_v2`.

`coys_game_v4.wasm` is version 4 (the Feathers, compact settlement), byte for byte the CI build
deployed on `play.coys-game.testnet` on 12 November 2026 (sha256
`e57cda6610e00a63f0f8f56cb65b71f3e6bb6556280343755d233fc233b3ea41`, 353,408 bytes). The version 5
test deploys it, mints three Feathers in a test season and skips two days, as happened on testnet,
then upgrades with `migrate`, burns the test Feathers and catches the days up.

`coys_game_v5.wasm` is version 5 (the live season, test Feathers burnt, late days), byte for byte
the CI build (run 43321613192) kept as `contracts/coys-game/res/coys_game.wasm` and deployed on
`play.coys-game.testnet` (sha256 `7fa2c0608b91f8f76df93789a072f086936248dec26ce7930353e7b72abbfa2d`,
388,311 bytes). The version 6 test deploys it, sets the live season, mints two Feathers in a day
close and skips two days, then upgrades with `migrate`, mints Feathers by drawn number (live and
test) and catches the days up. Since version 6 no test deploys `coys_game_v4.wasm`.
