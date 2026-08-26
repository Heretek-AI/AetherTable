import React, { useState, useRef, useEffect, useMemo } from 'react';
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
  MapPin,
  X
} from 'lucide-react';
import { globalVoiceCapture } from '../render/voice_capture';
import { globalAudio } from '../render/audio_manager';
import type { SpotlightView } from '../sync/speech_ledger';
import {
  MIN_TRANSCRIBABLE_MS,
  AudioSegmentBuffer,
  reduceVoiceTranscription,
  type VoiceTranscriptionEvent,
  type VoiceUtterance,
} from '../api/speech_transcription';
import { BrowserWhisperTranscriber } from '../api/browser_whisper';
import {
  ServerWhisperTranscriber,
  resolveSttEngine,
  type SttEngineChoice,
} from '../api/server_stt';

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
  /**
   * REAL spotlight balance derived from accumulated VAD speech seconds
   * (sync/speech_ledger.ts). `shares` is empty until somebody actually talks;
   * scope 'local-only' means no sync transport is carrying it to peers.
   */
  spotlightView: SpotlightView;
  /** Silero VAD burst started on this client's mic. */
  onSpeechStart?: () => void;
  /** Silero VAD burst ended; carries the raw audio buffer. */
  onSpeechSegment?: (audio: Float32Array) => void;
  /** Capture stopped (mic released) so any open burst can be closed out. */
  onCaptureStop?: () => void;
  isStreamingResponse?: boolean;
  activePeerTyping?: string | null;
  onBroadcastPing?: () => void;
  /**
   * GOALS.md Pillar 9 (iteration 68): broadcast-safe rendering for the
   * dedicated StreamerView. Hides the "GM Whispers" channel tab entirely (the
   * tab is a GM surface even when its log renders nothing) and pins the active
   * channel to public ones so no private affordance exists in the capture.
   * Default false — the seated table keeps every channel.
   */
  publicOnly?: boolean;
}

const CRIMSON_TEXT = 'var(--statblock-header)'; /* --rp-crimson-600 — safe crimson text on parchment */
const INK_MUTED = 'color-mix(in srgb, var(--parchment-ink) 65%, transparent)';
/** vad-web resamples the mic stream to 16 kHz mono before onSpeechEnd fires. */
const VOICE_SAMPLE_RATE = 16_000;

type ReduceVoice = (event: VoiceTranscriptionEvent) => void;

/**
 * Tiny inline glyph for the speaker-balance readout: a pulsing dot while real
 * speech data is flowing, a hollow one when the ledger is honestly empty.
 */
const BalanceGlyph: React.FC<{ active: boolean }> = ({ active }) => (
  <span
    aria-hidden="true"
    className={`w-1.5 h-1.5 rounded-full ${active ? 'animate-pulse' : ''}`}
    style={{
      backgroundColor: active ? 'var(--state-success)' : 'transparent',
      border: active ? 'none' : '1px solid var(--rp-parchment-300)',
    }}
  />
);

