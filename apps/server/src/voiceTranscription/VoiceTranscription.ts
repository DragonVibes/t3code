import {
  VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS,
  VOICE_TRANSCRIPTION_URL_TTL_MS,
  VoiceTranscriptionAudioMimeType,
  type VoiceTranscriptionCreateUrlInput,
  type VoiceTranscriptionCreateUrlResult,
  VoiceTranscriptionNotConfiguredError,
  type VoiceTranscriptionProvider,
  type VoiceTranscriptionResult,
  type VoiceTranscriptionSettings,
  VoiceTranscriptionSigningKeyError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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

export const VOICE_TRANSCRIPTION_ROUTE_PREFIX = "/api/voice/transcriptions";

const UPSTREAM_TIMEOUT_SECONDS = 90;
const UPSTREAM_MESSAGE_MAX_LENGTH = 300;

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

interface ProviderProtocol {
  readonly name: string;
  readonly path: string;
  readonly acceptedMimeTypes: ReadonlyArray<VoiceTranscriptionAudioMimeType>;
  readonly form: (input: TranscriptionFormInput) => FormData;
}

const PROVIDER_PROTOCOLS = {
  "openai-compatible": {
    name: "OpenAI",
    path: "audio/transcriptions",
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
    name: "xAI",
    path: "stt",
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
} as const satisfies Record<VoiceTranscriptionProvider, ProviderProtocol>;

const VoiceTranscriptionClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("voice-transcription"),
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

export class VoiceTranscriptionUnsupportedFormatError extends Schema.TaggedError<VoiceTranscriptionUnsupportedFormatError>()(
  "VoiceTranscriptionUnsupportedFormatError",
  {
    providerName: Schema.String,
    mimeType: VoiceTranscriptionAudioMimeType,
  },
) {
  override get message(): string {
    return unsupportedFormatMessage(this.providerName, this.mimeType);
  }
}

const unsupportedFormatMessage = (
  providerName: string,
  mimeType: VoiceTranscriptionAudioMimeType,
) => `${providerName} does not accept ${mimeType} recordings.`;

export class VoiceTranscriptionCredentialsRejectedError extends Schema.TaggedError<VoiceTranscriptionCredentialsRejectedError>()(
  "VoiceTranscriptionCredentialsRejectedError",
  {
    host: Schema.String,
    status: Schema.Number,
    upstreamMessage: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `The transcription service at ${this.host} rejected the API key (HTTP ${this.status})${
      this.upstreamMessage ? `: ${this.upstreamMessage}` : "."
    }`;
  }
}

export class VoiceTranscriptionUpstreamError extends Schema.TaggedError<VoiceTranscriptionUpstreamError>()(
  "VoiceTranscriptionUpstreamError",
  {
    host: Schema.String,
    stage: Schema.Literals(["request", "timeout", "status", "response"]),
    status: Schema.optional(Schema.Number),
    upstreamMessage: Schema.optional(Schema.String),
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
        return `The transcription service at ${this.host} answered HTTP ${this.status}${
          this.upstreamMessage ? `: ${this.upstreamMessage}` : "."
        }`;
      case "response":
        return `The transcription service at ${this.host} returned an unexpected response.`;
    }
  }
}

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly createUploadUrl: (
      input: VoiceTranscriptionCreateUrlInput,
    ) => Effect.Effect<
      VoiceTranscriptionCreateUrlResult,
      VoiceTranscriptionNotConfiguredError | VoiceTranscriptionSigningKeyError
    >;
    readonly verifyUploadToken: (
      token: string,
    ) => Effect.Effect<Option.Option<VoiceTranscriptionClaims>>;
    readonly transcribe: (
      claims: VoiceTranscriptionClaims,
      audio: Uint8Array<ArrayBuffer>,
    ) => Effect.Effect<
      VoiceTranscriptionResult,
      | VoiceTranscriptionNotConfiguredError
      | VoiceTranscriptionInvalidUploadError
      | VoiceTranscriptionUnsupportedFormatError
      | VoiceTranscriptionCredentialsRejectedError
      | VoiceTranscriptionUpstreamError
    >;
  }
>()("t3/voiceTranscription/VoiceTranscription") {}

interface TranscriptionEndpoint {
  readonly protocol: ProviderProtocol;
  readonly url: string;
  readonly host: string;
  readonly model: string;
  readonly language: string;
  readonly apiKey: string;
}

