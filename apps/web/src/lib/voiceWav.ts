/** Speech models downsample to 16 kHz mono anyway, so the upload carries nothing more. */
export const VOICE_WAV_SAMPLE_RATE = 16_000;

const WAV_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/** Canonical 44-byte RIFF header followed by little-endian 16-bit mono PCM. */
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

/**
 * Every provider gets the same 16 kHz mono WAV. xAI rejects WebM, which is the only
 * container Chromium's MediaRecorder produces, and a local whisper.cpp server would
 * otherwise need ffmpeg to read the browser's upload.
 */
export async function convertRecordingToWav(recording: Blob): Promise<Blob> {
  const encoded = await recording.arrayBuffer();
  const decoder = new OfflineAudioContext({
    numberOfChannels: 1,
    length: 1,
    sampleRate: VOICE_WAV_SAMPLE_RATE,
  });
  const decoded = await decoder.decodeAudioData(encoded);
  const resampler = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.max(1, Math.ceil(decoded.duration * VOICE_WAV_SAMPLE_RATE)),
    sampleRate: VOICE_WAV_SAMPLE_RATE,
  });
  const source = resampler.createBufferSource();
  source.buffer = decoded;
  source.connect(resampler.destination);
  source.start();
  const rendered = await resampler.startRendering();
  return new Blob([encodeWavPcm16(rendered.getChannelData(0), VOICE_WAV_SAMPLE_RATE)], {
    type: "audio/wav",
  });
}
