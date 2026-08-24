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

const CRIMSON_TEXT = 'var(--statblock-header)'; /* --rp-crimson-600 — safe crimson text on parchment */
const INK_MUTED = 'color-mix(in srgb, var(--parchment-ink) 65%, transparent)';

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
  const [isSpeechActive, setIsSpeechActive] = useState(false);
  const [vadReady, setVadReady] = useState(false);
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
      setIsSpeechActive(false);
      setVadReady(false);
      globalAudio.playTurnAdvance();
      const started = await globalVoiceCapture.startRecording({
        onVolumeUpdate: (volume) => setVoiceVolume(volume),
        // Real Silero VAD speech events — drive an honest indicator only.
        onSpeechStart: () => setIsSpeechActive(true),
        onSpeechEnd: () => setIsSpeechActive(false),
      });
      if (!started) {
        // Microphone inaccessible — do not pretend a session is live.
        setIsRecording(false);
        setVoiceVolume(0);
      } else {
        setVadReady(globalVoiceCapture.isUsingNeuralVad());
      }
    } else {
      setIsRecording(false);
      setIsSpeechActive(false);
      globalVoiceCapture.stopRecording();
      setVoiceVolume(0);
      // No transcription backend exists in this client, so a recorded segment
      // produces NO chat text. Never fabricate utterances on the player's behalf.
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

  const channels: Array<{ id: ChatChannel; label: string; icon: React.ReactNode }> = [
    { id: 'all', label: 'All Table', icon: <MessageSquare className="w-3 h-3" /> },
    { id: 'party', label: 'Party', icon: <Users className="w-3 h-3" /> },
    { id: 'gm', label: 'GM Whispers', icon: <Lock className="w-3 h-3" /> },
    { id: 'combat', label: 'Combat Log', icon: <Dices className="w-3 h-3" /> },
  ];

  return (
    <div className="h-60 border-t border-tavern-border bg-tavern-bg/95 flex flex-col text-[var(--rp-parchment-200)] shadow-2xl shrink-0 select-none">
      {/* Top Telemetry Strip & Channel Tabs */}
      <div className="h-8 px-3 border-b border-tavern-border bg-tavern-surface/60 flex items-center justify-between text-[11px] shrink-0">
        <div className="vtt-tabbar">
          {channels.map(({ id, label, icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveChannel(id)}
              data-active={activeChannel === id}
              title={label}
              className={`vtt-tab ${activeChannel === id ? '' : 'cursor-pointer'} flex items-center gap-1 text-[10px] font-semibold`}
            >
              {icon}
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {onBroadcastPing && (
            <button
              onClick={() => {
                onBroadcastPing();
                globalAudio.playTurnAdvance();
              }}
              className="vtt-btn vtt-btn-secondary"
              style={{ padding: '0.15rem 0.5rem', fontSize: '10px' }}
              title="Broadcast tactical beacon ping to party"
            >
              <MapPin className="w-3 h-3 text-tavern-accent animate-bounce" />
              <span className="hidden sm:inline">Map Ping</span>
            </button>
          )}

          <div className="flex items-center gap-1.5 text-[10px] text-[var(--rp-parchment-300)]">
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ backgroundColor: 'var(--state-success)' }}
            />
            <span>Thorin (50%) · Lyra (50%)</span>
          </div>
        </div>
      </div>

      {/* Narrative Messages Stream */}
      <div className="flex-1 p-3 overflow-y-auto space-y-2">
        {filteredMessages.map((msg) => {
          const isDm = msg.role === 'dm';
          const isSystem = msg.role === 'system';
          const isWhisper = msg.channel === 'gm';
          // In-world prose (GM narration / whispers) prints on paper; table chatter
          // stays on dark tavern chrome.
          const onPaper = (isDm || isWhisper) && !isSystem;

          return (
            <div
              key={msg.id}
              className={`rounded-lg p-2 transition-all ${
                onPaper ? 'vtt-parchment' : 'vtt-surface'
              }`}
              style={
                isWhisper
                  ? { borderColor: 'color-mix(in srgb, var(--statblock-header) 55%, transparent)' }
                  : undefined
              }
            >
              <div className="flex items-center justify-between mb-1 text-[10px]">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className="font-display uppercase tracking-widest font-semibold"
                    style={{
                      color: onPaper
                        ? CRIMSON_TEXT
                        : isSystem
                        ? 'var(--tavern-accent)'
                        : 'var(--rp-parchment-300)',
                    }}
                  >
                    {msg.sender}
                  </span>
                  {isWhisper && (
                    <span className="vtt-badge-danger" style={{ fontSize: '9px', padding: '0.05rem 0.4rem' }}>
                      Secret Whisper
                    </span>
                  )}
                  {msg.channel && msg.channel !== 'all' && !isWhisper && (
                    <span
                      className="vtt-badge"
                      style={{ fontSize: '9px', padding: '0.05rem 0.4rem', textTransform: 'uppercase' }}
                    >
                      {msg.channel}
                    </span>
                  )}
                </div>
                <span style={{ color: onPaper ? INK_MUTED : 'var(--rp-parchment-300)' }}>{msg.timestamp}</span>
              </div>

              {/* Drop cap only on scene-setting GM prose, never on chat chatter. */}
              <div
                className={`leading-relaxed selectable-text ${
                  onPaper ? 'font-prose text-sm vtt-dropcap' : 'text-xs'
                }`}
                style={!onPaper ? { color: 'var(--rp-parchment-200)' } : undefined}
              >
                {msg.content}
              </div>

              {msg.diceRollDetails && (
                <div className="mt-1.5 flex items-center flex-wrap gap-x-2 gap-y-1">
                  <span className="vtt-badge" style={{ fontSize: '10px' }}>
                    <Dices className="w-3 h-3" style={{ color: onPaper ? CRIMSON_TEXT : 'var(--tavern-accent)' }} />
                    {msg.diceRollDetails.expression}
                  </span>
                  <span
                    className={`${onPaper ? 'vtt-badge-success' : 'vtt-badge'}`}
                    style={{ fontSize: '10px' }}
                  >
                    Total: {msg.diceRollDetails.total}
                  </span>
                  <span
                    className="text-[10px]"
                    style={{ color: onPaper ? INK_MUTED : 'var(--rp-parchment-300)', fontFamily: 'var(--font-serif-prose)' }}
                  >
                    [{msg.diceRollDetails.rolls.join(', ')}]
                  </span>
                </div>
              )}
            </div>
          );
        })}

        {/* Live Peer Typing Indicator */}
        {(activePeerTyping || isStreamingResponse) && (
          <div className="vtt-surface rounded-lg p-2 flex items-center gap-2 text-xs animate-pulse">
            <Sparkles className="w-3.5 h-3.5 text-tavern-accent animate-spin" />
            <span className="text-[var(--rp-parchment-200)]">
              {activePeerTyping ? `${activePeerTyping} is typing...` : 'AI Narrative Director is forging story...'}
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Message Input & Action Bar */}
      <form onSubmit={handleSend} className="p-2 border-t border-tavern-border bg-tavern-surface/80 flex items-center gap-2">
        <div className="relative flex items-center">
          {/* Live volume ring driven by real mic amplitude (RMS meter). */}
          {isRecording && (
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full pointer-events-none transition-[box-shadow] duration-100"
              style={{
                boxShadow: `0 0 0 2px color-mix(in srgb, var(--state-danger) ${Math.min(voiceVolume, 100)}%, transparent)`,
              }}
            />
          )}
          <button
            type="button"
            onClick={toggleRecording}
            className={`vtt-btn ${isRecording ? 'vtt-btn-danger' : 'vtt-btn-secondary'}`}
            style={{ padding: '0.45rem' }}
            title={
              isRecording
                ? vadReady
                  ? 'Stop Recording (Silero VAD active)'
                  : 'Stop Recording (amplitude-only mode — no speech detection)'
                : 'Push-to-Talk (Microphone Ingestion)'
            }
          >
            {isRecording ? <MicOff className="w-4 h-4 animate-pulse" /> : <Mic className="w-4 h-4" />}
          </button>
        </div>

        {isRecording && (
          <span
            className={`text-[10px] font-semibold uppercase tracking-wide ${
              isSpeechActive ? 'text-[var(--state-success)]' : 'opacity-60'
            }`}
            role="status"
            aria-live="polite"
          >
            {isSpeechActive ? (
              <>
                <Volume2 className="w-3 h-3 inline mr-1" />
                Speaking…
              </>
            ) : (
              'Listening…'
            )}
          </span>
        )}

        <input
          type="text"
          id="narrative-chat-input"
          name="chat-message"
          aria-label="Chat message"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={
            activeChannel === 'gm'
              ? 'Whisper secretly to Dungeon Master...'
              : activeChannel === 'party'
              ? 'Speak to party members...'
              : "Declare action (e.g. 'I cast Fireball at the warlord', 'I roll Athletics to leap')..."
          }
          className="vtt-input flex-1 text-xs font-prose"
        />

        <button
          type="submit"
          disabled={!inputText.trim()}
          className="vtt-btn vtt-btn-primary disabled:opacity-30 disabled:cursor-not-allowed text-xs"
          style={{ padding: '0.35rem 0.8rem' }}
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
};

export default NarrativeChat;
