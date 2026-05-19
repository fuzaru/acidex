import { supabase } from "@/lib/supabase";

import { saveAnalysisRecord } from "../store/analysisStore";
import { AnalysisNarrative, AnalysisRecord } from "../types/analysis";

const ANALYSIS_LLM_FUNCTION_NAME =
  process.env.EXPO_PUBLIC_ANALYSIS_LLM_FUNCTION_NAME || "analysis-llm";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

type InvokePayload = {
  record: {
    coffeeType: AnalysisRecord["coffeeType"];
    ph: AnalysisRecord["ph"];
    classification: AnalysisRecord["classification"];
    riskLevel: AnalysisRecord["riskLevel"];
    stomachState: AnalysisRecord["stomachState"];
    cupsToday: AnalysisRecord["cupsToday"];
    stabilizationTimeSec: AnalysisRecord["stabilizationTimeSec"];
    averageVoltage: AnalysisRecord["averageVoltage"];
    samplesCollected: AnalysisRecord["samplesCollected"];
  };
};

async function invokeAnalysisLlm(payload: InvokePayload) {
  let result = await supabase.functions.invoke(ANALYSIS_LLM_FUNCTION_NAME, {
    body: payload,
  });

  const statusCode =
    (result.error as any)?.statusCode ||
    (result.error as any)?.status ||
    (result.error as any)?.context?.status ||
    (result.error as any)?.response?.status;

  if (statusCode === 401 && SUPABASE_ANON_KEY) {
    // Retry once with explicit anon auth to bypass stale/invalid session token headers.
    result = await supabase.functions.invoke(ANALYSIS_LLM_FUNCTION_NAME, {
      body: payload,
      headers: {
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
  }

  return result;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("LLM analysis request timed out."));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

type PhBand = "High" | "Moderate" | "Low";

function classifyPhBand(ph?: number): PhBand {
  if (typeof ph !== "number") return "Moderate";
  if (ph < 4.7) return "High";
  if (ph > 5.3) return "Low";
  return "Moderate";
}

function filterOut(items: string[], patterns: RegExp[]): string[] {
  return items.filter((item) => !patterns.some((pattern) => pattern.test(item)));
}

function padItems(items: string[], fallback: string[], minCount = 3, maxCount = 4): string[] {
  const next = [...items];
  for (const item of fallback) {
    if (next.length >= minCount) break;
    if (!next.includes(item)) next.push(item);
  }
  return next.slice(0, maxCount);
}

function buildUxLikelyEffects(band: PhBand): string[] {
  if (band === "High") {
    return ["Possible stomach warmth", "Mild heartburn", "Light bloating"];
  }
  if (band === "Low") {
    return ["Generally gentle on the stomach", "Low likelihood of reflux", "Comfort is usually steady"];
  }
  return ["Mild stomach sensitivity", "Occasional bloating", "Possible light reflux"];
}

function buildUxSummary(record: AnalysisRecord, band: PhBand): string {
  if (band === "High") {
    return "This result suggests higher acidity, so your stomach may feel more sensitive. Pairing with food and hydration can help.";
  }
  if (band === "Low") {
    return "This result looks gentler overall. Comfort can still vary, so keep timing and hydration in mind.";
  }
  return "This result sits in a moderate range. Most people do fine, especially with food and slower sipping.";
}

function buildUxAdvisory(record: AnalysisRecord, band: PhBand): string {
  if (band === "High") {
    return "If you notice discomfort, reduce intake, drink after meals, and consider gentler instant options.";
  }
  if (band === "Low") {
    return "Even with a gentler profile, moderation and food pairing help maintain comfort.";
  }
  return "If you feel sensitivity, try drinking after meals and spacing cups through the day.";
}

function buildUxSafeTiming(record: AnalysisRecord): string {
  return record.stomachState === "Empty stomach"
    ? "Best after a meal or a snack to buffer acidity."
    : "Continue after meals for better comfort.";
}

function buildUxTips(record: AnalysisRecord, band: PhBand): string[] {
  const tips: string[] = [
    "Have coffee after meals whenever possible",
    "Stay hydrated: drink water alongside coffee",
  ];

  if ((record.cupsToday ?? 0) >= 2) {
    tips.push("Limit intake: keep it to fewer cups per day when possible");
  } else {
    tips.push("Keep portions moderate and sip slowly");
  }

  if (band === "High") {
    tips.push("Consider lower-acid instant options or decaf");
  } else if (band === "Low") {
    tips.push("This is a gentler profile, but moderation still helps");
  } else {
    tips.push("Pair with food to buffer acidity");
  }

  return tips.slice(0, 4);
}

function buildUxImpactItems(record: AnalysisRecord, band: PhBand): string[] {
  const impactItems: string[] = [];

  if (band === "High") {
    impactItems.push("Higher acidity can feel harsher on the stomach.");
  } else if (band === "Low") {
    impactItems.push("Lower acidity usually feels easier on digestion.");
  } else {
    impactItems.push("A mid-range acidity often leads to moderate effects.");
  }

  if (record.stomachState === "Empty stomach") {
    impactItems.push("An empty stomach can amplify discomfort.");
  } else if (record.stomachState === "After meal") {
    impactItems.push("Food can buffer acidity and reduce irritation.");
  }

  if ((record.cupsToday ?? 0) >= 2) {
    impactItems.push("Multiple cups can still add irritation over time.");
  }

  return impactItems.slice(0, 4);
}

function buildLlmFallbackNarrative(record: AnalysisRecord): AnalysisNarrative {
  const band = classifyPhBand(record.ph);
  return {
    summary: buildUxSummary(record, band),
    likelyEffectTitle: "Effects",
    likelyEffectItems: buildUxLikelyEffects(band),
    advisory: buildUxAdvisory(record, band),
    tips: buildUxTips(record, band),
    safeTiming: buildUxSafeTiming(record),
    impactItems: buildUxImpactItems(record, band),
    source: "llm",
    model: "fallback",
    generatedAt: new Date().toISOString(),
  };
}

function isUxSafeText(text: string): boolean {
  const patterns = [
    /\bph\b/i,
    /\bcups?\b/i,
    /risk level/i,
    /voltage/i,
    /sample(s)?/i,
    /stabilization/i,
    /\d/,
    /caffeine\s*rush/i,
    /alert(ness)?/i,
    /insomnia/i,
    /headache/i,
  ];
  return !patterns.some((pattern) => pattern.test(text));
}

function sanitizeLlmNarrative(narrative: AnalysisNarrative, record: AnalysisRecord): AnalysisNarrative {
  const band = classifyPhBand(record.ph);
  const nonDigestivePatterns = [
    /caffeine\s*rush/i,
    /alert(ness)?/i,
    /insomnia/i,
    /headache/i,
    /energy\s*boost/i,
  ];
  const measurementPatterns = [
    /\bph\b/i,
    /\bcups?\b/i,
    /risk level/i,
    /voltage/i,
    /sample(s)?/i,
    /stabilization/i,
    /\d/,
  ];
  const highPhMislabelPatterns = band === "Low"
    ? [/high\s*acidity/i, /highly\s*acidic/i, /high\s*pH/i]
    : [];

  const filteredEffects = filterOut(narrative.likelyEffectItems, [
    ...nonDigestivePatterns,
    ...measurementPatterns,
  ]);
  const filteredTips = filterOut(narrative.tips, [
    ...nonDigestivePatterns,
    ...highPhMislabelPatterns,
    ...measurementPatterns,
  ]);
  const filteredImpact = filterOut(narrative.impactItems, [
    ...nonDigestivePatterns,
    ...highPhMislabelPatterns,
    ...measurementPatterns,
  ]);

  const summary = isUxSafeText(narrative.summary)
    ? narrative.summary
    : buildUxSummary(record, band);

  const advisory = isUxSafeText(narrative.advisory)
    ? narrative.advisory
    : buildUxAdvisory(record, band);

  const safeTiming = isUxSafeText(narrative.safeTiming)
    ? narrative.safeTiming
    : buildUxSafeTiming(record);

  const forceLowAcidityCopy = band === "Low";

  return {
    ...narrative,
    summary,
    advisory,
    safeTiming,
    likelyEffectItems: forceLowAcidityCopy
      ? buildUxLikelyEffects(band)
      : padItems(filteredEffects, buildUxLikelyEffects(band)),
    tips: padItems(filteredTips, buildUxTips(record, band)),
    impactItems: forceLowAcidityCopy
      ? buildUxImpactItems(record, band)
      : padItems(filteredImpact, buildUxImpactItems(record, band)),
  };
}

function pickFirstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = toNonEmptyString(value[key]);
    if (candidate) return candidate;
  }
  return null;
}

function normalizeNarrative(data: unknown): AnalysisNarrative | null {
  let value: Record<string, unknown> | null = null;

  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") {
        value = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  } else if (data && typeof data === "object") {
    value = data as Record<string, unknown>;
  }

  if (!value) return null;

  const narrativeValue =
    value.narrative && typeof value.narrative === "object"
      ? (value.narrative as Record<string, unknown>)
      : value;

  const summary = pickFirstString(narrativeValue, ["summary", "Summary"]);
  const likelyEffectTitle = pickFirstString(narrativeValue, [
    "likelyEffectTitle",
    "likely_effect_title",
    "effectTitle",
    "effect_title",
  ]);
  const advisory = pickFirstString(narrativeValue, ["advisory", "advice"]);
  const safeTiming = pickFirstString(narrativeValue, ["safeTiming", "safe_timing", "timing"]);

  const likelyEffectItems = toStringArray(
    narrativeValue.likelyEffectItems ?? narrativeValue.likely_effect_items ?? narrativeValue.effects
  );
  const tips = toStringArray(narrativeValue.tips ?? narrativeValue.tipItems ?? narrativeValue.recommendations);
  const impactItems = toStringArray(
    narrativeValue.impactItems ?? narrativeValue.impact_items ?? narrativeValue.impacts
  );

  const normalizedSummary = summary ?? likelyEffectItems[0] ?? impactItems[0] ?? null;
  if (!normalizedSummary) {
    return null;
  }

  return {
    summary: normalizedSummary,
    likelyEffectTitle: likelyEffectTitle || "Effects",
    likelyEffectItems: likelyEffectItems.length > 0 ? likelyEffectItems : ["See summary for details"],
    advisory: advisory || "Consult health professionals if needed",
    tips: tips.length > 0 ? tips : ["Monitor your intake"],
    safeTiming: safeTiming || "As needed",
    impactItems: impactItems.length > 0 ? impactItems : ["Individual results may vary"],
    source: "llm",
    model: typeof value.model === "string" ? value.model : undefined,
    generatedAt:
      typeof value.generatedAt === "string" ? value.generatedAt : new Date().toISOString(),
  };
}

