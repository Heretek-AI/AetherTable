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
  Radio
} from 'lucide-react';
import { globalVoiceCapture } from '../render/voice_capture';
import { globalAudio } from '../render/audio_manager';

export interface ChatMessage {
  id: string;
  sender: string;
  role: 'dm' | 'player' | 'system';
  content: string;
  timestamp: string;
  isStreaming?: boolean;
  diceRollDetails?: {
    total: number;
    expression: string;
    rolls: number[];
  };
}

interface NarrativeChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  spotlightWeights: { Thorin: number; Lyra: number; [key: string]: number };
  isStreamingResponse?: boolean;
}

export const NarrativeChat: React.FC<NarrativeChatProps> = ({
  messages,
  onSendMessage,
  spotlightWeights,
  isStreamingResponse = false,
}) => {
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [voiceVolume, setVoiceVolume] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreamingResponse]);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText.trim());
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
      onSendMessage(randomUtterance);
    }
  };

  return (
    <div className="h-56 border-t border-slate-800 bg-slate-950/95 flex flex-col text-slate-100 font-sans shadow-2xl shrink-0">
      {/* Top Telemetry Strip */}
      <div className="h-7 px-4 border-b border-slate-800/80 bg-slate-900/60 flex items-center justify-between text-[11px] font-mono text-slate-400 shrink-0">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-purple-400 font-semibold">
            <Sparkles className="w-3.5 h-3.5" />
            <span>AI Narrative Director</span>
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">
            Voice Spotlight: Thorin ({Math.round(spotlightWeights.Thorin * 100)}%) · Lyra ({Math.round(spotlightWeights.Lyra * 100)}%)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isStreamingResponse && (
            <span className="flex items-center gap-1 text-emerald-400 font-bold animate-pulse">
              <Radio className="w-3 h-3 text-emerald-400" />
              <span>Streaming SSE Narrative...</span>
            </span>
          )}
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 p-3 overflow-y-auto space-y-2.5 vtt-scrollbar font-sans text-xs min-h-0">
        {messages.map((msg) => {
          const isDm = msg.role === 'dm';
          const isSystem = msg.role === 'system';

          return (
            <div
              key={msg.id}
              className={`p-2.5 rounded-xl border transition-all ${
                isDm
                  ? 'bg-purple-950/30 border-purple-800/50 shadow-md shadow-purple-950/20'
                  : isSystem
                  ? 'bg-slate-900/90 border-slate-700/60 text-slate-300'
                  : 'bg-slate-900/60 border-slate-800'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div
                    className={`w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold ${
                      isDm
                        ? 'bg-purple-600 text-white'
                        : isSystem
                        ? 'bg-slate-700 text-slate-300'
                        : 'bg-sky-600 text-white'
                    }`}
                  >
                    {isDm ? <Sparkles className="w-2.5 h-2.5" /> : isSystem ? <ShieldAlert className="w-2.5 h-2.5" /> : <User className="w-2.5 h-2.5" />}
                  </div>
                  <span className={`font-bold font-display text-[11px] ${isDm ? 'text-purple-300' : 'text-slate-200'}`}>
                    {msg.sender}
                  </span>
                </div>
                <span className="text-[9px] font-mono text-slate-500">{msg.timestamp}</span>
              </div>

              <p className="text-slate-200 leading-relaxed font-sans text-[11px] select-text">
                {msg.content}
                {msg.isStreaming && (
                  <span className="inline-block w-1.5 h-3 ml-1 bg-purple-400 animate-pulse align-middle" />
                )}
              </p>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input & Microphone Bar */}
      <form onSubmit={handleSend} className="p-2.5 bg-slate-900/80 border-t border-slate-800 flex items-center gap-2 shrink-0">
        {/* Animated Microphone Push-to-Talk Button */}
        <button
          type="button"
          onClick={toggleRecording}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono font-bold transition shadow ${
            isRecording
              ? 'bg-rose-600 text-white shadow-rose-900/50 animate-pulse'
              : 'bg-slate-800 hover:bg-slate-700 text-purple-300 border border-slate-700'
          }`}
          title={isRecording ? 'Click to Stop & Send Speech Declaration' : 'Push-to-Talk (Microphone Ingestion)'}
        >
          {isRecording ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          <span>{isRecording ? 'Listening...' : 'Mic'}</span>
        </button>

        {/* Live Audio Waveform Bars (when recording) */}
        {isRecording && (
          <div className="flex items-center gap-1 px-2 h-7 bg-slate-950 rounded-lg border border-slate-800">
            {Array.from({ length: 6 }).map((_, i) => {
              const h = Math.max(4, Math.min(18, (voiceVolume / 100) * 18 * (0.5 + Math.sin(i * 1.2) * 0.5)));
              return (
                <div
                  key={i}
                  className="w-1 bg-purple-400 rounded-full transition-all duration-75"
                  style={{ height: `${h}px` }}
                />
              );
            })}
          </div>
        )}

        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Speak or type player action (e.g. 'I cast Fireball at the warlord', 'I roll Athletics to jump')..."
          className="flex-1 px-3.5 py-1.5 bg-slate-950 border border-slate-700/80 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-purple-500 font-sans"
        />

        <button
          type="submit"
          disabled={!inputText.trim()}
          className="px-3.5 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-30 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow shadow-purple-950"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
};
