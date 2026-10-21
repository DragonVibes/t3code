import { describe, expect, it } from "vite-plus/test";

import { resolveVoiceInputErrorPresentation } from "./voiceInputErrorPresentation";

const denied = {
  phase: "error",
  error: "Microphone access is required for voice input.",
  errorAction: "settings",
} as const;

describe("resolveVoiceInputErrorPresentation", () => {
  it("routes a blocked microphone to the place that can unblock it", () => {
    expect(
      resolveVoiceInputErrorPresentation(denied, { secureContext: true, permissionHost: "macos" }),
    ).toMatchObject({ action: "open-settings", message: expect.stringContaining("System") });
    expect(
      resolveVoiceInputErrorPresentation(denied, {
        secureContext: true,
        permissionHost: "windows",
      }),
    ).toMatchObject({ action: "retry", message: expect.stringContaining("Privacy & security") });
    expect(
      resolveVoiceInputErrorPresentation(denied, { secureContext: true, permissionHost: "linux" }),
    ).toMatchObject({ action: "retry", message: expect.stringContaining("system") });
    expect(
      resolveVoiceInputErrorPresentation(denied, {
        secureContext: true,
        permissionHost: "browser",
      }),
    ).toMatchObject({ action: "retry", message: expect.stringContaining("browser") });
    expect(
      resolveVoiceInputErrorPresentation(denied, { secureContext: false, permissionHost: "macos" }),
    ).toMatchObject({ action: null, message: expect.stringContaining("HTTPS") });
  });

  it("shows other failures verbatim with a retry when the controller offers one", () => {
    const context = { secureContext: true, permissionHost: "browser" } as const;
    expect(
      resolveVoiceInputErrorPresentation(
        { phase: "error", error: "Groq is down.", errorAction: "retry" },
        context,
      ),
    ).toEqual({ message: "Groq is down.", action: "retry" });
    expect(
      resolveVoiceInputErrorPresentation(
        { phase: "error", error: "Upload failed.", errorAction: "retry-transcription" },
        context,
      ),
    ).toEqual({ message: "Upload failed.", action: "retry" });
    expect(
      resolveVoiceInputErrorPresentation(
        { phase: "error", error: "Voice transcription is not available.", errorAction: null },
        context,
      ),
    ).toEqual({ message: "Voice transcription is not available.", action: null });
    expect(
      resolveVoiceInputErrorPresentation(
        { phase: "recording", error: null, errorAction: null },
        context,
      ),
    ).toBeNull();
  });
});
