import React, { useState } from 'react';
import {
  Dices,
  Eye,
  EyeOff,
  Shield,
  Sword,
  Flame,
  Sparkles,
  Zap,
  Skull,
  Send,
  Sliders,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { globalAudio } from '../render/audio_manager';

interface MacroQuickbarProps {
  onExecuteRoll: (macroName: string, formula: string, isWhisper: boolean, advDis: 'normal' | 'advantage' | 'disadvantage') => void;
}

export const MacroQuickbar: React.FC<MacroQuickbarProps> = ({ onExecuteRoll }) => {
  const [advDis, setAdvDis] = useState<'normal' | 'advantage' | 'disadvantage'>('normal');
  const [isWhisper, setIsWhisper] = useState<boolean>(false);
  const [customFormula, setCustomFormula] = useState<string>('');
  // Collapsed by default: expanded, this panel covers ~80% of the chat
  // console it floats over (the chat is a fixed h-60). Players still see the
  // labelled header and can pop it open with one click; the chat stays legible.
  const [isExpanded, setIsExpanded] = useState<boolean>(false);

  const quickMacros = [
    { name: 'Initiative', formula: '1d20 + 2', icon: <Zap className="w-3 h-3 text-amber-400" /> },
    { name: 'Perception', formula: '1d20 + 1', icon: <Eye className="w-3 h-3 text-sky-400" /> },
    { name: 'Stealth', formula: '1d20 + 2', icon: <EyeOff className="w-3 h-3 text-[var(--tavern-accent)]" /> },
    { name: 'Athletics', formula: '1d20 + 4', icon: <Shield className="w-3 h-3 text-emerald-400" /> },
    { name: 'Death Save', formula: '1d20', icon: <Skull className="w-3 h-3 text-rose-400" /> },
    { name: 'Greataxe', formula: '1d12 + 4', icon: <Sword className="w-3 h-3 text-rose-400" /> },
    { name: 'Fireball', formula: '8d6', icon: <Flame className="w-3 h-3 text-orange-400" /> },
  ];

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customFormula.trim()) return;
    const formula = customFormula.startsWith('/roll ') ? customFormula.replace('/roll ', '') : customFormula;
    onExecuteRoll('Custom Roll', formula, isWhisper, advDis);
    setCustomFormula('');
  };

  const handleTriggerQuickMacro = (name: string, formula: string) => {
    globalAudio.playDiceRoll();
    onExecuteRoll(name, formula, isWhisper, advDis);
  };

  return (
    <div
      className="absolute bottom-20 left-1/2 -translate-x-1/2 transition-all select-none"
      style={{ zIndex: 'var(--z-chrome)' }}
    >
      <div className="vtt-glass-panel shadow-2xl rounded-2xl p-2.5 flex flex-col items-center gap-2 max-w-2xl w-full">
        {/* Toggle Collapse Bar */}
        <div className="flex items-center justify-between w-full px-2 text-[10px] font-mono text-[var(--rp-parchment-300)] border-b border-[var(--tavern-border)] pb-1.5">
          <div className="flex items-center space-x-2">
            <Dices className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-bold tracking-wider uppercase text-[var(--rp-parchment-200)]">Roll20 Macro Quickbar</span>
          </div>

          <div className="flex items-center space-x-3">
            {/* Advantage / Disadvantage Toggle */}
            <div className="flex bg-black/30 rounded-lg p-0.5 border border-[var(--tavern-border)]">
              <button
                onClick={() => setAdvDis('advantage')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  advDis === 'advantage' ? 'bg-emerald-600 text-white' : 'text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)]'
                }`}
                title="Roll with Advantage (Roll 2d20, take highest)"
              >
                ADV
              </button>
              <button
                onClick={() => setAdvDis('normal')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  advDis === 'normal' ? 'bg-[var(--rp-leather-600)] text-white' : 'text-[var(--rp-parchment-300)] opacity-70 hover:opacity-100'
                }`}
              >
                NORM
              </button>
              <button
                onClick={() => setAdvDis('disadvantage')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  advDis === 'disadvantage' ? 'bg-rose-600 text-white' : 'text-[var(--rp-parchment-300)] hover:text-[var(--rp-parchment-100)]'
                }`}
                title="Roll with Disadvantage (Roll 2d20, take lowest)"
              >
                DIS
              </button>
            </div>

            {/* Whisper to GM Toggle */}
            <button
              onClick={() => setIsWhisper(!isWhisper)}
              className={`flex items-center space-x-1 px-2 py-0.5 rounded border text-[10px] font-bold transition cursor-pointer ${
                isWhisper ? 'bg-[var(--rp-leather-700)] text-[var(--rp-parchment-200)] border-[var(--tavern-accent)]/60' : 'bg-black/30 text-[var(--rp-parchment-300)] border-[var(--tavern-border)]'
              }`}
              title="Whisper roll results privately to the Dungeon Master"
            >
              {isWhisper ? <EyeOff className="w-3 h-3 text-[var(--tavern-accent)]" /> : <Eye className="w-3 h-3" />}
              <span>{isWhisper ? 'Whisper GM' : 'Public'}</span>
            </button>

            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-[var(--rp-parchment-300)] opacity-70 hover:opacity-100 transition cursor-pointer"
            >
              {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Expanded Quick Macro Buttons & Custom Formula */}
        {isExpanded && (
          <div className="flex flex-wrap items-center justify-center gap-1.5 w-full pt-1">
            {quickMacros.map((macro) => (
              <button
                key={macro.name}
                onClick={() => handleTriggerQuickMacro(macro.name, macro.formula)}
                className="flex items-center space-x-1 px-2.5 py-1.5 bg-black/30 hover:bg-[var(--rp-leather-700)] border border-[var(--tavern-border)] hover:border-[var(--tavern-accent)]/50 rounded-lg text-[11px] font-mono font-medium text-[var(--rp-parchment-200)] hover:text-amber-200 transition-all cursor-pointer shadow-sm group active:scale-95"
              >
                {macro.icon}
                <span>{macro.name}</span>
                <span className="text-[9px] opacity-60 font-normal">({macro.formula})</span>
              </button>
            ))}

            {/* Custom Formula Input */}
            <form onSubmit={handleCustomSubmit} className="flex items-center space-x-1 ml-1">
              <input
                type="text"
                id="macro-custom-formula"
                name="custom-formula"
                aria-label="Custom dice formula"
                placeholder="/roll 2d6 + 4"
                value={customFormula}
                onChange={(e) => setCustomFormula(e.target.value)}
                className="w-28 bg-black/30 border border-[var(--tavern-border)] rounded-lg px-2 py-1 text-[11px] font-mono text-[var(--rp-parchment-100)] focus:outline-none focus:border-amber-500"
              />
              <button
                type="submit"
                className="p-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition cursor-pointer"
                title="Roll Custom Expression"
              >
                <Send className="w-3 h-3" />
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
};
