import type { EnvironmentId } from "@t3tools/contracts";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useLayoutEffect, useState } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { createBrowserVoiceRecorderEnvironment, createWebVoiceRecorder } from "~/lib/voiceRecorder";
import { createWebVoiceTranscriber } from "~/state/voiceTranscription";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export interface ComposerVoiceInputInput {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly language: string;
  readonly draftText: string;
  readonly readDraft: () => Omit<VoiceDraftSnapshot, "revision">;
  readonly commitDraft: (text: string, selection: VoiceDraftSnapshot["selection"]) => void;
}

export interface ComposerVoiceInput {
  readonly state: VoiceInputState;
  readonly busy: boolean;
  readonly readStartedAt: () => number | null;
  readonly readLevel: () => number;
  readonly toggle: () => void;
  readonly cancel: () => void;
}

interface VoiceInputRuntime extends Omit<ComposerVoiceInput, "state" | "busy"> {
  readonly setInput: (input: ComposerVoiceInputInput) => void;
  readonly setOwner: (ownerKey: string) => void;
  readonly setDraftText: (draftText: string) => void;
  readonly dispose: () => void;
}

function createRuntime(
  initialInput: ComposerVoiceInputInput,
  onStateChange: (state: VoiceInputState) => void,
): VoiceInputRuntime {
  let latest = initialInput;
  let draftText = initialInput.draftText;
  let revision = 0;
  let ownerKey: string | null = null;
  let controller: VoiceInputController | null = null;
  const recorder = createWebVoiceRecorder(createBrowserVoiceRecorderEnvironment(), (status) => {
    void controller?.handleRecorderStatus(status);
  });
  const active = new VoiceInputController({
    recorder: recorder.recorder,
    getTranscriber: () => createWebVoiceTranscriber(latest.environmentId, () => latest.language),
    requestPermission: recorder.requestPermission,
    configureRecording: recorder.configureRecording,
    releaseRecording: recorder.releaseRecording,
    deleteRecording: recorder.deleteRecording,
    readDraft: () => ({ ...latest.readDraft(), revision }),
    commitDraft: (text, selection) => latest.commitDraft(text, selection),
    onStateChange: (state) => {
      onStateChange(state);
      if (!voiceInputBlocksSubmission(state)) void recorder.releaseRecording();
    },
  });
  controller = active;
  return {
    setInput: (input) => {
      latest = input;
    },
    setOwner: (next) => {
      if (ownerKey !== null && ownerKey !== next) active.ownerChanged();
      ownerKey = next;
    },
    setDraftText: (next) => {
      if (next === draftText) return;
      draftText = next;
      revision += 1;
    },
    dispose: () => {
      active.dispose();
      void recorder.releaseRecording();
    },
    readStartedAt: () => recorder.startedAt,
    readLevel: recorder.readLevel,
    toggle: () => {
      const phase = active.currentState.phase;
      if (phase === "recording") void active.stop();
      else if (phase === "idle" || phase === "error") void active.start();
    },
    cancel: () => active.cancel(),
  };
}

export function useComposerVoiceInput(input: ComposerVoiceInputInput): ComposerVoiceInput {
  const [state, setState] = useState(IDLE_STATE);
  const [runtime] = useState(() => createRuntime(input, setState));
  const busy = voiceInputBlocksSubmission(state);

  useLayoutEffect(() => {
    runtime.setInput(input);
  });
  useEffect(() => {
    runtime.setDraftText(input.draftText);
  }, [runtime, input.draftText]);
  useEffect(() => {
    runtime.setOwner(input.ownerKey);
  }, [runtime, input.ownerKey]);
  useEffect(() => () => runtime.dispose(), [runtime]);

  useEffect(() => {
    if (!busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isCommandPaletteOpen()) return;
      // A dialog or menu that is open owns its own Escape.
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      runtime.cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, runtime]);

  return {
    state,
    busy,
    readStartedAt: runtime.readStartedAt,
    readLevel: runtime.readLevel,
    toggle: runtime.toggle,
    cancel: runtime.cancel,
  };
}
