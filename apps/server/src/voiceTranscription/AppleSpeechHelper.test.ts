// @effect-diagnostics nodeBuiltinImport:off - The skip gate for the real helper runs before any Effect runtime exists.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AppleSpeechHelper from "./AppleSpeechHelper.ts";

const devHelperPath = `${import.meta.dirname}/../../../../native/apple-speech/build/t3-apple-speech`;
const realHelperUsable =
  HostProcess.Platform.defaultValue() === "darwin" &&
  Number.parseInt(AppleSpeechHelper.AppleSpeechHostKernelRelease.defaultValue(), 10) >= 25 &&
  NodeFS.existsSync(devHelperPath);

const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const probeAvailable =
  '{"available":true,"supportedLocales":["en_US"],"installedLocales":["en_US"]}';

const output = (
  fields: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...fields,
});

const failed = (stdout: string) => output({ code: ChildProcessSpawner.ExitCode(1), stdout });

const timedOut = (input: ProcessRunner.ProcessRunInput) =>
  new ProcessRunner.ProcessTimeoutError({
    command: input.command,
    argumentCount: input.args.length,
    timeoutMs: 1,
  });

type Handler = (
  input: ProcessRunner.ProcessRunInput,
) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;

const setup = Effect.fn(function* (
  host: { readonly platform: NodeJS.Platform; readonly kernelRelease: string },
  handle: Handler,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-apple-speech-test-" });
  const helperPath = `${baseDir}/t3-apple-speech`;
  yield* fileSystem.writeFileString(helperPath, "helper");
  const runs: Array<ProcessRunner.ProcessRunInput> = [];
  const service = yield* AppleSpeechHelper.make.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.suspend(() => {
            runs.push(input);
            return handle(input);
          }),
      }),
    ),
    Effect.provideService(HostProcess.Platform, host.platform),
    Effect.provideService(HostProcess.Environment, { T3CODE_APPLE_SPEECH_PATH: helperPath }),
    Effect.provideService(AppleSpeechHelper.AppleSpeechHostKernelRelease, host.kernelRelease),
  );
  return { service, runs, helperPath };
});

const macOS26 = { platform: "darwin", kernelRelease: "25.0.0" } as const;

const helperThat =
  (onTranscribe: Handler): Handler =>
  (input) =>
    input.args[0] === "probe"
      ? Effect.succeed(output({ stdout: probeAvailable }))
      : onTranscribe(input);

