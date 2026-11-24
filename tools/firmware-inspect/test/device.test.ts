import { describe, expect, test } from "bun:test";
import { classify, findFm1Devices, parseIoreg } from "../src/device";

// Shaped like `ioreg -p IOUSB -l -w0` and `ioreg -p IOService -r -c IOPortTransportStateUSB2 -l -w0` on this Mac.
const USB = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 51>
  +-o AppleT8142USBXHCI@01000000  <class AppleT8142USBXHCI, id 0x100000561, registered, matched, active, busy 0, retain 35>
  | +-o CoralFlower FM-1@01100000  <class IOUSBHostDevice, id 0x1000a2e84, !registered, !matched, active, busy 0, retain 13>
  |     {
  |       "idProduct" = 1
  |       "bcdDevice" = 769
  |       "USB Product Name" = "CoralFlower FM-1"
  |       "locationID" = 17825792
  |       "USB Vendor Name" = "CoralFlower"
  |       "Device Speed" = 1
  |       "idVendor" = 4617
  |     }
  | +-o Keyboard@01200000  <class IOUSBHostDevice, id 0x1, registered, matched, active, busy 0, retain 13>
  |     {
  |       "idVendor" = 1452
  |     }`;
const PORTS = `+-o USB2  <class IOPortTransportStateUSB2, id 0x1000a2e7f, registered, matched, active, busy 0 (10 ms), retain 13>
    {
      "Vendor ID" = 4617
      "Product" = "CoralFlower FM-1"
      "Product ID" = 1
      "AuthorizationStatusDescription" = "Unauthorized"
      "TRM_ProfileDescription" = "Ask for New Accessories"
    }`;

describe("device (ioreg parsing)", () => {
  test("parses objects and properties", () => {
    const b = parseIoreg(USB).find((x) => x.cls === "IOUSBHostDevice");
    expect(b?.name).toBe("CoralFlower FM-1@01100000");
    expect(b?.props.bcdDevice).toBe(769);
    expect(b?.props["USB Product Name"]).toBe("CoralFlower FM-1");
  });
  test("finds the FM-1 with its accessory authorization, ignores other devices", () => {
    const list = findFm1Devices(USB, PORTS);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ vendorId: 0x1209, productId: 1, bcdDevice: 0x0301, locationId: 0x01100000,
      authorization: "Unauthorized", accessoryPolicy: "Ask for New Accessories" });
    expect(list[0]?.mode).toContain("CoralFlower");
  });
  test("classifies update mode, mask ROM and our firmware", () => {
    expect(classify(0x1209, 2, "Felucca Update")).toContain("update loader");
    expect(classify(0x4c4a, 0x8057, "UBOOT1.00")).toContain("mask-ROM");
    expect(classify(0x1209, 1, "FM1 CONSOLE")).toContain("this project");
    expect(classify(0x05ac, 1, null)).toBe("not an FM-1 USB identity");
  });
});
