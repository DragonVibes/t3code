import {
  VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS,
  VOICE_TRANSCRIPTION_URL_TTL_MS,
  VoiceTranscriptionAudioMimeType,
  type VoiceTranscriptionCreateUrlInput,
  type VoiceTranscriptionCreateUrlResult,
  VoiceTranscriptionInternalError,
  VoiceTranscriptionNotConfiguredError,
  type VoiceTranscriptionNotConfiguredReason,
  type VoiceTranscriptionProvider,
  type VoiceTranscriptionResult,
  type VoiceTranscriptionSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { loadUploadSigningSecret } from "../assets/AttachmentUpload.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AppleSpeechHelper from "./AppleSpeechHelper.ts";

export const VOICE_TRANSCRIPTION_ROUTE_PREFIX = "/api/voice/transcriptions";

const UPSTREAM_TIMEOUT_SECONDS = 90;
const UPSTREAM_MESSAGE_MAX_LENGTH = 300;

export class VoiceTranscriptionInvalidUploadError extends Schema.TaggedError<VoiceTranscriptionInvalidUploadError>()(
  "VoiceTranscriptionInvalidUploadError",
  {
    expectedBytes: Schema.Number,
    receivedBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `The recording was ${this.receivedBytes} bytes, expected ${this.expectedBytes}.`;
  }
}

export class VoiceTranscriptionCredentialsRejectedError extends Schema.TaggedError<VoiceTranscriptionCredentialsRejectedError>()(
  "VoiceTranscriptionCredentialsRejectedError",
  {
    host: Schema.String,
    status: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The transcription service at ${this.host} rejected the API key (HTTP ${this.status}).`;
  }
}

export class VoiceTranscriptionUpstreamError extends Schema.TaggedError<VoiceTranscriptionUpstreamError>()(
  "VoiceTranscriptionUpstreamError",
  {
    host: Schema.String,
    stage: Schema.Literals(["request", "timeout", "status", "response"]),
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "request":
        return `Could not reach the transcription service at ${this.host}.`;
      case "timeout":
        return `The transcription service at ${this.host} did not answer within ${UPSTREAM_TIMEOUT_SECONDS} seconds.`;
      case "status":
        return `The transcription service at ${this.host} answered HTTP ${this.status}.`;
      case "response":
        return `The transcription service at ${this.host} returned an unexpected response.`;
    }
  }
}

const VoiceTranscriptionClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("voice-transcription"),
  /** Keeps two otherwise identical links distinct, since each is accepted once. */
  nonce: Schema.String,
  mimeType: VoiceTranscriptionAudioMimeType,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
export type VoiceTranscriptionClaims = typeof VoiceTranscriptionClaims.Type;

const claimsJson = Schema.fromJsonString(VoiceTranscriptionClaims);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);
const encodeClaims = Schema.encodeSync(claimsJson);

const decodeTranscript = Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }));
// OpenAI nests the message under `error`; some compatible servers send `error` as a plain string.
const decodeUpstreamError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Union([Schema.Struct({ message: Schema.String }), Schema.String]),
    }),
  ),
);

const AUDIO_FILE_EXTENSIONS = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
} as const satisfies Record<VoiceTranscriptionAudioMimeType, string>;

interface TranscriptionFormInput {
  readonly model: string;
  readonly language: string;
  readonly file: Blob;
  readonly fileName: string;
}

interface ProviderBackendBase {
  readonly name: string;
  readonly acceptedMimeTypes: ReadonlyArray<VoiceTranscriptionAudioMimeType>;
}

interface HttpProviderBackend extends ProviderBackendBase {
  readonly kind: "http";
  readonly path: string;
  readonly hostedBaseUrl: string;
  readonly form: (input: TranscriptionFormInput) => FormData;
}

interface AppleProviderBackend extends ProviderBackendBase {
  readonly kind: "apple";
}

type ProviderBackend = HttpProviderBackend | AppleProviderBackend;

const PROVIDER_BACKENDS = {
  "openai-compatible": {
    kind: "http",
    name: "OpenAI",
    path: "audio/transcriptions",
    hostedBaseUrl: VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS["openai-compatible"].baseUrl,
    acceptedMimeTypes: VoiceTranscriptionAudioMimeType.literals,
    form: ({ model, language, file, fileName }) => {
      const form = new FormData();
      form.append("file", file, fileName);
      form.append("model", model);
      form.append("response_format", "json");
      if (language) {
        // gpt-transcribe takes a `languages` array instead of `language` and rejects both together.
        form.append(model.startsWith("gpt-transcribe") ? "languages[]" : "language", language);
      }
      return form;
    },
  },
  xai: {
    kind: "http",
    name: "xAI",
    path: "stt",
    hostedBaseUrl: VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS.xai.baseUrl,
    acceptedMimeTypes: ["audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"],
    form: ({ model, language, file, fileName }) => {
      const form = new FormData();
      form.append("model", model);
      if (language) form.append("language", language);
      // xAI may ignore fields sent after `file`, so it must be last.
      form.append("file", file, fileName);
      return form;
    },
  },
  "apple-on-device": {
    kind: "apple",
    name: "Apple on-device transcription",
    acceptedMimeTypes: ["audio/wav"],
  },
} as const satisfies Record<VoiceTranscriptionProvider, ProviderBackend>;

type HttpTranscriptionEndpoint = HttpProviderBackend & {
  readonly url: string;
  readonly host: string;
  readonly model: string;
  readonly language: string;
  readonly apiKey: string;
};

type TranscriptionEndpoint =
  | HttpTranscriptionEndpoint
  | (AppleProviderBackend & { readonly language: string });

const acceptsMimeType = (backend: ProviderBackend, mimeType: VoiceTranscriptionAudioMimeType) =>
  backend.acceptedMimeTypes.includes(mimeType);

const orInternalError =
  (stage: VoiceTranscriptionInternalError["stage"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) =>
        Effect.logError("Voice transcription hit a server error.", { stage, cause }),
      ),
      Effect.mapError((cause) => new VoiceTranscriptionInternalError({ stage, cause })),
    );

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly createUploadUrl: (
      input: VoiceTranscriptionCreateUrlInput,
    ) => Effect.Effect<
      VoiceTranscriptionCreateUrlResult,
      VoiceTranscriptionNotConfiguredError | VoiceTranscriptionInternalError
    >;
    readonly verifyUploadToken: (
      token: string,
    ) => Effect.Effect<Option.Option<VoiceTranscriptionClaims>, VoiceTranscriptionInternalError>;
    readonly transcribe: (
      claims: VoiceTranscriptionClaims,
      audio: Uint8Array<ArrayBuffer>,
    ) => Effect.Effect<
      VoiceTranscriptionResult,
      | VoiceTranscriptionNotConfiguredError
      | VoiceTranscriptionInvalidUploadError
      | VoiceTranscriptionCredentialsRejectedError
      | VoiceTranscriptionUpstreamError
      | VoiceTranscriptionInternalError
      | AppleSpeechHelper.AppleSpeechHelperError
    >;
  }
>()("t3/voiceTranscription/VoiceTranscription") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const client = yield* HttpClient.HttpClient;
  const appleSpeech = yield* AppleSpeechHelper.AppleSpeechHelper;
  const crypto = yield* Crypto.Crypto;
  const consumedSignatures = yield* Ref.make(new Map<string, number>());

  const signingSecret = loadUploadSigningSecret.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
    orInternalError("load-signing-key"),
  );

  const resolveEndpoint = Effect.fn("VoiceTranscription.resolveEndpoint")(function* (
    settings: VoiceTranscriptionSettings,
  ): Effect.fn.Return<TranscriptionEndpoint, VoiceTranscriptionNotConfiguredError> {
    const backend = PROVIDER_BACKENDS[settings.provider];
    const notConfigured = (reason: VoiceTranscriptionNotConfiguredReason) =>
      new VoiceTranscriptionNotConfiguredError({ reason, providerName: backend.name });
    if (!settings.enabled) return yield* notConfigured("disabled");
    if (backend.kind === "apple") {
      const availability = yield* appleSpeech.availability;
      if (availability !== "available") {
        return yield* notConfigured(
          availability === "unsupported-host" ? "apple-unsupported-host" : "apple-unavailable",
        );
      }
      return { ...backend, language: settings.language };
    }
    const baseUrl = settings.baseUrl.replace(/\/+$/, "");
    if (!baseUrl) return yield* notConfigured("missing-base-url");
    if (!settings.model) return yield* notConfigured("missing-model");
    if (!settings.apiKey && baseUrl === backend.hostedBaseUrl) {
      return yield* notConfigured("missing-api-key");
    }
    const url = URL.parse(`${baseUrl}/${backend.path}`);
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      return yield* notConfigured("invalid-base-url");
    }
    return {
      ...backend,
      url: url.toString(),
      host: url.host,
      model: settings.model,
      language: settings.language,
      apiKey: settings.apiKey,
    };
  });

  const loadEndpoint = Effect.fn("VoiceTranscription.loadEndpoint")(function* (
    mimeType: VoiceTranscriptionAudioMimeType,
  ) {
    const settings = yield* settingsService.getSettings.pipe(orInternalError("read-settings"));
    const endpoint = yield* resolveEndpoint(settings.voiceTranscription);
    if (!acceptsMimeType(endpoint, mimeType)) {
      return yield* new VoiceTranscriptionNotConfiguredError({
        reason: "unsupported-format",
        providerName: endpoint.name,
        mimeType,
      });
    }
    return endpoint;
  });

  const readUpstreamCause = Effect.fn("VoiceTranscription.readUpstreamCause")(function* (
    response: HttpClientResponse.HttpClientResponse,
    apiKey: string,
  ) {
    const body = yield* response.text.pipe(Effect.option);
    const reported = Option.getOrUndefined(Option.flatMap(body, decodeUpstreamError));
    if (reported === undefined) return undefined;
    const message = typeof reported.error === "string" ? reported.error : reported.error.message;
    const redacted = apiKey ? message.replaceAll(apiKey, "[key]") : message;
    return new Error(redacted.slice(0, UPSTREAM_MESSAGE_MAX_LENGTH));
  });

  const createUploadUrl = Effect.fn("VoiceTranscription.createUploadUrl")(function* (
    input: VoiceTranscriptionCreateUrlInput,
  ) {
    yield* loadEndpoint(input.mimeType);
    const secret = yield* signingSecret;
    const expiresAt = (yield* Clock.currentTimeMillis) + VOICE_TRANSCRIPTION_URL_TTL_MS;
    const encodedPayload = base64UrlEncode(
      encodeClaims({
        version: 1,
        kind: "voice-transcription",
        nonce: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        expiresAt,
      }),
    );
    return {
      relativeUrl: `${VOICE_TRANSCRIPTION_ROUTE_PREFIX}/${encodedPayload}.${signPayload(encodedPayload, secret)}`,
      expiresAt,
    };
  });

  const verifyUploadToken = Effect.fn("VoiceTranscription.verifyUploadToken")(function* (
    token: string,
  ) {
    const [encodedPayload, signature, unexpectedSegment] = token.split(".");
    if (!encodedPayload || !signature || unexpectedSegment !== undefined) {
      return Option.none();
    }
    const secret = yield* signingSecret;
    if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) {
      return Option.none();
    }
    const claims = Option.flatMap(
      Option.liftThrowable(base64UrlDecodeUtf8)(encodedPayload),
      decodeClaims,
    );
    const nowMs = yield* Clock.currentTimeMillis;
    if (Option.isNone(claims) || claims.value.expiresAt <= nowMs) return Option.none();
    const firstUse = yield* Ref.modify(consumedSignatures, (consumed) => {
      const live = new Map([...consumed].filter(([, expiresAt]) => expiresAt > nowMs));
      if (live.has(signature)) return [false, live];
      live.set(signature, claims.value.expiresAt);
      return [true, live];
    });
    return firstUse ? claims : Option.none();
  });

  const transcribe = Effect.fn("VoiceTranscription.transcribe")(function* (
    claims: VoiceTranscriptionClaims,
    audio: Uint8Array<ArrayBuffer>,
  ) {
    if (audio.byteLength !== claims.sizeBytes) {
      return yield* new VoiceTranscriptionInvalidUploadError({
        expectedBytes: claims.sizeBytes,
        receivedBytes: audio.byteLength,
      });
    }
    const endpoint = yield* loadEndpoint(claims.mimeType);
    if (endpoint.kind === "apple") {
      const { text } = yield* appleSpeech.transcribe({ audio, locale: endpoint.language }).pipe(
        Effect.catchTags({
          AppleSpeechUnsupportedLocaleError: ({ locale }) =>
            new VoiceTranscriptionNotConfiguredError({
              reason: "unsupported-locale",
              providerName: endpoint.name,
              locale,
            }),
        }),
      );
      return { text } satisfies VoiceTranscriptionResult;
    }
    const upstreamError = (
      fields: Omit<ConstructorParameters<typeof VoiceTranscriptionUpstreamError>[0], "host">,
    ) => new VoiceTranscriptionUpstreamError({ host: endpoint.host, ...fields });

    const request = HttpClientRequest.post(endpoint.url).pipe(
      HttpClientRequest.bodyFormData(
        endpoint.form({
          model: endpoint.model,
          language: endpoint.language,
          file: new Blob([audio], { type: claims.mimeType }),
          fileName: `audio.${AUDIO_FILE_EXTENSIONS[claims.mimeType]}`,
        }),
      ),
      endpoint.apiKey ? HttpClientRequest.bearerToken(endpoint.apiKey) : identity,
      HttpClientRequest.acceptJson,
    );
    return yield* Effect.gen(function* () {
      const response = yield* client
        .execute(request)
        .pipe(Effect.mapError((cause) => upstreamError({ stage: "request", cause })));
      if (response.status === 401 || response.status === 403) {
        return yield* new VoiceTranscriptionCredentialsRejectedError({
          host: endpoint.host,
          status: response.status,
          cause: yield* readUpstreamCause(response, endpoint.apiKey),
        });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* upstreamError({
          stage: "status",
          status: response.status,
          cause: yield* readUpstreamCause(response, endpoint.apiKey),
        });
      }
      const { text } = yield* response.json.pipe(
        Effect.flatMap(decodeTranscript),
        Effect.mapError((cause) => upstreamError({ stage: "response", cause })),
      );
      return { text } satisfies VoiceTranscriptionResult;
    }).pipe(
      Effect.timeoutOrElse({
        duration: `${UPSTREAM_TIMEOUT_SECONDS} seconds`,
        orElse: () => Effect.fail(upstreamError({ stage: "timeout" })),
      }),
    );
  });

  return VoiceTranscription.of({ createUploadUrl, verifyUploadToken, transcribe });
});

export const layer = Layer.effect(VoiceTranscription, make);
