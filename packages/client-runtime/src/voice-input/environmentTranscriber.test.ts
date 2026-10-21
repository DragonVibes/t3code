import {
  VoiceTranscriptionNotConfiguredError,
  type VoiceTranscriptionSettings,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createEnvironmentVoiceTranscriber,
  voiceTranscriptionUnavailableReason,
  type EnvironmentVoiceTranscriberDependencies,
} from "./environmentTranscriber.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

const RECORDING_URI = "blob:https://app.example/recording";

const HOSTED_OPENAI: VoiceTranscriptionSettings = {
  enabled: true,
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-transcribe",
  language: "",
  apiKey: "••••",
};

type PostResponse = { readonly status: number; readonly body: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(options: {
  readonly audio?: Blob;
  readonly language?: string;
  readonly settings?: VoiceTranscriptionSettings | null;
  readonly post?: PostResponse | ((init: RequestInit) => Promise<Response>);
  readonly createTranscriptionUrl?: EnvironmentVoiceTranscriberDependencies["createTranscriptionUrl"];
  readonly resolveUrl?: EnvironmentVoiceTranscriberDependencies["resolveUrl"];
  readonly prepareAudio?: EnvironmentVoiceTranscriberDependencies["prepareAudio"];
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
    readSettings: () => (options.settings === undefined ? HOSTED_OPENAI : options.settings),
    createTranscriptionUrl:
      options.createTranscriptionUrl ??
      (async (input) => {
        mintInputs.push(input);
        return { relativeUrl: "/api/voice/abc", expiresAt: 1 };
      }),
    resolveUrl: options.resolveUrl ?? ((relativeUrl) => `https://env.example${relativeUrl}`),
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...(options.prepareAudio ? { prepareAudio: options.prepareAudio } : {}),
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

  it("uploads the prepared audio in place of the raw recording", async () => {
    const harness = createHarness({
      prepareAudio: async (recording) =>
        new Blob([`wav:${await recording.text()}`], { type: "audio/wav" }),
    });
    await expect(transcribe(harness)).resolves.toBe("hello world");
    expect(harness.mintInputs).toEqual([{ mimeType: "audio/wav", sizeBytes: 15 }]);
    expect(harness.posts[0]?.init.headers).toEqual({ "content-type": "audio/wav" });
    expect(await new Response(harness.posts[0]?.init.body as Blob).text()).toBe("wav:audio-bytes");

    const broken = createHarness({
      prepareAudio: async () => {
        throw new Error("decode failed");
      },
    });
    const error = await transcriptionError(transcribe(broken));
    expect(error).toMatchObject({ code: "transcription-failed", retryable: false });
    expect(broken.mintInputs).toHaveLength(0);
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

    const internal = await transcriptionError(
      transcribe(
        createHarness({
          post: { status: 500, body: { code: "internal", message: "Server error." } },
        }),
      ),
    );
    expect(internal).toMatchObject({ code: "transcription-failed", message: "Server error." });

    const opaque = await transcriptionError(
      transcribe(createHarness({ post: { status: 500, body: "<html>" } })),
    );
    expect(opaque).toMatchObject({ code: "transcription-failed", retryable: true });

    const unreachable = await transcriptionError(
      transcribe(createHarness({ post: () => Promise.reject(new TypeError("fetch failed")) })),
    );
    expect(unreachable).toMatchObject({ code: "transcription-failed", retryable: true });
  });

  it.each([
    ["upstream_failed", 502, true],
    ["internal", 500, true],
    ["not_configured", 409, false],
    ["invalid_upload", 400, false],
    ["upstream_rejected_credentials", 502, false],
  ] as const)("marks a %s failure retryable: %s", async (code, status, retryable) => {
    const error = await transcriptionError(
      transcribe(createHarness({ post: { status, body: { code, message: "Refused." } } })),
    );
    expect(error.retryable).toBe(retryable);
  });

  it("maps a refused URL mint to unavailable with the environment's own reason", async () => {
    const refusedBy = (error: unknown) =>
      transcriptionError(
        transcribe(
          createHarness({
            createTranscriptionUrl: async () => {
              throw error;
            },
          }),
        ),
      );

    const decoded = await refusedBy(
      new VoiceTranscriptionNotConfiguredError({ reason: "missing-api-key", providerName: "xAI" }),
    );
    expect(decoded).toMatchObject({
      code: "unavailable",
      message: "Add an xAI API key to use voice transcription.",
      retryable: false,
    });

    const encoded = await refusedBy({
      _tag: "VoiceTranscriptionNotConfiguredError",
      reason: "insecure-base-url",
      providerName: "OpenAI",
    });
    expect(encoded).toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("https"),
    });

    const bare = await refusedBy({ _tag: "VoiceTranscriptionNotConfiguredError" });
    expect(bare).toMatchObject({ code: "unavailable", message: expect.stringContaining("not") });

    const offline = await transcriptionError(
      transcribe(
        createHarness({
          createTranscriptionUrl: async () => {
            throw new Error("socket closed");
          },
        }),
      ),
    );
    expect(offline).toMatchObject({ code: "transcription-failed", retryable: true });

    const disconnected = await transcriptionError(
      transcribe(createHarness({ resolveUrl: () => null })),
    );
    expect(disconnected).toMatchObject({ code: "transcription-failed", retryable: true });
  });

  it("settles as cancelled only after the upload itself has been aborted", async () => {
    const controller = new AbortController();
    const uploadEntered = deferred<void>();
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
          uploadEntered.resolve(undefined);
        }),
    });
    const pending = transcribe(harness, controller.signal);
    await uploadEntered.promise;
    controller.abort();
    const cancelled = await transcriptionError(pending);
    expect(cancelled.code).toBe("cancelled");
    expect(uploadSettled).toBe(true);
  });

  it("settles as cancelled while a URL mint is still pending", async () => {
    const controller = new AbortController();
    const mintEntered = deferred<void>();
    const harness = createHarness({
      createTranscriptionUrl: () => {
        mintEntered.resolve(undefined);
        return new Promise(() => {});
      },
    });
    const pending = transcribe(harness, controller.signal);
    await mintEntered.promise;
    controller.abort();
    const cancelled = await transcriptionError(pending);
    expect(cancelled.code).toBe("cancelled");
    expect(harness.posts).toHaveLength(0);
  });

  it("refuses to prepare when the environment's own settings cannot transcribe", async () => {
    const signal = new AbortController().signal;
    const configured = (settings: Partial<VoiceTranscriptionSettings>) => ({
      ...HOSTED_OPENAI,
      ...settings,
    });
    const prepare = (settings: VoiceTranscriptionSettings | null) =>
      createHarness({ settings }).transcriber.prepare({ signal });

    const disabled = await transcriptionError(prepare(configured({ enabled: false })));
    expect(disabled).toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("off"),
    });
    const keyless = await transcriptionError(prepare(configured({ apiKey: "" })));
    expect(keyless.message).toBe("Add an OpenAI API key to use voice transcription.");
    const keylessXai = await transcriptionError(
      prepare(configured({ provider: "xai", baseUrl: "https://api.x.ai/v1/", apiKey: "" })),
    );
    expect(keylessXai.message).toBe("Add an xAI API key to use voice transcription.");

    await expect(
      prepare(configured({ baseUrl: "http://127.0.0.1:8080/v1", apiKey: "" })),
    ).resolves.toBeDefined();
    await expect(prepare(null)).resolves.toBeDefined();
    expect(voiceTranscriptionUnavailableReason(HOSTED_OPENAI)).toBeNull();
  });

  it("leaves Apple availability to the environment, which names the reason", async () => {
    const apple = { ...HOSTED_OPENAI, provider: "apple-on-device" as const, apiKey: "" };
    await expect(transcribe(createHarness({ settings: apple }))).resolves.toBe("hello world");

    const refused = await transcriptionError(
      transcribe(
        createHarness({
          settings: apple,
          createTranscriptionUrl: async () => {
            throw new VoiceTranscriptionNotConfiguredError({
              reason: "apple-unavailable",
              providerName: "Apple on-device transcription",
            });
          },
        }),
      ),
    );
    expect(refused).toMatchObject({
      code: "unavailable",
      message: "Apple on-device transcription is unavailable on the machine running T3 Code.",
    });
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
    expect(error).toMatchObject({ code: "transcription-failed", retryable: false });
    expect(harness.mintInputs).toHaveLength(0);
    expect(harness.posts).toHaveLength(0);
  });
});
