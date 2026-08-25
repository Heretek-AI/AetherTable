/**
 * Positional 3D Web Audio Spatial Engine
 * Computes azimuth stereo panning and distance-attenuated gain based on token coordinates.
 *
 * Two kinds of spatialization live here:
 *  1. One-shot cues (impact/spell/roar/dice) built per play call.
 *  2. PERSISTENT VOICE SOURCES (Pillar 9): one long-lived HRTF PannerNode chain
 *     per remote peer microphone, registered via `attachMediaStream` and moved
 *     across the board with `setSourcePosition(peerId, x, y)` as the peer's
 *     bound token moves. Distance attenuation and azimuth therefore track the
 *     tactical map in real time.
 *
 * Honest limits:
 *  - A peer with no identifiable board token is PINNED at the listener's
 *    coordinates (distance 0 ⇒ unity gain, azimuth 0 ⇒ neutral pan). That is a
 *    FIXED placement decided at pin time — the engine never invents motion.
 *  - `attachMediaStream` fails honestly (returns false) when the AudioContext
 *    cannot run yet (autoplay policy before a user gesture) or spatial mode is
 *    off; callers must fall back to plain element playback in that case.
 *  - ELEVATION (iteration 50): sources and the listener carry their token's
 *    `elevationFeet` on the panner's vertical axis via `./audio_elevation`
 *    (board-cell units, 5ft per cell), so HRTF produces true above/below cues
 *    and inverse-distance attenuation over full 3D separation. Grounded
 *    tokens behave exactly as before (both planes at the 1.5 ear height).
 *
 * Occlusion (Pillar 9, implemented): every source path additionally attenuates
 * by the WALL CELLS standing between the listener token and the source token.
 * The wall data is the session's existing `{x, y}` cell list (`customWalls` in
 * App.tsx — the same cells pixi_board renders and RaycastLighting blocks LoS
 * with), pushed in via `setWalls`. The pure grid-walk + dB model lives in
 * `./occlusion`; this class recomputes each live voice's occluded gain whenever
 * the listener moves, a peer token moves (~10 Hz mesh feed), or the wall set
 * changes. See that module for the acoustic model documentation (-6 dB per
 * intervening wall, clamped, stacked on inverse-distance rolloff).
 */

import { computeOccludedDistanceGain, countWallsOnSegment, wallCountToGainFactor, wallKey } from './occlusion';
import { elevationToAudioZ } from './audio_elevation';

/** Ear height above the board plane for grounded tokens (world units). */
const EAR_HEIGHT = 1.5;

interface VoiceSourceNodes {
  tap: MediaStreamAudioSourceNode;
  /** Per-source stage feeding the panner: userVolume × occlusion factor. */
  gain: GainNode;
  /** HRTF panner, null when only a dry gain path could be built. */
  panner: PannerNode | null;
  x: number;
  y: number;
  /** Source token elevation in feet (0 = board plane). */
  elevationFeet: number;
  /** Mixer-slider loudness requested by the caller (occlusion multiplies it). */
  userVolume: number;
}

export class SpatialAudioEngine {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;
  private isSpatialEnabled: boolean = true;
  private masterGain: GainNode | null = null;
  private listenerPos: { x: number; y: number } = { x: 4, y: 4 };
  /** Listener token elevation in feet (0 = board plane). */
  private listenerElevationFeet = 0;
  /** Persistent peer-voice chains, keyed by peer id. */
  private voiceSources = new Map<string, VoiceSourceNodes>();
  /**
   * Positions requested before a source's audio graph exists (or remembered
   * across detach/reattach), so a re-attached peer lands where its token is,
   * not back at the listener.
   */
  private desiredPositions = new Map<
    string,
    { x: number; y: number; elevationFeet?: number }
  >();
  /**
   * Current session wall cells as "x:y" keys (pixi_board convention). Empty
   * until `setWalls` is called; an empty set means zero occlusion everywhere.
   */
  private walls = new Set<string>();

