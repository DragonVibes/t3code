export const VOICE_WAV_SAMPLE_RATE = 16_000;

const WAV_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

export function encodeWavPcm16(samples: ArrayLike<number>, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(
      WAV_HEADER_BYTES + index * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }
  return buffer;
}

export function downmixToMono(audio: AudioBuffer): Float32Array {
  const mono = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    const samples = audio.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) {
      mono[index] = (mono[index] ?? 0) + (samples[index] ?? 0) / audio.numberOfChannels;
    }
  }
  return mono;
}

/**
 * Every provider gets the same 16 kHz mono WAV. xAI rejects WebM, Chromium's default
 * MediaRecorder container, and a local whisper.cpp server would otherwise need ffmpeg
 * to read the browser's upload. decodeAudioData resamples to its context's rate, so a
 * 16 kHz offline context does the conversion itself.
 */
export async function convertRecordingToWav(recording: Blob): Promise<Blob> {
  const decoder = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 1,
    sampleRate: VOICE_WAV_SAMPLE_RATE,
  });
  const decoded = await decoder.decodeAudioData(await recording.arrayBuffer());
  return new Blob([encodeWavPcm16(downmixToMono(decoded), VOICE_WAV_SAMPLE_RATE)], {
    type: "audio/wav",
  });
}
