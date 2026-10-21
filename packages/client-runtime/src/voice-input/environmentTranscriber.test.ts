import { describe, expect, it, vi } from "vite-plus/test";

import {
  createEnvironmentVoiceTranscriber,
  type EnvironmentVoiceTranscriberDependencies,
} from "./environmentTranscriber.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

const RECORDING_URI = "blob:https://app.example/recording";

type PostResponse = { readonly status: number; readonly body: unknown };

function createHarness(options: {
  readonly audio?: Blob;
  readonly language?: string;
  readonly post?: PostResponse | ((init: RequestInit) => Promise<Response>);
  readonly createTranscriptionUrl?: EnvironmentVoiceTranscriberDependencies["createTranscriptionUrl"];
  readonly resolveUrl?: EnvironmentVoiceTranscriberDependencies["resolveUrl"];
}) {
  const audio = options.audio ?? new Blob(["audio-bytes"], { type: "audio/webm;codecs=opus" });
  const posts: Array<{ url: string; init: RequestInit }> = [];
  const mintInputs: Array<{ mimeType: string; sizeBytes: number }> = [];
  const post = options.post ?? { status: 200, body: { text: "hello world" } };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === RECORDING_URI) return new Response(audio);
    posts.push({ url, init: init ?? {} });
    if (typeof post === "function") return post(init ?? {});
    return new Response(JSON.stringify(post.body), {
      status: post.status,
      headers: { "content-type": "application/json" },
    });
  });
  const transcriber = createEnvironmentVoiceTranscriber({
    language: () => options.language ?? "",
    fallbackLocale: () => "fr-FR",
    createTranscriptionUrl:
      options.createTranscriptionUrl ??
      (async (input) => {
        mintInputs.push(input);
        return { relativeUrl: "/api/voice/abc", expiresAt: 1 };
      }),
    resolveUrl: options.resolveUrl ?? ((relativeUrl) => `https://env.example${relativeUrl}`),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { transcriber, posts, mintInputs };
}

async function transcribe(
  harness: ReturnType<typeof createHarness>,
  signal: AbortSignal = new AbortController().signal,
) {
  const prepared = await harness.transcriber.prepare({ signal });
  return prepared.transcribe(RECORDING_URI, { signal });
}

async function transcriptionError(promise: Promise<unknown>): Promise<VoiceTranscriptionError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(VoiceTranscriptionError);
  return error as VoiceTranscriptionError;
}

describe("createEnvironmentVoiceTranscriber", () => {
  it("posts the recording to the minted URL as its container type and returns the text", async () => {
    const harness = createHarness({});
    await expect(transcribe(harness)).resolves.toBe("hello world");

    expect(harness.mintInputs).toEqual([{ mimeType: "audio/webm", sizeBytes: 11 }]);
    expect(harness.posts).toHaveLength(1);
    const [post] = harness.posts;
    expect(post?.url).toBe("https://env.example/api/voice/abc");
    expect(post?.init.method).toBe("POST");
    expect(post?.init.headers).toEqual({ "content-type": "audio/webm" });
    expect(await new Response(post?.init.body as Blob).text()).toBe("audio-bytes");
  });

  it("uses the configured language as the locale and falls back to the device locale", async () => {
    const signal = new AbortController().signal;
    expect((await createHarness({ language: "de" }).transcriber.prepare({ signal })).locale).toBe(
      "de",
    );
    expect((await createHarness({}).transcriber.prepare({ signal })).locale).toBe("fr-FR");
  });

  it("surfaces the environment's failure message and marks a missing configuration unavailable", async () => {
    const rejected = await transcriptionError(
      transcribe(
        createHarness({
          post: { status: 502, body: { code: "upstream_failed", message: "Groq is down." } },
        }),
      ),
    );
    expect(rejected).toMatchObject({ code: "transcription-failed", message: "Groq is down." });

    const unconfigured = await transcriptionError(
      transcribe(
        createHarness({
          post: { status: 409, body: { code: "not_configured", message: "Add an API key." } },
        }),
      ),
    );
    expect(unconfigured).toMatchObject({ code: "unavailable", message: "Add an API key." });

    const opaque = await transcriptionError(
      transcribe(createHarness({ post: { status: 500, body: "<html>" } })),
    );
    expect(opaque.code).toBe("transcription-failed");
  });

  it("maps a refused URL mint to unavailable when the environment is not configured", async () => {
    const unconfigured = await transcriptionError(
      transcribe(
        createHarness({
          createTranscriptionUrl: async () => {
            throw { _tag: "VoiceTranscriptionNotConfiguredError", message: "no key" };
          },
        }),
      ),
    );
    expect(unconfigured.code).toBe("unavailable");

    const offline = await transcriptionError(
      transcribe(
        createHarness({
          createTranscriptionUrl: async () => {
            throw new Error("socket closed");
          },
        }),
      ),
    );
    expect(offline.code).toBe("transcription-failed");

    const disconnected = await transcriptionError(
      transcribe(createHarness({ resolveUrl: () => null })),
    );
    expect(disconnected.code).toBe("transcription-failed");
  });

  it("settles as cancelled only after the upload itself has been aborted", async () => {
    const controller = new AbortController();
    let uploadSettled = false;
    const harness = createHarness({
      post: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            void Promise.resolve().then(() => {
              uploadSettled = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }),
    });
    const pending = transcribe(harness, controller.signal);
    await vi.waitFor(() => expect(harness.posts).toHaveLength(1));
    controller.abort();
    const cancelled = await transcriptionError(pending);
    expect(cancelled.code).toBe("cancelled");
    expect(uploadSettled).toBe(true);
  });

  it.each([
    ["an unsupported container", new Blob(["x"], { type: "audio/flac" })],
    ["an empty recording", new Blob([], { type: "audio/mp4" })],
    [
      "an oversized recording",
      new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: "audio/ogg" }),
    ],
  ])("rejects %s before minting a URL", async (_label, audio) => {
    const harness = createHarness({ audio });
    const error = await transcriptionError(transcribe(harness));
    expect(error.code).toBe("transcription-failed");
    expect(harness.mintInputs).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
  });
});
