import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The Swift compiler targets the actual host; this script has no Effect runtime.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- SpeechAnalyzer only links against the macOS 26 SDK, so this only builds on a Mac.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: hostArch } },
});

const SWIFT_ARCHES = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] };
const DEPLOYMENT_TARGET = "26.0";

if (hostPlatform !== "darwin") {
  throw new Error("The Apple speech helper can only be built on macOS.");
}
const arches = SWIFT_ARCHES[values.arch];
if (arches === undefined) throw new Error(`Unsupported macOS architecture: ${values.arch}`);

const root = NodeURL.fileURLToPath(new URL("./", import.meta.url));
const source = NodePath.resolve(root, "main.swift");
const output = values.output ?? NodePath.resolve(root, "build", "t3-apple-speech");

const builtArches = (file) => {
  try {
    return NodeChildProcess.execFileSync("lipo", ["-archs", file], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .sort();
  } catch {
    return [];
  }
};
let current = false;
try {
  current =
    NodeFS.statSync(output).mtimeMs >=
      Math.max(
        NodeFS.statSync(source).mtimeMs,
        NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
      ) && builtArches(output).join(" ") === [...arches].sort().join(" ");
} catch {}

if (!current) {
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  const temporaries = arches.map((arch) => `${output}.${arch}.${process.pid}.tmp`);
  try {
    arches.forEach((arch, index) => {
      NodeChildProcess.execFileSync(
        "swiftc",
        [
          "-parse-as-library",
          "-swift-version",
          "6",
          "-O",
          "-target",
          `${arch}-apple-macos${DEPLOYMENT_TARGET}`,
          "-o",
          temporaries[index],
          source,
        ],
        { stdio: "inherit" },
      );
    });
    if (temporaries.length === 1) {
      NodeFS.renameSync(temporaries[0], output);
    } else {
      NodeChildProcess.execFileSync("lipo", ["-create", ...temporaries, "-output", output], {
        stdio: "inherit",
      });
    }
  } finally {
    for (const temporary of temporaries) NodeFS.rmSync(temporary, { force: true });
  }
}
