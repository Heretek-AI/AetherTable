import React, { useState, useEffect } from 'react';
import {
  Skull,
  Clock,
} from 'lucide-react';
import { Token } from './TacticalCanvas';

interface BossHealthBarProps {
  bossToken: Token | null;
  activeTurnName: string;
}

export const BossHealthBar: React.FC<BossHealthBarProps> = ({
  bossToken,
  activeTurnName,
}) => {
  const [turnTimerSeconds, setTurnTimerSeconds] = useState(60);
  const [legendaryResistances, setLegendaryResistances] = useState(3);

  // Turn timer countdown tick
  useEffect(() => {
    setTurnTimerSeconds(60);
    const interval = setInterval(() => {
      setTurnTimerSeconds((prev) => (prev > 0 ? prev - 1 : 60));
    }, 1000);
    return () => clearInterval(interval);
  }, [activeTurnName]);

  if (!bossToken) return null;

  const hpPercent = Math.max(0, Math.min(100, Math.round((bossToken.hp / bossToken.maxHp) * 100)));

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
                  {bossToken.name}
                </span>
                <span className="vtt-badge vtt-badge-danger text-[9px] uppercase">BOSS</span>
              </div>
              <div className="text-[10px] text-[var(--rp-parchment-300)]">
                Phase {hpPercent > 50 ? 'I' : hpPercent > 25 ? 'II' : 'III'} · {bossToken.ac} AC
              </div>
            </div>
          </div>

          {/* Turn Timer & Legendary Resistances */}
          <div className="flex items-center space-x-3 text-xs">
            {/* Legendary Resistances */}
            <div className="flex items-center space-x-1" title="Legendary Resistances Remaining">
              {[1, 2, 3].map((gem) => (
                <span
                  key={gem}
                  className={`text-sm ${
                    gem <= legendaryResistances ? 'text-tavern-accent drop-shadow' : 'text-[var(--rp-leather-700)] opacity-40'
                  }`}
                >
                  💎
                </span>
              ))}
            </div>

            {/* Turn Timer */}
            <div className="flex items-center space-x-1 px-2 py-0.5 bg-tavern-bg border border-tavern-border rounded-lg text-[var(--rp-parchment-200)]">
              <Clock className="w-3 h-3 text-tavern-accent" />
              <span
                className={`font-bold ${turnTimerSeconds <= 15 ? 'animate-pulse' : ''}`}
                style={turnTimerSeconds <= 15 ? { color: 'var(--rp-crimson-400)' } : undefined}
              >
                {turnTimerSeconds}s
              </span>
            </div>
          </div>
        </div>

        {/* Health Bar Progress Container */}
        <div className="relative w-full h-3.5 bg-tavern-bg rounded-full border border-tavern-border overflow-hidden shadow-inner">
          <div
            className={`h-full transition-all duration-300 rounded-full ${
              hpPercent > 50
                ? ''
                : hpPercent > 25
                ? 'animate-pulse'
                : 'animate-ping'
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
              {bossToken.hp} / {bossToken.maxHp}
            </span>
          </div>

          {/* Phase Markers */}
          <div className="absolute top-0 bottom-0 left-1/4 w-0.5 bg-black/50 z-10" />
          <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-black/50 z-10" />
          <div className="absolute top-0 bottom-0 left-3/4 w-0.5 bg-black/50 z-10" />
        </div>

        {/* HP Numeric Text */}
        <div className="flex justify-between text-[10px] text-[var(--rp-parchment-300)] pt-0.5">
          <span>Current Turn: <strong className="text-tavern-accent">{activeTurnName}</strong></span>
          <span>
            Current HP: <strong className="font-bold" style={{ color: 'var(--rp-crimson-400)' }}>{hpPercent}%</strong> ({bossToken.hp}/{bossToken.maxHp})
          </span>
        </div>
      </div>
    </div>
  );
};
