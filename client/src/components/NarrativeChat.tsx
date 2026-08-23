import React, { useState, useRef, useEffect } from 'react';
import { 
  Send, 
  Sparkles, 
  Terminal, 
  User, 
  ShieldAlert, 
  Mic, 
  MicOff, 
  Volume2, 
  Flame, 
  Skull,
  Radio,
  Lock,
  MessageSquare,
  Users,
  Dices,
  Eye,
  MapPin
} from 'lucide-react';
import { globalVoiceCapture } from '../render/voice_capture';
import { globalAudio } from '../render/audio_manager';

export type ChatChannel = 'all' | 'party' | 'gm' | 'combat';

export interface ChatMessage {
  id: string;
  sender: string;
  role: 'dm' | 'player' | 'system';
  content: string;
  timestamp: string;
  channel?: ChatChannel;
  recipient?: string;
  isStreaming?: boolean;
  diceRollDetails?: {
    total: number;
    expression: string;
    rolls: number[];
  };
}

interface NarrativeChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string, channel?: ChatChannel, recipient?: string) => void;
  spotlightWeights: { Thorin: number; Lyra: number; [key: string]: number };
  isStreamingResponse?: boolean;
  activePeerTyping?: string | null;
  onBroadcastPing?: () => void;
}

export const NarrativeChat: React.FC<NarrativeChatProps> = ({
  messages,
  onSendMessage,
  spotlightWeights,
  isStreamingResponse = false,
  activePeerTyping = null,
  onBroadcastPing,
}) => {
  const [activeChannel, setActiveChannel] = useState<ChatChannel>('all');
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [voiceVolume, setVoiceVolume] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreamingResponse, activePeerTyping]);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText.trim(), activeChannel);
    setInputText('');
  };

  const toggleRecording = async () => {
    if (!isRecording) {
      setIsRecording(true);
      globalAudio.playTurnAdvance();
      await globalVoiceCapture.startRecording((volume) => {
        setVoiceVolume(volume);
      });
    } else {
      setIsRecording(false);
      globalVoiceCapture.stopRecording();
      setVoiceVolume(0);
      globalAudio.playDiceRoll();

      // Dispatch spoken declaration
      const voiceUtterances = [
        "I charge forward with my greataxe raised and strike at the warlord!",
        "I cast Shield as a reaction to deflect the incoming missile!",
        "I examine the ancient runes carved into the sarcophagus lid.",
      ];
      const randomUtterance = voiceUtterances[Math.floor(Math.random() * voiceUtterances.length)];
      onSendMessage(randomUtterance, activeChannel);
    }
  };

  // Filter messages based on active channel
  const filteredMessages = messages.filter((msg) => {
    if (activeChannel === 'all') return true;
    if (activeChannel === 'party') return msg.role === 'player' || msg.channel === 'party';
    if (activeChannel === 'gm') return msg.channel === 'gm' || msg.sender.includes('DM') || msg.sender.includes('Auditor');
    if (activeChannel === 'combat') return !!msg.diceRollDetails || msg.content.includes('Damage') || msg.content.includes('Hit') || msg.content.includes('rolled');
    return true;
  });

  return (
    <div className="h-60 border-t border-slate-800 bg-slate-950/95 flex flex-col text-slate-100 font-sans shadow-2xl shrink-0 select-none">
      {/* Top Telemetry Strip & Channel Tabs */}
      <div className="h-8 px-3 border-b border-slate-800/80 bg-slate-900/60 flex items-center justify-between text-[11px] font-mono text-slate-400 shrink-0">
        <div className="flex items-center gap-1.5 bg-slate-950 p-0.5 rounded-lg border border-slate-800">
          <button
            onClick={() => setActiveChannel('all')}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
              activeChannel === 'all' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <MessageSquare className="w-3 h-3" />
            <span>All Table</span>
          </button>

          <button
            onClick={() => setActiveChannel('party')}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
              activeChannel === 'party' ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Users className="w-3 h-3" />
            <span>Party</span>
          </button>

          <button
            onClick={() => setActiveChannel('gm')}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
              activeChannel === 'gm' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Lock className="w-3 h-3" />
            <span>GM Whispers</span>
          </button>

          <button
            onClick={() => setActiveChannel('combat')}
            className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold transition cursor-pointer ${
              activeChannel === 'combat' ? 'bg-rose-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Dices className="w-3 h-3" />
            <span>Combat Log</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {onBroadcastPing && (
            <button
              onClick={() => {
                onBroadcastPing();
                globalAudio.playTurnAdvance();
              }}
              className="flex items-center space-x-1 px-2 py-0.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-amber-300 rounded text-[10px] font-bold transition cursor-pointer"
              title="Broadcast tactical beacon ping to party"
            >
              <MapPin className="w-3 h-3 text-amber-400 animate-bounce" />
              <span className="hidden sm:inline">Map Ping</span>
            </button>
          )}

          <div className="flex items-center gap-1.5 text-slate-500 font-mono text-[10px]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-slate-400">Thorin (50%) · Lyra (50%)</span>
          </div>
        </div>
      </div>

      {/* Narrative Messages Stream */}
      <div className="flex-1 p-3 overflow-y-auto space-y-2 text-xs font-mono">
        {filteredMessages.map((msg) => {
          const isDm = msg.role === 'dm';
          const isSystem = msg.role === 'system';
          const isWhisper = msg.channel === 'gm';

          return (
            <div
              key={msg.id}
              className={`p-2 rounded-xl border transition-all ${
                isWhisper
                  ? 'bg-purple-950/40 border-purple-500/50 shadow-md'
                  : isDm
                  ? 'bg-slate-900/90 border-slate-800 text-slate-200'
                  : isSystem
                  ? 'bg-amber-950/20 border-amber-500/30 text-amber-200'
                  : 'bg-slate-950 border-slate-850 text-slate-300'
              }`}
            >
              <div className="flex items-center justify-between mb-1 text-[10px]">
                <div className="flex items-center space-x-1.5">
                  <span
                    className={`font-bold ${
                      isWhisper
                        ? 'text-purple-300'
                        : isDm
                        ? 'text-amber-400'
                        : isSystem
                        ? 'text-sky-400'
                        : 'text-emerald-400'
                    }`}
                  >
                    {msg.sender}
                  </span>
                  {isWhisper && (
                    <span className="px-1.5 py-0.2 bg-purple-900 border border-purple-500/50 text-purple-200 rounded text-[9px] font-bold">
                      SECRET WHISPER
                    </span>
                  )}
                  {msg.channel && msg.channel !== 'all' && !isWhisper && (
                    <span className="px-1.5 py-0.2 bg-slate-800 rounded text-[9px] uppercase text-slate-400">
                      {msg.channel}
                    </span>
                  )}
                </div>
                <span className="text-slate-600">{msg.timestamp}</span>
              </div>

              <div className="leading-relaxed font-sans text-xs">{msg.content}</div>

              {msg.diceRollDetails && (
                <div className="mt-1.5 p-1.5 bg-slate-950 rounded-lg border border-slate-800 flex items-center space-x-2 text-[10px] font-mono">
                  <Dices className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-slate-400">Expression: {msg.diceRollDetails.expression}</span>
                  <span className="text-slate-600">•</span>
                  <span className="text-amber-300 font-bold">Total: {msg.diceRollDetails.total}</span>
                  <span className="text-slate-600">•</span>
                  <span className="text-slate-500">[{msg.diceRollDetails.rolls.join(', ')}]</span>
                </div>
              )}
            </div>
          );
        })}

        {/* Live Peer Typing Indicator */}
        {(activePeerTyping || isStreamingResponse) && (
          <div className="p-2 bg-slate-900/60 border border-slate-800 rounded-xl flex items-center space-x-2 text-xs font-mono text-purple-300 animate-pulse">
            <Sparkles className="w-3.5 h-3.5 text-purple-400 animate-spin" />
            <span>
              {activePeerTyping ? `${activePeerTyping} is typing...` : 'AI Narrative Director is forging story...'}
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Message Input & Action Bar */}
      <form onSubmit={handleSend} className="p-2 border-t border-slate-800/80 bg-slate-900/80 flex items-center gap-2">
        <button
          type="button"
          onClick={toggleRecording}
          className={`p-2 rounded-xl border transition cursor-pointer ${
            isRecording
              ? 'bg-red-600 text-white border-red-500 animate-pulse'
              : 'bg-slate-800 text-slate-300 border-slate-700 hover:text-white'
          }`}
          title={isRecording ? 'Stop Recording' : 'Push-to-Talk (Microphone Ingestion)'}
        >
          {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>

        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={
            activeChannel === 'gm'
              ? 'Whisper secretly to Dungeon Master...'
              : activeChannel === 'party'
              ? 'Speak to party members...'
              : "Declare action (e.g. 'I cast Fireball at the warlord', 'I roll Athletics to leap')..."
          }
          className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-amber-500 font-mono"
        />

        <button
          type="submit"
          disabled={!inputText.trim()}
          className="px-4 py-1.5 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 disabled:opacity-30 text-white text-xs font-bold font-mono rounded-xl shadow transition cursor-pointer flex items-center space-x-1"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
};

export default NarrativeChat;
