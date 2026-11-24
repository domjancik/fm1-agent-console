// Bluetooth permission (TCC) is checked against the "responsible" process: the terminal app that started the
// companion, not this helper. A terminal without NSBluetoothAlwaysUsageDescription gets the helper aborted (exit 134,
// crash reports 2026-11-23, responsibleProc "stable"). So the helper re-launches itself once with responsibility
// disclaimed: it becomes its own responsible process, TCC reads its embedded Info.plist and asks for Bluetooth once.
// stdio is inherited; the parent forwards SIGTERM/SIGINT and exits with the child's status.
import Darwin
import Foundation

private var disclaimChild: pid_t = 0

func runDisclaimed() {
  let marker = "FM1_BLE_DISCLAIMED"
  if getenv(marker) != nil { return }
  typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
  guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { return }
  let setDisclaim = unsafeBitCast(sym, to: SetDisclaim.self)
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  defer { posix_spawnattr_destroy(&attr) }
  guard setDisclaim(&attr, 1) == 0 else { return }
  setenv(marker, "1", 1)
  guard let path = Bundle.main.executablePath else { return }
  let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  var pid: pid_t = 0
  guard posix_spawn(&pid, path, nil, &attr, argv, environ) == 0 else { unsetenv(marker); return }
  disclaimChild = pid
  for sig in [SIGTERM, SIGINT, SIGHUP] { signal(sig) { s in if disclaimChild > 0 { kill(disclaimChild, s) } } }
  var status: Int32 = 0
  while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
  let code = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
  exit(code)
}
