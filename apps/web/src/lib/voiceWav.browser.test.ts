import { describe, expect, it } from "vite-plus/test";

import { convertRecordingToWav, encodeWavPcm16, VOICE_WAV_SAMPLE_RATE } from "./voiceWav";

const SOURCE_SAMPLE_RATE = 48_000;

function tone(gain: number): Float32Array {
  return Float32Array.from(
    { length: SOURCE_SAMPLE_RATE },
    (_, index) => gain * Math.sin((2 * Math.PI * 440 * index) / SOURCE_SAMPLE_RATE),
  );
}

function monoRecording(samples: Float32Array): Blob {
  return new Blob([encodeWavPcm16(samples, SOURCE_SAMPLE_RATE)], { type: "audio/wav" });
}

/** Interleaves two channels and patches the mono header into a stereo one. */
function stereoRecording(left: Float32Array, right: Float32Array): Blob {
  const interleaved = new Float32Array(left.length * 2);
  for (let index = 0; index < left.length; index += 1) {
    interleaved[index * 2] = left[index] ?? 0;
    interleaved[index * 2 + 1] = right[index] ?? 0;
  }
  const buffer = encodeWavPcm16(interleaved, SOURCE_SAMPLE_RATE);
  const view = new DataView(buffer);
  view.setUint16(22, 2, true);
  view.setUint32(28, SOURCE_SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  return new Blob([buffer], { type: "audio/wav" });
}

async function decodeMonoWav(wav: Blob): Promise<{ sampleCount: number; peak: number }> {
  const view = new DataView(await wav.arrayBuffer());
  expect(wav.type).toBe("audio/wav");
  expect(view.getUint32(24, true)).toBe(VOICE_WAV_SAMPLE_RATE);
  expect(view.getUint16(22, true)).toBe(1);
  const sampleCount = view.getUint32(40, true) / 2;
  let peak = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    peak = Math.max(peak, Math.abs(view.getInt16(44 + index * 2, true)));
  }
  return { sampleCount, peak };
}

describe("convertRecordingToWav", () => {
  it("resamples a recording to 16 kHz mono PCM WAV in Chromium", async () => {
    const { sampleCount, peak } = await decodeMonoWav(
      await convertRecordingToWav(monoRecording(tone(1))),
    );
    expect(sampleCount).toBeGreaterThanOrEqual(VOICE_WAV_SAMPLE_RATE - 1);
    expect(sampleCount).toBeLessThanOrEqual(VOICE_WAV_SAMPLE_RATE + 1);
    expect(peak).toBeGreaterThan(20_000);
  });

  it("averages stereo channels, so opposite channels cancel and equal ones keep their level", async () => {
    const opposite = await decodeMonoWav(
      await convertRecordingToWav(stereoRecording(tone(1), tone(-1))),
    );
    expect(opposite.peak).toBeLessThan(50);

    const identical = await decodeMonoWav(
      await convertRecordingToWav(stereoRecording(tone(1), tone(1))),
    );
    expect(identical.peak).toBeGreaterThan(20_000);
  });
});
