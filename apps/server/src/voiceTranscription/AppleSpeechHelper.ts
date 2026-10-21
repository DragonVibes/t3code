import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const HELPER_NAME = "t3-apple-speech";
// Darwin 25 is macOS 26, the first release with SpeechAnalyzer.
const MIN_DARWIN_MAJOR = 25;
const PROBE_TIMEOUT = "10 seconds";
const PROBE_RETRY_DELAY = Duration.minutes(1);
const PROBE_ATTEMPTS = 5;
// The first transcription in a language downloads its model through AssetInventory.
const TRANSCRIBE_TIMEOUT_SECONDS = 120;
const CAUSE_MAX_LENGTH = 300;

const ProbeOutput = Schema.Struct({ available: Schema.Boolean });

const TranscribeOutput = Schema.Struct({
  text: Schema.String,
  locale: Schema.String,
});
type AppleSpeechTranscript = typeof TranscribeOutput.Type;

const HelperErrorOutput = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals(["unsupported_locale", "unavailable", "assets_failed", "failed"]),
    message: Schema.String,
  }),
});

const decodeProbe = Schema.decodeUnknownOption(Schema.fromJsonString(ProbeOutput));
const decodeTranscript = Schema.decodeUnknownOption(Schema.fromJsonString(TranscribeOutput));
const decodeHelperError = Schema.decodeUnknownOption(Schema.fromJsonString(HelperErrorOutput));

export class AppleSpeechUnsupportedLocaleError extends Schema.TaggedError<AppleSpeechUnsupportedLocaleError>()(
  "AppleSpeechUnsupportedLocaleError",
  {
    locale: Schema.String,
  },
) {
  override get message(): string {
    return this.locale
      ? `Apple on-device transcription does not support the language '${this.locale}'.`
      : "Apple on-device transcription does not support this Mac's system language.";
  }
}

