import React, { useState } from 'react';
import { Send, Bot, Dices, Volume2, Sparkles, ChevronUp, ChevronDown, User, MessageSquare } from 'lucide-react';

export interface ChatMessage {
  id: string;
  sender: string;
  role: 'dm' | 'player' | 'system';
  content: string;
  timestamp: string;
  diceRollDetails?: {
    total: number;
    expression: string;
    rolls: number[];
  };
}

interface NarrativeChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  spotlightWeights: { [player: string]: number };
}

export const NarrativeChat: React.FC<NarrativeChatProps> = ({
  messages,
  onSendMessage,
  spotlightWeights,
}) => {
  const [inputText, setInputText] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) {
      onSendMessage(inputText.trim());
      setInputText('');
    }
  };

  return (
    <footer aria-label="Narrative & Chat Panel" className={`vtt-glass-panel border-t border-slate-800/80 flex flex-col justify-between transition-all shrink-0 ${
      isExpanded ? 'h-80' : 'h-56'
    }`}>
      {/* Top Banner: Voice Spotlight Agency Monitor & Expand Toggle */}
      <div className="px-4 py-1.5 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
        <div className="flex items-center gap-2 text-slate-400">
          <Volume2 className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-slate-300 font-semibold">Conversational Agency:</span>
        </div>

        {/* Agency Distribution Gauges */}
        <div className="flex items-center gap-4">
          {Object.entries(spotlightWeights).map(([player, weight]) => (
            <div key={player} className="flex items-center gap-1.5">
              <span className="text-slate-400 text-[11px]">{player}:</span>
              <div className="w-14 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-indigo-500 transition-all duration-300"
                  style={{ width: `${Math.round(weight * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-slate-400 font-semibold">{Math.round(weight * 100)}%</span>
            </div>
          ))}

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 text-slate-400 hover:text-white transition"
            title={isExpanded ? 'Collapse Log' : 'Expand Log'}
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 p-3 overflow-y-auto vtt-scrollbar space-y-2">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`p-2.5 rounded-xl text-xs leading-relaxed max-w-4xl transition-all ${
              msg.role === 'dm'
                ? 'bg-purple-950/30 border border-purple-900/40 text-slate-100 shadow-sm'
                : msg.role === 'system'
                ? 'bg-slate-900/80 border border-slate-800 text-sky-300 font-mono text-[11px]'
                : 'bg-slate-900/60 border border-slate-800/80 text-slate-200 ml-6'
            }`}
          >
            <div className="flex items-center justify-between mb-1 text-[10px] font-mono">
              <span className="font-bold flex items-center gap-1.5 text-purple-300">
                {msg.role === 'dm' ? <Bot className="w-3.5 h-3.5 text-purple-400" /> : <User className="w-3.5 h-3.5 text-sky-400" />}
                {msg.sender}
              </span>
              <span className="text-slate-500">{msg.timestamp}</span>
            </div>
            <div className="font-sans leading-normal">{msg.content}</div>

            {/* Attached Dice Breakdown */}
            {msg.diceRollDetails && (
              <div className="mt-2 p-2 bg-slate-950/90 rounded-lg border border-slate-800/90 flex items-center gap-2.5 font-mono text-[11px] text-amber-300 animate-dice-roll">
                <Dices className="w-4 h-4 text-amber-400 shrink-0" />
                <span className="font-bold">Roll Total: {msg.diceRollDetails.total}</span>
                <span className="text-slate-500 text-[10px]">
                  Formula: {msg.diceRollDetails.expression} → [{msg.diceRollDetails.rolls.join(', ')}]
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input Bar */}
      <form onSubmit={handleSubmit} className="p-2.5 bg-slate-950/90 border-t border-slate-800/80 flex gap-2">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Speak in-character or declare action (e.g. 'I cast Fireball at the warlord', 'I leap across the chasm')..."
          className="flex-1 px-3 py-1.5 bg-slate-900 border border-slate-700/80 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500 font-sans"
        />
        <button
          type="submit"
          className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shadow-md shadow-purple-950 border border-purple-400/30"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send</span>
        </button>
      </form>
    </footer>
  );
};
