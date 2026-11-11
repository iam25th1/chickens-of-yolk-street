// Web Audio engine. One-shots play the packed MP3 takes, with a random press (take and pitch) and
// random pitch and volume variation on every play. Ambience and machine loops play the gapless OGGs
// with their sample-exact loop points. Music is never downloaded up front: it streams through a media
// element once the player has touched the page, so the first screens do not wait for megabytes.
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
  private music: { id: string; el: HTMLAudioElement; gain: GainNode } | null = null;
  private wantedMusic: { id: string; fadeMs: number } | null = null;
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
    const start = () => {
      const w = this.wantedMusic;
      if (w && !this.music) this.playMusic(w.id, w.fadeMs);
    };
    if (this.ctx.state === 'suspended') void this.ctx.resume().then(start);
    else start();
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
        if (s.kind === 'music') return onEach();
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

  /** Crossfades to a streamed music track; null fades the music out. Waits for the first gesture. */
  playMusic(id: string | null, fadeMs = 800): void {
    this.wantedMusic = id ? { id, fadeMs } : null;
    if (this.music?.id === id) return;
    const old = this.music;
    this.music = null;
    if (old) {
      const now = this.ctx.currentTime;
      old.gain.gain.cancelScheduledValues(now);
      old.gain.gain.setValueAtTime(old.gain.gain.value, now);
      old.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
      setTimeout(() => {
        old.el.pause();
        old.el.removeAttribute('src');
        old.el.load();
      }, fadeMs + 50);
    }
    const s = id ? this.index.sounds[id] : null;
    if (!id || !s || !this.unlocked) return;
    const el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    const ogg = s.loop && el.canPlayType('audio/ogg; codecs="vorbis"') !== '';
    const file = ogg && s.loop ? s.loop.file : s.presses[0]?.file;
    if (!file) return;
    el.src = `${ASSET_BASE}audio/${id}/${file}`;
    const gain = this.ctx.createGain();
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.7, t + fadeMs / 1000);
    this.ctx.createMediaElementSource(el).connect(gain).connect(this.musicBus);
    void el.play().catch(() => undefined);
    this.music = { id, el, gain };
  }

  get musicId(): string | null {
    return this.music?.id ?? null;
  }
}
