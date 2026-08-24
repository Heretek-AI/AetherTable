import React, { useEffect, useMemo, useState } from 'react';
import { Skull } from 'lucide-react';
import { getStoredToken } from '../api/auth_headers';

/**
 * One entity exactly as POST /api/v1/engine/session-state projects it for THE
 * CALLING ROLE (see _project_entities in python/vtt_orchestrator/server.py):
 *
 *   - gm/admin        full authoritative stat block (max_hp/current_hp/ac present)
 *   - player          own sheet unredacted; every OTHER visible hostile reduced
 *                     to board-token facts ONLY (no hp, no ac)
 *   - spectator       board-token facts only, nothing more
 *
 * Every field except `id` is therefore OPTIONAL, and absence means "the
 * projection did not disclose it", never zero. This component refuses to draw
 * a bar it cannot source from live values.
 */
export interface ProjectedEntity {
  id: string;
  name?: string;
  is_player?: boolean;
  is_visible?: boolean;
  is_dead?: boolean;
  current_hp?: number;
  max_hp?: number;
  ac?: number;
}

interface BossHealthBarProps {
  /**
   * Engine session whose projected state feeds the bar. Null/undefined while
   * no engine session exists — the component then renders nothing at all.
   */
  sessionId?: string | null;
  /**
   * Whose turn it is per the engine's rolled initiative order (already
   * resolved by the caller from `combat.order[turn_index].name`). Empty string
   * hides the strip instead of printing a placeholder actor.
   */
  activeTurnName?: string;
}

/**
 * Defensively coerce the session-state `entities` map into ProjectedEntity[]
 * values. A malformed entry is skipped, never guessed into shape.
 */
function parseProjectedEntities(raw: unknown): ProjectedEntity[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: ProjectedEntity[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const e = value as Record<string, unknown>;
    out.push({
      id: typeof e.id === 'string' && e.id.length > 0 ? e.id : key,
      name: typeof e.name === 'string' ? e.name : undefined,
      is_player: e.is_player === true,
      is_visible: e.is_visible !== false,
      is_dead: e.is_dead === true,
      current_hp: typeof e.current_hp === 'number' ? e.current_hp : undefined,
      max_hp: typeof e.max_hp === 'number' ? e.max_hp : undefined,
      ac: typeof e.ac === 'number' ? e.ac : undefined,
    });
  }
  return out;
}

/**
 * Top HUD threat bar. Sources EVERYTHING from the role-projected engine state
 * polled live through the gateway's session-state read proxy:
 *
 *   - candidate = visible (is_visible !== false), non-player, non-dead entity
 *   - the projection must expose BOTH max_hp and current_hp, i.e. this caller
 *     is privileged enough to see the sheet (GM/admin, or owns the entity).
 *     A player-facing projection carries neither, so players correctly see
 *     NO bar rather than a fabricated one.
 *   - among candidates the highest max_hp wins.
 *
 * When no candidate qualifies the component renders NOTHING — no placeholder
 * boss, no invented HP, no hardcoded legendary resistances, no decorative
 * countdown timer (all three existed in the previous demo-data version and
 * were removed as fabrications).
 */
