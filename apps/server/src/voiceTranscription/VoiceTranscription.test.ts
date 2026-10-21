import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ServerSettingsError,
  type VoiceTranscriptionAudioMimeType,
  type VoiceTranscriptionSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { issueAttachmentUploadUrl } from "../assets/AttachmentUpload.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AppleSpeechHelper from "./AppleSpeechHelper.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

const audio = new Uint8Array([1, 2, 3, 4, 5, 6]);

const appleSpeechWith = (
  availability: AppleSpeechHelper.AppleSpeechAvailability,
  transcribe: AppleSpeechHelper.AppleSpeechHelper["Service"]["transcribe"] = () =>
    Effect.die("the Apple speech helper is unavailable"),
) =>
  AppleSpeechHelper.AppleSpeechHelper.of({
    available: Effect.succeed(availability === "available"),
    availability: Effect.succeed(availability),
    transcribe,
  });

const appleSpeechUnavailable = appleSpeechWith("unsupported-host");

const appleSpeechAvailable = (
  transcribe: AppleSpeechHelper.AppleSpeechHelper["Service"]["transcribe"],
) => appleSpeechWith("available", transcribe);

function setup(
  settings: Partial<VoiceTranscriptionSettings>,
  upstream: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response> = () =>
    Effect.succeed(Response.json({ text: "hello world" })),
  appleSpeech = appleSpeechUnavailable,
  overrides: {
    readonly settingsService?: Layer.Layer<ServerSettings.ServerSettingsService>;
    readonly secretStore?: Layer.Layer<ServerSecretStore.ServerSecretStore>;
  } = {},
) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) =>
    Effect.suspend(() => {
      requests.push(request);
      return upstream(request);
    }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response))),
  );
  const layer = VoiceTranscription.layer.pipe(
    Layer.provideMerge(
      overrides.settingsService ??
        ServerSettings.layerTest({
          voiceTranscription: { enabled: true, apiKey: "sk-test", ...settings },
        }),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(Layer.succeed(AppleSpeechHelper.AppleSpeechHelper, appleSpeech)),
    Layer.provideMerge(overrides.secretStore ?? ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, requests };
}

const mintAs = (mimeType: VoiceTranscriptionAudioMimeType) =>
  Effect.gen(function* () {
    const voice = yield* VoiceTranscription.VoiceTranscription;
    return yield* voice.createUploadUrl({ mimeType, sizeBytes: audio.byteLength });
  });
const mint = mintAs("audio/webm");

const xai = {
  provider: "xai",
  baseUrl: "https://api.x.ai/v1",
  model: "grok-voice-transcribe-2.0",
} as const;

const apple = { provider: "apple-on-device", baseUrl: "", model: "", apiKey: "" } as const;

const post = (
  relativeUrl: string,
  options: { readonly body?: Uint8Array; readonly contentLength?: number } = {},
) =>
  Effect.gen(function* () {
    const body = options.body ?? audio;
    const app = yield* HttpRouter.toHttpEffect(ServerHttp.layerVoiceTranscriptionRoute);
    const request = new Request(`http://t3.test${relativeUrl}`, {
      method: "POST",
      body: new Blob([new Uint8Array(body)]),
      headers: {
        "content-type": "audio/webm",
        "content-length": String(options.contentLength ?? body.byteLength),
      },
    });
    const response = HttpServerResponse.toWeb(
      yield* app.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      ),
    );
    return {
      status: response.status,
      body: (yield* Effect.promise(() => response.json())) as Record<string, unknown>,
    };
  }).pipe(Effect.scoped);

const formOf = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "FormData")
    throw new Error(`expected FormData, got ${request.body._tag}`);
  return request.body.formData;
};

