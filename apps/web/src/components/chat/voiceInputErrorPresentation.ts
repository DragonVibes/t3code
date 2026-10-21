import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

export interface VoiceInputErrorContext {
  /** getUserMedia exists only on HTTPS and localhost origins. */
  readonly secureContext: boolean;
  /** True on macOS desktop builds whose bridge can open the Microphone privacy pane. */
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
