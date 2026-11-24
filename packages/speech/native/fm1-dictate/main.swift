// fm1-dictate: Apple on-device dictation (DictationTranscriber, macOS 26+) over stdin PCM.
//
//   fm1-dictate status [--locale en_US]
//       -> {"available":bool,"installed":[...],"supported":bool,"assetsInstalled":bool}
//   fm1-dictate transcribe [--locale en_US] [--rate 16000] < pcm_s16le_mono
//       -> {"text":"...","ms":123}
// Errors go to stdout as {"error":"code","message":"..."} with a non-zero exit code.
// It never downloads assets: a missing locale fails with "assets_not_installed".

import AVFAudio
import Foundation
import Speech

func printJSON(_ object: [String: Any]) {
  let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func fail(_ code: String, _ message: String) -> Never {
  printJSON(["error": code, "message": message])
  exit(2)
}

struct Options {
  var command = ""
  var locale = "en_US"
  var rate = 16000.0
}

func parse() -> Options {
  var opts = Options()
  var args = Array(CommandLine.arguments.dropFirst())
  opts.command = args.isEmpty ? "" : args.removeFirst()
  var i = 0
  while i + 1 < args.count {
    switch args[i] {
    case "--locale": opts.locale = args[i + 1]
    case "--rate": opts.rate = Double(args[i + 1]) ?? 16000
    default: fail("usage", "unknown flag \(args[i])")
    }
    i += 2
  }
  return opts
}

func readPCM(rate: Double) -> AVAudioPCMBuffer {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  let frames = data.count / 2
  if frames == 0 { fail("empty_audio", "no PCM on stdin") }
  guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
    let out = buffer.floatChannelData?[0]
  else { fail("engine", "cannot allocate buffer") }
  data.withUnsafeBytes { raw in
    let src = raw.bindMemory(to: Int16.self)
    for i in 0..<frames { out[i] = Float(Int16(littleEndian: src[i])) / 32768 }
  }
  buffer.frameLength = AVAudioFrameCount(frames)
  return buffer
}

func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer {
  if buffer.format == format { return buffer }
  guard let converter = AVAudioConverter(from: buffer.format, to: format),
    let out = AVAudioPCMBuffer(
      pcmFormat: format,
      frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1024)
  else { fail("engine", "cannot convert to \(format)") }
  var fed = false
  var error: NSError?
  converter.convert(to: out, error: &error) { _, status in
    if fed {
      status.pointee = .endOfStream
      return nil
    }
    fed = true
    status.pointee = .haveData
    return buffer
  }
  if let error { fail("convert_failed", "\(error)") }
  return out
}

func status(_ opts: Options) async {
  let locale = Locale(identifier: opts.locale)
  let installed = await DictationTranscriber.installedLocales.map { $0.identifier }.sorted()
  let supported = await DictationTranscriber.supportedLocales.contains { $0.identifier == locale.identifier }
  var assetsInstalled = false
  if supported {
    let transcriber = DictationTranscriber(locale: locale, preset: .shortDictation)
    assetsInstalled = (try? await AssetInventory.assetInstallationRequest(supporting: [transcriber])) == nil
  }
  printJSON([
    "available": true, "locale": opts.locale, "installed": installed, "supported": supported,
    "assetsInstalled": assetsInstalled,
  ])
}

func transcribe(_ opts: Options) async {
  let pcm = readPCM(rate: opts.rate)
  let started = Date()
  let locale = Locale(identifier: opts.locale)
  let transcriber = DictationTranscriber(locale: locale, preset: .shortDictation)
  do {
    if try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) != nil {
      fail("assets_not_installed", "dictation assets for \(opts.locale) are not installed")
    }
    let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) ?? pcm.format
    let input = convert(pcm, to: format)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    async let text: String = {
      var s = ""
      for try await result in transcriber.results { s += String(result.text.characters) }
      return s
    }()
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    continuation.yield(AnalyzerInput(buffer: input))
    continuation.finish()
    if let last = try await analyzer.analyzeSequence(stream) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    let result = try await text
    printJSON(["text": result, "ms": Int(Date().timeIntervalSince(started) * 1000)])
  } catch {
    fail("transcribe_failed", "\(error)")
  }
}

@main struct Main {
  static func main() async {
    let opts = parse()
    switch opts.command {
    case "status": await status(opts)
    case "transcribe": await transcribe(opts)
    default: fail("usage", "usage: fm1-dictate status|transcribe [--locale en_US] [--rate 16000]")
    }
  }
}