export const NarrativeChat: React.FC<NarrativeChatProps> = ({
  messages,
  onSendMessage,
  spotlightView,
  onSpeechStart,
  onSpeechSegment,
  onCaptureStop,
  isStreamingResponse = false,
  activePeerTyping = null,
  onBroadcastPing,
  publicOnly = false,
}) => {
  const [activeChannel, setActiveChannel] = useState<ChatChannel>('all');
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeechActive, setIsSpeechActive] = useState(false);
  const [vadReady, setVadReady] = useState(false);
  const [voiceVolume, setVoiceVolume] = useState(0);
  /** Voice drafts: captured VAD segments moving through transcription. */
  const [voiceUtterances, setVoiceUtterances] = useState<VoiceUtterance[]>([]);
  /**
   * Which STT engine this session uses (Loop 3 iteration 7). VITE_STT_ENGINE
   * decides; unset falls back to the legacy VITE_ENABLE_BROWSER_STT flag so
   * existing deployments keep their behaviour. Default 'off' — honest.
   */
  const sttEngine = useMemo<SttEngineChoice>(
    () => resolveSttEngine(import.meta.env.VITE_STT_ENGINE, import.meta.env.VITE_ENABLE_BROWSER_STT),
    [],
  );
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  /**
   * Lazily-created engine. Null ⇒ no STT this session (both env vars off)
   * and the UI says "transcription unavailable" instead of pretending audio
   * became text. The server path never constructs a BrowserWhisperTranscriber,
   * so no transformers chunk / model download ever happens on that route.
   */
  const voiceEngineRef = useRef<BrowserWhisperTranscriber | ServerWhisperTranscriber | null>(null);
  /** Retained mic audio for bursts still being transcribed (bounded). */
  const segmentBufferRef = useRef<AudioSegmentBuffer>(new AudioSegmentBuffer());

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreamingResponse, activePeerTyping]);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim()) return;
    onSendMessage(inputText.trim(), activeChannel);
    setInputText('');
  };

  const applyVoiceEvent: ReduceVoice = (event) =>
    setVoiceUtterances((prev) => reduceVoiceTranscription(prev, event).utterances);

  const ensureVoiceEngine = (): BrowserWhisperTranscriber | ServerWhisperTranscriber | null => {
    if (!voiceEngineRef.current) {
      switch (sttEngine) {
        case 'browser':
          voiceEngineRef.current = new BrowserWhisperTranscriber({ enabled: true });
          break;
        case 'server':
          // Gateway route: multipart wav upload, no client-side model weights.
          voiceEngineRef.current = new ServerWhisperTranscriber();
          break;
        default:
          voiceEngineRef.current = null;
      }
    }
    return voiceEngineRef.current;
  };

  /**
   * Iteration-39: the VAD burst used to be dropped here. Now it is retained
   * as wire-format audio, transcribed by the opt-in browser Whisper engine,
   * and surfaced ONLY as an editable draft — the player confirms before the
   * text enters the normal send pipeline. Raw STT never auto-submits.
   */
  const handleVoiceSegment = (audio: Float32Array) => {
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // vad-web delivers 16 kHz mono; duration derives from sample count.
    const durationMs = Math.round((audio.length / VOICE_SAMPLE_RATE) * 1000);
    if (durationMs < MIN_TRANSCRIBABLE_MS) return;

    const engine = ensureVoiceEngine();
    if (!engine) {
      applyVoiceEvent({
        type: 'SEGMENT',
        id,
        durationMs,
      });
      applyVoiceEvent({
        type: 'ENGINE_UNAVAILABLE',
        reason: `Transcription is off (set VITE_STT_ENGINE='browser' or 'server' to enable). Audio was counted for spotlight balance only.`,
      });
      return;
    }

    segmentBufferRef.current.retain(id, audio);
    applyVoiceEvent({ type: 'SEGMENT', id, durationMs });
    void engine.transcribe(audio).then((result) => {
      // Terminal state: the retained burst's job is done.
      segmentBufferRef.current.release(id);
      if (result.ok) {
        applyVoiceEvent({ type: 'TEXT_READY', id, text: result.text });
      } else {
        applyVoiceEvent({ type: 'FAILED', id, reason: result.reason });
      }
    });
  };

  /** KEEP: prefill the normal chat input with the shaped transcript. The
      user reviews/edits/sends through the existing intent pipeline — we
      never dispatch a spoken draft straight to the engine as an action. */
  const keepUtterance = (utterance: VoiceUtterance) => {
    const { utterances, keptText } = reduceVoiceTranscription(voiceUtterances, {
      type: 'KEEP',
      id: utterance.id,
    });
    setVoiceUtterances(utterances);
    if (!keptText) return;
    setInputText((prev) => (prev.trim() ? `${prev.trim()} ${keptText}` : keptText));
    document.getElementById('narrative-chat-input')?.focus();
  };

  const dismissUtterance = (utterance: VoiceUtterance) => {
    applyVoiceEvent({ type: 'DISMISS', id: utterance.id });
    segmentBufferRef.current.release(utterance.id);
  };

  const toggleRecording = async () => {
    if (!isRecording) {
      setIsRecording(true);
      setIsSpeechActive(false);
      setVadReady(false);
      globalAudio.playTurnAdvance();
      const started = await globalVoiceCapture.startRecording({
        onVolumeUpdate: (volume) => setVoiceVolume(volume),
        // Real Silero VAD speech events: drive the live indicator AND the
        // speech ledger that powers spotlight balance (App accumulates and
        // syncs them; we never fabricate utterance text).
        onSpeechStart: () => {
          setIsSpeechActive(true);
          onSpeechStart?.();
        },
        onSpeechEnd: (audio) => {
          setIsSpeechActive(false);
          onSpeechSegment?.(audio);
          // Previously discarded; now captured for opt-in transcription.
          handleVoiceSegment(audio);
        },
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
      // Let the ledger drop any burst that never saw onSpeechEnd, so no
      // phantom live tail keeps accruing after the mic is off.
      onCaptureStop?.();
      setVoiceVolume(0);
      // Release retained mic audio; transcription already in flight keeps its
      // own reference and still lands as a draft bubble.
      segmentBufferRef.current.releaseAll();
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
    // Pillar 9: the private channel affordance itself is a GM surface — the
    // streamer capture must not even show the tab. Omitted in publicOnly mode.
    ...(publicOnly
      ? []
      : [{ id: 'gm' as const, label: 'GM Whispers', icon: <Lock className="w-3 h-3" /> }]),
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

          {/* Speaker-balance indicator — real VAD-derived shares, or an honest
              empty state. Never seeded with demo speakers. */}
          <div
            className="flex items-center gap-1.5 text-[10px] text-[var(--rp-parchment-300)]"
            title={
              spotlightView.shares.length === 0
                ? 'Speaker balance: no speech detected yet'
                : 'Speaker balance from detected speech time' +
                  (spotlightView.scope === 'local-only' ? ' (this device only — not synced)' : '')
            }
          >
            <BalanceGlyph active={spotlightView.shares.length > 0} />
            {spotlightView.shares.length === 0 ? (
              <span className="opacity-60">No speech yet</span>
            ) : (
              <>
                {spotlightView.shares.slice(0, 3).map((w) => (
                  <span key={w.userId} className="whitespace-nowrap">
                    {w.name} ({Math.round(w.share * 100)}%)
                  </span>
                ))}
                {spotlightView.shares.length > 3 && (
                  <span className="opacity-60">+{spotlightView.shares.length - 3}</span>
                )}
                {spotlightView.scope === 'local-only' && (
                  <span
                    className="vtt-badge"
                    style={{ fontSize: '9px', padding: '0.05rem 0.4rem', textTransform: 'uppercase' }}
                  >
                    local only
                  </span>
                )}
              </>
            )}
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

      {/* Voice drafts (iteration-39): captured VAD bursts moving through
          opt-in on-device transcription. Nothing here is ever sent by itself —
          a ready draft must be loaded into the chat box, reviewed and sent
          through the normal pipeline by the player. */}
      {voiceUtterances.length > 0 && (
        <div className="px-2 pt-1.5 space-y-1" aria-live="polite">
          {voiceUtterances.map((u) => (
            <div
              key={u.id}
              role="status"
              className="vtt-surface rounded-lg p-1.5 flex items-center gap-2 text-[11px]"
              style={{ borderColor: 'color-mix(in srgb, var(--tavern-accent) 35%, transparent)' }}
            >
              <Mic className="w-3 h-3 shrink-0 text-tavern-accent" />
              {u.state === 'pending' && (
                <>
                  <span className="flex-1 opacity-70 animate-pulse">
                    {sttEngine === 'server' ? 'Transcribing via server…' : 'Transcribing speech…'}
                  </span>
                  <button
                    type="button"
                    onClick={() => dismissUtterance(u)}
                    title="Discard this voice capture"
                    className="opacity-60 hover:opacity-100 cursor-pointer shrink-0"
                    aria-label="Discard voice capture"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              )}
              {u.state === 'ready' && (
                <>
                  <span
                    className="flex-1 italic font-prose selectable-text"
                    style={{ fontFamily: 'var(--font-serif-prose)' }}
                  >
                    “{u.text}”
                  </span>
                  <span className="vtt-badge" style={{ fontSize: '9px', padding: '0.05rem 0.4rem' }}>
                    Voice draft — review before sending
                  </span>
                  <button
                    type="button"
                    onClick={() => keepUtterance(u)}
                    title="Load transcript into the chat box to edit and send"
                    className="vtt-btn vtt-btn-secondary"
                    style={{ padding: '0.15rem 0.5rem', fontSize: '10px' }}
                  >
                    Edit &amp; Send
                  </button>
                  <button
                    type="button"
                    onClick={() => dismissUtterance(u)}
                    title="Discard this draft"
                    className="opacity-60 hover:opacity-100 cursor-pointer shrink-0"
                    aria-label="Discard voice draft"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              )}
              {(u.state === 'failed' || u.state === 'unavailable') && (
                <>
                  <span className="flex-1 opacity-70">
                    {u.state === 'failed'
                      ? `Transcription failed: ${u.detail ?? 'unknown error'}`
                      : `Transcription unavailable: ${u.detail ?? 'no engine'}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => dismissUtterance(u)}
                    title="Dismiss notice"
                    className="opacity-60 hover:opacity-100 cursor-pointer shrink-0"
                    aria-label="Dismiss transcription notice"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

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
                  ? `Stop Recording (Silero VAD active${
                      sttEngine === 'browser'
                        ? ' · on-device transcription on'
                        : sttEngine === 'server'
                          ? ' · server transcription'
                          : ' · transcription off'
                    })`
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
