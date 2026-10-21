import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { VoiceTranscriptionSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { issueAttachmentUploadUrl } from "../assets/AttachmentUpload.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerHttp from "../http.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

const audio = new Uint8Array([1, 2, 3, 4, 5, 6]);

function setup(
  settings: Partial<VoiceTranscriptionSettings>,
  upstream: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response> = () =>
    Effect.succeed(Response.json({ text: "hello world" })),
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
      ServerSettings.layerTest({
        voiceTranscription: { enabled: true, apiKey: "sk-test", ...settings },
      }),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, requests };
}

const mint = Effect.gen(function* () {
  const voice = yield* VoiceTranscription.VoiceTranscription;
  return yield* voice.createUploadUrl({ mimeType: "audio/webm", sizeBytes: audio.byteLength });
});

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
    { settings: { model: "" }, message: "model name" },
    { settings: { baseUrl: "" }, message: "endpoint URL" },
    { settings: { baseUrl: "ftp://whisper.local" }, message: "not valid" },
  ] as const)("refuses to mint an upload URL when $message", ({ settings, message }) => {
    const { layer } = setup(settings);
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
    {
      upstream: Response.json(
        { error: { message: "Incorrect API key provided: sk-test." } },
        { status: 401 },
      ),
      code: "upstream_rejected_credentials",
      message: "api.openai.com rejected the API key (HTTP 401): Incorrect API key provided: [key].",
    },
    {
      upstream: Response.json({ error: "model not loaded" }, { status: 500 }),
      code: "upstream_failed",
      message: "api.openai.com answered HTTP 500: model not loaded",
    },
    {
      upstream: new Response("<html>bad gateway</html>", { status: 503 }),
      code: "upstream_failed",
      message: "api.openai.com answered HTTP 503.",
    },
    {
      upstream: Response.json({ transcript: "wrong shape" }),
      code: "upstream_failed",
      message: "api.openai.com returned an unexpected response.",
    },
  ])(
    "answers $code with a 502 for upstream HTTP $upstream.status",
    ({ upstream, code, message }) => {
      const { layer } = setup({}, () => Effect.succeed(upstream));
      return Effect.gen(function* () {
        const response = yield* post((yield* mint).relativeUrl);
        expect(response.status).toBe(502);
        expect(response.body.code).toBe(code);
        expect(response.body.message).toContain(message);
        expect(JSON.stringify(response.body)).not.toContain("sk-test");
      }).pipe(Effect.provide(layer));
    },
  );

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
        const issued = yield* mint;
        const attachment = yield* issueAttachmentUploadUrl({
          type: "file",
          name: "audio.webm",
          mimeType: "audio/webm",
          sizeBytes: audio.byteLength,
        });
        const attachmentToken = attachment.relativeUrl.split("/").at(-1)!;
        const rejected = [
          yield* post(`${issued.relativeUrl}x`),
          yield* post(`/api/voice/transcriptions/${attachmentToken}`),
          yield* post(issued.relativeUrl, { contentLength: audio.byteLength + 1 }),
          yield* post(issued.relativeUrl, {
            body: audio.slice(1),
            contentLength: audio.byteLength - 1,
          }),
        ];
        yield* TestClock.adjust("2 minutes");
        rejected.push(yield* post(issued.relativeUrl));

        for (const response of rejected) {
          expect(response.status).toBe(400);
          expect(response.body.code).toBe("invalid_upload");
        }
        expect(requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
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
