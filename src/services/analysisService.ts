import { mockAnalysisRecords } from "../data/analysisMock";
import {
  AnalysisNarrative,
  AnalysisRecord,
  BinaryAcidityLabel,
  FirmwareGuardBandLabel,
  PHClassification,
  RiskLevel,
  SensorReading,
} from "../types/analysis";

export interface TrendPoint {
  label: string;
  value: number;
  classification: string;
}

export interface CoffeeTypeAverage {
  coffeeType: string;
  averagePh: number;
}

export interface ConfusionMatrix {
  tp: number;
  tn: number;
  fp: number;
  fn: number;
}

export interface ClassificationMetrics extends ConfusionMatrix {
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  total: number;
}

export interface ModelEvaluationResult {
  key: string;
  name: string;
  metrics: ClassificationMetrics;
}

function sortNewestFirst(records: AnalysisRecord[]) {
  return [...records].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

function roundTo1(num: number) {
  return Math.round(num * 10) / 10;
}

function roundTo3(num: number) {
  return Math.round(num * 1000) / 1000;
}

export function buildRuleBasedNarrative(
  item: Pick<
    AnalysisRecord,
    "coffeeType" | "ph" | "classification" | "riskLevel" | "stomachState" | "cupsToday"
  >
): AnalysisNarrative {
  const summary =
    item.classification === "High Acidity"
      ? `Your ${item.coffeeType.toLowerCase()} tested as highly acidic, which may trigger gastric discomfort.`
      : item.classification === "Moderate Acidity"
        ? `Your ${item.coffeeType.toLowerCase()} tested as moderately acidic and may cause some discomfort depending on timing.`
      : `Your ${item.coffeeType.toLowerCase()} tested as low acidic and is generally gentler on the stomach.`;

  const likelyEffectTitle =
    item.riskLevel === "High Risk"
      ? "High likelihood of discomfort"
      : item.riskLevel === "Moderate Risk"
        ? "Possible discomfort"
        : "Lower likelihood of discomfort";

  const likelyEffectItems = [];
  if (item.riskLevel === "High Risk") {
    likelyEffectItems.push("Increased likelihood of acid reflux", "Potential for temporary stomach heaviness", "Possible heartburn sensation");
  } else if (item.riskLevel === "Moderate Risk") {
    likelyEffectItems.push("Possible mild indigestion", "Slight bloating", "Potential for minor heartburn");
  } else {
    likelyEffectItems.push("Generally well-tolerated", "Minimal gastric impact", "Low likelihood of reflux");
  }

  const advisory =
    item.classification === "Moderate Acidity"
      ? "This coffee's pH is near the typical range. Most people can enjoy it without issues. If you have acid sensitivity, consume moderately."
      : item.riskLevel === "High Risk"
        ? "Consider reducing intake or drinking after meals to minimize gastric discomfort."
        : item.riskLevel === "Moderate Risk"
          ? "Try improving timing and hydration to lessen possible irritation."
          : "Current result suggests lower discomfort risk, but moderation is still recommended.";

  const tips = [
    "Have coffee after meals whenever possible",
    "Stay hydrated: drink water alongside coffee",
    "Limit intake: keep it to 1-2 cups per day",
    item.classification === "High Acidity"
      ? "Switch to lower-acidity instant brands or decaf"
      : "Avoid drinking coffee too quickly to reduce irritation",
  ];

  const safeTiming =
    item.stomachState === "Empty stomach"
      ? "Best to drink coffee 30-45 minutes after eating to lessen irritation."
      : "Continue drinking coffee after meals for better stomach comfort.";

  const impactItems = [];
  
  const acidityLabel = 
    item.classification === "High Acidity" ? "High acidity concentration" :
    item.classification === "Moderate Acidity" ? "Moderate acidity level" :
    "Lower acidity concentration";

  impactItems.push(`${acidityLabel} (pH ${item.ph.toFixed(2)})`);
  
  if (item.stomachState === "Empty stomach") {
    impactItems.push("Consumption on an empty stomach");
  }
  if ((item.cupsToday ?? 0) >= 2) {
    impactItems.push(`Daily intake: ${item.cupsToday} cups`);
  }
  if (impactItems.length < 3) impactItems.push("Specific instant coffee processing and formulation");

  return {
    summary,
    likelyEffectTitle,
    likelyEffectItems,
    advisory,
    tips,
    safeTiming,
    impactItems,
    source: "rules",
  };
}

export function mapFirmwareLabelToClassification(
  firmwareLabel: FirmwareGuardBandLabel
): PHClassification {
  if (firmwareLabel === "ACIDIC") return "High Acidity";
  if (firmwareLabel === "NON_ACIDIC") return "Low Acidity";
  return "Moderate Acidity";
}

export function classifyRiskLevel(
  mlLabel: BinaryAcidityLabel,
  stomachState?: AnalysisRecord["stomachState"]
): RiskLevel {
  if (mlLabel === "Acidic" && stomachState === "Empty stomach") {
    return "High Risk";
  }

  if (
    mlLabel === "Acidic" || 
    (mlLabel === "Non-Acidic" && stomachState === "Empty stomach")
  ) {
    return "Moderate Risk";
  }

  return "Low Risk";
}

export function mapFirmwareLabelToBinaryAcidity(
  firmwareLabel: FirmwareGuardBandLabel
): BinaryAcidityLabel {
  return firmwareLabel === "ACIDIC" ? "Acidic" : "Non-Acidic";
}

export function buildAnalysisRecord(
  reading: SensorReading,
  options?: {
    coffeeType?: string;
    stomachState?: AnalysisRecord["stomachState"];
    note?: string;
    isNewCup?: boolean;
    cupsToday?: number;
  }
): AnalysisRecord {
  const classification = mapFirmwareLabelToClassification(reading.firmwareLabel);
  const stomachState = options?.stomachState ?? "After meal";
  const binaryLabel = mapFirmwareLabelToBinaryAcidity(reading.firmwareLabel);
  const coffeeType = options?.coffeeType ?? `Sample ${reading.sampleId}`;
  const riskLevel = classifyRiskLevel(binaryLabel, stomachState);
  const isNewCup = options?.isNewCup ?? true;
  const cupsToday = options?.cupsToday ?? 1;

  return {
    id: `${Date.now()}-${reading.sampleId}`,
    createdAt: new Date().toISOString(),
    coffeeType,
    ph: roundTo3(reading.ph),
    classification,
    binaryLabel,
    stabilizationTimeSec: reading.stabilizationTimeSec,
    averageVoltage: reading.averageVoltage,
    samplesCollected: reading.samplesCollected,
    sampleId: reading.sampleId,
    firmwareLabel: reading.firmwareLabel,
    note: options?.note,
    stomachState,
    cupsToday,
    isNewCup,
    riskLevel,
    narrative: buildRuleBasedNarrative({
      coffeeType,
      ph: roundTo3(reading.ph),
      classification,
      riskLevel,
      stomachState,
      cupsToday,
    }),
  };
}

export function getAllAnalysisRecords(): AnalysisRecord[] {
  return sortNewestFirst(mockAnalysisRecords);
}

export function getLatestAnalysis(): AnalysisRecord | null {
  const sorted = sortNewestFirst(mockAnalysisRecords);
  return sorted.length ? sorted[0] : null;
}

export function getTrendData(): TrendPoint[] {
  const sortedAsc = [...mockAnalysisRecords].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return sortedAsc.map((item) => {
    const date = new Date(item.createdAt);
    return {
      label: `${date.getDate()}`,
      value: item.ph,
      classification: item.classification,
    };
  });
}

export function getCoffeeTypeAverages(): CoffeeTypeAverage[] {
  const grouped: Record<string, number[]> = {};

  mockAnalysisRecords.forEach((item) => {
    if (!grouped[item.coffeeType]) grouped[item.coffeeType] = [];
    grouped[item.coffeeType].push(item.ph);
  });

  return Object.entries(grouped).map(([coffeeType, values]) => ({
    coffeeType,
    averagePh: roundTo1(
      values.reduce((sum, val) => sum + val, 0) / values.length
    ),
  }));
}

export function getSummaryInsights(): string[] {
  const entries = mockAnalysisRecords;
  const total = entries.length;
  const results = [];

  const moderateOrHigh = entries.filter(
    (item) =>
      item.classification === "Moderate Acidity" ||
      item.classification === "High Acidity"
  ).length;
  const percent = total ? roundTo1((moderateOrHigh / total) * 100) : 0;
  results.push(`${percent}% of your entries were "Moderate Acidity" or "High Acidity".`);

  const emptyHighRisk = entries.filter(
    (item) =>
      item.stomachState === "Empty stomach" &&
      item.riskLevel === "High Risk"
  ).length;
  results.push(`"Empty stomach" + high acidity showed ${emptyHighRisk} higher-risk logs.`);

  // Time-gap logic for mock data
  const newCups = [...entries]
    .filter((e) => e.isNewCup !== false)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  let rapidIntakeCount = 0;
  for (let i = 1; i < newCups.length; i++) {
    const diff = new Date(newCups[i].createdAt).getTime() - new Date(newCups[i - 1].createdAt).getTime();
    if (diff > 0 && diff < 90 * 60 * 1000) rapidIntakeCount++;
  }

  if (rapidIntakeCount > 0) {
    results.push(`Detected ${rapidIntakeCount} cases of back-to-back coffee consumption in under 90 minutes.`);
  }

  return results;
}

export function getPatternInsights(): string[] {
  const averages = getCoffeeTypeAverages();

  const highest = [...averages].sort((a, b) => a.averagePh - b.averagePh)[0];
  const lowest = [...averages].sort((a, b) => b.averagePh - a.averagePh)[0];

  return [
    highest
      ? `${highest.coffeeType} had the strongest acidity tendency.`
      : "No acidity pattern yet.",
    lowest
      ? `${lowest.coffeeType} appeared milder on average.`
      : "No coffee type comparison yet.",
  ];
}