  /**
   * Replaces the session wall set and re-applies occlusion to every live voice
   * source. Call whenever the session map's walls change (layer editor, WFC
   * import, campaign restore). Cells use the same `{x, y}` shape the board and
   * raycast lighting already consume.
   */
  public setWalls(cells: Iterable<{ x: number; y: number }>): void {
    const next = new Set<string>();
    for (const c of cells) next.add(wallKey(c.x, c.y));
    this.walls = next;
    this.reapplyOcclusionToAllSources();
  }

  /** Current wall keys (diagnostic/mixer display). */
  public getWallCount(): number {
    return this.walls.size;
  }

  /** Intervening wall cells between the listener and a board point. */
  public countOccludingWalls(x: number, y: number): number {
    return countWallsOnSegment(this.walls, this.listenerPos.x, this.listenerPos.y, x, y);
  }

  /**
   * Recomputes one voice's gain stage = userVolume × occlusion factor for its
   * current source position. Smoothed so a token sliding behind a wall fades
   * rather than steps.
   */
  private applyOcclusionToSource(s: VoiceSourceNodes): void {
    if (!this.ctx) return;
    // Distance attenuation for voices is handled natively by the HRTF
    // PannerNode's inverse model; the gain stage carries userVolume × the
    // occlusion factor only.
    const occluded = s.userVolume * wallCountToGainFactor(this.countOccludingWalls(s.x, s.y));
    s.gain.gain.setTargetAtTime(
      Math.max(0, Math.min(1, occluded)),
      this.ctx.currentTime,
      SpatialAudioEngine.POSITION_SMOOTHING_TC,
    );
  }

  private reapplyOcclusionToAllSources(): void {
    for (const s of this.voiceSources.values()) this.applyOcclusionToSource(s);
  }

  constructor() {
    // Lazy initialized on first user interaction
  }

  /** Time constant for positional setTargetAtTime smoothing (≈10 Hz feed). */
  private static readonly POSITION_SMOOTHING_TC = 0.04;