describe("VoiceTranscription", () => {
  it("lets the cross-origin hosted web app read the transcript", async () => {
    const layerApp = Layer.mergeAll(
      ServerHttp.layerVoiceTranscriptionRoute,
      ServerHttp.layerBrowserApiCors,
    ).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-cors-test-" })),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
    const services = Context.make(
      VoiceTranscription.VoiceTranscription,
      VoiceTranscription.VoiceTranscription.of({
        createUploadUrl: () => Effect.die("unused"),
        verifyUploadToken: () =>
          Effect.succeedSome({
            version: 1,
            kind: "voice-transcription",
            nonce: "nonce",
            mimeType: "audio/webm",
            sizeBytes: audio.byteLength,
            expiresAt: Number.MAX_SAFE_INTEGER,
          } as const),
        transcribe: () => Effect.succeed({ text: "hello world" }),
      }),
    );
    try {
      const url = "https://backend.example/api/voice/transcriptions/token";
      const preflight = await handler(
        new Request(url, {
          method: "OPTIONS",
          headers: {
            origin: "https://app.t3.codes",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        }),
        services,
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

      const response = await handler(
        new Request(url, {
          method: "POST",
          body: new Blob([audio]),
          headers: {
            origin: "https://app.t3.codes",
            "content-type": "audio/webm",
            "content-length": String(audio.byteLength),
          },
        }),
        services,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toEqual({ text: "hello world" });
    } finally {
      await dispose();
    }
  });

  it.effect.each([
    { settings: { enabled: false }, message: "turned off" },
    { settings: { apiKey: "" }, message: "OpenAI API key" },
    { settings: { ...xai, apiKey: "" }, message: "xAI API key" },
    { settings: xai, message: "xAI does not accept audio/webm recordings." },
    { settings: apple, message: "Apple on-device transcription needs macOS 26 or later" },
    {
      settings: apple,
      appleSpeech: appleSpeechWith("unavailable"),
      message: "Apple on-device transcription is unavailable on the machine running T3 Code.",
    },
    { settings: { model: "" }, message: "model name" },
    { settings: { baseUrl: "" }, message: "endpoint URL" },
    { settings: { baseUrl: "ftp://whisper.local" }, message: "not valid" },
  ] as const)("refuses to mint an upload URL when $message", (expected) => {
    const { settings, message } = expected;
    const { layer } = setup(
      settings,
      undefined,
      "appleSpeech" in expected ? expected.appleSpeech : undefined,
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(mint);
      expect(error._tag).toBe("VoiceTranscriptionNotConfiguredError");
      expect(error.message).toContain(message);
    }).pipe(Effect.provide(layer));
  });

  it.effect("transcribes through a keyless local server with the singular language hint", () => {
    const { layer, requests } = setup({
      baseUrl: "http://whisper.local:8080/v1/",
      model: "whisper-1",
      language: "en",
      apiKey: "",
    });
    return Effect.gen(function* () {
      const issued = yield* mint;
      expect(issued.relativeUrl.startsWith("/api/voice/transcriptions/")).toBe(true);
      const response = yield* post(issued.relativeUrl);

      expect(response).toEqual({ status: 200, body: { text: "hello world" } });
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url).toBe("http://whisper.local:8080/v1/audio/transcriptions");
      expect(request.headers.authorization).toBeUndefined();
      const form = formOf(request);
      expect(form.get("model")).toBe("whisper-1");
      expect(form.get("response_format")).toBe("json");
      expect(form.getAll("language")).toEqual(["en"]);
      expect(form.has("languages[]")).toBe(false);
      const file = form.get("file") as File;
      expect(file.name).toBe("audio.webm");
      expect(file.type).toBe("audio/webm");
      expect(new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))).toEqual(audio);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    { language: "fr", languages: ["fr"] },
    { language: "", languages: [] },
  ])(
    "sends gpt-transcribe language hint $language as languages with the key",
    ({ language, languages }) => {
      const { layer, requests } = setup({ language });
      return Effect.gen(function* () {
        expect((yield* post((yield* mint).relativeUrl)).status).toBe(200);
        const request = requests[0]!;
        expect(request.url).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(request.headers.authorization).toBe("Bearer sk-test");
        const form = formOf(request);
        expect(form.get("model")).toBe("gpt-transcribe");
        expect(form.getAll("languages[]")).toEqual(languages);
        expect(form.has("language")).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([
    { language: "en", fields: ["model", "language", "file"] },
    { language: "", fields: ["model", "file"] },
  ])(
    "transcribes through xAI speech-to-text with language hint '$language' and the file last",
    ({ language, fields }) => {
      const { layer, requests } = setup({ ...xai, language }, () =>
        Effect.succeed(
          Response.json({ text: "hello grok", language: "en", duration: 1.2, words: [] }),
        ),
      );
      return Effect.gen(function* () {
        const response = yield* post((yield* mintAs("audio/wav")).relativeUrl);

        expect(response).toEqual({ status: 200, body: { text: "hello grok" } });
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://api.x.ai/v1/stt");
        expect(request.headers.authorization).toBe("Bearer sk-test");
        const form = formOf(request);
        expect([...form.keys()]).toEqual(fields);
        expect(form.get("model")).toBe("grok-voice-transcribe-2.0");
        expect(form.getAll("language")).toEqual(language ? [language] : []);
        const file = form.get("file") as File;
        expect(file.name).toBe("audio.wav");
        expect(file.type).toBe("audio/wav");
        expect(new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))).toEqual(audio);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("mints WAV but not WebM for Apple on-device without a key, URL, or model", () => {
    const { layer } = setup(
      apple,
      undefined,
      appleSpeechAvailable(() => Effect.die("unused")),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(mint);
      expect(error.message).toBe(
        "Apple on-device transcription does not accept audio/webm recordings.",
      );
      const issued = yield* mintAs("audio/wav");
      expect(issued.relativeUrl.startsWith("/api/voice/transcriptions/")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("transcribes WAV through the Apple speech helper without an HTTP request", () => {
    const transcribed: Array<{ readonly audio: Uint8Array; readonly locale: string }> = [];
    const { layer, requests } = setup(
      { ...apple, language: "en" },
      undefined,
      appleSpeechAvailable((input) => {
        transcribed.push(input);
        return Effect.succeed({ text: "hello apple", locale: "en_US" });
      }),
    );
    return Effect.gen(function* () {
      const response = yield* post((yield* mintAs("audio/wav")).relativeUrl);
      expect(response).toEqual({ status: 200, body: { text: "hello apple" } });
      expect(requests).toHaveLength(0);
      expect(transcribed).toEqual([{ audio, locale: "en" }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      failure: new AppleSpeechHelper.AppleSpeechUnsupportedLocaleError({ locale: "xx-YY" }),
      status: 409,
      code: "not_configured",
      message: "Apple on-device transcription does not support the language 'xx-YY'.",
    },
    {
      failure: new AppleSpeechHelper.AppleSpeechHelperError({ reason: "assets_failed" }),
      status: 502,
      code: "upstream_failed",
      message: "The Apple speech language model could not be downloaded.",
    },
  ])("answers $code when the Apple speech helper fails with $failure._tag", (expected) => {
    const { layer } = setup(
      apple,
      undefined,
      appleSpeechAvailable(() => expected.failure),
    );
    return Effect.gen(function* () {
      const response = yield* post((yield* mintAs("audio/wav")).relativeUrl);
      expect(response).toEqual({
        status: expected.status,
        body: { code: expected.code, message: expected.message },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a WebM upload minted before switching to xAI without calling upstream", () => {
    const { layer, requests } = setup({});
    return Effect.gen(function* () {
      const issued = yield* mint;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ voiceTranscription: { ...xai, apiKey: "sk-xai" } });
      const response = yield* post(issued.relativeUrl);
      expect(response).toEqual({
        status: 409,
        body: { code: "not_configured", message: "xAI does not accept audio/webm recordings." },
      });
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    {
      upstream: Response.json(
        { error: { message: "Incorrect API key provided: sk-test." } },
        { status: 401 },
      ),
      code: "upstream_rejected_credentials",
      message: "The transcription service at api.openai.com rejected the API key (HTTP 401).",
      cause: "Incorrect API key provided: [key].",
    },
    {
      upstream: Response.json({ error: "model not loaded" }, { status: 500 }),
      code: "upstream_failed",
      message: "The transcription service at api.openai.com answered HTTP 500.",
      cause: "model not loaded",
    },
    {
      upstream: new Response("<html>bad gateway</html>", { status: 503 }),
      code: "upstream_failed",
      message: "The transcription service at api.openai.com answered HTTP 503.",
      cause: undefined,
    },
    {
      upstream: Response.json({ transcript: "wrong shape" }),
      code: "upstream_failed",
      message: "The transcription service at api.openai.com returned an unexpected response.",
      cause: undefined,
    },
  ])(
    "answers $code with a 502 for upstream HTTP $upstream.status",
    ({ upstream, code, message, cause }) => {
      const { layer } = setup({}, () => Effect.succeed(upstream.clone()));
      return Effect.gen(function* () {
        const response = yield* post((yield* mint).relativeUrl);
        expect(response).toEqual({ status: 502, body: { code, message } });

        const voice = yield* VoiceTranscription.VoiceTranscription;
        const token = (yield* mint).relativeUrl.split("/").at(-1)!;
        const claims = Option.getOrThrow(yield* voice.verifyUploadToken(token));
        const error = yield* Effect.flip(voice.transcribe(claims, audio));
        if (cause !== undefined) {
          expect(error.cause).toBeInstanceOf(Error);
          expect((error.cause as Error).message).toBe(cause);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("answers internal when the settings cannot be read", () => {
    const { layer } = setup({}, undefined, undefined, {
      settingsService: Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.fail(
          new ServerSettingsError({ settingsPath: "settings.json", operation: "read-file" }),
        ),
      }),
    });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(mint);
      expect(error._tag).toBe("VoiceTranscriptionInternalError");
      expect(error.message).toBe("Voice transcription hit a server error.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers internal instead of an invalid link when the signing key cannot load", () => {
    const { layer, requests } = setup({}, undefined, undefined, {
      secretStore: Layer.mock(ServerSecretStore.ServerSecretStore)({
        getOrCreateRandom: () =>
          Effect.fail(
            new ServerSecretStore.SecretStoreReadError({
              resource: "upload signing key",
              cause: new Error("disk unreadable"),
            }),
          ),
      }),
    });
    return Effect.gen(function* () {
      const response = yield* post("/api/voice/transcriptions/payload.signature");
      expect(response).toEqual({
        status: 500,
        body: { code: "internal", message: "Voice transcription hit a server error." },
      });
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("answers upstream_failed when the service does not answer in time", () =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const { layer } = setup({}, () =>
        Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
      );
      yield* Effect.gen(function* () {
        const pending = yield* Effect.forkChild(post((yield* mint).relativeUrl));
        yield* Deferred.await(reached);
        yield* TestClock.adjust("90 seconds");
        const response = yield* Fiber.join(pending);
        expect(response.status).toBe(502);
        expect(response.body).toEqual({
          code: "upstream_failed",
          message: "The transcription service at api.openai.com did not answer within 90 seconds.",
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "rejects tampered, expired, foreign, and mis-sized uploads before calling upstream",
    () => {
      const { layer, requests } = setup({});
      return Effect.gen(function* () {
        const attachment = yield* issueAttachmentUploadUrl({
          type: "file",
          name: "audio.webm",
          mimeType: "audio/webm",
          sizeBytes: audio.byteLength,
        });
        const attachmentToken = attachment.relativeUrl.split("/").at(-1)!;
        const rejected = [
          yield* post(`${(yield* mint).relativeUrl}x`),
          yield* post(`/api/voice/transcriptions/${attachmentToken}`),
          yield* post((yield* mint).relativeUrl, { contentLength: audio.byteLength + 1 }),
          yield* post((yield* mint).relativeUrl, {
            body: audio.slice(1),
            contentLength: audio.byteLength - 1,
          }),
        ];
        const expiring = yield* mint;
        yield* TestClock.adjust("2 minutes");
        rejected.push(yield* post(expiring.relativeUrl));

        for (const response of rejected) {
          expect(response.status).toBe(400);
          expect(response.body.code).toBe("invalid_upload");
        }
        expect(requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("accepts each upload link once", () => {
    const { layer, requests } = setup({});
    return Effect.gen(function* () {
      const issued = yield* mint;
      expect((yield* post(issued.relativeUrl)).status).toBe(200);
      expect(yield* post(issued.relativeUrl)).toEqual({
        status: 400,
        body: {
          code: "invalid_upload",
          message: "This transcription link is invalid or has expired.",
        },
      });
      expect((yield* post((yield* mint).relativeUrl)).status).toBe(200);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps upload links out of traces", () =>
    Effect.gen(function* () {
      const traced = yield* Deferred.make<(path: string) => boolean>();
      yield* Layer.build(
        ServerHttp.withUntracedRequests(
          Layer.effectDiscard(
            Effect.gen(function* () {
              const disabled = yield* HttpMiddleware.TracerDisabledWhen;
              yield* Deferred.succeed(
                traced,
                (path) =>
                  !disabled(HttpServerRequest.fromWeb(new Request(`http://t3.test${path}`))),
              );
            }),
          ),
        ),
      );
      const isTraced = yield* Deferred.await(traced);
      expect(isTraced("/api/voice/transcriptions/payload.signature")).toBe(false);
      expect(isTraced("/api/attachments/upload/payload.signature")).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("answers not_configured when transcription is turned off after minting", () => {
    const { layer, requests } = setup({});
    return Effect.gen(function* () {
      const issued = yield* mint;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ voiceTranscription: { enabled: false } });
      const response = yield* post(issued.relativeUrl);
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        code: "not_configured",
        message: "Voice transcription is turned off for this environment.",
      });
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});
