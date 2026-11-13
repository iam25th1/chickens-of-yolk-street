#!/usr/bin/env python3
"""Builds the Chickens of Yolk Street demo video from the clips capture.ts recorded.

    ~/.coys/demo/venv/bin/python scripts/demo-video/build.py \\
        [--capture ~/Documents/coys-demo/capture] [--out ~/Documents/coys-demo] [--models ~/.coys/demo/models]

Each section has its voice lines (kokoro-onnx, voice af_heart at speed 1.08, one file a line) and its
footage (scene clips, sped up at most 3x to fit the voice, the last frame held if short, never slowed).
The frame: a 1920x1080 dark brown canvas, the footage inset at 1568x882 (x 176, y 74) in a cream border
inside a dark red one, the logo top left, YOLKSTREET.25TH.DEV in the top bar, a red track chip top
right, captions below the footage (never over it). Audio: the farm-day loop under the voice, ducked by
it, game sounds at the actions the capture logged, a sting on the end card, -15 LUFS. ffmpeg here has
no drawtext or subtitles filter, so every piece of text is drawn with Pillow into overlays.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[2]
ASSETS = REPO / 'apps/client/public/assets'
FONTS = REPO / 'apps/client/public/fonts'

ap = argparse.ArgumentParser()
ap.add_argument('--capture', default=str(Path.home() / 'Documents/coys-demo/capture'))
ap.add_argument('--out', default=str(Path.home() / 'Documents/coys-demo'))
ap.add_argument('--models', default=str(Path.home() / '.coys/demo/models'))
ap.add_argument('--dry-voice', action='store_true', help='silence of an estimated length instead of the voice (to check the edit)')
args = ap.parse_args()
CAP = Path(args.capture).expanduser()
OUT = Path(args.out).expanduser()
WORK = OUT / 'work'
VOICE_DIR = WORK / 'voice'
for d in (WORK, VOICE_DIR):
    d.mkdir(parents=True, exist_ok=True)

FPS = 30
CW, CH = 1920, 1080
IX, IY, IW, IH = 176, 74, 1568, 882
BROWN = (0x1E, 0x14, 0x10)
CREAM = (0xF3, 0xE6, 0xC8)
DARK_RED = (0x7A, 0x23, 0x18)
GOLD = (0xF2, 0xC1, 0x4E)
CHIP_RED = (0xB8, 0x41, 0x2E)
SR = 48000
VOICE, SPEED = 'af_heart', 1.08
GAP = 0.6  # seconds between voice lines
LEAD = 0.5  # seconds before a section's first line
END_CARD = 4.6

# Crops (16:9, in the 1920x1080 recording) where panel text would be small.
CARD = (80, 90, 1440, 810)
LEDGER = (110, 170, 1280, 720)
ORDERS = (0, 60, 1280, 720)
TRADERS = (760, 250, 1152, 648)

# The sections in the order of the claims. Each line: its caption, what the voice says (None: the
# caption), and its footage: (scene, start, end, crop) stretches fitted to that line alone, so what is
# said is on screen while it is said.
SERV_SAY = 'Serve'
SECTIONS = [
    {'chip': 'THE GAME', 'lines': [
        ('This is Chickens of Yolk Street: a goofy pixel-art egg farm where real players and AI agents share one live market on NEAR.', None,
         [('title', 0, 6.0, None), ('wide', 0, 3.5, None)]),
    ]},
    {'chip': 'NEAR WALLET', 'lines': [
        ('Sign in with email through Privy, and a NEAR wallet is made for you, with no seed phrase. Then you name your farm.', None,
         [('name', 0, 8.0, None)]),
    ]},
    {'chip': 'THE LOOP', 'lines': [
        ("Hens lay through the day: collect the eggs, then sell the crate at today's price.", None, [('collect', 0, 10.6, None)]),
    ]},
    {'chip': 'SHARED MARKET', 'lines': [
        ("There is one shared market. Every farm's eggs are supply, so when the street floods, prices crash for everyone.", None,
         [('market', 3.0, 13.0, None)]),
        ('Buyers post orders, and you can fill one straight from your crate.', None, [('orders', 1.0, 8.7, ORDERS)]),
    ]},
    {'chip': 'AGENT ECONOMY', 'lines': [
        ('Rival farms, feed suppliers and buyers are agents, each with its own NEAR wallet, memory and personality.', None,
         [('wholesaler', 2.0, 9.0, CARD)]),
        ('They haggle on offer cards: the Wholesaler counters, the Loyalist takes your counter, and you can switch your feed to the Squeezer.', None,
         [('wholesaler', 10.5, 16.5, CARD), ('loyalist', 17.5, 22.5, CARD), ('squeezer', 5.5, 10.5, CARD)]),
        ('Agent decisions run on NEAR AI Cloud, with SERV Reasoning as the fallback, and rule-based strategies as the last resort.',
         'Agent decisions run on NEAR AI Cloud, with ' + SERV_SAY + ' Reasoning as the fallback, and rule-based strategies as the last resort.',
         [('market', 12.5, 18.1, TRADERS)]),
    ]},
    {'chip': 'REAL ECONOMY', 'lines': [
        ('New hens hatch right at the coop, from the auction or a few at a time.', None, [('auction', 7.5, 13.5, None), ('chorus', 13.0, 21.1, None)]),
        ('Machines do real work and wear down, so you buy them and keep them repaired.', None, [('machine-buy', 8.5, 12.5, None), ('repair', 1.5, 9.1, None)]),
        ('Buy land to grow the farm, then drag the view to look around it, with a small map to find your way.', None,
         [('land', 10.0, 15.0, None), ('drag', 5.0, 12.0, None)]),
        ('Run out of coins and you go bust, like these rivals.', None, [('farms', 0.5, 6.5, None)]),
    ]},
    {'chip': 'ON-CHAIN RECORD', 'lines': [
        ('Every batch of market days is settled on NEAR as a hash of the full records, and your ledger links each receipt.', None,
         [('ledger', 8.5, 17.1, LEDGER)]),
    ]},
    {'chip': 'NFTS THAT DO SOMETHING', 'lines': [
        ('Feathers are NFTs you earn at milestones, minted instantly with no gas.', None, [('mint', 4.5, 9.5, None)]),
        ('Each one is a claim on one of 777 Founding Hens, with rarities locked by a provenance hash and revealed at mainnet.', None,
         [('mint', 9.5, 14.9, None)]),
    ]},
    {'chip': 'LIVE ON TESTNET', 'lines': [
        ('Live now on NEAR testnet.', None, [('wide', 0, 5.9, None)]),
    ]},
]

# Game sounds at the actions the capture logged (file, gain).
SFX = {
    'egg': ('08-egg-pop/08-egg-pop-a.mp3', 0.55),
    'sale': ('15-kaching/15-kaching-a.mp3', 0.5),
    'coins': ('14-coins-small/14-coins-small-a.mp3', 0.55),
    'counter': ('30-stamp-thump/30-stamp-thump-a.mp3', 0.45),
    'stamp': ('18-stamp/18-stamp-a.mp3', 0.6),
    'land': ('21-build/21-build-a.mp3', 0.55),
    'buy-machine': ('21-build/21-build-a.mp3', 0.45),
    'repair': ('21-build/21-build-a.mp3', 0.45),
    'buy-hen': ('14-coins-small/14-coins-small-a.mp3', 0.45),
    'buy-hens': ('14-coins-small/14-coins-small-a.mp3', 0.45),
    'click': ('35-click/35-click-a.mp3', 0.25),
    'play': ('35-click/35-click-a.mp3', 0.3),
    'confirm': ('35-click/35-click-a.mp3', 0.3),
}
# a hatch: the egg cracks, pops, the hen clucks; three or more: the chorus
HATCH = [(1.6, '09-crack/09-crack-a.mp3', 0.5), (2.4, '08-egg-pop/08-egg-pop-b.mp3', 0.5), (2.7, '01-cluck/01-cluck-a.mp3', 0.45)]
STING = ('45-deal-closed/45-deal-closed-a.mp3', 0.7)
MUSIC = '42-farm-day/42-farm-day-a-loop.ogg'


def run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f'failed: {" ".join(cmd[:6])} ...\n{r.stderr[-1500:]}')
    return r.stderr


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    path = {'silkscreen-bold': FONTS / 'silkscreen/Silkscreen-Bold.ttf', 'pixelify': FONTS / 'pixelify-sans/PixelifySans-Variable.ttf'}[name]
    return ImageFont.truetype(str(path), size)


def check_text(s: str) -> None:
    if chr(0x2014) in s:
        raise SystemExit(f'an em dash in: {s}')


# ---- voice -------------------------------------------------------------------------------------

def voice_lines() -> dict[str, tuple[Path, float]]:
    """Each line's voice file (48 kHz mono) and its length, made once and kept by the line's hash."""
    from kokoro_onnx import Kokoro

    tts = None
    out: dict[str, tuple[Path, float]] = {}
    for sec in SECTIONS:
        for caption, say, _ in sec['lines']:
            check_text(caption)
            text = say or caption
            key = hashlib.sha256(f'{VOICE}|{SPEED}|{text}'.encode()).hexdigest()[:16]
            wav = VOICE_DIR / f'{key}.wav'
            if args.dry_voice:
                wav = VOICE_DIR / f'{key}-dry.wav'
                sf.write(wav, np.zeros(int(len(text) / 15.5 * SR), np.float32), SR)
            elif not wav.exists():
                if tts is None:
                    tts = Kokoro(str(Path(args.models).expanduser() / 'kokoro-v1.0.onnx'), str(Path(args.models).expanduser() / 'voices-v1.0.bin'))
                samples, sr = tts.create(text, voice=VOICE, speed=SPEED, lang='en-us')
                raw = VOICE_DIR / f'{key}-raw.wav'
                sf.write(raw, samples, sr)
                run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(raw), '-ar', str(SR), '-ac', '1', str(wav)])
                raw.unlink()
            data, _ = sf.read(wav)
            out[caption] = (wav, len(data) / SR)
    return out


# ---- footage -----------------------------------------------------------------------------------

def clip_info(scene: str) -> dict:
    return json.loads((CAP / scene / 'clip.json').read_text())


def segment_video(scene: str, start: float, end: float | None, crop: tuple | None, path: Path) -> float:
    """One scene's stretch as a 30 fps video at the inset size; returns its length in seconds."""
    info = clip_info(scene)
    frames = info['frames']
    end = min(end if end is not None else info['duration'], info['duration'])
    lines = ['ffconcat version 1.0']
    for i, f in enumerate(frames):
        nxt = frames[i + 1]['t'] if i + 1 < len(frames) else info['duration']
        lines.append(f"file '{CAP / scene / f['file']}'")
        lines.append(f'duration {max(0.001, nxt - f["t"]):.4f}')
    lines.append(f"file '{CAP / scene / frames[-1]['file']}'")
    lst = path.with_suffix('.txt')
    lst.write_text('\n'.join(lines))
    vf = []
    if crop:
        x, y, w, h = crop
        vf.append(f'crop={w}:{h}:{x}:{y}')
    vf += [f'scale={IW}:{IH}:flags=lanczos', f'fps={FPS}', f'trim=start={start}:end={end}', 'setpts=PTS-STARTPTS']
    run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(lst), '-vf', ','.join(vf), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', str(path)])
    return end - start


