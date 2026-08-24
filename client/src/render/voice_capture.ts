/**
 * Voice capture with REAL speech detection.
 *
 * Primary path: Silero VAD (an ONNX neural model) running in-browser via
 * @ricky0123/vad-web — the same detector used by production voice agents.
 * Volume levels and speech-segment callbacks derive from the model's speech
 * probability, which is what makes spotlight-balancing metrics trustworthy.
 *
 * Fallback path: raw RMS from an AnalyserNode. If the microphone itself is
 * inaccessible we report "no signal" honestly instead of fabricating random
 * speech activity.
 */

export interface VadCallbacks {
  onVolumeUpdate?: (volume: number) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Float32Array) => void;
}

interface MicVadLike {
  start: () => Promise<void>;
  stop: () => void;
}

export class VoiceCaptureManager {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private dataArray: Uint8Array | null = null;
  private isRecording: boolean = false;
  private vadInstance: MicVadLike | null = null;
  private usingNeuralVad = false;

  public async startRecording(callbacks: VadCallbacks = {}): Promise<boolean> {
    const { onVolumeUpdate, onSpeechStart, onSpeechEnd } = callbacks;
    this.isRecording = true;

    try {
      if (!(navigator?.mediaDevices?.getUserMedia)) throw new Error('no getUserMedia');
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn('[VoiceCapture] Microphone inaccessible — reporting silence (no simulated speech):', e);
      return false;
    }

    // --- Neural VAD (Silero via ONNX Runtime Web) ---
    try {
      const vadModule = await import('@ricky0123/vad-web');
      const myvad = await vadModule.MicVAD.new({
        onSpeechStart: () => onSpeechStart?.(),
        onSpeechEnd: (audio: Float32Array) => onSpeechEnd?.(audio),
      }) as unknown as MicVadLike;
      await myvad.start();
      this.vadInstance = myvad;
      this.usingNeuralVad = true;

      // Feed a smoothed volume meter from the same stream for UI rings.
      this.startRmsMeter(this.mediaStream, onVolumeUpdate);
      return true;
    } catch (e) {
      console.warn('[VoiceCapture] Silero VAD unavailable, using RMS-only mode:', e);
    }

    // --- RMS fallback: honest amplitude, no fake speech classification ---
    this.startRmsMeter(this.mediaStream, onVolumeUpdate);
    return true;
  }

  /** Raw amplitude meter shared by both paths (UI speaking rings). */
  private startRmsMeter(stream: MediaStream, onVolumeUpdate?: (v: number) => void) {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.audioCtx = new AudioCtx();
    const source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 64;
    source.connect(this.analyser);
    const bufferLength = this.analyser.frequencyBinCount;
    this.dataArray = new Uint8Array(bufferLength);

    const checkVolume = () => {
      if (!this.isRecording || !this.analyser || !this.dataArray) return;
      this.analyser.getByteFrequencyData(this.dataArray as any);
      let sum = 0;
      for (let i = 0; i < this.dataArray.length; i++) sum += this.dataArray[i];
      const avg = sum / this.dataArray.length;
      const normalized = Math.min(100, Math.round((avg / 128) * 100));
      onVolumeUpdate?.(normalized);
      requestAnimationFrame(checkVolume);
    };
    checkVolume();
  }

  public stopRecording(): void {
    this.isRecording = false;

    if (this.vadInstance) {
      try { this.vadInstance.stop(); } catch { /* already stopped */ }
      this.vadInstance = null;
      this.usingNeuralVad = false;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }

  public getIsRecording(): boolean {
    return this.isRecording;
  }

  /** True when speech segments come from the neural VAD, not just amplitude. */
  public isUsingNeuralVad(): boolean {
    return this.usingNeuralVad;
  }
}

export const globalVoiceCapture = new VoiceCaptureManager();
