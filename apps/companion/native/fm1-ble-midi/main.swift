// fm1-ble-midi: a plain GATT pipe between the companion and one FM-1's BLE-MIDI characteristic ("BT direct").
//
// macOS's Bluetooth MIDI driver creates the CoreMIDI port "<name> Bluetooth" only after a click in Audio MIDI
// Setup, and MIDIBluetoothDriverActivateAllConnections did not bring the device online (observed 2026-11-22,
// FM1 CONSOLE 19E2). This helper needs no click: it scans for the device by name (or takes it when macOS already
// connected it), connects, subscribes, and moves raw characteristic values both ways. It does not parse MIDI:
// the BLE-MIDI codec is in TypeScript (apps/companion/src/device/ble-midi-codec.ts), where Bun tests cover it.
//
// Usage: fm1-ble-midi "<device name>"
// stdout, one line each (nothing else is ever printed to stdout):
//   state scanning | state connecting <how> | state connected | state ready mtu=<n> write=without|with
//   state disconnected | state waiting <why>
//   rx <hex>        one notification value, verbatim
//   ack             one `tx` line was handed to CoreBluetooth (or dropped with an error line); credit for the next
//   log <text> | error <text>
// stdin, one line each: `tx <hex>` = one characteristic value to write (at most mtu bytes, already BLE-MIDI
// encoded). Writes keep their order. Without-response writes wait for canSendWriteWithoutResponse; with-response
// writes wait for the previous response. EOF on stdin ends the helper (the companion has gone).
// Exit codes: 0 stdin closed or SIGTERM, 2 usage, 3 Bluetooth permission denied.
import CoreBluetooth
import Foundation

let midiService = CBUUID(string: "03B80E5A-EDE8-4B33-A751-6CE34EC4C700")
let midiIO = CBUUID(string: "7772E5DB-3868-4112-A1A9-F2669D106BF3")
let retrySeconds = 2.0
let readyTimeoutSeconds = 15.0

guard CommandLine.arguments.count == 2, !CommandLine.arguments[1].isEmpty else {
  FileHandle.standardError.write("usage: fm1-ble-midi <device name>\n".data(using: .utf8)!)
  exit(2)
}
runDisclaimed()   // our own TCC identity (Disclaim.swift); returns in the re-launched child
let wanted = CommandLine.arguments[1]

func say(_ s: String) {
  print(s)
  fflush(stdout)
}

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

func unhex(_ s: Substring) -> Data? {
  guard s.count % 2 == 0 else { return nil }
  var out = Data(capacity: s.count / 2)
  var i = s.startIndex
  while i < s.endIndex {
    let j = s.index(i, offsetBy: 2)
    guard let b = UInt8(s[i..<j], radix: 16) else { return nil }
    out.append(b)
    i = j
  }
  return out
}