def line_footage(key: str, label: str, clips: list, length: float) -> tuple[Path, list[tuple[float, str, str]]]:
    """A line's footage fitted to its length: sped up (at most 3x), held on its last frame if short."""
    parts, total, actions = [], 0.0, []
    for j, (scene, start, end, crop) in enumerate(clips):
        p = WORK / f'{key}-{j}.mp4'
        d = segment_video(scene, start, end, crop, p)
        for a in clip_info(scene)['actions']:
            if start <= a['t'] <= start + d:
                actions.append((total + a['t'] - start, a['kind'], a['label']))
        parts.append(p)
        total += d
    speed = min(3.0, max(1.0, total / length))
    joined = WORK / f'{key}-joined.mp4'
    lst = WORK / f'{key}-joined.txt'
    lst.write_text('\n'.join(f"file '{p}'" for p in parts))
    run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', str(joined)])
    out = WORK / f'{key}.mp4'
    hold = max(0.0, length - total / speed)
    vf = f'setpts=PTS/{speed:.5f},fps={FPS},tpad=stop_mode=clone:stop_duration={hold + 0.1:.3f},trim=duration={length:.3f}'
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(joined), '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', str(out)])
    cut = max(0.0, total / speed - length)
    print(f'  {label}: footage {total:.1f} s at {speed:.2f}x into {length:.1f} s' + (f' (held {hold:.1f} s)' if hold > 0.05 else '') + (f' (CUT {cut:.1f} s)' if cut > 0.05 else ''))
    return out, [(t / speed, k, l) for t, k, l in actions if t / speed <= length]


