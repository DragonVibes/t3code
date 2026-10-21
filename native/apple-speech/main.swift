import AVFoundation
import Foundation
import Speech

struct ProbeOutput: Encodable {
  let available: Bool
  let supportedLocales: [String]
  let installedLocales: [String]
}

struct TranscribeOutput: Encodable {
  let text: String
  let locale: String
}

struct ErrorOutput: Encodable {
  struct Body: Encodable {
    let code: String
    let message: String
  }

  let error: Body
}

func emit<Output: Encodable>(_ output: Output) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  guard let data = try? encoder.encode(output) else {
    FileHandle.standardOutput.write(Data("{\"error\":{\"code\":\"failed\",\"message\":\"Could not encode the helper output.\"}}\n".utf8))
    exit(1)
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

let assetDownloadTimeoutSeconds = 90

func fail(_ code: String, _ message: String) -> Never {
  emit(ErrorOutput(error: .init(code: code, message: message)))
  exit(1)
}

func probe() async {
  let supported = await SpeechTranscriber.supportedLocales
  let installed = await SpeechTranscriber.installedLocales
  emit(
    ProbeOutput(
      available: SpeechTranscriber.isAvailable,
      supportedLocales: supported.map(\.identifier).sorted(),
      installedLocales: installed.map(\.identifier).sorted()))
}

func transcribe(localeIdentifier: String, wavPath: String) async {
  guard SpeechTranscriber.isAvailable else {
    fail("unavailable", "SpeechTranscriber is not available on this Mac.")
  }
  let requested = localeIdentifier.isEmpty ? Locale.current : Locale(identifier: localeIdentifier)
  guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
    fail("unsupported_locale", "No speech model supports the locale '\(requested.identifier)'.")
  }
  let file: AVAudioFile
  do {
    file = try AVAudioFile(forReading: URL(fileURLWithPath: wavPath))
  } catch {
    fail("failed", "Could not read the recording: \(error)")
  }
  guard file.length > 0 else {
    emit(TranscribeOutput(text: "", locale: locale.identifier))
    return
  }
  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  // The server's own timeout is longer, so a stalled first download reports
  // as a model download failure instead of a generic timeout.
  let assetWatchdog = Task {
    try await Task.sleep(for: .seconds(assetDownloadTimeoutSeconds))
    fail(
      "assets_failed",
      "The speech model for '\(locale.identifier)' did not download within \(assetDownloadTimeoutSeconds) seconds.")
  }
  do {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
  } catch {
    fail("assets_failed", "Could not install the speech model for '\(locale.identifier)': \(error)")
  }
  assetWatchdog.cancel()
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  // An unstructured task, so a throw below exits the process instead of
  // waiting for a results stream that may never finish.
  let transcript = Task { try await transcriber.results.reduce("") { $0 + String($1.text.characters) } }
  do {
    guard let last = try await analyzer.analyzeSequence(from: file) else {
      await analyzer.cancelAndFinishNow()
      transcript.cancel()
      emit(TranscribeOutput(text: "", locale: locale.identifier))
      return
    }
    try await analyzer.finalizeAndFinish(through: last)
    emit(TranscribeOutput(text: try await transcript.value, locale: locale.identifier))
  } catch {
    fail("failed", "Transcription failed: \(error)")
  }
}

@main
struct Main {
  static func main() async {
    let usage = "usage: t3-apple-speech probe | transcribe --locale <bcp47 or empty> <wavPath>"
    var arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else { fail("failed", usage) }
    arguments.removeFirst()
    switch command {
    case "probe":
      await probe()
    case "transcribe":
      var locale = ""
      var wavPath: String?
      var index = 0
      while index < arguments.count {
        if arguments[index] == "--locale" {
          locale = index + 1 < arguments.count ? arguments[index + 1] : ""
          index += 2
        } else {
          wavPath = arguments[index]
          index += 1
        }
      }
      guard let wavPath else { fail("failed", usage) }
      await transcribe(localeIdentifier: locale, wavPath: wavPath)
    default:
      fail("failed", usage)
    }
  }
}
