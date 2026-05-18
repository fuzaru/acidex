// where to put the shared types such as :
// SensorReading
// AnalysisRecord
// PhClassification


export type PHClassification =
  | "Low Acidity"
  | "Moderate Acidity"
  | "High Acidity";

export type FirmwareGuardBandLabel = "ACIDIC" | "NON_ACIDIC" | "UNCERTAIN";

export type RiskLevel = "Low Risk" | "Moderate Risk" | "High Risk";
export type BinaryAcidityLabel = "Acidic" | "Non-Acidic";
export type MlModelKey = "logistic_regression" | "decision_stump";

export interface AnalysisNarrative {
  summary: string;
  likelyEffectTitle: string;
  likelyEffectItems: string[];
  advisory: string;
  tips: string[];
  safeTiming: string;
  impactItems: string[];
  source: "rules" | "llm";
  model?: string;
  generatedAt?: string;
}

export interface SensorReading {
  sampleId: string;
  averageVoltage: number;
  ph: number;
  samplesCollected: number;
  stabilizationTimeSec: number;
  firmwareLabel: FirmwareGuardBandLabel;
}

export interface AnalysisRecord {
  id: string;
  createdAt: string;
  coffeeType: string;
  ph: number;
  classification: PHClassification;
  binaryLabel?: BinaryAcidityLabel;
  mlConfidence?: number;
  mlModelKey?: MlModelKey;
  mlModelName?: string;
  stabilizationTimeSec?: number;
  averageVoltage?: number;
  samplesCollected?: number;
  sampleId?: string;
  firmwareLabel?: FirmwareGuardBandLabel;
  title?: string;
  note?: string;
  stomachState?: "Empty stomach" | "After meal";
  cupsToday?: number;
  isNewCup?: boolean;
  riskLevel?: RiskLevel;
  narrative?: AnalysisNarrative;
}

export function normalizePHClassification(value?: string | null): PHClassification {
  const normalized = (value ?? "").trim().toLowerCase();

  if (
    normalized === "high acidity" ||
    normalized === "high_acidity" ||
    normalized === "acidic"
  ) {
    return "High Acidity";
  }

  if (
    normalized === "low acidity" ||
    normalized === "low_acidity" ||
    normalized === "non-acidic" ||
    normalized === "non acidic" ||
    normalized === "non_acidic"
  ) {
    return "Low Acidity";
  }

  return "Moderate Acidity";
}

// calculation of mV using nern's equation
