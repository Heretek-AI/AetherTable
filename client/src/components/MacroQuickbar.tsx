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
  const [isExpanded, setIsExpanded] = useState<boolean>(true);

  const quickMacros = [
    { name: 'Initiative', formula: '1d20 + 2', icon: <Zap className="w-3 h-3 text-amber-400" /> },
    { name: 'Perception', formula: '1d20 + 1', icon: <Eye className="w-3 h-3 text-sky-400" /> },
    { name: 'Stealth', formula: '1d20 + 2', icon: <EyeOff className="w-3 h-3 text-purple-400" /> },
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
    <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 transition-all select-none">
      <div className="bg-slate-950/95 border border-slate-800/90 shadow-2xl rounded-2xl p-2.5 backdrop-blur-md flex flex-col items-center gap-2 max-w-2xl w-full">
        {/* Toggle Collapse Bar */}
        <div className="flex items-center justify-between w-full px-2 text-[10px] font-mono text-slate-400 border-b border-slate-800/60 pb-1.5">
          <div className="flex items-center space-x-2">
            <Dices className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-bold tracking-wider uppercase text-slate-300">Roll20 Macro Quickbar</span>
          </div>

          <div className="flex items-center space-x-3">
            {/* Advantage / Disadvantage Toggle */}
            <div className="flex bg-slate-900 rounded-lg p-0.5 border border-slate-800">
              <button
                onClick={() => setAdvDis('advantage')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  advDis === 'advantage' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Roll with Advantage (Roll 2d20, take highest)"
              >
                ADV
              </button>
              <button
                onClick={() => setAdvDis('normal')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  advDis === 'normal' ? 'bg-slate-750 text-slate-200' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                NORM
              </button>
              <button
                onClick={() => setAdvDis('disadvantage')}
                className={`px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
                  advDis === 'disadvantage' ? 'bg-rose-600 text-white' : 'text-slate-400 hover:text-slate-200'
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
                isWhisper ? 'bg-purple-950 text-purple-300 border-purple-600' : 'bg-slate-900 text-slate-400 border-slate-800'
              }`}
              title="Whisper roll results privately to the Dungeon Master"
            >
              {isWhisper ? <EyeOff className="w-3 h-3 text-purple-400" /> : <Eye className="w-3 h-3" />}
              <span>{isWhisper ? 'Whisper GM' : 'Public'}</span>
            </button>

            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-slate-500 hover:text-slate-300 transition cursor-pointer"
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
                className="flex items-center space-x-1 px-2.5 py-1.5 bg-slate-900/90 hover:bg-slate-800 border border-slate-800 hover:border-amber-500/50 rounded-lg text-[11px] font-mono font-medium text-slate-200 hover:text-amber-200 transition-all cursor-pointer shadow-sm group active:scale-95"
              >
                {macro.icon}
                <span>{macro.name}</span>
                <span className="text-[9px] text-slate-500 font-normal">({macro.formula})</span>
              </button>
            ))}

            {/* Custom Formula Input */}
            <form onSubmit={handleCustomSubmit} className="flex items-center space-x-1 ml-1">
              <input
                type="text"
                placeholder="/roll 2d6 + 4"
                value={customFormula}
                onChange={(e) => setCustomFormula(e.target.value)}
                className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[11px] font-mono text-slate-200 focus:outline-none focus:border-amber-500"
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
