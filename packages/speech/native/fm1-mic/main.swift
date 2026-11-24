// fm1-mic: microphone helper for the FM-1 companion.
//
//   fm1-mic status                      -> {"status": "...", "authorized": bool}
//   fm1-mic request                     -> prompts for mic access, prints status JSON
//   fm1-mic devices                     -> JSON array of input devices, default marked
//   fm1-mic record [--device <uid>] [--rate 16000] [--max-seconds N]
//       stdout: mono s16le PCM at --rate
//       stderr: NDJSON events: started, level, device_changed, error, stopped
//       stops on SIGTERM, SIGINT, stdin EOF, or --max-seconds.
//       env FM1_MIC_RAW_OUT=<path>: also writes the unconverted input (all channels, input rate) as interleaved
//       s16le to <path> (created 0600). Diagnostics only; stdout is unchanged. `started` reports "rawOut".
//       An env var, not a flag, so an older helper ignores it instead of failing on an unknown flag.
//
// Exit codes: 0 ok, 1 usage, 2 engine failure, 3 permission denied, 4 no/unknown device.

import AVFoundation
import CoreAudio
import Foundation

let processStart = DispatchTime.now()

func elapsedMs() -> Double {
  Double(DispatchTime.now().uptimeNanoseconds - processStart.uptimeNanoseconds) / 1_000_000
}

func jsonLine(_ object: Any) -> String {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
    let text = String(data: data, encoding: .utf8)
  else { return "{}" }
  return text
}

let stderrLock = NSLock()
func emit(_ event: [String: Any]) {
  stderrLock.lock()
  defer { stderrLock.unlock() }
  FileHandle.standardError.write((jsonLine(event) + "\n").data(using: .utf8)!)
}

func fail(_ code: String, _ message: String, exitCode: Int32) -> Never {
  emit(["type": "error", "code": code, "message": message])
  exit(exitCode)
}

// MARK: permission

