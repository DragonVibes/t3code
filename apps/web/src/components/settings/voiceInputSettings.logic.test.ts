import { describe, expect, it } from "vite-plus/test";

import {
  availableVoiceInputPresets,
  resolveVoiceInputPreset,
  VOICE_INPUT_PRESETS,
  voiceInputPresetPatch,
  voiceInputProviderPatch,
} from "./voiceInputSettings.logic";

const openai = { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1" } as const;

describe("voice input presets", () => {
  it("recognizes every preset from the settings it writes, ignoring URL case and slashes", () => {
    for (const preset of VOICE_INPUT_PRESETS) {
      const patch = voiceInputPresetPatch(preset.id, openai);
      expect(patch).not.toBeNull();
      const written = { baseUrl: openai.baseUrl, model: "gpt-transcribe", ...patch! };
      expect(resolveVoiceInputPreset(written)).toBe(preset.id);
      expect(
        resolveVoiceInputPreset({
          ...written,
          baseUrl: `${written.baseUrl.toUpperCase()}/`,
          model: ` ${written.model} `,
        }),
      ).toBe(preset.id);
    }
    expect(voiceInputPresetPatch("custom", openai)).toBeNull();
  });

  it("treats an edited endpoint or model as custom, except for Apple which has neither", () => {
    expect(resolveVoiceInputPreset({ ...openai, model: "gpt-5-transcribe" })).toBe("custom");
    expect(
      resolveVoiceInputPreset({
        provider: "xai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-transcribe",
      }),
    ).toBe("custom");
    expect(
      resolveVoiceInputPreset({
        provider: "apple-on-device",
        baseUrl: "https://api.groq.com/openai/v1",
        model: "whisper-large-v3-turbo",
      }),
    ).toBe("apple-on-device");
  });

  it("resets the endpoint for HTTP providers and leaves it alone for Apple", () => {
    expect(voiceInputProviderPatch("xai", openai)).toEqual({
      provider: "xai",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-voice-transcribe-2.0",
      apiKey: "",
    });
    expect(
      voiceInputProviderPatch("openai-compatible", { baseUrl: "https://api.x.ai/v1" }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-transcribe",
      apiKey: "",
    });
    expect(voiceInputProviderPatch("apple-on-device", openai)).toEqual({
      provider: "apple-on-device",
    });
    expect(voiceInputPresetPatch("apple-on-device", openai)).toEqual({
      provider: "apple-on-device",
    });
  });

  it("drops the saved API key only when the endpoint moves to another host", () => {
    expect(voiceInputPresetPatch("openai-whisper-1", openai)).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
    });
    expect(voiceInputPresetPatch("groq-whisper-large-v3-turbo", openai)).toMatchObject({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "",
    });
    expect(voiceInputPresetPatch("local-whisper-cpp", openai)).toMatchObject({
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "",
    });
    expect(
      voiceInputPresetPatch("openai-gpt-transcribe", { baseUrl: "HTTPS://API.OPENAI.COM/v1/" }),
    ).not.toHaveProperty("apiKey");
  });

  it("offers Apple first only where the environment supports it, then the free local option", () => {
    expect(
      availableVoiceInputPresets(true)
        .map((preset) => preset.id)
        .slice(0, 2),
    ).toEqual(["apple-on-device", "local-whisper-cpp"]);
    const withoutApple = availableVoiceInputPresets(false).map((preset) => preset.id);
    expect(withoutApple[0]).toBe("local-whisper-cpp");
    expect(withoutApple).not.toContain("apple-on-device");
  });
});
