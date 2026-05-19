import { Platform } from "react-native";
import type { Device, UsbSerial } from "react-native-usb-serialport-for-android";

type UsbAndroidModule = typeof import("react-native-usb-serialport-for-android");

function getUsbAndroidModule(): UsbAndroidModule {
  ensureAndroid();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("react-native-usb-serialport-for-android") as UsbAndroidModule;
}

const DEFAULT_OPEN_OPTIONS = {
  baudRate: 115200,
  parity: 0,
  dataBits: 8,
  stopBits: 1,
} as const;

export type ArduinoReadStage =
  | "device-found"
  | "port-opened"
  | "waiting-before-send"
  | "command-sent"
  | "serial-received"
  | "serial-chunk"
  | "arduino-ready"
  | "arduino-stable"
  | "arduino-collecting"
  | "result-detected";

export type ArduinoWaitMode = "measurement" | "calibration";

export interface ArduinoReadProgress {
  stage: ArduinoReadStage;
  message: string;
  rawChunk?: string;
}

type ProgressListener = (progress: ArduinoReadProgress) => void;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureAndroid() {
  if (Platform.OS !== "android") {
    throw new Error("USB OTG serial is only supported on Android.");
  }
}

function hexToAscii(hex: string) {
  const clean = hex.replace(/\s+/g, "");
  let output = "";

  for (let index = 0; index < clean.length - 1; index += 2) {
    const value = Number.parseInt(clean.slice(index, index + 2), 16);
    if (!Number.isNaN(value) && value !== 0) {
      output += String.fromCharCode(value);
    }
  }

  return output;
}

function asciiToHex(text: string) {
  return text
    .split("")
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function hasCompleteMeasurementBlock(buffer: string) {
  return buffer.includes("RESULT_JSON:");
}

function hasCompleteCalibrationBlock(buffer: string) {
  return buffer.includes("CAL_JSON:") || buffer.includes("CAL_UPDATED_JSON:") || buffer.includes("CAL_CURRENT_JSON:");
}

function getCancellationReason(buffer: string): string | null {
  if (!buffer.includes('"status":"analysis_cancelled"')) {
    return null;
  }

  if (buffer.includes('"reason":"usb_disconnected"')) {
    return "Device disconnected. Analysis cancelled.";
  }

  return "Analysis cancelled by device.";
}

export async function listUsbDevices(): Promise<Device[]> {
  const { UsbSerialManager } = getUsbAndroidModule();
  return UsbSerialManager.list();
}

export async function getFirstUsbDevice(): Promise<Device | null> {
  const devices = await listUsbDevices();
  return devices[0] ?? null;
}

export async function hasUsbDevice(): Promise<boolean> {
  const device = await getFirstUsbDevice();
  return !!device;
}

export function describeUsbDevice(device: Device): string {
  return `deviceId=${device.deviceId}, vendorId=0x${device.vendorId
    .toString(16)
    .padStart(4, "0")}, productId=0x${device.productId
    .toString(16)
    .padStart(4, "0")}`;
}

export async function requestUsbPermissionIfNeeded(device: Device): Promise<boolean> {
  const { UsbSerialManager } = getUsbAndroidModule();

  const hasPermission = await UsbSerialManager.hasPermission(device.deviceId);
  if (hasPermission) {
    return true;
  }

  return UsbSerialManager.tryRequestPermission(device.deviceId);
}

export async function openUsbConnection(device: Device): Promise<UsbSerial> {
  const { Codes, UsbSerialManager } = getUsbAndroidModule();

  const granted = await requestUsbPermissionIfNeeded(device);
  if (!granted) {
    throw new Error(
      `USB permission prompt shown for ${describeUsbDevice(device)}. Tap analyze again after allowing access.`
    );
  }

  try {
    return await UsbSerialManager.open(device.deviceId, DEFAULT_OPEN_OPTIONS);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;

    if (code === Codes.DRIVER_NOT_FOND) {
      throw new Error(
        `Android found ${describeUsbDevice(device)}, but the USB serial driver could not recognize it. ` +
          "If the board is meant to expose CDC, make sure the app is rebuilt with the updated native module."
      );
    }

    if (code === Codes.PERMISSION_DENIED) {
      throw new Error(
        `Android could not access ${describeUsbDevice(device)} after permission was requested. Reconnect the cable, tap the USB prompt again, and retry.`
      );
    }

    if (code === Codes.OPEN_FAILED) {
      throw new Error(
        `Android found ${describeUsbDevice(device)} and granted permission, but opening the serial port still failed. ` +
          "This usually means the connected USB interface is not a supported serial adapter."
      );
    }

    throw new Error(
      `Failed to open ${describeUsbDevice(device)}. This usually means Android found the USB device but no serial driver supports it.`
    );
  }
}

export async function sendAsciiCommand(port: UsbSerial, command: string): Promise<void> {
  const normalized = command.endsWith("\n") ? command : `${command}\n`;
  await port.send(asciiToHex(normalized));
}

export async function waitForArduinoResult(
  port: UsbSerial,
  timeoutMs = 150000,
  onProgress?: ProgressListener,
  mode: ArduinoWaitMode = "measurement"
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    let completeTimer: ReturnType<typeof setTimeout> | null = null;
    let hasReportedSerial = false;
    let hasReportedReady = false;
    let hasReportedStable = false;
    let hasReportedCollecting = false;
    let hasReportedResult = false;
    let lastChunkProgressAt = 0;

    const finish = async (action: "resolve" | "reject", payload: string | Error) => {
      if (settled) return;
      settled = true;

      if (completeTimer) clearTimeout(completeTimer);
      timeoutHandle && clearTimeout(timeoutHandle);
      subscription.remove();

      try {
        await port.close();
      } catch (error) {
        console.log("USB close error:", error);
      }

      if (action === "resolve") {
        resolve(payload as string);
      } else {
        reject(payload);
      }
    };

    const subscription = port.onReceived((event) => {
      const chunk = hexToAscii(event.data);
      if (!chunk) return;

      buffer += chunk;

      if (!hasReportedSerial) {
        hasReportedSerial = true;
        onProgress?.({
          stage: "serial-received",
          message: "Arduino serial data detected.",
          rawChunk: chunk,
        });
      } else {
        const now = Date.now();
        // Throttle chunk events to keep the UI responsive.
        if (now - lastChunkProgressAt > 250) {
          lastChunkProgressAt = now;
          onProgress?.({
            stage: "serial-chunk",
            message: "Arduino is still sending serial data.",
            rawChunk: chunk,
          });
        }
      }

      if (!hasReportedReady && buffer.includes('"status":"ready"')) {
        hasReportedReady = true;
        onProgress?.({
          stage: "arduino-ready",
          message: "Arduino acknowledged the sample command.",
          rawChunk: chunk,
        });
      }

      if (!hasReportedStable && buffer.includes('"status":"stable"')) {
        hasReportedStable = true;
        onProgress?.({
          stage: "arduino-stable",
          message: "Arduino marked the probe reading as stable.",
          rawChunk: chunk,
        });
      }

      if (!hasReportedCollecting && buffer.includes('"status":"collecting"')) {
        hasReportedCollecting = true;
        onProgress?.({
          stage: "arduino-collecting",
          message: "Arduino started collecting the final sample window.",
          rawChunk: chunk,
        });
      }

      const cancellationReason = getCancellationReason(buffer);
      if (cancellationReason) {
        finish("reject", new Error(cancellationReason));
        return;
      }

      const complete =
        mode === "calibration"
          ? hasCompleteCalibrationBlock(buffer)
          : hasCompleteMeasurementBlock(buffer);

      if (!complete) {
        return;
      }

      if (!hasReportedResult) {
        hasReportedResult = true;
        onProgress?.({
          stage: "result-detected",
          message: "Arduino result block detected.",
          rawChunk: chunk,
        });
      }

      if (completeTimer) clearTimeout(completeTimer);
      completeTimer = setTimeout(() => {
        finish("resolve", buffer);
      }, 300);
    });

    const timeoutHandle = setTimeout(() => {
      finish(
        "reject",
        new Error("Timed out while waiting for the Arduino result block.")
      );
    }, timeoutMs);
  });
}

