// Web Audio engine. One-shots play the packed MP3 takes, with a random press (take and pitch) and
// random pitch and volume variation on every play. The 12 loops play the gapless OGGs with their
// sample-exact loop points (converted to seconds, so they survive resampling to the device rate).
import { ASSET_BASE, type AssetIndex } from '../assets/catalog';

export interface LoopHandle {
  stop(fadeMs?: number): void;
  setVolume(v: number, rampMs?: number): void;
}

interface Decoded {
  buffer: AudioBuffer;
  loopStart: number;
  loopEnd: number;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly musicBus: GainNode;
  private readonly sfxBus: GainNode;
  private readonly takes = new Map<string, AudioBuffer>();
  private readonly loops = new Map<string, Decoded>();
  private music: { id: string; handle: LoopHandle } | null = null;
  private lastPlay = new Map<string, number>();

  constructor(private readonly index: AssetIndex) {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.ctx.destination);
  }

  /** Browsers start audio suspended until a user gesture. */
  unlock(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get unlocked(): boolean {
    return this.ctx.state === 'running';
  }

  setVolumes(music: number, sfx: number): void {
    const t = this.ctx.currentTime;
    this.musicBus.gain.setTargetAtTime(music * music, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(sfx * sfx, t, 0.05);
  }

  private async decode(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  }

  async load(ids: string[], onEach: () => void = () => undefined): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const s = this.index.sounds[id];
        if (!s) throw new Error(`unknown sound ${id}`);
        if (s.loop && !this.loops.has(id)) {
          try {
            const buffer = await this.decode(`${ASSET_BASE}audio/${id}/${s.loop.file}`);
            this.loops.set(id, {
              buffer,
              loopStart: s.loop.loopStartSample / s.loop.sampleRate,
              loopEnd: s.loop.loopEndSample / s.loop.sampleRate,
            });
          } catch {
            // No OGG Vorbis decoder (older Safari): loop the MP3 take end to end instead.
            const first = s.presses[0]?.file;
            if (first) {
              const buffer = await this.decode(`${ASSET_BASE}audio/${id}/${first}`);
              this.loops.set(id, { buffer, loopStart: 0, loopEnd: buffer.duration });
            }
          }
        } else if (!s.loop) {
          for (const file of Object.keys(s.files)) {
            const key = `${id}/${file}`;
            if (!this.takes.has(key)) this.takes.set(key, await this.decode(`${ASSET_BASE}audio/${key}`));
          }
        }
        onEach();
      }),
    );
  }

  /** One-shot with a random press, plus pitch and volume variation. */
  play(id: string, opts: { volume?: number; pitch?: number; delayMs?: number; minGapMs?: number } = {}): void {
    if (!this.unlocked) return;
    const s = this.index.sounds[id];
    if (!s || s.presses.length === 0) return;
    const now = performance.now();
    if (opts.minGapMs && now - (this.lastPlay.get(id) ?? 0) < opts.minGapMs) return;
    this.lastPlay.set(id, now);
    const press = s.presses[Math.floor(Math.random() * s.presses.length)];
    const buffer = press && this.takes.get(`${id}/${press.file}`);
    if (!press || !buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = press.pitch * (opts.pitch ?? 1) * (0.94 + Math.random() * 0.12);
    const gain = this.ctx.createGain();
    gain.gain.value = (opts.volume ?? 1) * (0.82 + Math.random() * 0.18);
    src.connect(gain).connect(this.sfxBus);
    src.start(this.ctx.currentTime + (opts.delayMs ?? 0) / 1000);
  }

  /** Gapless loop on the music or effects bus. */
  loop(id: string, opts: { bus?: 'music' | 'sfx'; volume?: number; fadeMs?: number } = {}): LoopHandle | null {
    const d = this.loops.get(id);
    if (!d) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = d.buffer;
    src.loop = true;
    src.loopStart = d.loopStart;
    src.loopEnd = d.loopEnd;
    const gain = this.ctx.createGain();
    const target = opts.volume ?? 1;
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(opts.fadeMs ? 0 : target, t);
    if (opts.fadeMs) gain.gain.linearRampToValueAtTime(target, t + opts.fadeMs / 1000);
    src.connect(gain).connect(opts.bus === 'music' ? this.musicBus : this.sfxBus);
    src.start(t, d.loopStart);
    let stopped = false;
    return {
      stop: (fadeMs = 400) => {
        if (stopped) return;
        stopped = true;
        const now = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
        src.stop(now + fadeMs / 1000 + 0.05);
      },
      setVolume: (v, rampMs = 300) => {
        const now = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(v, now + rampMs / 1000);
      },
    };
  }

  /** Crossfades to a music loop; null fades the music out. */
  playMusic(id: string | null, fadeMs = 800): void {
    if (this.music?.id === id) return;
    this.music?.handle.stop(fadeMs);
    this.music = null;
    if (!id || !this.unlocked) return;
    const handle = this.loop(id, { bus: 'music', volume: 0.7, fadeMs });
    if (handle) this.music = { id, handle };
  }

  get musicId(): string | null {
    return this.music?.id ?? null;
  }
}
