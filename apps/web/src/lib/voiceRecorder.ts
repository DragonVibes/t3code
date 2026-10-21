import {
  normalizeVoiceInputDecibels,
  voiceInputDecibelsFromByteSamples,
  VoiceRecorderError,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "@t3tools/client-runtime/voice-input";

import { isElectron } from "~/env";

const PREFERRED_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
] as const;

export interface VoiceLevelMeter {
  readLevel(): number;
  close(): void;
}

export type MediaRecorderLike = Pick<
  MediaRecorder,
  "state" | "mimeType" | "start" | "stop" | "addEventListener"
>;

export interface VoiceRecorderEnvironment {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly queryMicrophonePermission: () => Promise<PermissionState | null>;
  readonly isTypeSupported: (mimeType: string) => boolean;
  readonly createMediaRecorder: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => MediaRecorderLike;
  readonly createLevelMeter: (stream: MediaStream) => VoiceLevelMeter | null;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  /** Who refused a microphone request. The OS cannot be asked again from the page. */
  readonly deniedBy: "os" | "browser";
}

export interface WebVoiceRecorder {
  readonly recorder: VoiceRecorder;
  readonly startedAt: number | null;
  requestPermission(): Promise<{ readonly granted: boolean; readonly canAskAgain: boolean }>;
  configureRecording(): Promise<void>;
  releaseRecording(): Promise<void>;
  deleteRecording(uri: string): void;
  readLevel(): number;
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function isPermissionRefusal(error: unknown): error is DOMException {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  );
}

function describeMicrophoneFailure(error: unknown): VoiceRecorderError | null {
  if (!(error instanceof DOMException)) return null;
  switch (error.name) {
    case "NotFoundError":
    case "OverconstrainedError":
      return new VoiceRecorderError("No microphone was found. Connect one and try again.", {
        cause: error,
      });
    case "NotReadableError":
      return new VoiceRecorderError(
        "The microphone could not be started. Another app may be using it.",
        { cause: error },
      );
    default:
      return null;
  }
}

async function openMicrophone(environment: VoiceRecorderEnvironment): Promise<MediaStream> {
  try {
    return await environment.getUserMedia({ audio: true });
  } catch (error) {
    throw describeMicrophoneFailure(error) ?? error;
  }
}

export function createWebVoiceRecorder(
  environment: VoiceRecorderEnvironment,
  onStatus: (status: VoiceRecorderStatus) => void,
): WebVoiceRecorder {
  let promptedStream: MediaStream | null = null;
  let stream: MediaStream | null = null;
  let meter: VoiceLevelMeter | null = null;
  let mediaRecorder: MediaRecorderLike | null = null;
  let stopEventPending = false;
  let stopRequested = false;
  let stopped: Promise<void> | null = null;
  let chunks: Blob[] = [];
  let recordingUri: string | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let startedAt: number | null = null;
  let releaseGeneration = 0;

  const clearLimitTimer = () => {
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
  };

  const handleTracksEnded = () => {
    onStatus({ isFinished: true, hasError: false, error: null, url: recordingUri });
  };

  const recorder: VoiceRecorder = {
    get uri() {
      return recordingUri;
    },
    prepareToRecordAsync: async () => {
      if (!stream) throw new Error("The microphone is not open.");
      const mimeType = PREFERRED_AUDIO_MIME_TYPES.find(environment.isTypeSupported);
      const next = environment.createMediaRecorder(stream, mimeType ? { mimeType } : {});
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      chunks = [];
      next.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      next.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: next.mimeType || mimeType || "" });
        chunks = [];
        recordingUri = environment.createObjectURL(blob);
        clearLimitTimer();
        startedAt = null;
        resolve();
        if (!stopRequested) handleTracksEnded();
      });
      next.addEventListener("error", () => {
        onStatus({
          isFinished: false,
          hasError: true,
          error: "The microphone stopped recording.",
          url: null,
        });
      });
      mediaRecorder = next;
      stopEventPending = false;
      stopRequested = false;
      stopped = promise;
    },
    record: ({ forDuration }) => {
      if (!mediaRecorder) throw new Error("The recorder is not prepared.");
      clearLimitTimer();
      mediaRecorder.start();
      stopEventPending = true;
      startedAt = Date.now();
      limitTimer = setTimeout(() => {
        void recorder
          .stop()
          .then(() =>
            onStatus({ isFinished: true, hasError: false, error: null, url: recordingUri }),
          );
      }, forDuration * 1000);
    },
    stop: async () => {
      clearLimitTimer();
      const current = mediaRecorder;
      if (!current) return;
      if (stopEventPending) {
        stopRequested = true;
        if (current.state !== "inactive") current.stop();
        await stopped;
      }
      mediaRecorder = null;
      stopped = null;
      stopEventPending = false;
      startedAt = null;
    },
  };

  return {
    recorder,
    get startedAt() {
      return startedAt;
    },
    requestPermission: async () => {
      stopTracks(promptedStream);
      promptedStream = null;
      const generationAtPrompt = releaseGeneration;
      try {
        const granted = await openMicrophone(environment);
        if (releaseGeneration !== generationAtPrompt) stopTracks(granted);
        else promptedStream = granted;
        return { granted: true, canAskAgain: true };
      } catch (error) {
        if (!isPermissionRefusal(error)) throw error;
        // A SecurityError means the origin itself cannot ask, so retrying cannot help.
        const state =
          environment.deniedBy === "os" || error.name === "SecurityError"
            ? "denied"
            : await environment.queryMicrophonePermission();
        return { granted: false, canAskAgain: state !== "denied" };
      }
    },
    configureRecording: async () => {
      stream = promptedStream ?? (await openMicrophone(environment));
      promptedStream = null;
      meter = environment.createLevelMeter(stream);
    },
    releaseRecording: async () => {
      releaseGeneration += 1;
      clearLimitTimer();
      meter?.close();
      meter = null;
      stopTracks(stream);
      stream = null;
      stopTracks(promptedStream);
      promptedStream = null;
      startedAt = null;
    },
    deleteRecording: (uri) => {
      environment.revokeObjectURL(uri);
      if (uri === recordingUri) recordingUri = null;
    },
    readLevel: () => meter?.readLevel() ?? 0,
  };
}

function createAnalyserLevelMeter(stream: MediaStream): VoiceLevelMeter | null {
  if (typeof AudioContext === "undefined") return null;
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  if (context.state === "suspended") void context.resume().catch(() => undefined);
  const samples = new Uint8Array(analyser.fftSize);
  return {
    readLevel: () => {
      analyser.getByteTimeDomainData(samples);
      return normalizeVoiceInputDecibels(voiceInputDecibelsFromByteSamples(samples));
    },
    close: () => {
      void context.close().catch(() => undefined);
    },
  };
}

export function createBrowserVoiceRecorderEnvironment(): VoiceRecorderEnvironment {
  return {
    getUserMedia: (constraints) =>
      navigator.mediaDevices?.getUserMedia
        ? navigator.mediaDevices.getUserMedia(constraints)
        : Promise.reject(
            new DOMException("Microphone access needs a secure context.", "SecurityError"),
          ),
    queryMicrophonePermission: async () => {
      try {
        const status = await navigator.permissions.query({ name: "microphone" });
        return status.state;
      } catch {
        return null;
      }
    },
    isTypeSupported: (mimeType) =>
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType),
    createMediaRecorder: (stream, options) => new MediaRecorder(stream, options),
    createLevelMeter: createAnalyserLevelMeter,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    deniedBy: isElectron ? "os" : "browser",
  };
}
