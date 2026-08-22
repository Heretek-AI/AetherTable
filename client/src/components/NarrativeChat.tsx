import React, { useState } from 'react';
import { Send, Bot, Dices, Volume2, Sparkles } from 'lucide-react';

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) {
      onSendMessage(inputText.trim());
      setInputText('');
    }
  };

  return (
    <div className="h-64 vtt-glass-panel border-t border-slate-800 flex flex-col justify-between">
      {/* Top Banner: Voice Spotlight Agency Monitor */}
      <div className="px-4 py-1.5 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between text-xs font-mono">
        <div className="flex items-center gap-2 text-slate-400">
          <Volume2 className="w-3.5 h-3.5 text-purple-400" />
          <span>Conversational Agency:</span>
        </div>
        <div className="flex items-center gap-3">
          {Object.entries(spotlightWeights).map(([player, weight]) => (
            <div key={player} className="flex items-center gap-1.5">
              <span className="text-slate-400">{player}:</span>
              <div className="w-12 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-500 transition-all"
                  style={{ width: `${Math.round(weight * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-slate-500">{Math.round(weight * 100)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 p-3 overflow-y-auto vtt-scrollbar space-y-2">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`p-2.5 rounded-lg text-xs leading-relaxed max-w-3xl ${
              msg.role === 'dm'
                ? 'bg-purple-950/30 border border-purple-900/50 text-slate-200'
                : msg.role === 'system'
                ? 'bg-slate-900/80 border border-slate-800 text-sky-300 font-mono'
                : 'bg-slate-900/50 border border-slate-800 text-slate-300 ml-6'
            }`}
          >
            <div className="flex items-center justify-between mb-1 text-[10px] font-mono">
              <span className="font-bold flex items-center gap-1 text-purple-300">
                {msg.role === 'dm' && <Bot className="w-3 h-3" />}
                {msg.sender}
              </span>
              <span className="text-slate-500">{msg.timestamp}</span>
            </div>
            <div>{msg.content}</div>

            {/* Dice Breakdown if attached */}
            {msg.diceRollDetails && (
              <div className="mt-1.5 p-1.5 bg-slate-950/80 rounded border border-slate-800 flex items-center gap-2 font-mono text-[11px] text-amber-300">
                <Dices className="w-3.5 h-3.5 text-amber-400" />
                <span>Result: {msg.diceRollDetails.total}</span>
                <span className="text-slate-500 text-[10px]">
                  ({msg.diceRollDetails.expression}: [{msg.diceRollDetails.rolls.join(', ')}])
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input Bar */}
      <form onSubmit={handleSubmit} className="p-2.5 bg-slate-950/90 border-t border-slate-800 flex gap-2">
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Speak in-character or declare action (e.g. 'I cast Fireball at the warlord')..."
          className="flex-1 px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500"
        />
        <button
          type="submit"
          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-medium flex items-center gap-1 transition"
        >
          <Send className="w-3.5 h-3.5" />
          Send
        </button>
      </form>
    </div>
  );
};
