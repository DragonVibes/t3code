import type { EnvironmentId } from "@t3tools/contracts";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useLayoutEffect, useState } from "react";

import { createBrowserVoiceRecorderEnvironment, createWebVoiceRecorder } from "~/lib/voiceRecorder";
import { createWebVoiceTranscriber } from "~/state/voiceTranscription";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export interface ComposerVoiceInputInput {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly language: string;
  /** The controller treats a draft that changed since recording started as stale. */
  readonly draftText: string;
  readonly readDraft: () => Omit<VoiceDraftSnapshot, "revision">;
  readonly commitDraft: (text: string, selection: VoiceDraftSnapshot["selection"]) => void;
}

export interface ComposerVoiceInput {
  readonly state: VoiceInputState;
  readonly busy: boolean;
  readonly readStartedAt: () => number | null;
  readonly readLevel: () => number;
  /** Starts from idle or an error, stops and transcribes while recording. */
  readonly toggle: () => void;
  readonly cancel: () => void;
}

interface VoiceInputRuntime extends Omit<ComposerVoiceInput, "state" | "busy"> {
  readonly setInput: (input: ComposerVoiceInputInput) => void;
  readonly setOwner: (ownerKey: string) => void;
  readonly noteDraftChanged: (draftText: string) => void;
  readonly dispose: () => void;
}

/**
 * Everything the controller reads at event time lives here rather than in React
 * state, so the hook re-renders only when the voice input phase changes.
 */
function createRuntime(
  initialInput: ComposerVoiceInputInput,
  onStateChange: (state: VoiceInputState) => void,
): VoiceInputRuntime {
  let latest = initialInput;
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
      // The microphone is on only while voice input is active, whichever path ended it.
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
    noteDraftChanged: () => {
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
    runtime.noteDraftChanged(input.draftText);
  }, [runtime, input.draftText]);
  useEffect(() => {
    runtime.setOwner(input.ownerKey);
  }, [runtime, input.ownerKey]);
  useEffect(() => () => runtime.dispose(), [runtime]);

  useEffect(() => {
    if (!busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      runtime.cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
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
