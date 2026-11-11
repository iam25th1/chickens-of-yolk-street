// Packs iam25th1/coys-assets into the client's public asset folder.
//
// Rules: every source file is verified against its manifest SHA-256 before use; PNG, MP3 and OGG
// files are copied byte for byte (no trimming, no resampling, no re-encoding), so every packed
// binary keeps its manifest hash. Each sprite gets a PixiJS spritesheet JSON (hash format) with an
// animations list keyed by row name, per-frame durations and anchors from anim.json.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodePng, detectPixelGrid } from './png';

type Rect = [number, number, number, number];

interface AnimRow {
  name: string;
  mode: 'loop' | 'once';
  vanish: boolean;
  frameCount: number;
  totalMs: number;
  frames: { rect: Rect; ms: number }[];
}

interface AnimJson {
  tracker: string;
  label: string;
  sheet?: { file: string; width: number; height: number; sha256: string };
  traitLayer?: { file: string; width: number; height: number; sha256: string };
  cell: { w: number; h: number } | null;
  anchor: 'feet' | 'center';
  static: boolean;
  rows: AnimRow[];
}

interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  role?: string;
  sampleRate?: number;
  channels?: number;
  samples?: number;
}

interface ManifestEntry {
  tracker?: string;
  id?: string;
  doc_tracker?: string;
  doc_sound?: number;
  role: string;
  label: string;
  files: ManifestFile[];
}

interface Manifest {
  art: ManifestEntry[];
  audio: ManifestEntry[];
  unmapped: { easels: (ManifestEntry | ManifestFile)[]; uploads: (ManifestEntry | ManifestFile)[] } | (ManifestEntry | ManifestFile)[];
  traits: { path: string; sha256: string };
}

interface SoundJson {
  id: string;
  label: string;
  kind: 'one-shot' | 'loop' | 'music';
  presses: { press: number; file: string; pitch: number }[];
  takes: { file: string; sha256: string }[];
  loop?: {
    file: string;
    loopStartSample: number;
    loopEndSample: number;
    derivedFrom: { file: string; sha256: string };
    crossfadeMs: number;
  };
}

export interface SpriteIndexEntry {
  json: string;
  png: string;
  sha256: string;
  source: string;
  role: string;
  docTracker: string | null;
  label: string;
  width: number;
  height: number;
  /** Detected pixel grid of the art (8, 4 or 2), or 1 for soft art with no grid. */
  grid: number;
  anchor: 'feet' | 'center';
  static: boolean;
  rows: Record<string, { mode: 'loop' | 'once'; vanish: boolean; frameCount: number; totalMs: number }>;
}

export interface SoundIndexEntry {
  docSound: number | null;
  role: string;
  label: string;
  kind: 'one-shot' | 'loop' | 'music';
  /** Each press plays one take at a pitch; presses replay takes, so there can be more presses than takes. */
  presses: { file: string; pitch: number }[];
  files: Record<string, { sha256: string; source: string }>;
  loop: {
    file: string;
    sha256: string;
    loopStartSample: number;
    loopEndSample: number;
    sampleRate: number;
    channels: number;
    crossfadeMs: number;
  } | null;
}

export interface AssetIndex {
  version: 1;
  source: { repo: string; commit: string | null; manifestSha256: string };
  sprites: Record<string, SpriteIndexEntry>;
  sounds: Record<string, SoundIndexEntry>;
  traits: {
    stackOrder: string[];
    options: Record<string, string[]>;
    layers: Record<string, string>;
    baseFramesFrom: string;
    bodyRecolour: Record<string, [[number, number, number], [number, number, number]]>;
  };
  /** Doc tracker 19 has two machines; the grader is canonical and the sorter is packed but unused. */
  canonical: Record<string, string>;
  unused: string[];
}

export interface PackResult {
  index: AssetIndex;
  filesVerified: number;
  spritesPacked: number;
  soundsPacked: number;
  bytesCopied: number;
}

const sha256 = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');
const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** Pixel anchor of a frame: the feet (bottom centre) or the centre of the cell the frame belongs to. */
export function frameAnchor(rect: Rect, cell: { w: number; h: number }, anchor: 'feet' | 'center'): { x: number; y: number } {
  const [x, y, w, h] = rect;
  const col = Math.floor((x + w / 2) / cell.w);
  const row = Math.floor((y + h / 2) / cell.h);
  const ax = col * cell.w + cell.w / 2 - x;
  const ay = anchor === 'feet' ? (row + 1) * cell.h - y : row * cell.h + cell.h / 2 - y;
  return { x: ax / w, y: ay / h };
}