export function getNarrativeWithFallback(record: AnalysisRecord): AnalysisNarrative {
  if (record.narrative?.source === "llm") {
    return record.narrative;
  }

  return buildLlmFallbackNarrative(record);
}

export async function maybeEnrichAnalysisRecordWithLlm(
  record: AnalysisRecord
): Promise<AnalysisRecord> {
  if (record.narrative?.source === "llm") {
    return record;
  }

  try {
    const invokePromise = invokeAnalysisLlm({
      record: {
        coffeeType: record.coffeeType,
        ph: record.ph,
        classification: record.classification,
        riskLevel: record.riskLevel,
        stomachState: record.stomachState,
        cupsToday: record.cupsToday,
        stabilizationTimeSec: record.stabilizationTimeSec,
        averageVoltage: record.averageVoltage,
        samplesCollected: record.samplesCollected,
      },
    });

    const { data, error } = await withTimeout(invokePromise, 8000);
    if (error) {
      // Log detailed error information
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("LLM invocation failed:", {
        error: errorMsg,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }

    const narrative = normalizeNarrative(data);
    if (!narrative) {
      console.warn("LLM returned invalid narrative structure, falling back to rules", {
        keys: data && typeof data === "object" ? Object.keys(data as Record<string, unknown>) : typeof data,
      });
      const withFallback = { ...record, narrative: buildLlmFallbackNarrative(record) };
      await saveAnalysisRecord(withFallback);
      return withFallback;
    }

    const sanitizedNarrative = sanitizeLlmNarrative(narrative, record);

    const enriched = { ...record, narrative: sanitizedNarrative };
    await saveAnalysisRecord(enriched);
    return enriched;
  } catch (error) {
    const errorObj = error as any;
    const errorMsg = errorObj instanceof Error ? errorObj.message : String(errorObj);
    
    // Extract status code from various possible locations in FunctionsHttpError
    const statusCode = 
      errorObj?.statusCode ||
      errorObj?.status ||
      errorObj?.context?.status ||
      errorObj?.response?.status ||
      "unknown";

    const responseBody =
      errorObj?.context?.error ||
      errorObj?.context?.message ||
      errorObj?.response?._bodyText ||
      undefined;
    
    // Extract more context if available
    const errorContext = {
      error: errorMsg,
      statusCode,
      responseBody,
      timestamp: new Date().toISOString(),
      functionName: ANALYSIS_LLM_FUNCTION_NAME,
      coffeetype: record.coffeeType,
      ph: record.ph,
    };
    
    console.warn("maybeEnrichAnalysisRecordWithLlm falling back to rule-based narrative", errorContext);
    
    if (record.narrative) return record;

    const withFallback = { ...record, narrative: buildLlmFallbackNarrative(record) };
    await saveAnalysisRecord(withFallback);
    return withFallback;
  }
}
