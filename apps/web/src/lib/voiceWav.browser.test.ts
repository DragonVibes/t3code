import { describe, expect, it } from "vite-plus/test";

import { convertRecordingToWav, encodeWavPcm16, VOICE_WAV_SAMPLE_RATE } from "./voiceWav";

/** A one-second 440 Hz tone at 48 kHz, as a browser might hand back from a recording. */
function toneRecording(): Blob {
  const sampleRate = 48_000;
  const samples = Float32Array.from({ length: sampleRate }, (_, index) =>
    Math.sin((2 * Math.PI * 440 * index) / sampleRate),
  );
  return new Blob([encodeWavPcm16(samples, sampleRate)], { type: "audio/wav" });
}

describe("convertRecordingToWav", () => {
  it("resamples a recording to 16 kHz mono PCM WAV in Chromium", async () => {
    const wav = await convertRecordingToWav(toneRecording());
    const view = new DataView(await wav.arrayBuffer());

    expect(wav.type).toBe("audio/wav");
    expect(view.getUint32(24, true)).toBe(VOICE_WAV_SAMPLE_RATE);
    expect(view.getUint16(22, true)).toBe(1);
    const sampleCount = view.getUint32(40, true) / 2;
    expect(sampleCount).toBeGreaterThanOrEqual(VOICE_WAV_SAMPLE_RATE - 1);
    expect(sampleCount).toBeLessThanOrEqual(VOICE_WAV_SAMPLE_RATE + 1);

    let peak = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      peak = Math.max(peak, Math.abs(view.getInt16(44 + index * 2, true)));
    }
    expect(peak).toBeGreaterThan(20_000);
  });
});