# ---- overlays ----------------------------------------------------------------------------------

def logo_image(height: int) -> Image.Image:
    meta = json.loads((ASSETS / 'sprites/28-logo.json').read_text())
    last = list(meta['frames'].values())[-1]['frame']
    sheet = Image.open(ASSETS / 'sprites/28-logo.png').convert('RGBA')
    im = sheet.crop((last['x'], last['y'], last['x'] + last['w'], last['y'] + last['h']))
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w = round(im.width * height / im.height)
    return im.resize((w, height), Image.NEAREST)


def base_frame() -> Path:
    im = Image.new('RGB', (CW, CH), BROWN)
    d = ImageDraw.Draw(im)
    d.rectangle((IX - 12, IY - 12, IX + IW + 11, IY + IH + 11), fill=DARK_RED)
    d.rectangle((IX - 6, IY - 6, IX + IW + 5, IY + IH + 5), fill=CREAM)
    logo = logo_image(56)
    im.paste(logo, (24, (IY - 12 - 56) // 2 + 2), logo)
    f = font('silkscreen-bold', 34)
    text = 'YOLKSTREET.25TH.DEV'
    tw = d.textlength(text, font=f)
    d.text(((CW - tw) / 2, (IY - 12) / 2 - 20), text, font=f, fill=GOLD)
    p = WORK / 'base.png'
    im.save(p)
    return p


def chip_overlay(label: str, path: Path) -> None:
    check_text(label)
    im = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    f = font('silkscreen-bold', 22)
    tw = d.textlength(label, font=f)
    x1, y0, h = CW - 24, 12, 38
    d.rectangle((x1 - tw - 32, y0, x1, y0 + h), fill=CHIP_RED)
    d.text((x1 - tw - 16, y0 + 6), label, font=f, fill=CREAM)
    im.save(path)


def wrap(d: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = f'{cur} {w}'.strip()
        if d.textlength(t, font=f) <= width:
            cur = t
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def caption_overlay(text: str, path: Path) -> None:
    im = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    f = font('pixelify', 40)
    lines = wrap(d, text, f, 1720)
    if len(lines) > 2:
        raise SystemExit(f'a caption over two lines: {text}')
    top = IY + IH + 12
    room = CH - top
    lh = 46
    y = top + (room - lh * len(lines)) / 2 - 4
    for line in lines:
        tw = d.textlength(line, font=f)
        d.text(((CW - tw) / 2, y), line, font=f, fill=CREAM, stroke_width=3, stroke_fill=BROWN)
        y += lh
    im.save(path)


def end_card(path: Path) -> None:
    im = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((IX, IY, IX + IW - 1, IY + IH - 1), fill=BROWN + (236,))
    logo = logo_image(150)
    im.paste(logo, ((CW - logo.width) // 2, IY + 170), logo)
    for text, size, colour, y in [('PLAY NOW: YOLKSTREET.25TH.DEV', 50, GOLD, IY + 380), ('LIVE ON NEAR TESTNET', 34, CREAM, IY + 470), ('GAMES / AGENTS / NFTS', 30, CREAM, IY + 530)]:
        f = font('silkscreen-bold', size)
        tw = d.textlength(text, font=f)
        d.text(((CW - tw) / 2, y), text, font=f, fill=colour)
    im.save(path)


# ---- audio -------------------------------------------------------------------------------------

def load_audio(rel: str) -> np.ndarray:
    tmp = WORK / ('a-' + hashlib.sha256(rel.encode()).hexdigest()[:10] + '.wav')
    if not tmp.exists():
        run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(ASSETS / 'audio' / rel), '-ar', str(SR), '-ac', '1', str(tmp)])
    data, _ = sf.read(tmp)
    return data.astype(np.float32)


def place(track: np.ndarray, clip: np.ndarray, at: float, gain: float) -> None:
    i = int(at * SR)
    if i >= len(track):
        return
    n = min(len(clip), len(track) - i)
    track[i : i + n] += clip[:n] * gain


# ---- the build ---------------------------------------------------------------------------------

def main() -> None:
    voices = voice_lines()
    timeline, captions, chips, sfx_at = [], [], [], []
    t = 0.0
    for i, sec in enumerate(SECTIONS):
        start = t
        for li, (caption, _, clips) in enumerate(sec['lines']):
            wav, dur = voices[caption]
            lead = LEAD if li == 0 else 0.0
            tail = 0.2 if li == len(sec['lines']) - 1 else 0.0
            length = lead + dur + GAP + tail
            footage, actions = line_footage(f's{i:02d}-{li}', f'{sec["chip"]} {li + 1}', clips, length)
            timeline.append(footage)
            captions.append([t + lead, None, caption, wav])
            sfx_at += [(t + a, k) for a, k, _ in actions]
            t += length
        chips.append((start, t, sec['chip']))
    # each caption shows from its voice start until the next line starts (the last until the end)
    total = t + END_CARD
    for j, c in enumerate(captions):
        c[1] = captions[j + 1][0] if j + 1 < len(captions) else t
    print(f'length {total:.1f} s')
    if total > 140:
        raise SystemExit('over 2:20')

    # the footage, end to end, with the last frame held under the end card
    lst = WORK / 'footage.txt'
    lst.write_text('\n'.join(f"file '{p}'" for p in timeline))
    footage = WORK / 'footage.mp4'
    run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', str(lst), '-vf', f'tpad=stop_mode=clone:stop_duration={END_CARD + 0.2},fps={FPS}', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', str(footage)])

    # overlays
    base = base_frame()
    overlays = []
    for k, (a, b, label) in enumerate(chips):
        # the last section's chip stays up over the end card
        b = total + 1 if k == len(chips) - 1 else b
        p = WORK / f'chip-{k}.png'
        chip_overlay(label, p)
        overlays.append((p, a, b))
    for k, (a, b, cap, _) in enumerate(captions):
        p = WORK / f'cap-{k}.png'
        caption_overlay(cap, p)
        overlays.append((p, a, b))
    card = WORK / 'end.png'
    end_card(card)
    overlays.append((card, t, total + 1))

    # audio: voice, game sounds, the sting; the music under it, ducked by the voice
    n = int((total + 0.5) * SR)
    voice = np.zeros(n, np.float32)
    effects = np.zeros(n, np.float32)
    for a, _, _, wav in captions:
        data, _ = sf.read(wav)
        place(voice, data.astype(np.float32), a, 1.0)
    for at, kind in sfx_at:
        if kind in ('hatch', 'hatch3'):
            for dt, rel, g in HATCH:
                place(effects, load_audio(rel), at + dt, g)
            if kind == 'hatch3':
                place(effects, load_audio('07-chorus/07-chorus-a.mp3'), at + 3.2, 0.45)
        elif kind in SFX:
            rel, g = SFX[kind]
            place(effects, load_audio(rel), at, g)
    place(effects, load_audio(STING[0]), t + 0.15, STING[1])
    loop = load_audio(MUSIC)
    music = np.tile(loop, int(np.ceil(n / len(loop))) + 1)[:n] * 0.32
    fade_in, fade_out = int(1.2 * SR), int(2.5 * SR)
    music[:fade_in] *= np.linspace(0, 1, fade_in)
    music[n - fade_out :] *= np.linspace(1, 0, fade_out)
    for name, arr in (('voice', voice), ('effects', effects), ('music', music)):
        sf.write(WORK / f'{name}.wav', arr, SR)
    mix = WORK / 'mix.wav'
    graph = (
        '[2:a][0:a]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[ducked];'
        '[0:a][1:a][ducked]amix=inputs=3:normalize=0:duration=longest[m]'
    )
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(WORK / 'voice.wav'), '-i', str(WORK / 'effects.wav'), '-i', str(WORK / 'music.wav'), '-filter_complex', graph, '-map', '[m]', '-ar', str(SR), str(mix)])
    # loudness: two passes to -15 LUFS integrated, -1.5 dB true peak
    measure = run(['ffmpeg', '-i', str(mix), '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'])
    m = json.loads(measure[measure.rindex('{') : measure.rindex('}') + 1])
    norm = WORK / 'mix-norm.wav'
    run([
        'ffmpeg', '-y', '-loglevel', 'error', '-i', str(mix), '-af',
        f"loudnorm=I=-15:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true",
        '-ar', str(SR), '-ac', '2', str(norm),
    ])

    # the frame, the footage, the overlays and the audio into one file
    out = OUT / 'coys-demo-auto.mp4'
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-framerate', str(FPS), '-t', f'{total:.3f}', '-i', str(base), '-i', str(footage)]
    for p, _, _ in overlays:
        cmd += ['-loop', '1', '-framerate', str(FPS), '-t', f'{total:.3f}', '-i', str(p)]
    cmd += ['-i', str(norm)]
    parts = [f'[0:v][1:v]overlay={IX}:{IY}:shortest=1[v0]']
    for k, (_, a, b) in enumerate(overlays):
        parts.append(f"[v{k}][{k + 2}:v]overlay=0:0:enable='between(t,{a:.3f},{b:.3f})'[v{k + 1}]")
    # the frames came as JPEGs (full range): the file is ordinary yuv420p, TV range
    parts.append(f'[v{len(overlays)}]scale=in_range=pc:out_range=tv,format=yuv420p[vout]')
    cmd += [
        '-filter_complex', ';'.join(parts), '-map', '[vout]', '-map', f'{len(overlays) + 2}:a',
        '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-r', str(FPS),
        '-c:a', 'aac', '-b:a', '192k', '-ar', str(SR), '-t', f'{total:.3f}', '-movflags', '+faststart', str(out),
    ]
    run(cmd)

    # subtitles
    def ts(x: float) -> str:
        ms = int(round(x * 1000))
        return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'

    srt = []
    for k, (a, b, cap, _) in enumerate(captions, 1):
        srt.append(f'{k}\n{ts(a)} --> {ts(b)}\n{cap}\n')
    (OUT / 'coys-demo-auto.srt').write_text('\n'.join(srt))

    # one frame a second, for checking
    sheet = OUT / 'auto-contact.png'
    cols = 10
    rows = int(np.ceil(total / cols))
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(out), '-vf', f'fps=1,scale=384:-1,tile={cols}x{rows}', '-frames:v', '1', str(sheet)])

    log = {'length': total, 'sections': [{'chip': c, 'start': round(a, 2), 'end': round(b, 2)} for a, b, c in chips], 'captions': [{'start': round(a, 2), 'end': round(b, 2), 'text': c} for a, b, c, _ in captions]}
    (OUT / 'coys-demo-auto.json').write_text(json.dumps(log, indent=1))
    print(json.dumps(log['sections']))


if __name__ == '__main__':
    main()
