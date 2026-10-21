import {
  normalizeVoiceInputDecibels,
  voiceInputDecibelsFromByteSamples,
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
  readonly denialIsPermanent: boolean;
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

export function createWebVoiceRecorder(
  environment: VoiceRecorderEnvironment,
  onStatus: (status: VoiceRecorderStatus) => void,
): WebVoiceRecorder {
  let promptedStream: MediaStream | null = null;
  let stream: MediaStream | null = null;
  let meter: VoiceLevelMeter | null = null;
  let mediaRecorder: MediaRecorderLike | null = null;
  let started = false;
  let stopRequested = false;
  let stopped: Promise<void> | null = null;
  let chunks: Blob[] = [];
  let recordingUri: string | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let startedAt: number | null = null;
  let releases = 0;

  const clearLimitTimer = () => {
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
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
        // A stop nobody asked for means the tracks ended, such as a device
        // unplugged, so hand over what was captured instead of recording forever.
        if (!stopRequested) {
          onStatus({ isFinished: true, hasError: false, error: null, url: recordingUri });
        }
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
      started = false;
      stopRequested = false;
      stopped = promise;
    },
    record: ({ forDuration }) => {
      if (!mediaRecorder) throw new Error("The recorder is not prepared.");
      clearLimitTimer();
      mediaRecorder.start();
      started = true;
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
      // A recorder that never started fires no stop event, and one whose
      // tracks ended already fired it.
      if (started) {
        stopRequested = true;
        if (current.state !== "inactive") current.stop();
        await stopped;
      }
      mediaRecorder = null;
      stopped = null;
      started = false;
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
      const releasesBefore = releases;
      try {
        const granted = await environment.getUserMedia({ audio: true });
        // A cancel while the prompt was open already released, so this stream
        // has no owner left to stop it later.
        if (releases !== releasesBefore) stopTracks(granted);
        else promptedStream = granted;
        return { granted: true, canAskAgain: true };
      } catch (error) {
        if (!isPermissionRefusal(error)) throw error;
        // A SecurityError means the origin itself cannot ask, so retrying cannot help.
        const state =
          environment.denialIsPermanent || error.name === "SecurityError"
            ? "denied"
            : await environment.queryMicrophonePermission();
        return { granted: false, canAskAgain: state !== "denied" };
      }
    },
    configureRecording: async () => {
      stream = promptedStream ?? (await environment.getUserMedia({ audio: true }));
      promptedStream = null;
      meter = environment.createLevelMeter(stream);
    },
    releaseRecording: async () => {
      releases += 1;
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
    // Electron grants the page's request itself, so a refusal can only come from the OS.
    denialIsPermanent: isElectron,
  };
}
