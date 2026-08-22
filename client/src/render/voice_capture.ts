export class VoiceCaptureManager {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private dataArray: Uint8Array | null = null;
  private isRecording: boolean = false;
  private simulatedInterval: number | null = null;
  private simulatedVolume: number = 0;

  public async startRecording(onVolumeUpdate?: (volume: number) => void): Promise<boolean> {
    this.isRecording = true;

    try {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        this.audioCtx = new AudioCtx();
        const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 64;
        source.connect(this.analyser);

        const bufferLength = this.analyser.frequencyBinCount;
        this.dataArray = new Uint8Array(bufferLength);

        const checkVolume = () => {
          if (!this.isRecording || !this.analyser || !this.dataArray) return;
          this.analyser.getByteFrequencyData(this.dataArray as any);
          let sum = 0;
          for (let i = 0; i < this.dataArray.length; i++) {
            sum += this.dataArray[i];
          }
          const avg = sum / this.dataArray.length;
          const normalized = Math.min(100, Math.round((avg / 128) * 100));
          if (onVolumeUpdate) onVolumeUpdate(normalized);
          requestAnimationFrame(checkVolume);
        };
        checkVolume();
        return true;
      }
    } catch (e) {
      console.warn('[VoiceCapture] Hardware microphone not accessible, starting simulated speech pulse:', e);
    }

    // Fallback Simulated Speech Pulse
    this.simulatedInterval = window.setInterval(() => {
      if (!this.isRecording) return;
      this.simulatedVolume = Math.floor(Math.random() * 65) + 20;
      if (onVolumeUpdate) onVolumeUpdate(this.simulatedVolume);
    }, 100);

    return true;
  }

  public stopRecording(): void {
    this.isRecording = false;

    if (this.simulatedInterval) {
      clearInterval(this.simulatedInterval);
      this.simulatedInterval = null;
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
}

export const globalVoiceCapture = new VoiceCaptureManager();
