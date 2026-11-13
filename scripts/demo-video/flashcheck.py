#!/usr/bin/env python3
"""Checks a video for flashes, after WCAG 2.x's general flash threshold.

    python scripts/demo-video/flashcheck.py <video.mp4>     (exit 0: passes; 1: fails, with the timestamps)

- General flash: no more than 3 flashes in any 1 second. A flash is a pair of opposing changes in
  relative luminance of 10 percent or more of the maximum (0.1 on a 0 to 1 scale), where the darker
  state is below 0.80, over a large part of the frame. The large parts checked: the whole frame, the
  footage inset and each quarter of the inset (each is well over a quarter of the central field of view).
- A single frame whose mean luminance jumps more than 20 percent against both its neighbours (the
  same way) is flagged too: a one-frame flash.

Relative luminance per pixel is WCAG's: sRGB to linear, then 0.2126 R + 0.7152 G + 0.0722 B.
"""
from __future__ import annotations

import subprocess
import sys

import numpy as np

W, H = 192, 108  # decoded small: a region's mean is what counts
FPS = 30
# the footage inset of the 1920x1080 frame (x 176 to 1744, y 74 to 956), in the small frame
IX0, IX1, IY0, IY1 = round(176 / 10), round(1744 / 10), round(74 / 10), round(956 / 10)


def luminance_frames(path: str) -> np.ndarray:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', f'fps={FPS},scale={W}:{H}:flags=area,format=rgb24', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    rgb = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3).astype(np.float32) / 255.0
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722


def regions(lum: np.ndarray) -> dict[str, np.ndarray]:
    inset = lum[:, IY0:IY1, IX0:IX1]
    h, w = inset.shape[1] // 2, inset.shape[2] // 2
    out = {'frame': lum.mean(axis=(1, 2)), 'footage': inset.mean(axis=(1, 2))}
    for name, (y, x) in {'top left': (0, 0), 'top right': (0, 1), 'bottom left': (1, 0), 'bottom right': (1, 1)}.items():
        out[f'footage {name}'] = inset[:, y * h : (y + 1) * h, x * w : (x + 1) * w].mean(axis=(1, 2))
    return out


def transitions(series: np.ndarray, th: float = 0.1) -> list[int]:
    """Frame indices where a change of th or more between turning points completes, the darker side under 0.8."""
    out: list[int] = []
    trend = 0
    lo = hi = ext = float(series[0])
    for i in range(1, len(series)):
        v = float(series[i])
        if trend == 0:
            lo, hi = min(lo, v), max(hi, v)
            if v - lo >= th:
                trend, ext = 1, v
                if lo < 0.8:
                    out.append(i)
            elif hi - v >= th:
                trend, ext = -1, v
                if v < 0.8:
                    out.append(i)
        elif trend == 1:
            if v > ext:
                ext = v
            elif ext - v >= th:
                if v < 0.8:
                    out.append(i)
                trend, ext = -1, v
        else:
            if v < ext:
                ext = v
            elif v - ext >= th:
                if ext < 0.8:
                    out.append(i)
                trend, ext = 1, v
    return out


def check(path: str) -> list[str]:
    lum = luminance_frames(path)
    problems: list[str] = []
    for name, series in regions(lum).items():
        ev = transitions(series)
        # a flash is a pair of opposing changes: more than 3 flashes is more than 6 changes in any 1 second
        for k in range(len(ev)):
            window = [e for e in ev[k:] if e - ev[k] < FPS]
            if len(window) > 6:
                problems.append(f'{ev[k] / FPS:7.2f}s  {len(window)} changes in 1 s, {len(window) // 2} flashes ({name})')
    # one-frame jumps of more than 20 percent against both neighbours (the footage, and the whole frame)
    for name in ('footage', 'frame'):
        s = regions(lum)[name]
        for i in range(1, len(s) - 1):
            a, b, c = s[i - 1], s[i], s[i + 1]
            ja, jc = (b - a) / max(a, b, 1e-6), (b - c) / max(b, c, 1e-6)
            if abs(ja) > 0.2 and abs(jc) > 0.2 and np.sign(ja) == np.sign(jc):
                problems.append(f'{i / FPS:7.2f}s  one frame {abs(ja) * 100:.0f}% {"brighter" if ja > 0 else "darker"} than both neighbours ({name})')
    # one line per moment, in time order
    seen, out = set(), []
    for p in sorted(problems, key=lambda x: float(x.split('s')[0])):
        key = p.split('s')[0].strip()
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


if __name__ == '__main__':
    found = check(sys.argv[1])
    if found:
        print(f'flash check FAILED: {len(found)} moments')
        for p in found:
            print('  ' + p)
        sys.exit(1)
    print('flash check passed: no more than 3 flashes in any second, no one-frame jumps over 20 percent')
