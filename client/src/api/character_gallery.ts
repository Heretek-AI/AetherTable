/**
 * Iteration 14 (Loop 3) — pure shaping/gating for the "My Characters" gallery.
 *
 * Everything here is deterministic and side-effect free so the Vitest suite
 * can pin the gallery's contracts without a DOM or a network:
 *
 *   - `shapeGalleryCard(s)` projects the gateway's stored-character meta (the
 *     LIST endpoint strips the `data` blob, so only name/class/level exist
 *     there) plus an optional hydrated detail record into the exact card
 *     shape the view renders. Junk rows collapse to null and are DROPPED,
 *     never rendered as ghost cards.
 *   - `describeHp` formats the hydrated hit-point pair, keeping the
 *     "detail did not arrive" distinction (`—`) separate from a real zero.
 *   - `evaluateDeployGate` is the single source of truth for whether the
 *     Deploy action may fire: the gateway route
 *     (POST /api/v1/characters/{id}/deploy) REQUIRES a live engine
 *     `session_id`, so with no active session the button must be disabled
 *     with an honest reason instead of manufacturing a 422.
 */

import type { FullStoredCharacter, StoredCharacter } from './lobby_store';

/** One gallery card, exactly what MyCharactersView renders. */
export interface GalleryCard {
  id: string;
  name: string;
  classLabel: string;
  level: number;
  /** Hydrated hit points, or null when the detail record has not arrived. */
  hp: { current: number; max: number } | null;
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * Project one stored character (plus its optional hydrated full record) into
 * a card. Returns null for anything unusable — a missing id or name means the
 * row cannot be addressed (delete/deploy/view all key off the id), so it must
 * not become a clickable card.
 */
export function shapeGalleryCard(
  meta: StoredCharacter,
  detail?: FullStoredCharacter | null
): GalleryCard | null {
  if (!meta || typeof meta !== 'object') return null;
  const id = typeof meta.character_id === 'string' ? meta.character_id : '';
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  if (!id || !name) return null;
  const level = isFiniteNumber(meta.level) ? meta.level : 1;
  const classLabel =
    typeof meta.character_class === 'string' && meta.character_class.trim() !== ''
      ? meta.character_class.trim()
      : 'adventurer';

  const hpRaw = detail?.data?.hp;
  const maxHpRaw = detail?.data?.max_hp;
  const hp =
    isFiniteNumber(hpRaw) && isFiniteNumber(maxHpRaw)
      ? { current: hpRaw, max: maxHpRaw }
      : null;

  return { id, name, classLabel, level, hp };
}

/**
 * Shape a whole roster, silently dropping rows that cannot be addressed.
 * Order follows the input (the gateway already sorts newest-first).
 */
export function shapeGalleryCards(
  roster: readonly (StoredCharacter | null | undefined)[],
  details?: Readonly<Record<string, FullStoredCharacter | null>>
): GalleryCard[] {
  const cards: GalleryCard[] = [];
  for (const meta of roster) {
    if (!meta) continue;
    const card = shapeGalleryCard(meta, details?.[meta.character_id]);
    if (card) cards.push(card);
  }
  return cards;
}

/**
 * Format a hydrated HP pair for the card face. Null detail renders as an
 * explicit em-dash ("not fetched"), never as "0 / 0".
 */
export function describeHp(hp: GalleryCard['hp']): string {
  if (!hp) return '—';
  return `${Math.floor(hp.current)} / ${Math.max(0, Math.floor(hp.max))}`;
}

export type DeployGate = { allowed: true } | { allowed: false; reason: string };

/**
 * Single source of truth for the Deploy action's availability. The gateway's
 * deploy route validates `session_id` against the live engine session, so a
 * gallery opened with no active session disables Deploy up front and says why.
 */
export function evaluateDeployGate(
  activeSessionId: string | null | undefined
): DeployGate {
  if (typeof activeSessionId === 'string' && activeSessionId.trim() !== '') {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: 'No engine session is active — launch or join a table first.',
  };
}
