// `device`: the connected FM-1's USB identity from macOS's IORegistry (ioreg, read-only). Nothing is opened
// or sent to the device; macOS's own enumeration data is read.
import { spawnSync } from "node:child_process";

export interface UsbDevice {
  name: string;
  locationId: number | null;
  vendorId: number | null;
  productId: number | null;
  bcdDevice: number | null;
  product: string | null;
  vendor: string | null;
  speed: number | null;
  /** macOS accessory security (IOPortTransportStateUSB2): e.g. "Authorized" / "Unauthorized" */
  authorization: string | null;
  accessoryPolicy: string | null;
  mode: string;
}

const PROP = /"([^"]+)" = (.*)$/;

function value(raw: string): string | number {
  const v = raw.trim();
  if (/^".*"$/.test(v)) return v.slice(1, -1);
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^0x[0-9a-f]+$/i.test(v)) return Number.parseInt(v, 16);
  return v;
}

interface Block {
  name: string;
  cls: string;
  props: Record<string, string | number>;
}

/** Split `ioreg -l -w0` text into objects with their properties. */
export function parseIoreg(text: string): Block[] {
  const out: Block[] = [];
  let cur: Block | null = null;
  for (const line of text.split("\n")) {
    const head = /\+-o ([^<]+?)\s+<class (\w+)/.exec(line);
    if (head?.[1] && head[2]) {
      cur = { name: head[1], cls: head[2], props: {} };
      out.push(cur);
      continue;
    }
    const p = PROP.exec(line);
    if (cur && p?.[1] && p[2] !== undefined && !(p[1] in cur.props)) cur.props[p[1]] = value(p[2]);
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function classify(vid: number | null, pid: number | null, product: string | null): string {
  if (vid === 0x4c4a && pid === 0x8057) return "JieLi mask-ROM USB boot (WL82 UBOOT1.00): only the unbricker talks to it";
  if (vid !== 0x1209) return "not an FM-1 USB identity";
  if (pid === 0x0002) return "Felucca-family update loader (update mode)";
  if (pid !== 0x0001) return "pid.codes device, not an FM-1 firmware";
  if (product === "CoralFlower FM-1") return "CoralFlower (any release 0.1-0.7.1 uses this name)";
  if (product === "FM1 CONSOLE") return "FM1 CONSOLE (this project's firmware)";
  if (product === "Felucca") return "Felucca / Dinghy";
  return "Felucca-family firmware (unrecognised product string)";
}

export function findFm1Devices(usbTree: string, serviceTree: string): UsbDevice[] {
  const ports = parseIoreg(serviceTree).filter((b) => b.cls.startsWith("IOPortTransportState"));
  return parseIoreg(usbTree)
    .filter((b) => b.cls === "IOUSBHostDevice")
    .filter((b) => b.props.idVendor === 0x1209 || b.props.idVendor === 0x4c4a)
    .map((b) => {
      const vendorId = num(b.props.idVendor);
      const productId = num(b.props.idProduct);
      const product = str(b.props["USB Product Name"]);
      const port = ports.find((p) => p.props["Vendor ID"] === vendorId && p.props["Product ID"] === productId && p.props.Product === product);
      return {
        name: b.name, locationId: num(b.props.locationID), vendorId, productId, bcdDevice: num(b.props.bcdDevice),
        product, vendor: str(b.props["USB Vendor Name"]), speed: num(b.props["Device Speed"]),
        authorization: str(port?.props.AuthorizationStatusDescription), accessoryPolicy: str(port?.props.TRM_ProfileDescription),
        mode: classify(vendorId, productId, product),
      };
    });
}

function run(args: string[]): string {
  const r = spawnSync("ioreg", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ioreg ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export function readDevices(): UsbDevice[] {
  return findFm1Devices(run(["-p", "IOUSB", "-l", "-w0"]), run(["-p", "IOService", "-l", "-w0", "-r", "-c", "IOPortTransportStateUSB2"]));
}