func permissionName(_ status: AVAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

func printStatus() {
  let status = AVCaptureDevice.authorizationStatus(for: .audio)
  print(jsonLine(["status": permissionName(status), "authorized": status == .authorized]))
}

func requestAccess() -> Bool {
  let done = DispatchSemaphore(value: 0)
  var granted = false
  AVCaptureDevice.requestAccess(for: .audio) { ok in
    granted = ok
    done.signal()
  }
  done.wait()
  return granted
}

// MARK: devices

struct InputDevice {
  let id: AudioDeviceID
  let uid: String
  let name: String
  let channels: Int
  let sampleRate: Double
  let transport: String
  let isDefault: Bool

  var json: [String: Any] {
    [
      "id": Int(id), "uid": uid, "name": name, "inputChannels": channels,
      "sampleRate": sampleRate, "transport": transport, "default": isDefault,
    ]
  }
}

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal)
  -> AudioObjectPropertyAddress
{
  AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = address(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr, let v = value else { return nil }
  return v.takeRetainedValue() as String
}

func inputChannelCount(_ id: AudioDeviceID) -> Int {
  var addr = address(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
  let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func nominalRate(_ id: AudioDeviceID) -> Double {
  var addr = address(kAudioDevicePropertyNominalSampleRate)
  var rate = Float64(0)
  var size = UInt32(MemoryLayout<Float64>.size)
  AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &rate)
  return rate
}

func transportName(_ id: AudioDeviceID) -> String {
  var addr = address(kAudioDevicePropertyTransportType)
  var value = UInt32(0)
  var size = UInt32(MemoryLayout<UInt32>.size)
  AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value)
  switch value {
  case kAudioDeviceTransportTypeBuiltIn: return "builtin"
  case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
  case kAudioDeviceTransportTypeUSB: return "usb"
  case kAudioDeviceTransportTypeVirtual: return "virtual"
  case kAudioDeviceTransportTypeAggregate: return "aggregate"
  default: return "other"
  }
}

func defaultInputID() -> AudioDeviceID {
  var addr = address(kAudioHardwarePropertyDefaultInputDevice)
  var id = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
  return id
}

func listInputDevices() -> [InputDevice] {
  var addr = address(kAudioHardwarePropertyDevices)
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
  var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  let def = defaultInputID()
  return ids.compactMap { id in
    let channels = inputChannelCount(id)
    guard channels > 0 else { return nil }
    return InputDevice(
      id: id, uid: stringProperty(id, kAudioDevicePropertyDeviceUID) ?? "",
      name: stringProperty(id, kAudioObjectPropertyName) ?? "?", channels: channels,
      sampleRate: nominalRate(id), transport: transportName(id), isDefault: id == def)
  }
}

// MARK: record

struct RecordOptions {
  var deviceUID: String?
  var rate: Double = 16000
  var maxSeconds: Double = 0
}

func parseRecordOptions(_ args: [String]) -> RecordOptions {
  var opts = RecordOptions()
  var i = 0
  while i < args.count {
    let flag = args[i]
    // A flag without a value must fail: `--device` alone would otherwise silently open the default mic.
    guard i + 1 < args.count, !args[i + 1].hasPrefix("--"), !args[i + 1].isEmpty else {
      fail("usage", "\(flag) needs a value", exitCode: 1)
    }
    let value = args[i + 1]
    switch flag {
    case "--device": opts.deviceUID = value
    case "--rate":
      guard let rate = Double(value) else { fail("usage", "--rate must be a number", exitCode: 1) }
      opts.rate = rate
    case "--max-seconds":
      guard let seconds = Double(value), seconds >= 0 else {
        fail("usage", "--max-seconds must be a non-negative number", exitCode: 1)
      }
      opts.maxSeconds = seconds
    default: fail("usage", "unknown flag \(flag)", exitCode: 1)
    }
    i += 2
  }
  if opts.rate < 8000 || opts.rate > 48000 { fail("usage", "--rate must be 8000..48000", exitCode: 1) }
  return opts
}

/// Writes the whole buffer to fd 1. Returns false if the reader went away.
func writeStdout(_ pointer: UnsafeRawPointer, _ count: Int) -> Bool {
  var offset = 0
  while offset < count {
    let n = write(1, pointer + offset, count - offset)
    if n < 0 {
      if errno == EINTR { continue }
      return false
    }
    offset += n
  }
  return true
}

/// Optional raw side output (FM1_MIC_RAW_OUT). Any write error closes it; recording carries on.
final class RawSink {
  private var fd: Int32
  private var scratch: [Int16] = []

  init?(path: String) {
    let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    if fd < 0 { return nil }
    self.fd = fd
  }

  func write(_ buffer: AVAudioPCMBuffer) {
    guard fd >= 0 else { return }
    let frames = Int(buffer.frameLength)
    let channels = Int(buffer.format.channelCount)
    guard frames > 0, channels > 0 else { return }
    let interleaved = buffer.format.isInterleaved
    let total = frames * channels
    if scratch.count < total { scratch = [Int16](repeating: 0, count: total) }
    if let data = buffer.floatChannelData {
      for f in 0..<frames {
        for c in 0..<channels {
          let v = interleaved ? data[0][f * channels + c] : data[c][f]
          scratch[f * channels + c] = Int16(max(-32768, min(32767, (v * 32768).rounded())))
        }
      }
    } else if let data = buffer.int16ChannelData {
      for f in 0..<frames {
        for c in 0..<channels { scratch[f * channels + c] = interleaved ? data[0][f * channels + c] : data[c][f] }
      }
    } else {
      close()
      return
    }
    let ok = scratch.withUnsafeBytes { raw -> Bool in
      var offset = 0
      let count = total * 2
      while offset < count {
        let n = Darwin.write(fd, raw.baseAddress! + offset, count - offset)
        if n < 0 {
          if errno == EINTR { continue }
          return false
        }
        offset += n
      }
      return true
    }
    if !ok { close() }
  }

  func close() {
    if fd >= 0 { Darwin.close(fd) }
    fd = -1
  }
}

final class Recorder {
  let engine = AVAudioEngine()
  let opts: RecordOptions
  var raw: RawSink?
  let stateLock = NSLock()
  var frames: Int64 = 0
  var stopped = false
  var lastLevelAt = 0.0
  var signalSources: [DispatchSourceSignal] = []

  init(_ opts: RecordOptions) { self.opts = opts }

  func selectDevice() -> InputDevice {
    let devices = listInputDevices()
    if let uid = opts.deviceUID {
      guard let dev = devices.first(where: { $0.uid == uid }) else {
        fail("device_not_found", "no input device with uid \(uid)", exitCode: 4)
      }
      guard let unit = engine.inputNode.audioUnit else { fail("engine", "input node has no audio unit", exitCode: 2) }
      var id = dev.id
      let status = AudioUnitSetProperty(
        unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id,
        UInt32(MemoryLayout<AudioDeviceID>.size))
      if status != noErr { fail("device_select_failed", "AudioUnitSetProperty status \(status)", exitCode: 4) }
      return dev
    }
    guard let dev = devices.first(where: { $0.isDefault }) else {
      fail("no_device", "no default input device", exitCode: 4)
    }
    // An FM-1 USB audio input carries the synth's output, not a microphone: never pick it implicitly.
    if dev.name.uppercased().contains("FM-1") || dev.name.uppercased().contains("FM1") {
      fail("no_device", "default input is the FM-1 audio interface; pass --device with a microphone uid", exitCode: 4)
    }
    return dev
  }

  func start() {
    let device = selectDevice()
    let input = engine.inputNode
    let inFmt = input.outputFormat(forBus: 0)
    if inFmt.channelCount == 0 || inFmt.sampleRate == 0 {
      fail("no_device", "input format has no channels (\(inFmt))", exitCode: 4)
    }
    guard let outFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: opts.rate, channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: inFmt, to: outFmt)
    else { fail("engine", "cannot build converter from \(inFmt)", exitCode: 2) }

    if let path = ProcessInfo.processInfo.environment["FM1_MIC_RAW_OUT"], !path.isEmpty { raw = RawSink(path: path) }

    input.installTap(onBus: 0, bufferSize: 1024, format: inFmt) { [weak self] buffer, _ in
      self?.handle(buffer, converter: converter, outFmt: outFmt)
    }
    NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
    ) { [weak self] _ in
      emit(["type": "device_changed"])
      self?.stop(reason: "device_changed")
    }
    engine.prepare()
    do { try engine.start() } catch { fail("engine_start_failed", "\(error)", exitCode: 2) }
    emit([
      "type": "started", "sampleRate": opts.rate, "inputSampleRate": inFmt.sampleRate,
      "inputChannels": Int(inFmt.channelCount), "device": device.json, "t": elapsedMs(),
      "rawOut": raw != nil,
    ])
  }

  func handle(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter, outFmt: AVAudioFormat) {
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * outFmt.sampleRate / buffer.format.sampleRate) + 64
    guard let out = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    if let error { fail("convert_failed", "\(error)", exitCode: 2) }
    let count = Int(out.frameLength)
    guard count > 0, let samples = out.int16ChannelData?[0] else { return }

    stateLock.lock()
    if stopped {
      stateLock.unlock()
      return
    }
    frames += Int64(count)
    let total = frames
    stateLock.unlock()

    if !writeStdout(samples, count * 2) {
      stop(reason: "stdout_closed")
      return
    }
    raw?.write(buffer)
    emitLevel(samples, count)
    if opts.maxSeconds > 0 && Double(total) / opts.rate >= opts.maxSeconds { stop(reason: "max_seconds") }
  }

  func emitLevel(_ samples: UnsafePointer<Int16>, _ count: Int) {
    let now = elapsedMs()
    if now - lastLevelAt < 50 { return }
    lastLevelAt = now
    var sum = 0.0
    var peak = 0
    for i in 0..<count {
      let s = Int(samples[i])
      sum += Double(s * s)
      peak = max(peak, abs(s))
    }
    let rms = (sum / Double(count)).squareRoot() / 32768
    emit(["type": "level", "rms": rms, "peak": Double(peak) / 32768, "t": now])
  }

  func stop(reason: String) {
    stateLock.lock()
    if stopped {
      stateLock.unlock()
      return
    }
    stopped = true
    let total = frames
    stateLock.unlock()
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    raw?.close()
    emit(["type": "stopped", "reason": reason, "frames": total, "t": elapsedMs()])
    exit(0)
  }

  func installStopTriggers() {
    signal(SIGPIPE, SIG_IGN)
    for sig in [SIGTERM, SIGINT] {
      signal(sig, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      source.setEventHandler { [weak self] in self?.stop(reason: sig == SIGTERM ? "sigterm" : "sigint") }
      source.resume()
      signalSources.append(source)
    }
    DispatchQueue.global().async { [weak self] in
      _ = FileHandle.standardInput.readDataToEndOfFile()
      DispatchQueue.main.async { self?.stop(reason: "stdin_eof") }
    }
  }
}

func record(_ args: [String]) -> Never {
  let opts = parseRecordOptions(args)
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: break
  case .notDetermined:
    if !requestAccess() { fail("permission_denied", "microphone access was not granted", exitCode: 3) }
  default:
    fail("permission_denied", "microphone access is denied or restricted in System Settings", exitCode: 3)
  }
  let recorder = Recorder(opts)
  recorder.installStopTriggers()
  recorder.start()
  dispatchMain()
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first ?? "" {
case "status":
  printStatus()
case "request":
  _ = requestAccess()
  printStatus()
case "devices":
  print(jsonLine(listInputDevices().map { $0.json }))
case "record":
  record(Array(args.dropFirst()))
default:
  FileHandle.standardError.write("usage: fm1-mic status|request|devices|record [--device uid] [--rate hz] [--max-seconds n]\n".data(using: .utf8)!)
  exit(1)
}
