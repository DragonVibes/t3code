import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

export interface VoiceInputErrorContext {
  readonly secureContext: boolean;
  readonly canOpenSystemSettings: boolean;
}

export type VoiceInputErrorAction = "retry" | "open-settings";

export interface VoiceInputErrorPresentation {
  readonly message: string;
  readonly action: VoiceInputErrorAction | null;
}

export function resolveVoiceInputErrorPresentation(
  state: VoiceInputState,
  context: VoiceInputErrorContext,
): VoiceInputErrorPresentation | null {
  if (state.phase !== "error" || state.error === null) return null;
  if (state.errorAction === "settings") {
    if (!context.secureContext) {
      return { message: "Voice input needs an HTTPS or localhost connection.", action: null };
    }
    if (context.canOpenSystemSettings) {
      return {
        message: "Allow the microphone for T3 Code in System Settings, then try again.",
        action: "open-settings",
      };
    }
    return {
      message: "Allow the microphone for this site in your browser's settings, then try again.",
      action: "retry",
    };
  }
  return { message: state.error, action: state.errorAction === "retry" ? "retry" : null };
}
