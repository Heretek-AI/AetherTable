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
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public setListenerPosition(x: number, y: number) {
    this.listenerPos = { x, y };
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

    // Stereo Panning: -1.0 (far left) to +1.0 (far right)
    const pan = Math.max(-1.0, Math.min(1.0, dx / 8.0));

    // Inverse Distance Rolloff: 1 / (1 + 0.15 * d)
    const gain = Math.max(0.08, Math.min(1.0, 1.0 / (1.0 + distance * 0.15)));

    return { pan, gain, distance };
  }

  public playSpatialImpact(sourceX: number, sourceY: number) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const { pan, gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const now = this.ctx.currentTime;

    // Create Stereo Panner & Gain Nodes
    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    const soundGain = this.ctx.createGain();

    soundGain.gain.setValueAtTime(gain * 0.6, now);
    soundGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

    if (panner) {
      panner.pan.setValueAtTime(pan, now);
      soundGain.connect(panner);
      panner.connect(this.masterGain);
    } else {
      soundGain.connect(this.masterGain);
    }

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

    const { pan, gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const now = this.ctx.currentTime;

    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    const soundGain = this.ctx.createGain();

    soundGain.gain.setValueAtTime(gain * 0.5, now);
    soundGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

    if (panner) {
      panner.pan.setValueAtTime(pan, now);
      soundGain.connect(panner);
      panner.connect(this.masterGain);
    } else {
      soundGain.connect(this.masterGain);
    }

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

    const { pan, gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const now = this.ctx.currentTime;

    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    const soundGain = this.ctx.createGain();

    soundGain.gain.setValueAtTime(gain * 0.5, now);
    soundGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    if (panner) {
      panner.pan.setValueAtTime(pan, now);
      soundGain.connect(panner);
      panner.connect(this.masterGain);
    } else {
      soundGain.connect(this.masterGain);
    }

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

    const { pan, gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const now = this.ctx.currentTime;

    const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    const soundGain = this.ctx.createGain();

    soundGain.gain.setValueAtTime(gain * 0.35, now);
    soundGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    if (panner) {
      panner.pan.setValueAtTime(pan, now);
      soundGain.connect(panner);
      panner.connect(this.masterGain);
    } else {
      soundGain.connect(this.masterGain);
    }

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
