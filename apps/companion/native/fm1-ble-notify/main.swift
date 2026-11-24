// fm1-ble-notify: keeps the BLE-MIDI notifications of one connected FM-1 turned on.
//
// macOS's Bluetooth MIDI driver connects the FM-1 and creates its CoreMIDI port, but it never writes the
// MIDI characteristic's CCCD, so the device has nothing to notify on and the port stays silent (observed
// 2026-11-18, FM1 CONSOLE 19E2). While any app on the Mac holds the subscription, the notifications reach
// the CoreMIDI port too. When macOS has not connected the FM-1 (after a restart of the device, or Bluetooth
// MIDI never opened in Audio MIDI Setup), the helper scans for it by name and connects it itself, so macOS's
// Bluetooth MIDI driver can create the port. It subscribes and writes nothing else.
// Usage: fm1-ble-notify "<device name>". One status line per change on stdout.
import CoreBluetooth
import Foundation

let midiService = CBUUID(string: "03B80E5A-EDE8-4B33-A751-6CE34EC4C700")
let midiIO = CBUUID(string: "7772E5DB-3868-4112-A1A9-F2669D106BF3")

guard CommandLine.arguments.count == 2, !CommandLine.arguments[1].isEmpty else {
  FileHandle.standardError.write("usage: fm1-ble-notify <device name>\n".data(using: .utf8)!)
  exit(2)
}
runDisclaimed()   // our own TCC identity (Disclaim.swift); returns in the re-launched child
let wanted = CommandLine.arguments[1]

func say(_ s: String) {
  print(s)
  fflush(stdout)
}

final class Keeper: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private var central: CBCentralManager!
  private var peripheral: CBPeripheral?
  private var scanning = false

  override init() {
    super.init()
    central = CBCentralManager(delegate: self, queue: nil)
  }

  func centralManagerDidUpdateState(_ c: CBCentralManager) {
    switch c.state {
    case .poweredOn: look()
    case .unauthorized: say("error bluetooth permission denied"); exit(3)
    default: say("waiting bluetooth state \(c.state.rawValue)")
    }
  }

  /// Takes the device if macOS already connected it; otherwise scans for it and polls again every 2 s.
  private func look() {
    guard peripheral == nil else { return }
    if let p = central.retrieveConnectedPeripherals(withServices: [midiService]).first(where: { $0.name == wanted }) {
      stopScan()
      take(p, how: "connected by macOS")
    } else {
      if !scanning {
        scanning = true
        say("scanning for \(wanted)")
        central.scanForPeripherals(withServices: nil, options: nil)
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.look() }
    }
  }

  private func take(_ p: CBPeripheral, how: String) {
    peripheral = p
    p.delegate = self
    say("connecting (\(how))")
    central.connect(p)
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
    say("connected")
    p.discoverServices([midiService])
  }

  func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
    say("waiting connect failed")
    retry()
  }

  func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
    say("waiting disconnected")
    retry()
  }

  private func retry() {
    peripheral = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.look() }
  }

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    for s in p.services ?? [] where s.uuid == midiService { p.discoverCharacteristics([midiIO], for: s) }
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
    for ch in s.characteristics ?? [] where ch.uuid == midiIO { p.setNotifyValue(true, for: ch) }
  }

  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
    if let error { say("error subscribe \(error.localizedDescription)") } else { say(ch.isNotifying ? "subscribed" : "unsubscribed") }
  }

  // The data itself is read from CoreMIDI by the companion.
  func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {}
}

let keeper = Keeper()
signal(SIGTERM) { _ in exit(0) }
RunLoop.main.run()