export class AppleSpeechHelperError extends Schema.TaggedError<AppleSpeechHelperError>()(
  "AppleSpeechHelperError",
  {
    reason: Schema.Literals(["unavailable", "assets_failed", "timeout", "failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Apple on-device transcription is not available on this Mac.";
      case "assets_failed":
        return "The Apple speech language model could not be downloaded.";
      case "timeout":
        return `Apple on-device transcription did not finish within ${TRANSCRIBE_TIMEOUT_SECONDS} seconds.`;
      case "failed":
        return "Apple on-device transcription failed.";
    }
  }
}

class AppleSpeechProbeTimedOut extends Schema.TaggedError<AppleSpeechProbeTimedOut>()(
  "AppleSpeechProbeTimedOut",
  {
    helperPath: Schema.String,
  },
) {
  override get message(): string {
    return `The Apple speech helper at '${this.helperPath}' did not answer its probe within ${PROBE_TIMEOUT}.`;
  }
}

/** `unsupported-host` is anything older than macOS 26, where the helper is never spawned. */
export type AppleSpeechAvailability = "available" | "unavailable" | "unsupported-host";

export class AppleSpeechHelper extends Context.Service<
  AppleSpeechHelper,
  {
    /** The latest probe answer without waiting, false until one arrives; descriptor reads use it. */
    readonly available: Effect.Effect<boolean>;
    /** `available` now, then each time a probe answer changes it. */
    readonly streamAvailableChanges: Stream.Stream<boolean>;
    /** Waits for the first probe to answer. */
    readonly availability: Effect.Effect<AppleSpeechAvailability>;
    readonly transcribe: (input: {
      readonly audio: Uint8Array;
      readonly locale: string;
    }) => Effect.Effect<
      AppleSpeechTranscript,
      AppleSpeechHelperError | AppleSpeechUnsupportedLocaleError
    >;
  }
>()("t3/voiceTranscription/AppleSpeechHelper") {}

export const AppleSpeechHostKernelRelease = Context.Reference<string>(
  "t3/voiceTranscription/AppleSpeechHostKernelRelease",
  {
    defaultValue: () => NodeOS.release(),
  },
);

const hostSupportsSpeechAnalyzer = (platform: NodeJS.Platform, kernelRelease: string) =>
  platform === "darwin" && Number.parseInt(kernelRelease, 10) >= MIN_DARWIN_MAJOR;

/** The helper's stdout may hold the user's words, so a cause built from it records only its size. */
const sizeOnlyCause = (stdout: string) =>
  new Error(`The helper printed ${stdout.length} bytes, not a transcript.`);

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const kernelRelease = yield* AppleSpeechHostKernelRelease;

  const candidates = [
    environment.T3CODE_APPLE_SPEECH_PATH,
    config.appleSpeechHelperPath,
    path.resolve(import.meta.dirname, "../../../../native/apple-speech/build", HELPER_NAME),
    path.resolve(import.meta.dirname, "../../../native/apple-speech/build", HELPER_NAME),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const locate = Effect.gen(function* () {
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(candidate);
      }
    }
    yield* Effect.logDebug("No Apple speech helper found.", { candidates });
    return Option.none<string>();
  });

  const probe = Effect.fn("AppleSpeechHelper.probe")(function* (helperPath: string) {
    const result = yield* processRunner
      .run({
        command: helperPath,
        args: ["probe"],
        timeout: PROBE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (Option.isSome(result) && result.value.timedOut) {
      return yield* new AppleSpeechProbeTimedOut({ helperPath });
    }
    const available =
      Option.isSome(result) &&
      result.value.code === 0 &&
      Option.exists(decodeProbe(result.value.stdout), (output) => output.available);
    if (!available) {
      yield* Effect.logWarning("The Apple speech helper is present but unusable.", { helperPath });
    }
    return available ? Option.some(helperPath) : Option.none<string>();
  });

  const hostSupported = hostSupportsSpeechAnalyzer(platform, kernelRelease);
  const helperPath = yield* SubscriptionRef.make(Option.none<string>());
  const firstProbeAnswered = yield* Deferred.make<void>();
  const locateOnce = yield* Effect.cached(locate);

  const probeInBackground = locateOnce.pipe(
    Effect.flatMap(Option.match({ onNone: () => Effect.succeedNone, onSome: probe })),
    Effect.flatMap((found) => SubscriptionRef.set(helperPath, found)),
    Effect.ensuring(Deferred.succeed(firstProbeAnswered, undefined)),
    Effect.retry({ schedule: Schedule.spaced(PROBE_RETRY_DELAY), times: PROBE_ATTEMPTS - 1 }),
    Effect.ignore({ log: true }),
  );
  if (hostSupported) {
    yield* Effect.forkScoped(probeInBackground);
  } else {
    yield* Deferred.succeed(firstProbeAnswered, undefined);
  }

  const answeredHelperPath = Deferred.await(firstProbeAnswered).pipe(
    Effect.andThen(SubscriptionRef.get(helperPath)),
  );
  const availability: Effect.Effect<AppleSpeechAvailability> = hostSupported
    ? Effect.map(answeredHelperPath, (found) =>
        Option.isSome(found) ? "available" : "unavailable",
      )
    : Effect.succeed("unsupported-host");

  const transcribe = Effect.fn("AppleSpeechHelper.transcribe")(function* (input: {
    readonly audio: Uint8Array;
    readonly locale: string;
  }) {
    const command = yield* answeredHelperPath;
    if (Option.isNone(command)) {
      return yield* new AppleSpeechHelperError({ reason: "unavailable" });
    }
    const directory = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-apple-speech-" })
      .pipe(Effect.mapError((cause) => new AppleSpeechHelperError({ reason: "failed", cause })));
    const wavPath = path.join(directory, "recording.wav");
    yield* fileSystem
      .writeFile(wavPath, input.audio)
      .pipe(Effect.mapError((cause) => new AppleSpeechHelperError({ reason: "failed", cause })));
    const result = yield* processRunner
      .run({
        command: command.value,
        args: ["transcribe", "--locale", input.locale, wavPath],
        timeout: `${TRANSCRIBE_TIMEOUT_SECONDS} seconds`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AppleSpeechHelperError({
              reason: cause._tag === "ProcessTimeoutError" ? "timeout" : "failed",
              cause,
            }),
        ),
      );
    if (result.code !== 0) {
      const reported = decodeHelperError(result.stdout);
      if (Option.isNone(reported)) {
        return yield* new AppleSpeechHelperError({
          reason: "failed",
          cause: new Error(result.stderr.slice(0, CAUSE_MAX_LENGTH)),
        });
      }
      const { code, message } = reported.value.error;
      return yield* code === "unsupported_locale"
        ? new AppleSpeechUnsupportedLocaleError({ locale: input.locale })
        : new AppleSpeechHelperError({
            reason: code,
            cause: new Error(message.slice(0, CAUSE_MAX_LENGTH)),
          });
    }
    return yield* Option.match(decodeTranscript(result.stdout), {
      onNone: () =>
        new AppleSpeechHelperError({ reason: "failed", cause: sizeOnlyCause(result.stdout) }),
      onSome: Effect.succeed,
    });
  }, Effect.scoped);

  return AppleSpeechHelper.of({
    available: Effect.map(SubscriptionRef.get(helperPath), Option.isSome),
    streamAvailableChanges: SubscriptionRef.changes(helperPath).pipe(
      Stream.map(Option.isSome),
      Stream.changes,
    ),
    availability,
    transcribe,
  });
});

export const layer = Layer.effect(AppleSpeechHelper, make).pipe(Layer.provide(ProcessRunner.layer));

export const layerUnavailable = Layer.succeed(
  AppleSpeechHelper,
  AppleSpeechHelper.of({
    available: Effect.succeed(false),
    streamAvailableChanges: Stream.make(false),
    availability: Effect.succeed("unavailable"),
    transcribe: () => new AppleSpeechHelperError({ reason: "unavailable" }),
  }),
);