export async function collectSingleArduinoResult(sampleCommand = "1"): Promise<string> {
  return collectSingleArduinoResultWithProgress(sampleCommand);
}

export async function collectSingleArduinoResultWithProgress(
  sampleId = "1",
  onProgress?: ProgressListener
): Promise<string> {
  const device = await getFirstUsbDevice();
  if (!device) {
    throw new Error("No OTG USB serial device detected.");
  }

  onProgress?.({
    stage: "device-found",
    message: "USB serial device found.",
  });

  const port = await openUsbConnection(device);
  onProgress?.({
    stage: "port-opened",
    message: "USB serial port opened.",
  });

  onProgress?.({
    stage: "waiting-before-send",
    message: "Waiting for Arduino serial to settle.",
  });

  await delay(1500);
  const command = `M ${sampleId.trim() || "1"}`;
  await sendAsciiCommand(port, command);
  onProgress?.({
    stage: "command-sent",
    message: `Command '${command}' sent to Arduino.`,
  });

  return waitForArduinoResult(port, 120000, onProgress, "measurement");
}

export async function runArduinoCalibrationCommandWithProgress(
  command: "L" | "H" | "?" | `C ${number} ${number}`,
  onProgress?: ProgressListener
): Promise<string> {
  const device = await getFirstUsbDevice();
  if (!device) {
    throw new Error("No OTG USB serial device detected.");
  }

  onProgress?.({
    stage: "device-found",
    message: "USB serial device found.",
  });

  const port = await openUsbConnection(device);
  onProgress?.({
    stage: "port-opened",
    message: "USB serial port opened.",
  });

  onProgress?.({
    stage: "waiting-before-send",
    message: "Waiting for Arduino serial to settle.",
  });

  await delay(1500);
  await sendAsciiCommand(port, command);
  onProgress?.({
    stage: "command-sent",
    message: `Calibration command '${command}' sent to Arduino.`,
  });

  return waitForArduinoResult(port, 120000, onProgress, "calibration");
}
