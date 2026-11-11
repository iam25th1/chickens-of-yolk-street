`coys_game_v1.wasm` is the version 1 game contract (days without seasons), byte for byte the build
deployed to `coys-game.testnet` on 11 November 2026 (sha256
`df6fe36d8a31357a5fc18a9b4857fffc6a5372eac0a0c9e3a107b7d330ee1d00`, from CI run 43058947236). The
sandbox upgrade test deploys it, settles days, then deploys the current build over it and calls
`migrate`.
