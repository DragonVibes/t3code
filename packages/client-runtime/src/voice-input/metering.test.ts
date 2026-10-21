import { describe, expect, it } from "vite-plus/test";

import { normalizeVoiceInputDecibels, voiceInputDecibelsFromByteSamples } from "./metering.ts";

describe("voice input metering", () => {
  it("maps silence to an empty meter and a full-scale signal to a full one", () => {
    expect(normalizeVoiceInputDecibels(voiceInputDecibelsFromByteSamples([128, 128, 128]))).toBe(0);
    expect(
      normalizeVoiceInputDecibels(voiceInputDecibelsFromByteSamples([0, 255, 0, 255])),
    ).toBeGreaterThan(0.99);
    expect(normalizeVoiceInputDecibels(voiceInputDecibelsFromByteSamples([]))).toBe(0);
  });

  it("grows with the signal between the noise floor and full scale", () => {
    const quiet = normalizeVoiceInputDecibels(voiceInputDecibelsFromByteSamples([129, 127]));
    const speech = normalizeVoiceInputDecibels(voiceInputDecibelsFromByteSamples([160, 96]));
    expect(quiet).toBeGreaterThan(0);
    expect(speech).toBeGreaterThan(quiet);
    expect(speech).toBeLessThan(1);
  });
});
