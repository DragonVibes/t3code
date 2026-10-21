// @effect-diagnostics nodeBuiltinImport:off - the test runs a real HTTP server for undici fetch to call.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AppleSpeechHelper from "./AppleSpeechHelper.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

const audio = new Uint8Array(1024 * 1024).fill(7);

const claims = {
  version: 1,
  kind: "voice-transcription",
  nonce: "nonce",
  mimeType: "audio/webm",
  sizeBytes: audio.byteLength,
  expiresAt: Number.MAX_SAFE_INTEGER,
} as const;

type Upstream = (response: NodeHttp.ServerResponse) => void;

const upstreamServer = (answer: Upstream) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: NodeHttp.Server; readonly port: number }>((resume) => {
      // Answers before reading the upload, as a server rejecting the key does.
      const server = NodeHttp.createServer((_request, response) => answer(response));
      server.listen(0, "127.0.0.1", () =>
        resume(Effect.succeed({ server, port: (server.address() as NodeNet.AddressInfo).port })),
      );
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

const processFailures = Effect.acquireRelease(
  Effect.sync(() => {
    const failures: Array<unknown> = [];
    const record = (failure: unknown) => failures.push(failure);
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
    return { failures, record };
  }),
  ({ record }) =>
    Effect.sync(() => {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
    }),
);

// Not needed to pass. It gives a returning undici crash, which no event marks, time to land.
const settleProcess = Effect.sleep("200 millis");

const transcribeAgainst = (answer: Upstream) =>
  Effect.gen(function* () {
    const { failures } = yield* processFailures;
    const { port } = yield* upstreamServer(answer);
    const layer = VoiceTranscription.layer.pipe(
      Layer.provide(
        ServerSettings.layerTest({
          voiceTranscription: {
            enabled: true,
            apiKey: "sk-test",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "whisper-1",
          },
        }),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        Layer.succeed(
          AppleSpeechHelper.AppleSpeechHelper,
          AppleSpeechHelper.AppleSpeechHelper.of({
            available: Effect.succeed(false),
            streamAvailableChanges: Stream.make(false),
            availability: Effect.succeed("unsupported-host"),
            transcribe: () => Effect.die("unused"),
          }),
        ),
      ),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-fetch-test-" })),
      Layer.provide(NodeServices.layer),
    );
    const result = yield* Effect.gen(function* () {
      const voice = yield* VoiceTranscription.VoiceTranscription;
      return yield* voice.transcribe(claims, audio);
    }).pipe(Effect.provide(layer), Effect.result);
    yield* settleProcess;
    return { result, failures };
  }).pipe(Effect.scoped);

const json = (status: number, body: unknown) => (response: NodeHttp.ServerResponse) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
};

describe("VoiceTranscription over undici fetch", () => {
  it.live("reports rejected credentials without crashing the process", () =>
    Effect.gen(function* () {
      const { result, failures } = yield* transcribeAgainst(
        json(401, { error: { message: "Incorrect API key provided" } }),
      );
      expect(result).toMatchObject({
        failure: {
          _tag: "VoiceTranscriptionCredentialsRejectedError",
          status: 401,
          cause: { message: "Incorrect API key provided" },
        },
      });
      expect(failures).toEqual([]);
    }),
  );

  it.live("returns the transcript without crashing the process", () =>
    Effect.gen(function* () {
      const { result, failures } = yield* transcribeAgainst(json(200, { text: "hi" }));
      expect(result).toMatchObject({ success: { text: "hi" } });
      expect(failures).toEqual([]);
    }),
  );

  it.live("refuses a chunked body over the cap without crashing the process", () =>
    Effect.gen(function* () {
      const { result, failures } = yield* transcribeAgainst((response) => {
        response.writeHead(200, { "content-type": "application/json" });
        const chunk = Buffer.alloc(256 * 1024, " ");
        for (let index = 0; index < 6; index++) response.write(chunk);
        response.end("{}");
      });
      expect(result).toMatchObject({
        failure: {
          _tag: "VoiceTranscriptionUpstreamError",
          stage: "response",
          cause: { _tag: "VoiceTranscriptionUpstreamBodyTooLargeError" },
        },
      });
      expect(failures).toEqual([]);
    }),
  );

  it.live("reports rejected credentials sent without a length without crashing", () =>
    Effect.gen(function* () {
      const { result, failures } = yield* transcribeAgainst((response) => {
        response.writeHead(401, { "content-type": "application/json" });
        response.write(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
        response.end();
      });
      expect(result).toMatchObject({
        failure: {
          _tag: "VoiceTranscriptionCredentialsRejectedError",
          cause: { message: "Incorrect API key provided" },
        },
      });
      expect(failures).toEqual([]);
    }),
  );

  it.live("reports a 500 with an empty body without crashing the process", () =>
    Effect.gen(function* () {
      const { result, failures } = yield* transcribeAgainst((response) => {
        response.writeHead(500, { "content-length": 0 });
        response.end();
      });
      expect(result).toMatchObject({
        failure: { _tag: "VoiceTranscriptionUpstreamError", stage: "status", status: 500 },
      });
      expect(failures).toEqual([]);
    }),
  );
});
