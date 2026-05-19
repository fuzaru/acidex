// @ts-nocheck
// Deploy with Supabase Edge Functions and set GROQ_API_KEY in function secrets.
// Optional: set GROQ_MODEL, otherwise llama-3.1-8b-instant is used.

type AnalysisInput = {
  coffeeType?: string;
  ph?: number;
  classification?: string;
  riskLevel?: string;
  stomachState?: string;
  cupsToday?: number;
  stabilizationTimeSec?: number;
  averageVoltage?: number;
  samplesCollected?: number;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeNarrative(data: unknown) {
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

  const summary =
    toNonEmptyString(narrativeValue.summary) ??
    toNonEmptyString(narrativeValue.Summary) ??
    toNonEmptyString(narrativeValue.message);

  if (!summary) return null;

  return {
    summary,
    likelyEffectTitle:
      toNonEmptyString(narrativeValue.likelyEffectTitle) ??
      toNonEmptyString(narrativeValue.likely_effect_title) ??
      toNonEmptyString(narrativeValue.effectTitle) ??
      "Effects",
    likelyEffectItems: toStringArray(
      narrativeValue.likelyEffectItems ?? narrativeValue.likely_effect_items ?? narrativeValue.effects
    ),
    advisory:
      toNonEmptyString(narrativeValue.advisory) ??
      toNonEmptyString(narrativeValue.advice) ??
      "Consult health professionals if needed",
    tips: toStringArray(narrativeValue.tips ?? narrativeValue.tipItems ?? narrativeValue.recommendations),
    safeTiming:
      toNonEmptyString(narrativeValue.safeTiming) ??
      toNonEmptyString(narrativeValue.safe_timing) ??
      toNonEmptyString(narrativeValue.timing) ??
      "As needed",
    impactItems: toStringArray(
      narrativeValue.impactItems ?? narrativeValue.impact_items ?? narrativeValue.impacts
    ),
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const groqApiKey = Deno.env.get("GROQ_API_KEY");
    if (!groqApiKey) {
      throw new Error("GROQ_API_KEY is not configured.");
    }

    const model = Deno.env.get("GROQ_MODEL") || "llama-3.1-8b-instant";
    const { record } = (await request.json()) as { record?: AnalysisInput };
    if (!record) {
      return Response.json({ error: "Missing record payload." }, { status: 400, headers: corsHeaders });
    }

    const inputText = [
      "You are a coffee science expert providing digestive guidance for an app that analyzes INSTANT COFFEE ONLY.",
      "Strictly base your assessment on the measured pH: < 4.7 is Highly Acidic, 4.7-5.3 is Moderate, and > 5.3 is Low Acidity/Gentle.",
      "High pH means lower acidity. Never describe high pH as high acidity.",
      "Do NOT use terms like 'High acidity concentration' if the pH is above 5.0.",
      "Do NOT suggest switching to 'brewed coffee' or 'filtered coffee'. Focus on instant coffee alternatives (low-acid brands, decaf) or behavioral changes (timing, hydration).",
      "Avoid overly severe warnings like 'sharp gastric irritation' for standard instant coffee pH levels (around 4.8-5.0).",
      "Avoid non-digestive effects (no caffeine rush, alertness, insomnia, or headache) unless explicitly tied to stomach sensitivity.",
      "Do not mention voltage, sample counts, stabilization time, or any raw numeric values (pH, cups). Use qualitative phrasing only.",
      "Use only the provided measurements. Do not invent medical diagnoses.",
      "Keep the tone concise and practical.",
      "Return valid JSON only.",
      "Required keys: summary, likelyEffectTitle, likelyEffectItems, advisory, tips, safeTiming, impactItems.",
      "Instruction for likelyEffectItems: List potential physical sensations or digestive outcomes (e.g., 'Heartburn', 'Bloating').",
      "Instruction for impactItems: List specific reasons why this reading is risky or safe (e.g., 'Low pH level', 'Lack of food buffer').",
      "likelyEffectItems, tips, and impactItems must be arrays of strings.",
      "",
      `Coffee type: ${record.coffeeType ?? "Unknown"}`,
      `pH: ${record.ph ?? "Unknown"}`,
      `Classification: ${record.classification ?? "Unknown"}`,
      `Risk level: ${record.riskLevel ?? "Unknown"}`,
      `Stomach state: ${record.stomachState ?? "Unknown"}`,
      `Cups today: ${record.cupsToday ?? "Unknown"}`,
      "Stabilization time: (provided)",
      "Average voltage: (provided)",
      "Samples collected: (provided)",
    ].join("\n");

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: inputText,
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const message = `Groq request failed: ${response.status} ${errorText}`;
      return Response.json(
        {
          error: message,
          upstreamStatus: response.status,
        },
        { status: 502, headers: corsHeaders }
      );
    }

    const payload = await response.json();
    const outputText = payload?.choices?.[0]?.message?.content;
    if (!outputText || typeof outputText !== "string") {
      throw new Error("Groq response did not include valid content.");
    }

    const narrative = normalizeNarrative(outputText);
    if (!narrative) {
      throw new Error("Groq response did not match the required narrative structure.");
    }

    return Response.json(
      {
        ...narrative,
        model,
        generatedAt: new Date().toISOString(),
      },
      { headers: corsHeaders }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown LLM analysis error.";
    return Response.json(
      {
        error: message,
      },
      { status: 500, headers: corsHeaders }
    );
  }
});