export const BossHealthBar: React.FC<BossHealthBarProps> = ({
  sessionId,
  activeTurnName,
}) => {
  // Last known projected roster. Kept on transient transport failure so a
  // single dropped poll doesn't blank a live fight; cleared whenever there is
  // no session to read from.
  const [roster, setRoster] = useState<ProjectedEntity[] | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setRoster(null);
      return;
    }
    let cancelled = false;

    const pull = async () => {
      const token = getStoredToken();
      if (!token) {
        // Not signed in: the gateway's session-state route is authenticated,
        // so there is genuinely nothing readable — show nothing.
        if (!cancelled) setRoster(null);
        return;
      }
      try {
        const resp = await fetch(
          `/api/v1/engine/session-state?token=${encodeURIComponent(token)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId }),
          }
        );
        if (!resp.ok) return; // keep last known snapshot (matches App's poll policy)
        const snap = (await resp.json()) as { entities?: unknown };
        if (!cancelled) setRoster(parseProjectedEntities(snap?.entities));
      } catch {
        /* engine unreachable — keep showing the last known projection */
      }
    };

    void pull();
    const timer = window.setInterval(() => void pull(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId]);

  /**
   * The qualifying hostile: visible, hostile, alive, with BOTH HP figures
   * disclosed by the projection. Highest max_hp wins; ties keep the first.
   */
  const boss = useMemo<ProjectedEntity | null>(() => {
    if (!roster) return null;
    let best: ProjectedEntity | null = null;
    for (const e of roster) {
      if (
        !e ||
        e.is_player === true ||
        e.is_visible === false ||
        e.is_dead === true ||
        typeof e.max_hp !== 'number' ||
        e.max_hp <= 0 ||
        typeof e.current_hp !== 'number'
      ) {
        continue;
      }
      if (best === null || (e.max_hp as number) > (best.max_hp as number)) best = e;
    }
    return best;
  }, [roster]);

  // Explicit empty state: no qualifying hostile in the projected state means
  // this HUD element does not exist for this viewer right now.
  if (!boss) return null;

  const clampedHp = Math.max(0, Math.min(boss.max_hp as number, boss.current_hp as number));
  const hpPercent = Math.max(0, Math.min(100, Math.round((clampedHp / (boss.max_hp as number)) * 100)));
  // AC is a stat-block fact the player/spectator projection strips; render it
  // only when this role was actually told.
  const knownAc = typeof boss.ac === 'number';

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 w-full max-w-xl px-4 animate-fadeIn pointer-events-none font-mono select-none">
      <div className="bg-tavern-bg/90 backdrop-blur-md border border-tavern-border rounded-2xl p-3 shadow-2xl space-y-2 pointer-events-auto">
        {/* Top Info Strip */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            {/* Crimson sigil tile — danger is the load-bearing hue here */}
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center text-white"
              style={{ backgroundColor: 'var(--rp-crimson-600)' }}
            >
              <Skull className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                {/* Nameplate — Cinzel small caps, printed-book monster style */}
                <span
                  className="font-extrabold text-sm tracking-wide lowercase"
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontVariant: 'small-caps',
                    letterSpacing: '0.08em',
                    color: 'var(--rp-parchment-100)',
                  }}
                >
                  {boss.name || boss.id}
                </span>
                <span className="vtt-badge vtt-badge-danger text-[9px] uppercase">Hostile</span>
              </div>
              <div className="text-[10px] text-[var(--rp-parchment-300)]">
                {knownAc ? `${boss.ac} AC · ` : ''}
                Highest-HP visible enemy on the board
              </div>
            </div>
          </div>
        </div>

        {/* Health Bar Progress Container */}
        <div className="relative w-full h-3.5 bg-tavern-bg rounded-full border border-tavern-border overflow-hidden shadow-inner">
          <div
            className={`h-full transition-all duration-300 rounded-full ${
              hpPercent > 50 ? '' : hpPercent > 25 ? 'animate-pulse' : ''
            }`}
            /* Crimson-to-dark-red blood ramp; parchment numeral rides on top */
            style={{
              width: `${hpPercent}%`,
              background: 'linear-gradient(90deg, var(--rp-crimson-600), #7f1d1d)',
            }}
          />

          {/* Parchment numeral overlay */}
          <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
            <span
              className="text-[10px] font-bold tracking-widest"
              style={{ fontFamily: 'var(--font-display)', color: 'var(--rp-parchment-100)', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}
            >
              {clampedHp} / {boss.max_hp}
            </span>
          </div>

          {/* Half/quarter thresholds — visual reference marks only */}
          <div className="absolute top-0 bottom-0 left-1/4 w-0.5 bg-black/50 z-10" />
          <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-black/50 z-10" />
          <div className="absolute top-0 bottom-0 left-3/4 w-0.5 bg-black/50 z-10" />
        </div>

        {/* HP Numeric Text */}
        <div className="flex justify-between text-[10px] text-[var(--rp-parchment-300)] pt-0.5">
          {(activeTurnName ?? '').length > 0 ? (
            <span>
              Current Turn: <strong className="text-tavern-accent">{activeTurnName}</strong>
            </span>
          ) : (
            <span />
          )}
          <span>
            Current HP: <strong className="font-bold" style={{ color: 'var(--rp-crimson-400)' }}>{hpPercent}%</strong> ({clampedHp}/{boss.max_hp})
          </span>
        </div>
      </div>
    </div>
  );
};
