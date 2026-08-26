/**
 * Tag SFX (Loop 3 iteration 31) — a GM-only "tag" action that plays a generated
 * one-shot AT A TOKEN's board coordinates, routed through the existing spatial
 * engine (render/spatial_audio.ts): StereoPannerNode / HRTF PannerNode + Gain
 * pipeline — pan by board-x relative to the listener, gain by distance, wall
 * occlusion included.
 *
 * GENERATION + CREDENTIALS: this lane REUSES `generateSfx` from sfx_library.ts
 * (POST /api/v1/media/sfx), so Bearer auth, the decoded-AudioBuffer session
 * cache, in-flight coalescing and the "failures are never cached" rule are all
 * inherited gateway contracts. They are pinned at the sfx_library seam and
 * re-pinned at this seam by tag_sfx.test.ts — this module only ever hands the
 * spatial player a SUCCESSFULLY-decoded cue.
 *
 * PLAYBACK PATH: sfx_library.playCachedSfx (the standalone SfxPanel) stays on
 * the plain HTMLAudioElement fallback because it carries NO board position.
 * The TAG lane is different — it has a token's world coordinates — so it uses
 * the iteration-31 SpatialAudioEngine.playSpatialBuffer lane instead.
 *
 * MONO HONESTY: a monaural generated cue is still a point source; HRTF binaural
 * azimuth and the StereoPannerNode fallback remain meaningful (center pan at
 * distance zero). The PLAYED result reports the decoded channel count so the
 * UI can surface the fact without pretending the buffer is stereo.
 *
 * GATE: `isTagSfxAllowed(role, spectatorMode)` — gm/admin seats and anonymous
 * solo sessions may tag; player and spectator seats never do (spectator wins
 * even under a stale staff role). This is a cosmetic client gate; the gateway's
 * own MEDIA_SFX_FORBIDDEN remains the real authority.
 */

import { generateSfx } from './sfx_library';
import { globalSpatialAudio } from '../render/spatial_audio';

/** The short jingle the token right-click action plays (first use synthesizes). */
export const TAG_SFX_PROMPT = 'magical chime cue';

export interface TagSfxRequest {
  prompt: string;
  /** Token board x in world grid cells. */
  x: number;
  /** Token board y in world grid cells. */
  y: number;
  /** Token elevation in feet (0 = board plane). */
  elevationFeet?: number;
}

export type TagSfxOutcome =
  | { outcome: 'PLAYED'; prompt: string; cached: boolean; channels: number }
  | { outcome: 'NOT_SIGNED_IN'; detail: string }
  | { outcome: 'FORBIDDEN'; detail: string }
  | { outcome: 'RATE_LIMITED'; detail: string }
  | { outcome: 'REJECTED'; detail: string }
  | { outcome: 'UNREACHABLE'; detail: string }
  | { outcome: 'NOT_PLAYED'; reason: 'UNSUPPORTED' | 'BUSY'; detail: string };

/** Injected seam: decodes nothing, plays an already-decoded buffer spatially. */
export type TagSfxPlayer = (
  buffer: AudioBuffer,
  x: number,
  y: number,
  elevationFeet: number,
) => boolean;

const defaultPlayer: TagSfxPlayer = (buffer, x, y, elevationFeet) =>
  globalSpatialAudio.playSpatialBuffer(buffer, x, y, elevationFeet);

/**
 * Client-side GM gate mirrored by the canvas's token context action. A
 * spectator seat is denied unconditionally — a read-only seat must not spend
 * the table's synthesis bucket — and a player seat never fires the wire call.
 */
export function isTagSfxAllowed(
  role: 'gm' | 'admin' | 'player' | 'spectator' | undefined,
  spectatorMode: boolean,
): boolean {
  if (spectatorMode) return false;
  if (role === 'player' || role === 'spectator') return false;
  return true; // gm / admin / anonymous solo (same omniscience precedent as fog)
}

/**
 * Generates (or replays from the session cache) the tag prompt and routes the
 * decoded cue through the spatial engine at the token's board coordinates.
 * Never throws; resolves to a discriminated outcome the caller renders
 * honestly. A repeat before the first decode resolves from cache WITHOUT a wire
 * call; concurrent identical requests share one generation (sfx_library).
 */
export async function playTagSfx(
  req: TagSfxRequest,
  player: TagSfxPlayer = defaultPlayer,
): Promise<TagSfxOutcome> {
  const generated = await generateSfx(req.prompt);
  if (generated.outcome !== 'OK') {
    // The five non-OK sfx_library outcomes are exactly the five failure
    // variants here — re-emitted verbatim so the gateway's detail survives.
    return generated;
  }

  const x = Number.isFinite(req.x) ? req.x : 0;
  const y = Number.isFinite(req.y) ? req.y : 0;
  const elevationFeet = Number.isFinite(req.elevationFeet) ? (req.elevationFeet ?? 0) : 0;
  const played = player(generated.buffer, x, y, elevationFeet);
  if (!played) {
    return {
      outcome: 'NOT_PLAYED',
      reason: 'BUSY',
      detail: 'The spatial engine refused to start this cue (muted or Web Audio unavailable).',
    };
  }
  return {
    outcome: 'PLAYED',
    prompt: generated.prompt,
    cached: generated.cached,
    channels: generated.buffer.numberOfChannels,
  };
}

/** Test/diagnostic reset. The tag lane keeps no cache of its own — the
 *  sfx_library session Map is the single source of truth and its own test
 *  clear handles it. */
export function clearTagSfxForTests(): void {
  /* no internal state — see module docs (generation cache lives in sfx_library) */
}