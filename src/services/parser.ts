import { FirmwareGuardBandLabel, SensorReading } from "../types/analysis";

export type CalibrationBuffer = "low" | "high";

export type CalibrationEvent =
  | {
      type: "buffer";
      buffer: CalibrationBuffer;
      voltage: number;
      ph?: number;
      samplesCollected: number;
      stabilizationTimeSec: number;
    }
  | {
      type: "current";
      slope: number;
      intercept: number;
    }
  | {
      type: "updated";
      slope: number;
      intercept: number;
    };

export function parseArduinoResultBlock(raw: string): SensorReading | null {
  const jsonMatch = raw.match(/RESULT_JSON:(\{.*?\})/s);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1]) as {
      sample?: string;
      avgVoltage?: number;
      pH?: number;
      label?: string;
      samplesCollected?: number;
      stabilizationTimeSec?: number;
    };

    const firmwareLabel =
      typeof parsed.label === "string" ? parsed.label.trim().toUpperCase() : "";
    const isValidLabel =
      firmwareLabel === "ACIDIC" ||
      firmwareLabel === "NON_ACIDIC" ||
      firmwareLabel === "UNCERTAIN";

    if (
      typeof parsed.sample === "string" &&
      typeof parsed.avgVoltage === "number" &&
      typeof parsed.pH === "number" &&
      isValidLabel &&
      typeof parsed.samplesCollected === "number" &&
      typeof parsed.stabilizationTimeSec === "number" &&
      parsed.stabilizationTimeSec >= 0
    ) {
      return {
        sampleId: parsed.sample,
        averageVoltage: parsed.avgVoltage,
        ph: parsed.pH,
        samplesCollected: parsed.samplesCollected,
        stabilizationTimeSec: parsed.stabilizationTimeSec,
        firmwareLabel: firmwareLabel as FirmwareGuardBandLabel,
      };
    }
  } catch (error) {
    console.error("parseArduinoResultBlock JSON parse error:", {
      error: error instanceof Error ? error.message : String(error),
      raw: raw.substring(0, 200),
    });
  }

  return null;
}

export function parseArduinoCalibrationBlock(raw: string): CalibrationEvent | null {
  const bufferMatch = raw.match(/CAL_JSON:(\{.*?\})/s);
  if (bufferMatch) {
    try {
      const parsed = JSON.parse(bufferMatch[1]) as {
        buffer?: string;
        voltage?: number;
        pH?: number | null;
        samplesCollected?: number;
        stabilizationTimeSec?: number;
      };

      const buffer =
        typeof parsed.buffer === "string" ? parsed.buffer.trim().toLowerCase() : "";

      if (
        (buffer === "low" || buffer === "high") &&
        typeof parsed.voltage === "number" &&
        typeof parsed.samplesCollected === "number" &&
        typeof parsed.stabilizationTimeSec === "number"
      ) {
        const ph = typeof parsed.pH === "number" && Number.isFinite(parsed.pH) ? parsed.pH : undefined;
        return {
          type: "buffer",
          buffer,
          voltage: parsed.voltage,
          ph,
          samplesCollected: parsed.samplesCollected,
          stabilizationTimeSec: parsed.stabilizationTimeSec,
        };
      }
    } catch {
      return null;
    }
  }

  const currentMatch = raw.match(/CAL_CURRENT_JSON:(\{.*?\})/s);
  if (currentMatch) {
    try {
      const parsed = JSON.parse(currentMatch[1]) as { slope?: number; intercept?: number };
      if (typeof parsed.slope === "number" && typeof parsed.intercept === "number") {
        return { type: "current", slope: parsed.slope, intercept: parsed.intercept };
      }
    } catch {
      return null;
    }
  }

  const updatedMatch = raw.match(/CAL_UPDATED_JSON:(\{.*?\})/s);
  if (updatedMatch) {
    try {
      const parsed = JSON.parse(updatedMatch[1]) as { slope?: number; intercept?: number };
      if (typeof parsed.slope === "number" && typeof parsed.intercept === "number") {
        return { type: "updated", slope: parsed.slope, intercept: parsed.intercept };
      }
    } catch {
      return null;
    }
  }

  return null;
}
