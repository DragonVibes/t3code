import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { MicOffIcon } from "lucide-react";

import { microphonePermissionHost, openMicrophoneSystemSettings } from "~/lib/microphoneSettings";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import {
  resolveVoiceInputErrorPresentation,
  type VoiceInputErrorContext,
} from "./voiceInputErrorPresentation";

const BROWSER_ERROR_CONTEXT: VoiceInputErrorContext = {
  secureContext: typeof window !== "undefined" && window.isSecureContext,
  permissionHost: microphonePermissionHost,
};

function keepEditorSelection(event: React.PointerEvent) {
  event.preventDefault();
}

async function openSettingsOrExplain(openSettings: () => Promise<void>): Promise<void> {
  try {
    await openSettings();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not open System Settings",
      description:
        error instanceof Error && error.message
          ? error.message
          : "Open System Settings > Privacy & Security > Microphone and allow T3 Code.",
    });
  }
}

export function voiceInputBannerItem(input: {
  readonly state: VoiceInputState;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  readonly errorContext?: VoiceInputErrorContext;
  readonly openSettings?: () => Promise<void>;
}): ComposerBannerStackItem | null {
  const error = resolveVoiceInputErrorPresentation(
    input.state,
    input.errorContext ?? BROWSER_ERROR_CONTEXT,
  );
  if (!error) return null;
  const openSettings = input.openSettings ?? openMicrophoneSystemSettings;
  const actions =
    error.action === "open-settings" ? (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => void openSettingsOrExplain(openSettings)}
      >
        Open settings
      </Button>
    ) : error.action === "retry" ? (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onPointerDown={keepEditorSelection}
        onClick={input.onRetry}
      >
        Retry
      </Button>
    ) : null;
  return {
    id: "voice-input-error",
    variant: "error",
    priority: "urgent",
    icon: <MicOffIcon />,
    title: error.message,
    ...(actions ? { actions } : {}),
    dismissLabel: "Dismiss voice input error",
    onDismiss: input.onDismiss,
  };
}
