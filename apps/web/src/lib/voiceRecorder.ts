import {
  normalizeVoiceInputDecibels,
  voiceInputDecibelsFromByteSamples,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "@t3tools/client-runtime/voice-input";

import { isElectron } from "~/env";

/** Containers the environment accepts, best first. Safari records only mp4. */
const PREFERRED_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
] as const;

export interface VoiceLevelMeter {
  /** Current microphone level from 0 (silence) to 1 (full scale). */
  readLevel(): number;
  close(): void;
}

export type MediaRecorderLike = Pick<
  MediaRecorder,
  "state" | "mimeType" | "start" | "stop" | "addEventListener"
>;

export interface VoiceRecorderEnvironment {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Null when the Permissions API cannot answer for the microphone. */
  readonly queryMicrophonePermission: () => Promise<PermissionState | null>;
  readonly isTypeSupported: (mimeType: string) => boolean;
  readonly createMediaRecorder: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => MediaRecorderLike;
  readonly createLevelMeter: (stream: MediaStream) => VoiceLevelMeter | null;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  /** True where the page cannot prompt again, so a refusal needs a settings change. */
  readonly denialIsPermanent: boolean;
}

export interface WebVoiceRecorder {
  readonly recorder: VoiceRecorder;
  /** Epoch milliseconds when the current recording started, null otherwise. */
  readonly startedAt: number | null;
  requestPermission(): Promise<{ readonly granted: boolean; readonly canAskAgain: boolean }>;
  configureRecording(): Promise<void>;
  /** Stops every microphone track. Safe to call at any time. */
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
  // Acquired by requestPermission, because a browser only prompts through
  // getUserMedia, and adopted by configureRecording.
  let pendingStream: MediaStream | null = null;
  let stream: MediaStream | null = null;
  let meter: VoiceLevelMeter | null = null;
  let mediaRecorder: MediaRecorderLike | null = null;
  let started = false;
  let stopped: Promise<void> | null = null;
  let chunks: Blob[] = [];
  let recordingUri: string | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let startedAt: number | null = null;

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
      stopped = promise;
    },
    record: ({ forDuration }) => {
      if (!mediaRecorder) throw new Error("The recorder is not prepared.");
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
      stopTracks(pendingStream);
      pendingStream = null;
      try {
        pendingStream = await environment.getUserMedia({ audio: true });
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
      stream = pendingStream ?? (await environment.getUserMedia({ audio: true }));
      pendingStream = null;
      meter = environment.createLevelMeter(stream);
    },
    releaseRecording: async () => {
      clearLimitTimer();
      meter?.close();
      meter = null;
      stopTracks(stream);
      stream = null;
      stopTracks(pendingStream);
      pendingStream = null;
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
        : // Plain-http origins other than localhost have no mediaDevices at all.
          Promise.reject(
            new DOMException("Microphone access needs a secure context.", "SecurityError"),
          ),
    queryMicrophonePermission: async () => {
      try {
        // lib.dom's PermissionName omits "microphone" although every engine answers it.
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
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
