import { EnvironmentId } from "@t3tools/contracts";
import type {
  PreparedVoiceTranscription,
  VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { MediaRecorderLike, VoiceRecorderEnvironment } from "~/lib/voiceRecorder";

const fakes = vi.hoisted(() => ({
  environment: null as VoiceRecorderEnvironment | null,
  transcriber: null as VoiceTranscriber | null,
}));
vi.mock(import("~/lib/voiceRecorder"), async (original) => ({
  ...(await original()),
  createBrowserVoiceRecorderEnvironment: () => fakes.environment!,
}));
vi.mock(import("~/state/voiceTranscription"), () => ({
  createWebVoiceTranscriber: () => fakes.transcriber!,
}));

import { useComposerVoiceInput, type ComposerVoiceInput } from "./useComposerVoiceInput";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeMediaRecorder implements MediaRecorderLike {
  state: RecordingState = "inactive";
  readonly mimeType = "audio/webm";
  private readonly listeners = new Map<string, Array<(event: never) => void>>();

  constructor(private readonly onStart: () => void) {}

  addEventListener(type: string, listener: unknown): void {
    this.listeners.set(type, [
      ...(this.listeners.get(type) ?? []),
      listener as (event: never) => void,
    ]);
  }

  start(): void {
    this.state = "recording";
    this.onStart();
  }

  stop(): void {
    this.state = "inactive";
    for (const listener of this.listeners.get("dataavailable") ?? []) {
      listener({ data: new Blob(["pcm"]) } as never);
    }
    for (const listener of this.listeners.get("stop") ?? []) listener(undefined as never);
  }
}

const prepared: PreparedVoiceTranscription = { locale: "en-US", transcribe: async () => "spoken" };

function setup(prepare: VoiceTranscriber["prepare"] = async () => prepared) {
  commits = [];
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const pendingStarts: Array<() => void> = [];
  fakes.environment = {
    getUserMedia: async () => stream,
    queryMicrophonePermission: async () => "granted",
    isTypeSupported: () => true,
    createMediaRecorder: () => new FakeMediaRecorder(() => pendingStarts.shift()?.()),
    createLevelMeter: () => null,
    createObjectURL: () => "blob:recording",
    revokeObjectURL: () => {},
    deniedBy: "browser",
  };
  const prepareSpy = vi.fn(prepare);
  fakes.transcriber = { prepare: prepareSpy };
  const armStart = () => {
    const started = deferred<void>();
    pendingStarts.push(() => started.resolve());
    return started.promise;
  };
  const startRecording = async () => {
    const started = armStart();
    await act(async () => {
      voice.toggle();
      await started;
    });
    expect(voice.state.phase).toBe("recording");
  };
  return { tracks, prepare: prepareSpy, armStart, startRecording };
}

let voice!: ComposerVoiceInput;
let commits: Array<{ text: string; selection: { start: number; end: number } }> = [];
function Host({ ownerKey }: { ownerKey: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const next = useComposerVoiceInput({
    environmentId: EnvironmentId.make("environment"),
    ownerKey,
    language: "",
    draftText: "hello",
    composerRef: rootRef,
    readDraft: () => ({ ownerKey, text: "hello", selection: { start: 5, end: 5 } }),
    commitDraft: (text, selection) => {
      commits.push({ text, selection });
      return true;
    },
  });
  useEffect(() => {
    voice = next;
  }, [next]);
  return (
    <div ref={rootRef}>
      <div contentEditable suppressContentEditableWarning aria-label="Composer editor" />
    </div>
  );
}

function Page({ ownerKey = "thread-1" }: { ownerKey?: string }) {
  return (
    <>
      <Host ownerKey={ownerKey} />
      <input aria-label="Sidebar search" />
      <div role="dialog" aria-label="Preferences">
        <button type="button">Close</button>
      </div>
    </>
  );
}

function pressEscape(target: Element) {
  return act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
}

describe("useComposerVoiceInput", () => {
  it("leaves Escape to an open dialog or another editable and cancels from the composer", async () => {
    const { tracks, startRecording } = setup();
    await using screen = await render(<Page />);
    await startRecording();

    await pressEscape(screen.getByRole("button", { name: "Close" }).element());
    expect(voice.state.phase).toBe("recording");
    await pressEscape(screen.getByRole("textbox", { name: "Sidebar search" }).element());
    expect(voice.state.phase).toBe("recording");
    expect(tracks[0]!.stop).not.toHaveBeenCalled();

    await pressEscape(screen.container.querySelector('[aria-label="Composer editor"]')!);
    expect(voice.state.phase).toBe("idle");
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels the recording when the composer's owner changes", async () => {
    const { tracks, startRecording } = setup();
    await using screen = await render(<Page ownerKey="thread-1" />);
    await startRecording();

    await screen.rerender(<Page ownerKey="thread-2" />);
    expect(voice.state.phase).toBe("idle");
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it("releases the microphone on cancel and on unmount", async () => {
    const { tracks, startRecording } = setup();
    await using screen = await render(<Page />);
    await startRecording();
    await act(async () => voice.cancel());
    expect(voice.state.phase).toBe("idle");
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1);

    await startRecording();
    await screen.unmount();
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(2);
  });

  it("inserts the transcript at the captured selection and announces each step", async () => {
    const { startRecording } = setup();
    await using _screen = await render(<Page />);
    expect(voice.announcement).toBe("");
    await startRecording();
    expect(voice.announcement).toBe("Recording.");

    await act(async () => voice.toggle());
    expect(voice.state.phase).toBe("idle");
    expect(commits).toEqual([{ text: "hello spoken", selection: { start: 12, end: 12 } }]);
    expect(voice.announcement).toBe("Transcript inserted.");
  });

  it("ignores toggle while voice input is still starting", async () => {
    const preparation = deferred<PreparedVoiceTranscription>();
    const { prepare, armStart } = setup(() => preparation.promise);
    await using screen = await render(<Page />);
    const started = armStart();
    await act(async () => voice.toggle());
    expect(voice.state.phase).toBe("preparing");
    expect(voice.busy).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);

    await act(async () => voice.toggle());
    expect(voice.state.phase).toBe("preparing");
    expect(prepare).toHaveBeenCalledTimes(1);

    await act(async () => {
      preparation.resolve(prepared);
      await started;
    });
    expect(voice.state.phase).toBe("recording");
    await screen.unmount();
  });
});