export function packAssets(opts: { assetsDir: string; outDir: string; log?: (line: string) => void }): PackResult {
  const log = opts.log ?? (() => undefined);
  const { assetsDir, outDir } = opts;
  const manifestBuf = readFileSync(join(assetsDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBuf.toString('utf8')) as Manifest;

  // 1. verify every file the manifest lists
  const hashes = new Map<string, string>();
  // Unmapped uploads are flat file records; mapped entries group their files.
  const unmapped = Array.isArray(manifest.unmapped)
    ? manifest.unmapped
    : [...manifest.unmapped.easels, ...manifest.unmapped.uploads];
  const asFiles = (e: ManifestEntry | ManifestFile): ManifestFile[] => ('files' in e ? e.files : [e as ManifestFile]);
  const listed = [...manifest.art, ...manifest.audio, ...unmapped].flatMap(asFiles);
  listed.push({ path: manifest.traits.path, sha256: manifest.traits.sha256, bytes: 0 });
  for (const f of listed) {
    const actual = sha256(readFileSync(join(assetsDir, f.path)));
    if (actual !== f.sha256) throw new Error(`SHA-256 mismatch for ${f.path}: manifest ${f.sha256}, file ${actual}`);
    hashes.set(f.path, f.sha256);
  }
  log(`verified ${listed.length} files against manifest.json`);

  rmSync(join(outDir, 'sprites'), { recursive: true, force: true });
  rmSync(join(outDir, 'audio'), { recursive: true, force: true });
  mkdirSync(join(outDir, 'sprites'), { recursive: true });

  let bytesCopied = 0;
  const copyVerified = (rel: string, dest: string): string => {
    const expected = hashes.get(rel);
    if (!expected) throw new Error(`${rel} is not listed in manifest.json`);
    const buf = readFileSync(join(assetsDir, rel));
    if (sha256(buf) !== expected) throw new Error(`SHA-256 mismatch for ${rel}`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(assetsDir, rel), dest);
    bytesCopied += buf.length;
    return expected;
  };

  // 2. sprites
  const sprites: Record<string, SpriteIndexEntry> = {};
  let henRows: AnimRow[] | null = null;
  const traitRows = new Map<string, AnimRow[]>();
  for (const entry of manifest.art) {
    if (!entry.tracker) continue;
    const folder = `art/${entry.tracker}`;
    const anim = JSON.parse(readFileSync(join(assetsDir, folder, 'anim.json'), 'utf8')) as AnimJson;
    const isTrait = entry.role === 'trait';
    const image = isTrait ? anim.traitLayer : anim.sheet;
    if (!image) throw new Error(`${entry.tracker}: anim.json has no ${isTrait ? 'traitLayer' : 'sheet'}`);
    const rel = `${folder}/${image.file}`;
    const png = `sprites/${entry.tracker}.png`;
    const pngSha = copyVerified(rel, join(outDir, png));
    const decoded = decodePng(readFileSync(join(assetsDir, rel)));
    if (decoded.width !== image.width || decoded.height !== image.height) {
      throw new Error(`${rel}: anim.json says ${image.width}x${image.height}, PNG is ${decoded.width}x${decoded.height}`);
    }
    const grid = detectPixelGrid(decoded);

    const frames: Record<string, unknown> = {};
    const animations: Record<string, string[]> = {};
    const rows: SpriteIndexEntry['rows'] = {};
    if (anim.static || anim.rows.length === 0) {
      const name = 'plate/0';
      frames[name] = {
        frame: { x: 0, y: 0, w: image.width, h: image.height },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: image.width, h: image.height },
        sourceSize: { w: image.width, h: image.height },
        anchor: { x: 0.5, y: 0.5 },
        duration: 0,
      };
      animations.plate = [name];
      rows.plate = { mode: 'loop', vanish: false, frameCount: 1, totalMs: 0 };
    } else {
      const cell = anim.cell;
      if (!cell) throw new Error(`${entry.tracker}: animated sheet without a cell size`);
      for (const row of anim.rows) {
        if (row.frames.length !== row.frameCount) throw new Error(`${entry.tracker}/${row.name}: frameCount mismatch`);
        animations[row.name] = row.frames.map((f, i) => {
          const [x, y, w, h] = f.rect;
          if (![x, y, w, h].every(Number.isInteger)) throw new Error(`${entry.tracker}/${row.name}: fractional rect`);
          if (x < 0 || y < 0 || x + w > image.width || y + h > image.height) {
            throw new Error(`${entry.tracker}/${row.name}/${i}: rect outside the sheet`);
          }
          const name = `${row.name}/${i}`;
          frames[name] = {
            frame: { x, y, w, h },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w, h },
            sourceSize: { w, h },
            anchor: frameAnchor(f.rect, cell, anim.anchor),
            duration: f.ms,
          };
          return name;
        });
        rows[row.name] = { mode: row.mode, vanish: row.vanish, frameCount: row.frameCount, totalMs: row.totalMs };
      }
      if (entry.tracker === '01-hen-anims') henRows = anim.rows;
      if (isTrait) traitRows.set(entry.tracker, anim.rows);
    }

    const json = `sprites/${entry.tracker}.json`;
    writeJson(join(outDir, json), {
      frames,
      animations,
      meta: {
        app: 'chickens-of-yolk-street/scripts/pack-assets.ts',
        version: '1',
        image: `${entry.tracker}.png`,
        format: 'RGBA8888',
        size: { w: image.width, h: image.height },
        scale: '1',
        source: { path: rel, sha256: pngSha },
        grid,
      },
    });
    sprites[entry.tracker] = {
      json,
      png,
      sha256: pngSha,
      source: rel,
      role: entry.role,
      docTracker: entry.doc_tracker ?? null,
      label: anim.label,
      width: image.width,
      height: image.height,
      grid,
      anchor: anim.anchor,
      static: anim.static,
      rows,
    };
  }
  log(`packed ${Object.keys(sprites).length} sprites`);

  // 3. trait layers must share the base hen's frames exactly, so they stack pixel-perfect
  if (!henRows) throw new Error('01-hen-anims missing');
  const henKey = JSON.stringify(henRows.map((r) => [r.name, r.frames]));
  for (const [tracker, rows] of traitRows) {
    if (JSON.stringify(rows.map((r) => [r.name, r.frames])) !== henKey) {
      throw new Error(`${tracker}: trait layer frames differ from 01-hen-anims`);
    }
  }
  log(`checked ${traitRows.size} trait layers: frame for frame with 01-hen-anims`);

  const traitsJson = JSON.parse(readFileSync(join(assetsDir, manifest.traits.path), 'utf8')) as {
    stackOrder: string[];
    options: Record<string, string[]>;
    bodyRecolour: { ramps: Record<string, [[number, number, number], [number, number, number]]> };
    sheets: { trait: string; option: string; tracker: string }[];
  };
  const layers: Record<string, string> = {};
  for (const s of traitsJson.sheets) layers[`${s.trait}:${s.option}`] = s.tracker;

  // 4. sounds
  const sounds: Record<string, SoundIndexEntry> = {};
  for (const entry of manifest.audio) {
    if (!entry.id) continue;
    const folder = `audio/${entry.id}`;
    const sound = JSON.parse(readFileSync(join(assetsDir, folder, 'sound.json'), 'utf8')) as SoundJson;
    const files: SoundIndexEntry['files'] = {};
    for (const take of sound.takes) {
      const rel = `${folder}/${take.file}`;
      files[take.file] = { sha256: copyVerified(rel, join(outDir, 'audio', entry.id, take.file)), source: rel };
    }
    let loop: SoundIndexEntry['loop'] = null;
    if (sound.loop) {
      const rel = `${folder}/${sound.loop.file}`;
      const meta = entry.files.find((f) => f.path === rel);
      if (!meta?.sampleRate || !meta.channels) throw new Error(`${rel}: manifest lacks sampleRate or channels`);
      if (sound.loop.loopEndSample > (meta.samples ?? Number.POSITIVE_INFINITY)) throw new Error(`${rel}: loop end past the end`);
      loop = {
        file: sound.loop.file,
        sha256: copyVerified(rel, join(outDir, 'audio', entry.id, sound.loop.file)),
        loopStartSample: sound.loop.loopStartSample,
        loopEndSample: sound.loop.loopEndSample,
        sampleRate: meta.sampleRate,
        channels: meta.channels,
        crossfadeMs: sound.loop.crossfadeMs,
      };
    }
    sounds[entry.id] = {
      docSound: entry.doc_sound ?? null,
      role: entry.role,
      label: sound.label,
      kind: sound.kind,
      presses: sound.presses.map((p) => ({ file: p.file, pitch: p.pitch })),
      files,
      loop,
    };
  }
  log(`packed ${Object.keys(sounds).length} sounds`);

  let commit: string | null;
  try {
    commit = execFileSync('git', ['-C', assetsDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    commit = null;
  }

  const index: AssetIndex = {
    version: 1,
    source: { repo: 'iam25th1/coys-assets', commit, manifestSha256: sha256(manifestBuf) },
    sprites,
    sounds,
    traits: {
      stackOrder: traitsJson.stackOrder,
      options: traitsJson.options,
      layers,
      baseFramesFrom: '01-hen-anims',
      bodyRecolour: traitsJson.bodyRecolour.ramps,
    },
    canonical: { '19': '19-egg-grader' },
    unused: ['19b-egg-sorter'],
  };
  writeJson(join(outDir, 'index.json'), index);
  // The manifest travels with the pack so a fresh clone can trace every packed file to its hash.
  writeFileSync(join(outDir, 'source-manifest.json'), manifestBuf);
  if (!existsSync(join(outDir, 'index.json'))) throw new Error('index.json was not written');

  return {
    index,
    filesVerified: listed.length,
    spritesPacked: Object.keys(sprites).length,
    soundsPacked: Object.keys(sounds).length,
    bytesCopied,
  };
}