describe("AppleSpeechHelper", () => {
  it.effect.skipIf(!realHelperUsable)("probes the built helper through the real layer", () =>
    Effect.gen(function* () {
      const service = yield* AppleSpeechHelper.AppleSpeechHelper;
      expect(yield* service.availability).toBe("available");
      expect(yield* service.available).toBe(true);
    }).pipe(
      Effect.provide(
        AppleSpeechHelper.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-apple-speech-real-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.provideService(HostProcess.Environment, { T3CODE_APPLE_SPEECH_PATH: devHelperPath }),
    ),
  );

  it.effect.each([
    { platform: "linux", kernelRelease: "6.8.0" },
    { platform: "win32", kernelRelease: "10.0.22631" },
    { platform: "darwin", kernelRelease: "24.6.0" },
  ] as const)("never spawns the helper on $platform $kernelRelease", (host) =>
    Effect.gen(function* () {
      const { service, runs } = yield* setup(host, () => Effect.die("must not spawn"));
      expect(yield* service.availability).toBe("unsupported-host");
      expect(yield* service.available).toBe(false);
      const error = yield* Effect.flip(service.transcribe({ audio, locale: "en" }));
      assert.instanceOf(error, AppleSpeechHelper.AppleSpeechHelperError);
      expect(error.reason).toBe("unavailable");
      expect(runs).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { name: "available", probe: output({ stdout: probeAvailable }), available: true },
    {
      name: "unavailable",
      probe: output({ stdout: '{"available":false,"supportedLocales":[],"installedLocales":[]}' }),
      available: false,
    },
    {
      name: "malformed",
      probe: output({ stdout: "Speech framework crashed\n" }),
      available: false,
    },
    {
      name: "failing",
      probe: failed('{"error":{"code":"failed","message":"boom"}}'),
      available: false,
    },
    { name: "hung", probe: output({ code: null, timedOut: true }), available: false },
  ])("reads a $name probe once and caches it", ({ probe, available }) =>
    Effect.gen(function* () {
      const { service, runs, helperPath } = yield* setup(macOS26, () => Effect.succeed(probe));
      expect(yield* service.availability).toBe(available ? "available" : "unavailable");
      expect(yield* service.available).toBe(available);
      expect(yield* service.available).toBe(available);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ command: helperPath, args: ["probe"] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unavailable without waiting while the first probe is still running", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const { service } = yield* setup(macOS26, () =>
        Deferred.await(release).pipe(Effect.as(output({ stdout: probeAvailable }))),
      );
      expect(yield* service.available).toBe(false);
      yield* Deferred.succeed(release, undefined);
      expect(yield* service.availability).toBe("available");
      expect(yield* service.available).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retries a probe that timed out, but not before a minute has passed", () =>
    Effect.gen(function* () {
      let probes = 0;
      const { service, runs } = yield* setup(macOS26, () =>
        Effect.sync(() =>
          probes++ === 0
            ? output({ code: null, timedOut: true })
            : output({ stdout: probeAvailable }),
        ),
      );
      expect(yield* service.availability).toBe("unavailable");
      expect(yield* service.available).toBe(false);
      yield* TestClock.adjust("59 seconds");
      expect(runs).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      expect(runs).toHaveLength(2);
      expect(yield* service.available).toBe(true);
      expect(yield* service.availability).toBe("available");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops retrying a probe that keeps timing out", () =>
    Effect.gen(function* () {
      const { service, runs } = yield* setup(macOS26, () =>
        Effect.succeed(output({ code: null, timedOut: true })),
      );
      expect(yield* service.availability).toBe("unavailable");
      yield* TestClock.adjust("1 hour");
      const attempts = runs.length;
      expect(attempts).toBeGreaterThan(1);
      yield* TestClock.adjust("1 hour");
      expect(runs).toHaveLength(attempts);
      expect(yield* service.available).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a helper that fails to launch as unavailable", () =>
    Effect.gen(function* () {
      const { service, runs } = yield* setup(macOS26, (input) =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("dyld: Symbol not found"),
          }),
        ),
      );
      expect(yield* service.availability).toBe("unavailable");
      expect(yield* service.available).toBe(false);
      expect(runs).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("transcribes a WAV through a temp file that is gone afterwards", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let wavPath = "";
      const { service, runs, helperPath } = yield* setup(
        macOS26,
        helperThat((input) =>
          Effect.gen(function* () {
            wavPath = input.args.at(-1)!;
            expect(new Uint8Array(yield* Effect.orDie(fileSystem.readFile(wavPath)))).toEqual(
              audio,
            );
            return output({ stdout: '{"text":"hello apple","locale":"en_US"}\n' });
          }),
        ),
      );
      const transcript = yield* service.transcribe({ audio, locale: "en" });
      expect(transcript).toEqual({ text: "hello apple", locale: "en_US" });
      expect(runs).toHaveLength(2);
      const run = runs[1]!;
      expect(run.command).toBe(helperPath);
      expect(run.args).toEqual(["transcribe", "--locale", "en", wavPath]);
      expect(yield* fileSystem.exists(wavPath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("passes an empty locale through so the helper uses the system language", () =>
    Effect.gen(function* () {
      const { service, runs } = yield* setup(
        macOS26,
        helperThat(() => Effect.succeed(output({ stdout: '{"text":"","locale":"en_US"}' }))),
      );
      expect(yield* service.transcribe({ audio, locale: "" })).toEqual({
        text: "",
        locale: "en_US",
      });
      expect(runs[1]!.args.slice(0, 3)).toEqual(["transcribe", "--locale", ""]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      name: "unsupported_locale",
      result: () =>
        Effect.succeed(failed('{"error":{"code":"unsupported_locale","message":"no model"}}')),
      tag: "AppleSpeechUnsupportedLocaleError",
      reason: undefined,
      message: "does not support the language 'xx-YY'",
    },
    {
      name: "assets_failed",
      result: () =>
        Effect.succeed(failed('{"error":{"code":"assets_failed","message":"offline"}}')),
      tag: "AppleSpeechHelperError",
      reason: "assets_failed",
      message: "language model could not be downloaded",
    },
    {
      name: "unavailable",
      result: () => Effect.succeed(failed('{"error":{"code":"unavailable","message":"off"}}')),
      tag: "AppleSpeechHelperError",
      reason: "unavailable",
      message: "not available on this Mac",
    },
    {
      name: "failed",
      result: () => Effect.succeed(failed('{"error":{"code":"failed","message":"bad wav"}}')),
      tag: "AppleSpeechHelperError",
      reason: "failed",
      message: "transcription failed",
    },
    {
      name: "crash without JSON",
      result: () => Effect.succeed(failed("Segmentation fault")),
      tag: "AppleSpeechHelperError",
      reason: "failed",
      message: "transcription failed",
    },
    {
      name: "unexpected success output",
      result: () => Effect.succeed(output({ stdout: '{"transcript":"wrong shape"}' })),
      tag: "AppleSpeechHelperError",
      reason: "failed",
      message: "transcription failed",
    },
    {
      name: "timeout",
      result: (input: ProcessRunner.ProcessRunInput) => Effect.fail(timedOut(input)),
      tag: "AppleSpeechHelperError",
      reason: "timeout",
      message: "did not finish within 120 seconds",
    },
  ])(
    "maps a $name helper result and still deletes the temp file",
    ({ result, tag, reason, message }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        let wavPath = "";
        const { service } = yield* setup(
          macOS26,
          helperThat((input) => {
            wavPath = input.args.at(-1)!;
            return result(input);
          }),
        );
        const error = yield* Effect.flip(service.transcribe({ audio, locale: "xx-YY" }));
        expect(error._tag).toBe(tag);
        if (reason !== undefined) {
          assert.instanceOf(error, AppleSpeechHelper.AppleSpeechHelperError);
          expect(error.reason).toBe(reason);
        }
        expect(error.message).toContain(message);
        expect(wavPath).not.toBe("");
        expect(yield* fileSystem.exists(wavPath)).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
