export class AudioManager {
  private ctx: AudioContext | null = null;
  public isMuted: boolean = false;

  // ── SFX debounce ──────────────────────────────────────────────────────────
  // Rapid-fire events (area attacks, multi-token moves, macro bursts) used to
  // stack identical cues into a harsh click wall. Each cue name is throttled
  // to one sound per SFX_DEBOUNCE_MS window; extra triggers within the window
  // are dropped, not queued — the ear reads one solid hit, not a machine gun.
  private static readonly SFX_DEBOUNCE_MS = 60;
  private lastPlayedAt: Record<string, number> = {};

  // INVARIANT: every one-shot SFX method in this class MUST gate on
  // shouldPlay('<method-name>') before touching the AudioContext. A new cue
  // added without the gate reintroduces the click-wall under burst load.

  private shouldPlay(cue: string): boolean {
    const now = performance.now();
    const last = this.lastPlayedAt[cue] ?? -Infinity;
    if (now - last < AudioManager.SFX_DEBOUNCE_MS) return false;
    this.lastPlayedAt[cue] = now;
    return true;
  }

  private init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public playDiceRoll() {
    if (this.isMuted) return;
    if (!this.shouldPlay('playDiceRoll')) return;  // debounce rapid duplicate triggers
    this.init();
    if (!this.ctx) return;

    // Polyhedral clatter: rapid sequence of filtered micro clicks & frequency drops
    const now = this.ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(450 - i * 60 + Math.random() * 80, now + i * 0.06);
      osc.frequency.exponentialRampToValueAtTime(120, now + i * 0.06 + 0.05);

      gain.gain.setValueAtTime(0.25, now + i * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.06 + 0.05);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now + i * 0.06);
      osc.stop(now + i * 0.06 + 0.05);
    }
  }

  public playWeaponImpact() {
    if (this.isMuted) return;
    if (!this.shouldPlay('playWeaponImpact')) return;  // debounce rapid duplicate triggers
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.18);

    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.18);
  }

  public playSpellCast() {
    if (this.isMuted) return;
    if (!this.shouldPlay('playSpellCast')) return;  // debounce rapid duplicate triggers
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(320, now);
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.35);

    osc2.frequency.setValueAtTime(480, now);
    osc2.frequency.exponentialRampToValueAtTime(1320, now + 0.35);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.35);
    osc2.stop(now + 0.35);
  }

  public playTurnAdvance() {
    if (this.isMuted) return;
    if (!this.shouldPlay('playTurnAdvance')) return;  // debounce rapid duplicate triggers
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.setValueAtTime(880, now + 0.08); // A5

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.28);
  }

  // ── Ambient soundscape engine ─────────────────────────────────────────────
  // Synthesised looping ambience so the Soundscape Jukebox's play state is
  // real, not decorative. Each preset shapes a shared noise buffer through a
  // per-track filter (+ optional drone), keeping CPU cost negligible.

  private ambientNoiseBuffer: AudioBuffer | null = null;
  private ambientNodes: Array<AudioBufferSourceNode | OscillatorNode> = [];
  private ambientGain: GainNode | null = null;
  private ambientTrackId: string | null = null;
  private ambientVolume: number = 0.5;

  /** Per-preset synthesis recipe: filter shape + optional drone oscillator. */
  private static readonly AMBIENCE_RECIPES: Record<
    string,
    { filterType: BiquadFilterType; freq: number; q: number; gain: number; droneHz?: number }
  > = {
    // Hearthfire crackle: warm low-passed noise
    tavern: { filterType: 'lowpass', freq: 700, q: 0.8, gain: 0.55 },
    // Rain on pines: bright band-passed hiss
    storm: { filterType: 'bandpass', freq: 2400, q: 0.5, gain: 0.4 },
    // Crypt: faint high reverb-y whisper noise + deep drone
    crypt: { filterType: 'highpass', freq: 3000, q: 0.7, gain: 0.18, droneHz: 52 },
    // Boss clash: ominous low drone + rumble
    boss: { filterType: 'lowpass', freq: 300, q: 1.0, gain: 0.5, droneHz: 65 },
  };

  /** Build one shared 2-second stereo noise buffer (cheap, looped). */
  private getNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    if (this.ambientNoiseBuffer) return this.ambientNoiseBuffer;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      // Pink-ish noise: average successive white samples to tame harshness.
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.04 * white) / 1.04;
        data[i] = last * 3.5;
      }
    }
    this.ambientNoiseBuffer = buf;
    return buf;
  }

  /**
   * Start (or switch) the looping ambience for a jukebox preset.
   * Safe to call repeatedly: switching tracks crossfades by stopping the old
   * nodes immediately and starting the new recipe at the current volume.
   */
  public startAmbience(trackId: string, volume?: number) {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    const recipe = AudioManager.AMBIENCE_RECIPES[trackId] ?? AudioManager.AMBIENCE_RECIPES.tavern;
    if (volume !== undefined) this.ambientVolume = volume;

    this.stopAmbience();
    this.ambientTrackId = trackId;
    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.setValueAtTime(this.ambientVolume * recipe.gain, this.ctx.currentTime);
    this.ambientGain.connect(this.ctx.destination);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.getNoiseBuffer();
    noise.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = recipe.filterType;
    filter.frequency.setValueAtTime(recipe.freq, this.ctx.currentTime);
    filter.Q.setValueAtTime(recipe.q, this.ctx.currentTime);
    noise.connect(filter);
    filter.connect(this.ambientGain);
    noise.start();
    this.ambientNodes.push(noise);

    if (recipe.droneHz) {
      const drone = this.ctx.createOscillator();
      drone.type = 'sine';
      drone.frequency.setValueAtTime(recipe.droneHz, this.ctx.currentTime);
      const droneGain = this.ctx.createGain();
      droneGain.gain.setValueAtTime(0.12, this.ctx.currentTime);
      drone.connect(droneGain);
      droneGain.connect(this.ambientGain);
      drone.start();
      this.ambientNodes.push(drone);
    }
  }

  /** True when a jukebox ambience loop is currently sounding. */
  public isAmbiencePlaying(): boolean {
    return this.ambientNodes.length > 0;
  }

  /** Track id passed to the last successful startAmbience call, if any. */
  public currentAmbienceTrack(): string | null {
    return this.ambientTrackId;
  }

  /** Live volume update from the jukebox master slider (0..1). */
  public setAmbienceVolume(volume: number) {
    this.ambientVolume = volume;
    if (this.ambientGain && this.ctx) {
      const trackId = this.ambientTrackId ?? 'tavern';
      const recipe = AudioManager.AMBIENCE_RECIPES[trackId] ?? AudioManager.AMBIENCE_RECIPES.tavern;
      this.ambientGain.gain.setTargetAtTime(
        volume * recipe.gain,
        this.ctx.currentTime,
        0.05 // short ramp avoids zipper noise on slider drags
      );
    }
  }

  public stopAmbience() {
    for (const node of this.ambientNodes) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.ambientNodes = [];
    this.ambientGain?.disconnect();
    this.ambientGain = null;
  }
}

export const globalAudio = new AudioManager();
