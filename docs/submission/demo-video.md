# The demo video, made from the game itself

`coys-demo-auto.mp4` is recorded from the game, with no footage from anyone's screen. Playwright plays a
**local copy** of the game (its own port and its own copy of the database, with no chain writes and no
model calls), and a build script cuts, voices, frames and mixes it. Nothing touches the live site or
the live database. No video, audio or model file is kept in the repo.

## What it needs

- Node 24 and the repo's dependencies (`npm ci --ignore-scripts`), Postgres 16 on this machine, and
  ffmpeg (any build; the build script draws every piece of text itself with Pillow).
- Python 3 with a venv **outside the repo**: `python3 -m venv ~/.coys/demo/venv` then
  `~/.coys/demo/venv/bin/pip install kokoro-onnx soundfile pillow numpy`.
- The kokoro model files from its GitHub release (`model-files-v1.0`): `kokoro-v1.0.onnx` and
  `voices-v1.0.bin`, in `~/.coys/demo/models`.

## Steps

1. **A fresh copy of the database.** Back up the live database (`npx tsx scripts/db-backup.ts --out
   ~/.coys/demo/backups`, which only reads), then restore it into a new local database whose name
   contains `demo`: `createdb coys_demo` and `pg_restore --no-owner --no-privileges -d coys_demo
   <dump>`. Every script below refuses a database whose name does not contain `demo`.
2. **Seed the demo farms**: `DATABASE_URL=postgres://$USER@127.0.0.1:5432/coys_demo npx tsx
   scripts/demo-video/seed.ts`. Through the game's own actions only, the copy's player farm with the
   most hens (it has real history, so its ledger shows real testnet receipts) is renamed Golden Yolk
   Acres in the copy, its coops are filled with hens bought in the shop, the east field is bought, the
   crate is sold and the trough filled. The name Clucky Ranch is freed for the fresh farm.
3. **Warm up**: `npx tsx scripts/demo-video/warm.ts` runs the local server with 30 second days (agents
   on their rule strategies) until the late farm has today's cards from the Loyalist, the Squeezer, the
   Wholesaler and the bakery, or ten days have passed, so the ledger's last 30 days still hold the
   real receipts, a batched range among them.
4. **Build the game**: `npm run build`.
5. **Record**: `npx tsx scripts/demo-video/capture.ts` records every scene into
   `~/Documents/coys-demo/capture/<scene>/` (frames and `clip.json`, the log of each key action); then
   `npx tsx scripts/demo-video/capture.ts --only haggle --day-seconds 400` records the haggles with a
   longer local day, so the day's cards have all arrived and do not expire in the middle.
6. **Build the video**: `~/.coys/demo/venv/bin/python scripts/demo-video/build.py` writes
   `~/Documents/coys-demo/coys-demo-auto.mp4`, `coys-demo-auto.srt`, `auto-contact.png` (one frame a
   second) and `coys-demo-auto.json` (the sections and captions with their times).

## The local server

`scripts/demo-video/local.ts` starts the built server with a clean environment: no NEAR keys (each day
settles as a no-op, recorded locally), no model keys (the agents run on their rule strategies and no
credits are spent), `HOST=127.0.0.1` and `DEMO_MODE=1`. Together those turn on the **demo session**:
`/?demo=new` or `/?demo=<farm name>` signs straight into a farm from the title's PLAY, so no sign-in
screen is ever recorded. The server refuses it in production whatever else is set, on any address
other than loopback, and for any request from another machine (`apps/server/test/demo-session.test.ts`).
The script checks the server reports the demo session on and the chain off before it records.

## Capture

Chromium through Playwright at 1920x1080 and device scale 1, a fresh profile that is never signed in,
no browser bar. Frames come from Chrome's own screencast (each as a JPEG at quality 95 with its
timestamp), which is sharper than Playwright's video recording, and the build turns them into 30 fps.
The game's pixel cursor is mirrored into the page (a headless browser draws none), and it moves at
about human speed.

## Edit

1:40 to 2:10. Each section's footage is sped up at most 3x to fit its voice, and its last frame is held
if it is short; it is never slowed down. The voice is kokoro-onnx, voice `af_heart` at speed 1.08, one
file a line, saying "Serve" for SERV. The frame, the track chips, the captions (below the footage,
never over it), the end card, the music ducked under the voice, the game's sounds at the logged
actions and the sting on the end card are all in `build.py`, with the loudness at -15 LUFS and the
true peak at -1.5 dB.
