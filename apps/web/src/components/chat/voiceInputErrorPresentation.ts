import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

import type { MicrophonePermissionHost } from "~/lib/microphoneSettings";

export interface VoiceInputErrorContext {
  readonly secureContext: boolean;
  readonly permissionHost: MicrophonePermissionHost;
}

export type VoiceInputErrorAction = "retry" | "open-settings";

export interface VoiceInputErrorPresentation {
  readonly message: string;
  readonly action: VoiceInputErrorAction | null;
}

const BLOCKED_MICROPHONE: Record<MicrophonePermissionHost, VoiceInputErrorPresentation> = {
  browser: {
    message: "Allow the microphone for this site in your browser's settings, then try again.",
    action: "retry",
  },
  macos: {
    message: "Allow the microphone for T3 Code in System Settings, then try again.",
    action: "open-settings",
  },
  windows: {
    message:
      "Allow the microphone for T3 Code under Settings > Privacy & security > Microphone, then try again.",
    action: "retry",
  },
  linux: {
    message:
      "Allow the microphone for T3 Code in your system's sound or privacy settings, then try again.",
    action: "retry",
  },
};

export function resolveVoiceInputErrorPresentation(
  state: VoiceInputState,
  context: VoiceInputErrorContext,
): VoiceInputErrorPresentation | null {
  if (state.phase !== "error" || state.error === null) return null;
  if (state.errorAction === "settings") {
    if (!context.secureContext) {
      return { message: "Voice input needs an HTTPS or localhost connection.", action: null };
    }
    return BLOCKED_MICROPHONE[context.permissionHost];
  }
  return {
    message: state.error,
    action:
      state.errorAction === "retry" || state.errorAction === "retry-transcription" ? "retry" : null,
  };
}
