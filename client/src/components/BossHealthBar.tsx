import React, { useState, useEffect } from 'react';
import {
  Skull,
  Flame,
  Shield,
  Clock,
  Sparkles,
  Zap,
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
      <div className="bg-slate-950/90 backdrop-blur-md border border-rose-900/60 rounded-2xl p-3 shadow-2xl space-y-2 pointer-events-auto">
        {/* Top Info Strip */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded-lg bg-rose-600 flex items-center justify-center text-white shadow-lg shadow-rose-950/50">
              <Skull className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-extrabold text-sm font-serif tracking-wide text-rose-200">
                  {bossToken.name}
                </span>
                <span className="px-1.5 py-0.2 bg-rose-950 text-rose-300 border border-rose-800 rounded text-[9px] font-bold uppercase">
                  BOSS
                </span>
              </div>
              <div className="text-[10px] text-slate-400">
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
                    gem <= legendaryResistances ? 'text-amber-400 drop-shadow' : 'text-slate-700 opacity-40'
                  }`}
                >
                  💎
                </span>
              ))}
            </div>

            {/* Turn Timer */}
            <div className="flex items-center space-x-1 px-2 py-0.5 bg-slate-900 border border-slate-800 rounded-lg text-slate-300">
              <Clock className="w-3 h-3 text-amber-400" />
              <span className={`font-bold ${turnTimerSeconds <= 15 ? 'text-rose-400 animate-pulse' : 'text-slate-200'}`}>
                {turnTimerSeconds}s
              </span>
            </div>
          </div>
        </div>

        {/* Health Bar Progress Container */}
        <div className="relative w-full h-3.5 bg-slate-900 rounded-full border border-slate-800 overflow-hidden shadow-inner">
          <div
            className={`h-full transition-all duration-300 rounded-full ${
              hpPercent > 50
                ? 'bg-gradient-to-r from-rose-600 via-rose-500 to-amber-500'
                : hpPercent > 25
                ? 'bg-gradient-to-r from-amber-600 to-orange-500 animate-pulse'
                : 'bg-gradient-to-r from-red-700 to-rose-600 animate-ping'
            }`}
            style={{ width: `${hpPercent}%` }}
          />

          {/* Phase Markers */}
          <div className="absolute top-0 bottom-0 left-1/4 w-0.5 bg-slate-950/60 z-10" />
          <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-slate-950/60 z-10" />
          <div className="absolute top-0 bottom-0 left-3/4 w-0.5 bg-slate-950/60 z-10" />
        </div>

        {/* HP Numeric Text */}
        <div className="flex justify-between text-[10px] text-slate-400 pt-0.5">
          <span>Current Turn: <strong className="text-amber-300">{activeTurnName}</strong></span>
          <span>
            <strong className="text-rose-300 font-bold">{bossToken.hp}</strong> / {bossToken.maxHp} HP ({hpPercent}%)
          </span>
        </div>
      </div>
    </div>
  );
};
