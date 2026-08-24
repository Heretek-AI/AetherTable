/**
 * Positional 3D Web Audio Spatial Engine
 * Computes azimuth stereo panning and distance-attenuated gain based on token coordinates.
 */

export class SpatialAudioEngine {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;
  private isSpatialEnabled: boolean = true;
  private masterGain: GainNode | null = null;
  private listenerPos: { x: number; y: number } = { x: 4, y: 4 };

  constructor() {
    // Lazy initialized on first user interaction
  }

  private initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(0.8, this.ctx.currentTime);
        this.masterGain.connect(this.ctx.destination);
        // Listener sits ON the board plane; sources are placed relative to it
        // so the HRTF convolution produces true azimuth + elevation cues.
        const listener = this.ctx.listener;
        const now = this.ctx.currentTime;
        if (listener.positionX) {
          listener.positionX.setValueAtTime(this.listenerPos.x, now);
          listener.positionY.setValueAtTime(1.5, now);
          listener.positionZ.setValueAtTime(this.listenerPos.y, now);
          listener.forwardX.setValueAtTime(0, now);
          listener.forwardY.setValueAtTime(-1, now);
          listener.forwardZ.setValueAtTime(0, now);
          listener.upX.setValueAtTime(0, now);
          listener.upY.setValueAtTime(0, now);
          listener.upZ.setValueAtTime(1, now);
        }
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public setListenerPosition(x: number, y: number) {
    this.listenerPos = { x, y };
    if (this.ctx?.listener.positionX) {
      const t = this.ctx.currentTime;
      this.ctx.listener.positionX.setValueAtTime(x, t);
      this.ctx.listener.positionZ.setValueAtTime(y, t);
    }
  }

  public getListenerPosition(): { x: number; y: number } {
    return { ...this.listenerPos };
  }

  public setMasterVolume(val: number) {
    this.initContext();
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1, val)), this.ctx.currentTime);
    }
  }

  public setSpatialEnabled(enabled: boolean) {
    this.isSpatialEnabled = enabled;
  }

  public getSpatialEnabled(): boolean {
    return this.isSpatialEnabled;
  }

  public calculateSpatialParameters(sourceX: number, sourceY: number): { pan: number; gain: number; distance: number } {
    const dx = sourceX - this.listenerPos.x;
    const dy = sourceY - this.listenerPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (!this.isSpatialEnabled) {
      return { pan: 0, gain: 1.0, distance };
    }

    // Stereo Panning: -1.0 (far left) to +1.0 (far right). tanh(dx/6) instead
    // of a hard-clamped dx/8: smooth S-curve saturation that asymptotically
    // approaches the extremes, so panning never "snaps" to full L/R at a fixed
    // distance and tokens far off-axis still shift subtly further out.
    const pan = Math.tanh(dx / 6.0);

    // Inverse Distance Rolloff: 1 / (1 + 0.15 * d)
    const gain = Math.max(0.08, Math.min(1.0, 1.0 / (1.0 + distance * 0.15)));

    return { pan, gain, distance };
  }

  /**
   * Builds a true 3D spatialization chain for one-shot cues:
   *   input gain -> PannerNode (HRTF binaural, inverse-distance rolloff,
   *   occluder-free plane) -> master.
   *
   * The PannerNode handles azimuth AND attenuation natively from world
   * coordinates, replacing the legacy tanh StereoPanner math. Where
   * PannerNode is unavailable (or spatial is disabled) we fall back to the
   * original stereo-pan + computed-gain path so behavior never regresses.
   */
  private buildSpatialChain(
    sourceX: number,
    sourceY: number
  ): { input: GainNode; pan: number; gain: number } {
    const { pan, gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const ctx = this.ctx!;
    const soundGain = ctx.createGain();

    if (ctx.createPanner && this.isSpatialEnabled) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.rolloffFactor = 0.15;
      panner.coneInnerAngle = 360;
      if (panner.positionX) {
        const t = ctx.currentTime;
        panner.positionX.setValueAtTime(sourceX, t);
        panner.positionY.setValueAtTime(1.5, t);
        panner.positionZ.setValueAtTime(sourceY, t);
      } else {
        // Legacy setPosition API.
        (panner as any).setPosition(sourceX, 1.5, sourceY);
      }
      soundGain.connect(panner);
      panner.connect(this.masterGain!);
    } else if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(pan, ctx.currentTime);
      soundGain.gain.setValueAtTime(gain, ctx.currentTime);
      soundGain.connect(panner);
      panner.connect(this.masterGain!);
    } else {
      soundGain.gain.setValueAtTime(gain, ctx.currentTime);
      soundGain.connect(this.masterGain!);
    }

    return { input: soundGain, pan, gain };
  }

  public playSpatialImpact(sourceX: number, sourceY: number) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const { gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const { input: soundGain } = this.buildSpatialChain(sourceX, sourceY);
    const now = this.ctx.currentTime;
    void gain; // attenuation is handled natively by the HRTF PannerNode

    // 8 ms linear attack before the decay: starting at full amplitude causes
    // an audible click (hard waveform onset); ramping up from near-silence
    // removes it without perceptibly softening the transient.
    soundGain.gain.setValueAtTime(0.0001, now);
    soundGain.gain.linearRampToValueAtTime(gain * 0.6, now + 0.008);
    soundGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    // Impact Tone
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.2);

    osc.connect(soundGain);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  public playSpatialSpell(sourceX: number, sourceY: number) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const { gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const { input: soundGain } = this.buildSpatialChain(sourceX, sourceY);
    const now = this.ctx.currentTime;


    // Attack ramp as in playSpatialImpact — kills onset click.
    soundGain.gain.setValueAtTime(0.0001, now);
    soundGain.gain.linearRampToValueAtTime(gain * 0.5, now + 0.01);
    soundGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);


    // Resonant Chord
    [520, 650, 780].forEach((freq, i) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.05);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + 0.5);
      osc.connect(soundGain);
      osc.start(now + i * 0.05);
      osc.stop(now + 0.6);
    });
  }

  public playSpatialCreatureRoar(sourceX: number, sourceY: number) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const { gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const { input: soundGain } = this.buildSpatialChain(sourceX, sourceY);
    const now = this.ctx.currentTime;


    // Attack ramp as in playSpatialImpact — kills onset click.
    soundGain.gain.setValueAtTime(0.0001, now);
    soundGain.gain.linearRampToValueAtTime(gain * 0.5, now + 0.008);
    soundGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);


    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(80, now);
    osc.frequency.linearRampToValueAtTime(110, now + 0.2);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.5);

    osc.connect(soundGain);
    osc.start(now);
    osc.stop(now + 0.5);
  }

  public playSpatialDice(sourceX: number, sourceY: number) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const { gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const { input: soundGain } = this.buildSpatialChain(sourceX, sourceY);
    const now = this.ctx.currentTime;


    // Shortest cue → shortest attack (4 ms) so the dice rattle stays crisp.
    soundGain.gain.setValueAtTime(0.0001, now);
    soundGain.gain.linearRampToValueAtTime(gain * 0.35, now + 0.004);
    soundGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);


    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + 0.1);

    osc.connect(soundGain);
    osc.start(now);
    osc.stop(now + 0.15);
  }
}

export const globalSpatialAudio = new SpatialAudioEngine();