final class Pipe: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private var central: CBCentralManager!
  private var peripheral: CBPeripheral?
  private var io: CBCharacteristic?
  private var scanning = false
  private var ready = false
  private var writeType: CBCharacteristicWriteType = .withoutResponse
  private var maxLen = 20
  private var pending: [Data] = []
  private var awaitingResponse = false
  /** Bumped on every new connection attempt, so a stale watchdog does nothing. */
  private var attempt = 0

  override init() {
    super.init()
    central = CBCentralManager(delegate: self, queue: nil)
  }

  func centralManagerDidUpdateState(_ c: CBCentralManager) {
    switch c.state {
    case .poweredOn: look()
    case .unauthorized: say("error bluetooth permission denied"); exit(3)
    default:
      if peripheral != nil { lost("bluetooth state \(c.state.rawValue)") }
      say("state waiting bluetooth state \(c.state.rawValue)")
    }
  }

  /// Takes the device if macOS (or another app) already connected it; otherwise scans and polls every 2 s.
  private func look() {
    guard peripheral == nil, central.state == .poweredOn else { return }
    if let p = central.retrieveConnectedPeripherals(withServices: [midiService]).first(where: { $0.name == wanted }) {
      stopScan()
      take(p, how: "already connected")
    } else {
      if !scanning {
        scanning = true
        say("state scanning")
        central.scanForPeripherals(withServices: nil, options: nil)
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + retrySeconds) { [weak self] in self?.look() }
    }
  }

  private func take(_ p: CBPeripheral, how: String) {
    peripheral = p
    p.delegate = self
    attempt += 1
    let mine = attempt
    say("state connecting \(how)")
    central.connect(p)
    DispatchQueue.main.asyncAfter(deadline: .now() + readyTimeoutSeconds) { [weak self] in
      guard let self, self.attempt == mine, !self.ready, let p = self.peripheral else { return }
      say("log not ready after \(Int(readyTimeoutSeconds)) s; retrying")
      self.central.cancelPeripheralConnection(p)
      self.lost("timeout")
    }
  }

  private func stopScan() {
    guard scanning else { return }
    scanning = false
    central.stopScan()
  }

  func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
    let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? p.name
    guard peripheral == nil, name == wanted else { return }
    stopScan()
    take(p, how: "found advertising")
  }

  func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
    guard p == peripheral else { return }
    say("state connected")
    p.discoverServices([midiService])
  }

  func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
    guard p == peripheral else { return }
    lost("connect failed")
  }

  func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
    guard p == peripheral else { return }
    lost(error.map { "disconnected: \($0.localizedDescription)" } ?? "disconnected")
  }

  /// Forgets the connection and everything queued for it, reports it, and looks again in 2 s.
  private func lost(_ why: String) {
    guard peripheral != nil else { return }
    peripheral = nil
    io = nil
    ready = false
    attempt += 1
    if !pending.isEmpty { say("log dropped \(pending.count) queued writes (\(why))") }
    pending.removeAll()
    awaitingResponse = false
    say("state disconnected")
    say("log \(why)")
    DispatchQueue.main.asyncAfter(deadline: .now() + retrySeconds) { [weak self] in self?.look() }
  }

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    if let error { say("error discover services \(error.localizedDescription)") }
    let services = (p.services ?? []).filter { $0.uuid == midiService }
    if services.isEmpty { say("error no BLE-MIDI service") }
    for s in services { p.discoverCharacteristics([midiIO], for: s) }
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
    if let error { say("error discover characteristics \(error.localizedDescription)") }
    for ch in s.characteristics ?? [] where ch.uuid == midiIO {
      io = ch
      p.setNotifyValue(true, for: ch)
    }
  }

  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
    if let error {
      say("error subscribe \(error.localizedDescription)")
      return
    }
    guard ch.isNotifying else {
      say("log unsubscribed")
      return
    }
    writeType = ch.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
    // The ATT MTU - 3: also the most a notification can carry, so packets are sized the same both ways.
    maxLen = p.maximumWriteValueLength(for: .withoutResponse)
    ready = true
    say("state ready mtu=\(maxLen) write=\(writeType == .withoutResponse ? "without" : "with")")
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
    if let error { return say("error notify \(error.localizedDescription)") }
    guard ch.uuid == midiIO, let v = ch.value, !v.isEmpty else { return }
    say("rx \(hex(v))")
  }

  // MARK: writes

  func tx(_ line: String) {
    guard line.hasPrefix("tx ") else { return say("error bad input line") }
    guard let d = unhex(line.dropFirst(3)), !d.isEmpty else {
      say("error bad tx hex")
      return say("ack")
    }
    guard ready else { return say("error tx dropped: not ready") }
    guard d.count <= maxLen else {
      say("error tx dropped: \(d.count) bytes > mtu \(maxLen)")
      return say("ack")
    }
    pending.append(d)
    pump()
  }

  private func pump() {
    guard ready, let p = peripheral, let ch = io else { return }
    while let d = pending.first {
      if writeType == .withoutResponse {
        guard p.canSendWriteWithoutResponse else { return }  // peripheralIsReady(toSendWriteWithoutResponse:) resumes
        p.writeValue(d, for: ch, type: .withoutResponse)
        pending.removeFirst()
        say("ack")
      } else {
        guard !awaitingResponse else { return }  // didWriteValueFor resumes
        awaitingResponse = true
        p.writeValue(d, for: ch, type: .withResponse)
        pending.removeFirst()
        return
      }
    }
  }

  func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) { pump() }

  func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
    if let error { say("error write \(error.localizedDescription)") }
    awaitingResponse = false
    say("ack")
    pump()
  }
}

let pipe = Pipe()
signal(SIGTERM) { _ in exit(0) }
signal(SIGPIPE, SIG_IGN)

var inbox = Data()
FileHandle.standardInput.readabilityHandler = { h in
  let chunk = h.availableData
  DispatchQueue.main.async {
    if chunk.isEmpty { exit(0) }
    inbox.append(chunk)
    while let nl = inbox.firstIndex(of: 0x0A) {
      let line = String(decoding: inbox[inbox.startIndex..<nl], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
      inbox.removeSubrange(inbox.startIndex...nl)
      if !line.isEmpty { pipe.tx(line) }
    }
    if inbox.count > 65536 {
      inbox.removeAll()
      say("error input line too long")
    }
  }
}
RunLoop.main.run()
