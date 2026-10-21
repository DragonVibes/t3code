import type { EnvironmentId } from "@t3tools/contracts";
import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { createBrowserVoiceRecorderEnvironment, createWebVoiceRecorder } from "~/lib/voiceRecorder";
import { createWebVoiceTranscriber } from "~/state/voiceTranscription";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export interface ComposerVoiceInputInput {
  readonly environmentId: EnvironmentId;
  readonly ownerKey: string;
  readonly language: string;
  readonly draftText: string;
  /** Escape inside an editable element outside this root belongs to that element. */
  readonly composerRef: RefObject<HTMLElement | null>;
  readonly readDraft: () => Omit<VoiceDraftSnapshot, "revision">;
  /** False when the composer refused the text, for example while a choice-only question owns it. */
  readonly commitDraft: (text: string, selection: VoiceDraftSnapshot["selection"]) => boolean;
}

export interface ComposerVoiceInput {
  readonly state: VoiceInputState;
  readonly busy: boolean;
  /** Live-region text: the phase while running, then whether a transcript landed. */
  readonly announcement: string;
  readonly readStartedAt: () => number | null;
  readonly readLevel: () => number;
  readonly toggle: () => void;
  /** Sends a kept recording again when the error offers it, otherwise records anew. */
  readonly retry: () => void;
  readonly cancel: () => void;
}

interface VoiceInputSnapshot {
  readonly state: VoiceInputState;
  readonly announcement: string;
}

const IDLE_SNAPSHOT: VoiceInputSnapshot = { state: IDLE_STATE, announcement: "" };

interface VoiceInputRuntime extends Omit<ComposerVoiceInput, "state" | "busy" | "announcement"> {
  readonly setInput: (input: ComposerVoiceInputInput) => void;
  readonly setOwner: (ownerKey: string) => void;
  readonly setDraftText: (draftText: string) => void;
  readonly composerRoot: () => Element | null;
  readonly dispose: () => void;
}

function announcementFor(state: VoiceInputState, transcriptInserted: boolean): string {
  switch (state.phase) {
    case "preparing":
      return "Starting voice input.";
    case "recording":
      return "Recording.";
    case "transcribing":
      return "Transcribing.";
    case "idle":
      return transcriptInserted ? "Transcript inserted." : "";
    case "error":
      // The error banner is an alert and announces itself.
      return "";
  }
}

const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function escapeBelongsElsewhere(target: EventTarget | null, composerRoot: Element | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(OVERLAY_SELECTOR)) return true;
  const editable = target.closest(EDITABLE_SELECTOR);
  return editable !== null && !(composerRoot?.contains(editable) ?? false);
}

function createRuntime(
  initialInput: ComposerVoiceInputInput,
  onSnapshot: (snapshot: VoiceInputSnapshot) => void,
): VoiceInputRuntime {
  let latest = initialInput;
  let draftText = initialInput.draftText;
  let revision = 0;
  let ownerKey: string | null = null;
  let transcriptInserted = false;
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
    retainFailedRecordings: true,
    readDraft: () => ({ ...latest.readDraft(), revision }),
    commitDraft: (text, selection) => {
      transcriptInserted = latest.commitDraft(text, selection);
      return transcriptInserted;
    },
    onStateChange: (state) => {
      onSnapshot({ state, announcement: announcementFor(state, transcriptInserted) });
      transcriptInserted = false;
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
    composerRoot: () => latest.composerRef.current,
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
    retry: () => {
      const { phase, errorAction } = active.currentState;
      if (errorAction === "retry-transcription") void active.retryTranscription();
      else if (phase === "idle" || phase === "error") void active.start();
    },
    cancel: () => active.cancel(),
  };
}

export function useComposerVoiceInput(input: ComposerVoiceInputInput): ComposerVoiceInput {
  const [snapshot, setSnapshot] = useState(IDLE_SNAPSHOT);
  const [runtime] = useState(() => createRuntime(input, setSnapshot));
  const busy = voiceInputBlocksSubmission(snapshot.state);

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
      if (escapeBelongsElsewhere(event.target, runtime.composerRoot())) return;
      event.preventDefault();
      runtime.cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, runtime]);

  return {
    state: snapshot.state,
    busy,
    announcement: snapshot.announcement,
    readStartedAt: runtime.readStartedAt,
    readLevel: runtime.readLevel,
    toggle: runtime.toggle,
    retry: runtime.retry,
    cancel: runtime.cancel,
  };
}