function resolveEndpoint(
  settings: VoiceTranscriptionSettings,
): Effect.Effect<TranscriptionEndpoint, VoiceTranscriptionNotConfiguredError> {
  const notConfigured = (message: string) =>
    Effect.fail(new VoiceTranscriptionNotConfiguredError({ message }));
  if (!settings.enabled) {
    return notConfigured("Voice transcription is turned off for this environment.");
  }
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) return notConfigured("Voice transcription needs an endpoint URL.");
  if (!settings.model) return notConfigured("Voice transcription needs a model name.");
  const protocol = PROVIDER_PROTOCOLS[settings.provider];
  // Local whisper.cpp-style servers take no key, but the hosted defaults always do.
  if (
    !settings.apiKey &&
    baseUrl === VOICE_TRANSCRIPTION_PROVIDER_DEFAULTS[settings.provider].baseUrl
  ) {
    return notConfigured(`Add an ${protocol.name} API key to use voice transcription.`);
  }
  const url = URL.parse(`${baseUrl}/${protocol.path}`);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return notConfigured("The voice transcription endpoint URL is not valid.");
  }
  return Effect.succeed({
    protocol,
    url: url.toString(),
    host: url.host,
    model: settings.model,
    language: settings.language,
    apiKey: settings.apiKey,
  });
}

const readUpstreamMessage = (
  response: HttpClientResponse.HttpClientResponse,
  endpoint: TranscriptionEndpoint,
) =>
  response.text.pipe(
    Effect.map((body) =>
      Option.getOrUndefined(
        Option.map(decodeUpstreamError(body), ({ error }) => {
          const message = typeof error === "string" ? error : error.message;
          const redacted = endpoint.apiKey ? message.replaceAll(endpoint.apiKey, "[key]") : message;
          return redacted.slice(0, UPSTREAM_MESSAGE_MAX_LENGTH);
        }),
      ),
    ),
    Effect.orElseSucceed(() => undefined),
  );

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const client = yield* HttpClient.HttpClient;

  const signingSecret = loadUploadSigningSecret.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
  );

  const loadEndpoint = settingsService.getSettings.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to read voice transcription settings.", { cause }),
    ),
    Effect.mapError(
      () =>
        new VoiceTranscriptionNotConfiguredError({
          message: "Could not read the voice transcription settings.",
        }),
    ),
    Effect.flatMap((settings) => resolveEndpoint(settings.voiceTranscription)),
  );

  const createUploadUrl = Effect.fn("VoiceTranscription.createUploadUrl")(function* (
    input: VoiceTranscriptionCreateUrlInput,
  ) {
    const endpoint = yield* loadEndpoint;
    if (!endpoint.protocol.acceptedMimeTypes.includes(input.mimeType)) {
      return yield* new VoiceTranscriptionNotConfiguredError({
        message: unsupportedFormatMessage(endpoint.protocol.name, input.mimeType),
      });
    }
    const secret = yield* signingSecret.pipe(
      Effect.mapError((cause) => new VoiceTranscriptionSigningKeyError({ cause })),
    );
    const expiresAt = (yield* Clock.currentTimeMillis) + VOICE_TRANSCRIPTION_URL_TTL_MS;
    const encodedPayload = base64UrlEncode(
      encodeClaims({
        version: 1,
        kind: "voice-transcription",
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
    const secret = yield* signingSecret.pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to load the voice transcription signing key.", { cause }),
      ),
      Effect.option,
    );
    if (
      Option.isNone(secret) ||
      !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret.value))
    ) {
      return Option.none();
    }
    const claims = Option.flatMap(
      Option.liftThrowable(base64UrlDecodeUtf8)(encodedPayload),
      decodeClaims,
    );
    const nowMs = yield* Clock.currentTimeMillis;
    return Option.filter(claims, (decoded) => decoded.expiresAt > nowMs);
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
    const endpoint = yield* loadEndpoint;
    // The provider can change between minting and uploading.
    if (!endpoint.protocol.acceptedMimeTypes.includes(claims.mimeType)) {
      return yield* new VoiceTranscriptionUnsupportedFormatError({
        providerName: endpoint.protocol.name,
        mimeType: claims.mimeType,
      });
    }
    const upstreamError = (
      fields: Omit<ConstructorParameters<typeof VoiceTranscriptionUpstreamError>[0], "host">,
    ) => new VoiceTranscriptionUpstreamError({ host: endpoint.host, ...fields });

    const request = HttpClientRequest.post(endpoint.url).pipe(
      HttpClientRequest.bodyFormData(
        endpoint.protocol.form({
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
        const upstreamMessage = yield* readUpstreamMessage(response, endpoint);
        return yield* new VoiceTranscriptionCredentialsRejectedError({
          host: endpoint.host,
          status: response.status,
          ...(upstreamMessage ? { upstreamMessage } : {}),
        });
      }
      if (response.status < 200 || response.status >= 300) {
        const upstreamMessage = yield* readUpstreamMessage(response, endpoint);
        return yield* upstreamError({
          stage: "status",
          status: response.status,
          ...(upstreamMessage ? { upstreamMessage } : {}),
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