  private initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(0.8, this.ctx.currentTime);
        this.masterGain.connect(this.ctx.destination);
        // Listener sits on the board plane (plus its token's elevation); sources
        // are placed relative to it so the HRTF convolution produces true
        // azimuth + elevation cues.
        const listener = this.ctx.listener;
        const now = this.ctx.currentTime;
        if (listener.positionX) {
          listener.positionX.setValueAtTime(this.listenerPos.x, now);
          listener.positionY.setValueAtTime(this.listenerHeight(), now);
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

  /**
   * Moves the listener. Elevation is optional so existing callers keep working
   * (a call without it PRESERVES the previous elevation rather than resetting
   * to zero — position and altitude are independent facts about the token).
   */
  public setListenerPosition(x: number, y: number, elevationFeet?: number) {
    this.listenerPos = { x, y };
    if (elevationFeet !== undefined) this.listenerElevationFeet = elevationFeet;
    if (this.ctx?.listener.positionX) {
      const t = this.ctx.currentTime;
      const listener = this.ctx.listener;
      listener.positionX.setValueAtTime(x, t);
      listener.positionY.setValueAtTime(this.listenerHeight(), t);
      listener.positionZ.setValueAtTime(y, t);
    }
    // Every voice's occlusion is measured from the listener token, so moving
    // our token re-evaluates all peer paths (e.g. stepping around a wall).
    this.reapplyOcclusionToAllSources();
  }

  /** Listener's vertical world position (ear height + elevation offset). */
  private listenerHeight(): number {
    return EAR_HEIGHT + elevationToAudioZ(this.listenerElevationFeet);
  }

  public getListenerPosition(): { x: number; y: number } {
    return { ...this.listenerPos };
  }

  /** Listener token elevation in feet (diagnostics/mixer display). */
  public getListenerElevationFeet(): number {
    return this.listenerElevationFeet;
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

  // -- persistent peer-voice sources (Pillar 9) ------------------------------

  /**
   * Routes a live (remote) MediaStream through this source's persistent HRTF
   * chain: stream tap → volume gain → PannerNode(HRTF, inverse rolloff) →
   * master. Returns true when routing succeeded; false means the caller MUST
   * keep ordinary element playback (autoplay-blocked context, Web Audio
   * unavailable, or spatial mode disabled) — nothing is silently dropped.
   *
   * The initial placement is the last `setSourcePosition` value for this id if
   * one exists, otherwise the listener's current coordinates (neutral pan,
 * unity distance) — a fixed pin, never simulated movement.
   */
  public attachMediaStream(
    id: string,
    stream: MediaStream,
    opts?: { volume?: number }
  ): boolean {
    try {
      this.initContext();
      const ctx = this.ctx;
      if (!ctx || !this.masterGain || !ctx.createMediaStreamSource) return false;
      // A suspended context would swallow the voice entirely once we mute the
      // fallback element, so refuse to take over until it is actually running.
      if (ctx.state !== 'running') return false;
      if (!this.isSpatialEnabled) return false;

      this.detachSource(id);
      const start = this.desiredPositions.get(id) ?? {
        ...this.listenerPos,
        elevationFeet: this.listenerElevationFeet,
      };
      const userVolume = Math.max(0, Math.min(1, opts?.volume ?? 1));
      const tap = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      // Seed with the occluded value; the source record below keeps the
      // un-occluded userVolume so later recomputes stay correct.
      gain.gain.setValueAtTime(
        Math.max(0, Math.min(1, userVolume * wallCountToGainFactor(
          countWallsOnSegment(this.walls, this.listenerPos.x, this.listenerPos.y, start.x, start.y),
        ))),
        ctx.currentTime,
      );

      let panner: PannerNode | null = null;
      if (ctx.createPanner) {
        panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = 1;
        panner.rolloffFactor = 0.15;
        panner.coneInnerAngle = 360;
        this.writePannerPosition(panner, start.x, start.y, start.elevationFeet ?? 0);
        gain.connect(panner);
        panner.connect(this.masterGain);
      } else {
        gain.connect(this.masterGain);
      }
      tap.connect(gain);

      this.voiceSources.set(id, {
        tap,
        gain,
        panner,
        x: start.x,
        y: start.y,
        elevationFeet: start.elevationFeet ?? 0,
        userVolume,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Tears down one peer's voice chain (idempotent, safe on unknown ids). */
  public detachSource(id: string): void {
    const s = this.voiceSources.get(id);
    if (!s) return;
    try {
      s.tap.disconnect();
      s.gain.disconnect();
      s.panner?.disconnect();
    } catch {
      /* already disconnected by context teardown */
    }
    this.voiceSources.delete(id);
  }

  public hasSource(id: string): boolean {
    return this.voiceSources.has(id);
  }

  /**
   * Moves a peer's voice to board coordinates (x, y). Called from the mesh at
   * ≈10 Hz as the peer's bound token moves; positions are smoothed with
   * setTargetAtTime so stepped updates do not zipper the HRTF filter.
   */
  /**
   * Moves a peer's voice to board coordinates (x, y). Elevation is optional —
   * when supplied it moves the source on the panner's vertical axis too; when
   * omitted the previously known elevation is preserved. Called from the mesh
   * at ≈10 Hz as the peer's bound token moves; positions are smoothed with
   * setTargetAtTime so stepped updates do not zipper the HRTF filter.
   */
  public setSourcePosition(id: string, x: number, y: number, elevationFeet?: number): void {
    const desired = this.desiredPositions.get(id);
    this.desiredPositions.set(id, {
      x,
      y,
      elevationFeet: elevationFeet ?? desired?.elevationFeet,
    });
    const s = this.voiceSources.get(id);
    if (!s || !this.ctx) return;
    s.x = x;
    s.y = y;
    if (elevationFeet !== undefined) s.elevationFeet = elevationFeet;
    if (s.panner) this.writePannerPosition(s.panner, x, y, s.elevationFeet);
    // The peer's token moved (~10 Hz mesh feed): its wall count may have
    // changed, so re-derive the occluded gain stage for the new position.
    this.applyOcclusionToSource(s);
  }

  /** Per-source loudness (mixer slider); no-op for unknown sources. */
  public setSourceVolume(id: string, volume: number): void {
    const s = this.voiceSources.get(id);
    if (!s || !this.ctx) return;
    s.userVolume = Math.max(0, Math.min(1, volume));
    // Occlusion stacks on top of the new slider value.
    this.applyOcclusionToSource(s);
  }

  private writePannerPosition(panner: PannerNode, x: number, y: number, elevationFeet = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // Vertical axis = ear height + this token's elevation in board-cell units.
    const height = EAR_HEIGHT + elevationToAudioZ(elevationFeet);
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(x, t, SpatialAudioEngine.POSITION_SMOOTHING_TC);
      panner.positionY.setTargetAtTime(height, t, SpatialAudioEngine.POSITION_SMOOTHING_TC);
      panner.positionZ.setTargetAtTime(y, t, SpatialAudioEngine.POSITION_SMOOTHING_TC);
    } else {
      // Legacy setPosition API has no smoothing; step directly.
      (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, height, y);
    }
  }

  /** A source's vertical world position (ear height + elevation offset). */
  public getSourceHeight(id: string): number | null {
    const s = this.voiceSources.get(id);
    if (!s || !this.ctx) return null;
    return EAR_HEIGHT + elevationToAudioZ(s.elevationFeet);
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

    // Inverse Distance Rolloff: 1 / (1 + 0.15 * d), multiplied by the Pillar-9
    // occlusion factor for the wall cells standing on the listener→source ray
    // (-6 dB each, clamped). With no intervening walls this is exactly the
    // pre-existing rolloff value.
    const wallCount = countWallsOnSegment(this.walls, this.listenerPos.x, this.listenerPos.y, sourceX, sourceY);
    const gain = computeOccludedDistanceGain(distance, wallCount);

    return { pan, gain, distance };
  }

  /**
   * Builds a true 3D spatialization chain for one-shot cues:
   *   input gain -> PannerNode (HRTF binaural, inverse-distance rolloff) -> master.
   *
   * The PannerNode handles azimuth natively from world coordinates; distance
   * attenuation and wall occlusion are folded into the returned gain, which
   * drives the cue's envelope. Where PannerNode is unavailable (or spatial is
   * disabled) we fall back to the stereo-pan + computed-gain path so behavior
   * never regresses.
   */
  private buildSpatialChain(
    sourceX: number,
    sourceY: number,
    sourceElevationFeet = 0
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
      const height = EAR_HEIGHT + elevationToAudioZ(sourceElevationFeet);
      if (panner.positionX) {
        const t = ctx.currentTime;
        panner.positionX.setValueAtTime(sourceX, t);
        panner.positionY.setValueAtTime(height, t);
        panner.positionZ.setValueAtTime(sourceY, t);
      } else {
        // Legacy setPosition API.
        (panner as any).setPosition(sourceX, height, sourceY);
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

  public playSpatialImpact(sourceX: number, sourceY: number, sourceElevationFeet = 0) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const { gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const { input: soundGain } = this.buildSpatialChain(sourceX, sourceY, sourceElevationFeet);
    const now = this.ctx.currentTime;
    // `gain` (distance rolloff × wall occlusion) drives the envelope below;
    // the PannerNode adds azimuth on top.

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

  public playSpatialSpell(sourceX: number, sourceY: number, sourceElevationFeet = 0) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const { gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const { input: soundGain } = this.buildSpatialChain(sourceX, sourceY, sourceElevationFeet);
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

  public playSpatialCreatureRoar(sourceX: number, sourceY: number, sourceElevationFeet = 0) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const { gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const { input: soundGain } = this.buildSpatialChain(sourceX, sourceY, sourceElevationFeet);
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

  public playSpatialDice(sourceX: number, sourceY: number, sourceElevationFeet = 0) {
    if (this.isMuted) return;
    this.initContext();
    if (!this.ctx || !this.masterGain) return;

    const { gain } = this.calculateSpatialParameters(sourceX, sourceY);
    const { input: soundGain } = this.buildSpatialChain(sourceX, sourceY, sourceElevationFeet);
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
