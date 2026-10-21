import type { VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createWebVoiceRecorder,
  type MediaRecorderLike,
  type VoiceRecorderEnvironment,
} from "./voiceRecorder";

type Listener = (event: never) => void;

class FakeMediaRecorder implements MediaRecorderLike {
  state: RecordingState = "inactive";
  readonly mimeType: string;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
    private readonly chunk: Blob,
  ) {
    this.mimeType = options.mimeType ?? "";
  }

  addEventListener(type: string, listener: unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as Listener]);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    for (const listener of this.listeners.get("dataavailable") ?? []) {
      listener({ data: this.chunk } as never);
    }
    for (const listener of this.listeners.get("stop") ?? []) listener(undefined as never);
  }
}

function createFakeStream() {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

function createHarness(overrides: Partial<VoiceRecorderEnvironment> = {}) {
  const { stream, tracks } = createFakeStream();
  const recorders: FakeMediaRecorder[] = [];
  const statuses: VoiceRecorderStatus[] = [];
  const created: Blob[] = [];
  const revoked: string[] = [];
  const environment: VoiceRecorderEnvironment = {
    getUserMedia: vi.fn(async () => stream),
    queryMicrophonePermission: async () => "prompt",
    isTypeSupported: (mimeType) => mimeType === "audio/webm;codecs=opus",
    createMediaRecorder: (target, options) => {
      const recorder = new FakeMediaRecorder(target, options, new Blob(["pcm"]));
      recorders.push(recorder);
      return recorder;
    },
    createLevelMeter: () => null,
    createObjectURL: (blob) => {
      created.push(blob);
      return `blob:recording-${created.length}`;
    },
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
    denialIsPermanent: false,
    ...overrides,
  };
  const web = createWebVoiceRecorder(environment, (status) => statuses.push(status));
  return { web, environment, tracks, recorders, statuses, created, revoked };
}

async function startRecording(harness: ReturnType<typeof createHarness>) {
  expect(await harness.web.requestPermission()).toEqual({ granted: true, canAskAgain: true });
  await harness.web.configureRecording();
  await harness.web.recorder.prepareToRecordAsync();
  harness.web.recorder.record({ forDuration: 300 });
}

function refusal(name: "NotAllowedError" | "SecurityError") {
  return async () => {
    throw new DOMException("refused", name);
  };
}

describe("createWebVoiceRecorder", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records into a blob URL that exists only after stop, then turns the microphone off", async () => {
    const harness = createHarness();
    await startRecording(harness);
    expect(harness.web.recorder.uri).toBeNull();
    expect(harness.web.startedAt).not.toBeNull();
    expect(harness.recorders[0]?.options).toEqual({ mimeType: "audio/webm;codecs=opus" });

    await harness.web.recorder.stop();
    expect(harness.web.recorder.uri).toBe("blob:recording-1");
    expect(harness.created[0]?.type).toBe("audio/webm;codecs=opus");
    expect(await harness.created[0]?.text()).toBe("pcm");
    expect(harness.web.startedAt).toBeNull();

    await harness.web.releaseRecording();
    for (const track of harness.tracks) expect(track.stop).toHaveBeenCalledTimes(1);

    harness.web.deleteRecording("blob:recording-1");
    expect(harness.revoked).toEqual(["blob:recording-1"]);
    expect(harness.web.recorder.uri).toBeNull();
  });

  it("falls back through the container list for engines without opus webm", async () => {
    const safari = createHarness({ isTypeSupported: (mimeType) => mimeType === "audio/mp4" });
    await startRecording(safari);
    expect(safari.recorders[0]?.options).toEqual({ mimeType: "audio/mp4" });

    const unknown = createHarness({ isTypeSupported: () => false });
    await startRecording(unknown);
    expect(unknown.recorders[0]?.options).toEqual({});
  });

  it("stops itself at the duration limit and reports the finished recording", async () => {
    const harness = createHarness();
    await startRecording(harness);
    vi.useFakeTimers();
    harness.web.recorder.record({ forDuration: 2 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.statuses).toEqual([
      { isFinished: true, hasError: false, error: null, url: "blob:recording-1" },
    ]);
  });

  it("resolves stop without a recording when nothing started", async () => {
    const harness = createHarness();
    await harness.web.recorder.stop();
    await harness.web.requestPermission();
    await harness.web.configureRecording();
    await harness.web.recorder.prepareToRecordAsync();
    await harness.web.recorder.stop();
    expect(harness.web.recorder.uri).toBeNull();
    await harness.web.releaseRecording();
    for (const track of harness.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("releases a stream acquired for the permission prompt even if recording never configures", async () => {
    const harness = createHarness();
    await harness.web.requestPermission();
    await harness.web.releaseRecording();
    for (const track of harness.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("tells a blocked microphone apart from a dismissed prompt", async () => {
    const dismissed = createHarness({ getUserMedia: refusal("NotAllowedError") });
    expect(await dismissed.web.requestPermission()).toEqual({ granted: false, canAskAgain: true });

    const blocked = createHarness({
      getUserMedia: refusal("NotAllowedError"),
      queryMicrophonePermission: async () => "denied",
    });
    expect(await blocked.web.requestPermission()).toEqual({ granted: false, canAskAgain: false });

    const desktop = createHarness({
      getUserMedia: refusal("NotAllowedError"),
      denialIsPermanent: true,
    });
    expect(await desktop.web.requestPermission()).toEqual({ granted: false, canAskAgain: false });

    const insecure = createHarness({
      getUserMedia: refusal("SecurityError"),
      queryMicrophonePermission: async () => null,
    });
    expect(await insecure.web.requestPermission()).toEqual({ granted: false, canAskAgain: true });

    const broken = createHarness({
      getUserMedia: async () => {
        throw new DOMException("no device", "NotFoundError");
      },
    });
    await expect(broken.web.requestPermission()).rejects.toMatchObject({ name: "NotFoundError" });
  });
});
