import { ThemedText } from "@/components/themed-text";
import Colors from "@/constants/colors";
import { UserPreferencesStore } from "@/src/data/userPreferencesStore";
import { getStoredAnalysisHistory } from "@/src/store/analysisStore";
import { AnalysisRecord, normalizePHClassification } from "@/src/types/analysis";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { Image } from "expo-image";
import { router } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import Svg, { Circle, Defs, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from "react-native-svg";

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterOption = { label: string; days: number };

// ─── Constants ────────────────────────────────────────────────────────────────

const FILTER_OPTIONS: FilterOption[] = [
  { label: "Past 7 days",  days: 7    },
  { label: "Past 14 days", days: 14   },
  { label: "Past 30 days", days: 30   },
  { label: "Past 60 days", days: 60   },
  { label: "Past 90 days", days: 90   },
  { label: "All time",     days: 9999 },
];

const CLASSIFICATION_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  "High Acidity":     { bg: "#FCDEDE", text: "#8C1A1A", dot: "#E74C3C" },
  "Moderate Acidity": { bg: "#FEF0D6", text: "#7A4A00", dot: "#F39C12" },
  "Low Acidity":      { bg: "#DCF0E4", text: "#1A5C34", dot: "#27AE60" },
};

const RISK_COLORS: Record<string, { bg: string; text: string }> = {
  "High Risk":     { bg: "#FCDEDE", text: "#8C1A1A" },
  "Moderate Risk": { bg: "#FEF0D6", text: "#7A4A00" },
  "Low Risk":      { bg: "#DCF0E4", text: "#1A5C34" },
};

const BAR_COLORS = ["#8B5E3C", "#C4905A", "#7B9E87", "#5B7FA6", "#A67B9E", "#D4AF7A"];

const SCREEN_W = Dimensions.get("window").width;
const CHART_W  = SCREEN_W - 64; // card padding both sides

// ─── Helpers ──────────────────────────────────────────────────────────────────

function filterByDays(days: number, records: AnalysisRecord[]): AnalysisRecord[] {
  if (days === 9999) return records;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  return records.filter((e) => new Date(e.createdAt) >= cutoff);
}

function getCoffeeTypeAverages(entries: AnalysisRecord[]) {
  const map: Record<string, { sum: number; count: number }> = {};
  entries.forEach((e) => {
    if (!map[e.coffeeType]) map[e.coffeeType] = { sum: 0, count: 0 };
    map[e.coffeeType].sum   += e.ph;
    map[e.coffeeType].count += 1;
  });
  return Object.entries(map).map(([coffeeType, { sum, count }]) => ({
    coffeeType,
    averagePh: sum / count,
  }));
}

function getClassificationBreakdown(entries: AnalysisRecord[]) {
  const total = entries.length;
  if (!total) return [];
  const map: Record<string, number> = {};
  entries.forEach((e) => {
    const cls = normalizePHClassification(e.classification);
    map[cls] = (map[cls] || 0) + 1;
  });
  return Object.entries(map).map(([label, count]) => ({
    label,
    count,
    pct: Math.round((count / total) * 100),
  }));
}

function getHourBuckets(entries: AnalysisRecord[]) {
  const buckets = [
    { label: "12–4am", range: [0, 4]   as [number, number], count: 0 },
    { label: "4–8am",  range: [4, 8]   as [number, number], count: 0 },
    { label: "8–12pm", range: [8, 12]  as [number, number], count: 0 },
    { label: "12–4pm", range: [12, 16] as [number, number], count: 0 },
    { label: "4–8pm",  range: [16, 20] as [number, number], count: 0 },
    { label: "8–12am", range: [20, 24] as [number, number], count: 0 },
  ];
  entries.forEach((e) => {
    const h = new Date(e.createdAt).getHours();
    buckets.forEach((b) => { if (h >= b.range[0] && h < b.range[1]) b.count++; });
  });
  return buckets;
}

function getSummaryInsights(entries: AnalysisRecord[]): string[] {
  if (!entries.length) return ["No data available for this period."];
  const results = [];

  const acidic = entries.filter(
    (e) => e.classification === "Moderate Acidity" || e.classification === "High Acidity"
  );
  const pct  = Math.round((acidic.length / entries.length) * 100);
  results.push(`${pct}% of your entries were "Moderate Acidity" or "High Acidity".`);

  const risk = entries.filter(
    (e) => e.stomachState === "Empty stomach" && e.classification === "High Acidity"
  ).length;
  results.push(`"Empty stomach" + high acidity showed ${risk} higher-risk log${risk !== 1 ? "s" : ""}.`);

  // Time-gap logic: check for "new cup" frequency
  const newCups = [...entries]
    .filter((e) => e.isNewCup !== false)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  let rapidIntakeCount = 0;
  const GAP_THRESHOLD_MS = 90 * 60 * 1000; // 90 minutes

  for (let i = 1; i < newCups.length; i++) {
    const diff = new Date(newCups[i].createdAt).getTime() - new Date(newCups[i - 1].createdAt).getTime();
    if (diff > 0 && diff < GAP_THRESHOLD_MS) {
      rapidIntakeCount++;
    }
  }

  if (rapidIntakeCount > 0) {
    results.push(
      `Rapid intake alert: ${rapidIntakeCount} instance${rapidIntakeCount > 1 ? "s" : ""} of drinking coffee less than 90 mins apart. This can stack gastric irritation.`
    );
  }

  return results;
}

function getPatternInsights(entries: AnalysisRecord[]): string[] {
  if (!entries.length) return ["Not enough data for this period."];
  const avgPh = entries.reduce((s, e) => s + e.ph, 0) / entries.length;
  const highRisk   = entries.filter((e) => e.riskLevel === "High Risk").length;
  return [
    `Average pH across all entries: ${avgPh.toFixed(2)}.`,
    `Total entries analyzed in this period: ${entries.length}.`,
    `High risk entries: ${highRisk} out of ${entries.length}.`,
  ];
}

function getComparisonInsight(entries: AnalysisRecord[]): string[] {
  if (entries.length < 2) return ["Log one more analysis to compare your next result."];

  const latest = entries[entries.length - 1];
  const previous = entries[entries.length - 2];
  const delta = latest.ph - previous.ph;
  const direction = delta > 0 ? "milder" : delta < 0 ? "more acidic" : "about the same";
  const diffText = Math.abs(delta).toFixed(1);
  const prevRisk = previous.riskLevel ?? "Low Risk";
  const currentRisk = latest.riskLevel ?? "Low Risk";
  const riskText =
    currentRisk === prevRisk
      ? "risk stayed steady"
      : `risk shifted from ${prevRisk.toLowerCase()} to ${currentRisk.toLowerCase()}`;

  return [
    `This result is ${direction} than your previous one by ${diffText} pH.`,
    `Compared with your last entry, ${riskText}.`,
  ];
}

function getBestTimeInsight(entries: AnalysisRecord[]): string {
  if (!entries.length) return "No timing insight yet.";

  const buckets = getHourBuckets(entries).map((bucket) => {
    const matching = entries.filter((entry) => {
      const hour = new Date(entry.createdAt).getHours();
      return hour >= bucket.range[0] && hour < bucket.range[1];
    });

    const avgPh = matching.length
      ? matching.reduce((sum, entry) => sum + entry.ph, 0) / matching.length
      : 0;
    const highRisk = matching.filter((entry) => entry.riskLevel === "High Risk").length;

    return {
      ...bucket,
      avgPh,
      score: avgPh - highRisk * 0.35 + matching.length * 0.05,
    };
  });

  const best = buckets.sort((a, b) => b.score - a.score)[0];
  return best ? `${best.label} looks like your lowest-discomfort window so far.` : "No timing insight yet.";
}

// ─── Line Chart ───────────────────────────────────────────────────────────────

function LineChart({ entries }: { entries: AnalysisRecord[] }) {
  const data = entries.slice(-10).map((e) => ({
    label: new Date(e.createdAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    value: e.ph,
    cls:   normalizePHClassification(e.classification),
  }));

  if (!data.length) {
    return (
      <View style={s.emptyChart}>
        <ThemedText style={s.emptyText}>No data for this period</ThemedText>
      </View>
    );
  }

  const W = CHART_W, H = 140;
  const padL = 28, padR = 12, padT = 14, padB = 30;
  const minV = 4.0, maxV = 7.0;

  const toX = (i: number) => padL + (i / Math.max(data.length - 1, 1)) * (W - padL - padR);
  const toY = (v: number) => padT + (1 - (v - minV) / (maxV - minV)) * (H - padT - padB);

  const pts = data.map((d, i) => ({ ...d, x: toX(i), y: toY(d.value) }));

  const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(H - padB).toFixed(1)} L${pts[0].x.toFixed(1)},${(H - padB).toFixed(1)} Z`;
  const threshY  = toY(5.0);

  return (
    <View>
      <Svg width={W} height={H}>
        <Defs>
          <LinearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%"   stopColor="#8B5E3C" stopOpacity="0.25" />
            <Stop offset="100%" stopColor="#8B5E3C" stopOpacity="0.02" />
          </LinearGradient>
        </Defs>

        {/* threshold */}
        <Line x1={padL} y1={threshY} x2={W - padR} y2={threshY}
          stroke="#E74C3C" strokeWidth="1" strokeDasharray="4,3" opacity="0.5" />
        <SvgText x={W - padR - 2} y={threshY - 4} fontSize="8" fill="#E74C3C" textAnchor="end" opacity="0.7">
          pH 5.0
        </SvgText>

        {/* area */}
        <Path d={areaPath} fill="url(#lineGrad)" />

        {/* line */}
        <Path d={linePath} fill="none" stroke="#8B5E3C" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" />

        {/* dots */}
        {pts.map((p, i) => {
          const col = CLASSIFICATION_COLORS[p.cls]?.dot ?? "#8B5E3C";
          return (
            <React.Fragment key={i}>
              <Circle cx={p.x} cy={p.y} r="5"  fill="white" stroke={col} strokeWidth="2" />
              <Circle cx={p.x} cy={p.y} r="2.5" fill={col} />
            </React.Fragment>
          );
        })}

        {/* x labels every other */}
        {pts.map((p, i) =>
          i % 2 === 0 ? (
            <SvgText key={i} x={p.x} y={H - 5} fontSize="8" fill="#A08880" textAnchor="middle">
              {p.label}
            </SvgText>
          ) : null
        )}
      </Svg>

      {/* legend */}
      <View style={s.legendRow}>
        {Object.entries(CLASSIFICATION_COLORS).map(([label, { dot }]) => (
          <View key={label} style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: dot }]} />
            <ThemedText style={s.legendText}>{label}</ThemedText>
          </View>
        ))}
      </View>
    </View>
  );
}

// ─── Bar Chart ────────────────────────────────────────────────────────────────

function BarChart({ entries, expanded = false }: { entries: AnalysisRecord[]; expanded?: boolean }) {
  const typeAverages = getCoffeeTypeAverages(entries);

  if (!typeAverages.length) {
    return (
      <View style={s.emptyChart}>
        <ThemedText style={s.emptyText}>No data for this period</ThemedText>
      </View>
    );
  }

  const W     = expanded ? SCREEN_W - 64 : (SCREEN_W - 64) / 2 - 10;
  const H     = expanded ? 150 : 110;
  const padB  = expanded ? 42 : 34;
  const padT  = 16;
  const maxPh = 7;
  const n     = typeAverages.length;
  const barW  = expanded ? Math.min(44, (W - 20) / n - 10) : Math.min(28, (W - 12) / n - 6);

  return (
    <Svg width={W} height={H}>
      {typeAverages.map((item, i) => {
        const x    = 10 + i * ((W - 20) / n) + ((W - 20) / n - barW) / 2;
        const barH = (item.averagePh / maxPh) * (H - padB - padT);
        const y    = H - padB - barH;
        const col  = BAR_COLORS[i % BAR_COLORS.length];
        const words = item.coffeeType.split(" ");
        const fontSize = expanded ? 10 : 8;

        return (
          <React.Fragment key={i}>
            <Rect x={x} y={y} width={barW} height={barH} fill={col} rx="7" opacity="0.88" />
            <SvgText x={x + barW / 2} y={y - 4} fontSize={fontSize + 1} fill={col} textAnchor="middle" fontWeight="600">
              {item.averagePh.toFixed(1)}
            </SvgText>
            {words.map((word, wi) => (
              <SvgText key={wi} x={x + barW / 2} y={H - padB + 13 + wi * 11}
                fontSize={fontSize} fill="#7A675C" textAnchor="middle">
                {word}
              </SvgText>
            ))}
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

// ─── Donut Chart ──────────────────────────────────────────────────────────────

function DonutChart({ entries, showLegend = false }: { entries: AnalysisRecord[]; showLegend?: boolean }) {
  const breakdown = getClassificationBreakdown(entries);
  if (!breakdown.length) return null;

  const size   = showLegend ? 110 : 80;
  const cx     = size / 2;
  const cy     = size / 2;
  const r      = showLegend ? 42 : 30;
  const strokeW = showLegend ? 16 : 12;
  const circumference = 2 * Math.PI * r;
  const total = entries.length;

  let offset = 0;
  const slices = breakdown.map((item) => {
    const dash  = (item.pct / 100) * circumference;
    const gap   = circumference - dash;
    const slice = {
      ...item,
      dash,
      gap,
      dashOffset: -(offset / 100) * circumference - circumference / 4,
      color: CLASSIFICATION_COLORS[item.label]?.dot ?? "#8B5E3C",
    };
    offset += item.pct;
    return slice;
  });

  return (
    <View style={showLegend ? s.donutRowExpanded : s.donutRowCompact}>
      <Svg width={size} height={size}>
        <Circle cx={cx} cy={cy} r={r} fill="none" stroke="#F4EEEA" strokeWidth={strokeW} />
        {slices.map((sl, i) => (
          <Circle key={i} cx={cx} cy={cy} r={r} fill="none"
            stroke={sl.color} strokeWidth={strokeW}
            strokeDasharray={`${sl.dash} ${sl.gap}`}
            strokeDashoffset={sl.dashOffset}
          />
        ))}
        <SvgText x={cx} y={cy - 4} textAnchor="middle" fontSize={showLegend ? 18 : 13} fontWeight="700" fill="#3C2C24">
          {total}
        </SvgText>
        <SvgText x={cx} y={cy + (showLegend ? 10 : 8)} textAnchor="middle" fontSize={showLegend ? 9 : 7} fill="#A08880">
          total
        </SvgText>
      </Svg>

      {showLegend && (
        <View style={s.donutLegend}>
          {slices.map((sl, i) => (
            <View key={i} style={s.donutLegendItem}>
              <View style={[s.donutDot, { backgroundColor: sl.color }]} />
              <View>
                <ThemedText style={s.donutPct}>{sl.pct}%</ThemedText>
                <ThemedText style={s.donutLabel}>{sl.label}</ThemedText>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Hour Heatmap ─────────────────────────────────────────────────────────────

function HourHeatmap({ entries }: { entries: AnalysisRecord[] }) {
  const buckets = getHourBuckets(entries);
  const max = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <View style={s.heatmapRow}>
      {buckets.map((b, i) => {
        const intensity = b.count / max;
        // interpolate from #F4EEEA → #4A3728
        const r = Math.round(244 - intensity * (244 - 74));
        const g = Math.round(238 - intensity * (238 - 55));
        const bC = Math.round(234 - intensity * (234 - 40));
        const bg = `rgb(${r},${g},${bC})`;
        const textColor = intensity > 0.55 ? "#FFF" : "#8B5E3C";
        return (
          <View key={i} style={s.heatmapCell}>
            <View style={[s.heatmapBox, { backgroundColor: bg }]}>
              <ThemedText style={[s.heatmapCount, { color: textColor }]}>{b.count}</ThemedText>
            </View>
            <ThemedText style={s.heatmapLabel}>{b.label}</ThemedText>
          </View>
        );
      })}
    </View>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

type AccentKey = "cream" | "warm" | "sage" | "slate" | "peach";

const CARD_ACCENTS: Record<AccentKey, { bg: string; border: string }> = {
  cream: { bg: "#FFFAF7", border: "#EDE3DC" },
  warm:  { bg: "#FDF6F0", border: "#E8D5C4" },
  sage:  { bg: "#F2F8F4", border: "#C8DFCE" },
  slate: { bg: "#F2F5F8", border: "#C8D4DF" },
  peach: { bg: "#FDF5EE", border: "#EDD8C5" },
};

function Card({
  title,
  accent = "cream",
  children,
}: {
  title?: string;
  accent?: AccentKey;
  children: React.ReactNode;
}) {
  const col = CARD_ACCENTS[accent];
  return (
    <View style={[s.card, { backgroundColor: col.bg, borderColor: col.border }]}>
      {title && (
        <View style={s.cardHeader}>
          <ThemedText style={s.cardTitle}>{title}</ThemedText>
          <Ionicons name="ellipsis-horizontal" size={18} color="#C4A882" />
        </View>
      )}
      {children}
    </View>
  );
}

// ─── Stat Pill ────────────────────────────────────────────────────────────────

type PillColor = "brown" | "blue" | "red";

const PILL_PALETTE: Record<PillColor, { bg: string; value: string; sub: string }> = {
  brown: { bg: "#EDE0D8", value: "#3C2418", sub: "#8B6A55" },
  blue:  { bg: "#DAE8F7", value: "#1A3F6C", sub: "#3A6FAA" },
  red:   { bg: "#FCDEDE", value: "#8C1A1A", sub: "#C04040" },
};

function StatPill({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color: PillColor;
}) {
  const p = PILL_PALETTE[color];
  return (
    <View style={[s.statPill, { backgroundColor: p.bg }]}>
      <ThemedText style={[s.statLabel, { color: p.sub }]}>{label}</ThemedText>
      <ThemedText style={[s.statValue, { color: p.value }]}>{value}</ThemedText>
      {sub && <ThemedText style={[s.statSub, { color: p.sub }]}>{sub}</ThemedText>}
    </View>
  );
}

// ─── Filter Dropdown ──────────────────────────────────────────────────────────

function FilterDropdown({
  selected,
  onSelect,
}: {
  selected: FilterOption;
  onSelect: (opt: FilterOption) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <View style={{ zIndex: 100 }}>
      <TouchableOpacity
        style={s.filterChip}
        onPress={() => setOpen((v) => !v)}
        activeOpacity={0.8}
      >
        <Ionicons name="calendar-outline" size={15} color="#FFF" />
        <ThemedText style={s.filterChipText}>{selected.label}</ThemedText>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={13} color="#FFF" />
      </TouchableOpacity>

      {open && (
        <>
          <Pressable style={s.backdrop} onPress={() => setOpen(false)} />
          <View style={s.dropdownPanel}>
            {FILTER_OPTIONS.map((opt) => {
              const active = opt.days === selected.days;
              return (
                <TouchableOpacity
                  key={opt.days}
                  style={[s.dropdownItem, active && s.dropdownItemActive]}
                  onPress={() => { onSelect(opt); setOpen(false); }}
                  activeOpacity={0.7}
                >
                  <ThemedText style={[s.dropdownItemText, active && s.dropdownItemTextActive]}>
                    {opt.label}
                  </ThemedText>
                  {active && <Ionicons name="checkmark" size={15} color="#FFF" />}
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const [records, setRecords] = useState<AnalysisRecord[]>([]);
  const [preferences, setPreferences] = useState(UserPreferencesStore.get());
  const [selectedFilter, setSelectedFilter] = useState<FilterOption>(
    FILTER_OPTIONS.find((f) => f.days === 30)!
  );

  const loadRecords = React.useCallback(async () => {
    const stored = await getStoredAnalysisHistory();
    const sortedOldestFirst = [...stored].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    setRecords(sortedOldestFirst);
  }, []);

  useEffect(() => {
    let mounted = true;

    void UserPreferencesStore.load();
    setPreferences(UserPreferencesStore.get());
    const unsubscribe = UserPreferencesStore.subscribe(setPreferences);
    
    void loadRecords();

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [loadRecords]);

  useFocusEffect(
    React.useCallback(() => {
      void loadRecords();
    }, [loadRecords])
  );

  const filteredEntries  = useMemo(
    () => filterByDays(selectedFilter.days, records),
    [selectedFilter, records]
  );
  const summaryInsights  = useMemo(() => getSummaryInsights(filteredEntries), [filteredEntries]);
  const patternInsights  = useMemo(() => getPatternInsights(filteredEntries), [filteredEntries]);
  const comparisonInsights = useMemo(() => getComparisonInsight(filteredEntries), [filteredEntries]);
  const bestTimeInsight = useMemo(() => getBestTimeInsight(filteredEntries), [filteredEntries]);

  const totalScans = filteredEntries.length;
  const avgPh      = totalScans
    ? (filteredEntries.reduce((sum, e) => sum + e.ph, 0) / totalScans).toFixed(2)
    : "—";
  const highRisk   = filteredEntries.filter((e) => e.riskLevel === "High Risk").length;
  const latest     = filteredEntries.length > 0 ? filteredEntries[filteredEntries.length - 1] : null;
  const contrastColor = preferences.highContrastEnabled ? "#1A1411" : undefined;

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={s.contentContainer}
      showsVerticalScrollIndicator={false}
    >
      {/* ── Header ── */}
      <View style={s.header}>
        <View style={s.headerMiddle}>
          <ThemedText
            style={s.title}
            lightColor={Colors.light.text}
            darkColor={Colors.light.text}
          >
            dashboard.
          </ThemedText>
          <ThemedText
            style={s.subtitle}
            lightColor={Colors.light.text}
            darkColor={Colors.light.text}
          >
            your coffee stats
          </ThemedText>
        </View>
      </View>

      {/* ── Filter ── */}
      <View style={s.filterRow}>
        <FilterDropdown selected={selectedFilter} onSelect={setSelectedFilter} />
      </View>

      {/* ── Stat pills ── */}
      <View style={s.pillRow}>
        <StatPill label="Total Scans" value={totalScans} sub="this period" color="brown" />
        <StatPill label="Avg pH" value={avgPh} sub="overall" color="blue" />
        <StatPill label="High Risk" value={highRisk}
          sub={`${totalScans ? Math.round((highRisk / totalScans) * 100) : 0}% of logs`}
          color="red" />
      </View>

      {/* ── Line chart ── */}
      <Card title="Acidity Trend" accent="cream">
        <LineChart entries={filteredEntries} />
      </Card>

      {/* ── Acidity Breakdown ── */}
      <Card title="Acidity Breakdown" accent="cream">
        <DonutChart entries={filteredEntries} showLegend />
      </Card>

      {/* ── Summary Insights ── */}
      <Card title="Summary Insights" accent="peach">
        {summaryInsights.map((item, i) => (
          <View key={i} style={s.bulletRow}>
            <View style={s.bullet} />
            <ThemedText style={s.bulletText}>{item}</ThemedText>
          </View>
        ))}
      </Card>

      {/* ── Hour Heatmap ── */}
      <Card title="When you drink coffee" accent="sage">
        <HourHeatmap entries={filteredEntries} />
      </Card>

      {/* ── Patterns & Insights ── */}
      <Card title="Patterns & Insights" accent="warm">
        {patternInsights.map((item, i) => (
          <View key={i} style={[
            s.patternRow,
            i < patternInsights.length - 1 && s.patternRowBorder,
          ]}>
            <ThemedText style={s.patternIcon}>
              {i === 0 ? "⚗️" : i === 1 ? "☕" : "⚠️"}
            </ThemedText>
            <ThemedText style={s.bulletText}>{item}</ThemedText>
          </View>
        ))}
      </Card>

      {/* ── Compare + timing ── */}
      <Card title="Compare with Last Result" accent="slate">
        {comparisonInsights.map((item, i) => (
          <View key={i} style={[s.bulletRow, i > 0 && { marginTop: 8 }]}>
            <View style={s.bullet} />
            <ThemedText style={[s.bulletText, contrastColor ? { color: contrastColor } : null]}>{item}</ThemedText>
          </View>
        ))}
      </Card>

      <Card title="Best Time for Low Discomfort" accent="sage">
        <View style={s.bestTimeCard}>
          <Ionicons name="time-outline" size={18} color="#5B7FA6" />
          <ThemedText style={[s.bestTimeText, contrastColor ? { color: contrastColor } : null]}>
            {bestTimeInsight}
          </ThemedText>
        </View>
      </Card>

      {/* ── View History button ── */}
      <TouchableOpacity 
        style={s.historyButton} 
        activeOpacity={0.85}
        onPress={() => router.push("/(tabs)/history")}
      >
        <View style={s.historyLeft}>
          <View style={s.historyIconCircle}>
            <Ionicons name="time-outline" size={15} color="#FFF" />
          </View>
          <ThemedText style={s.historyText}>View Analysis History</ThemedText>
        </View>
        <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.6)" />
      </TouchableOpacity>

      {/* ── Latest entry ── */}
      {latest && (
        <View style={s.latestCard}>
          <ThemedText style={s.latestMeta}>Latest entry</ThemedText>
          <ThemedText style={s.latestDate}>
            {new Date(latest.createdAt).toLocaleString("en-US", {
              month: "short", day: "numeric",
              hour: "2-digit", minute: "2-digit",
            })}
          </ThemedText>
          <View style={s.tagRow}>
            {([
              { label: latest.coffeeType,     type: "plain" },
              { label: `pH ${latest.ph}`,     type: "plain" },
              { label: normalizePHClassification(latest.classification), type: "cls" },
              { label: latest.riskLevel,      type: "risk"  },
            ] as const).map((tag, i) => {
              let bg = "#F4EEEA", color = "#6F5A4F";
              if (tag.type === "cls" && typeof tag.label === "string" && tag.label in CLASSIFICATION_COLORS) {
                bg    = CLASSIFICATION_COLORS[tag.label as keyof typeof CLASSIFICATION_COLORS].bg;
                color = CLASSIFICATION_COLORS[tag.label as keyof typeof CLASSIFICATION_COLORS].text;
              } else if (tag.type === "risk" && typeof tag.label === "string" && tag.label in RISK_COLORS) {
                bg    = RISK_COLORS[tag.label as keyof typeof RISK_COLORS].bg;
                color = RISK_COLORS[tag.label as keyof typeof RISK_COLORS].text;
              }
              return (
                <View key={i} style={[s.tag, { backgroundColor: bg }]}>
                  <ThemedText style={[s.tagText, { color }]}>{tag.label}</ThemedText>
                </View>
              );
            })}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.light.background },
  contentContainer: { paddingBottom: 40 },

  // header
  header: {
    flexDirection: "row", 
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16, 
    paddingTop: 50, 
    paddingBottom: 14,
    backgroundColor: Colors.light.background,
  },
  headerMiddle: { flex: 1, alignItems: "center", justifyContent: "center" },
  title: {
    fontSize: 18,
    fontWeight: "700",
    lineHeight: 20,
    textAlign: "center",
    paddingTop: 1,
    color: Colors.light.text,
  },
  subtitle: {
    fontSize: 12,
    opacity: 0.6,
    textAlign: "center",
    color: Colors.light.text,
  },

  // filter
  filterRow: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 4, zIndex: 100 },
  filterChip: {
    alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#4A3728", borderRadius: 24,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  filterChipText: { color: "#FFF", fontSize: 13, fontWeight: "600" },
  backdrop: {
    position: "absolute", top: 0, left: -1000, right: -1000, bottom: -2000, zIndex: 99,
  },
  dropdownPanel: {
    position: "absolute", top: 46, left: 0,
    backgroundColor: "#FFF", borderRadius: 18, paddingVertical: 6,
    minWidth: 190,
    shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 }, elevation: 10, zIndex: 200,
    borderWidth: 1, borderColor: "#EDE3DC",
  },
  dropdownItem: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, marginHorizontal: 6,
  },
  dropdownItemActive:     { backgroundColor: "#4A3728" },
  dropdownItemText:       { fontSize: 14, color: "#3C2C24", fontWeight: "500" },
  dropdownItemTextActive: { color: "#FFF", fontWeight: "700" },

  // stat pills
  pillRow: {
    flexDirection: "row", gap: 8,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4,
  },
  statPill: { flex: 1, borderRadius: 16, padding: 14 },
  statLabel: { fontSize: 9, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  statValue: { fontSize: 22, fontWeight: "700", lineHeight: 26 },
  statSub:   { fontSize: 9, marginTop: 2 },

  // card
  card: {
    borderRadius: 20, borderWidth: 1,
    padding: 16, marginHorizontal: 16, marginTop: 14,
  },
  cardHeader: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "space-between", marginBottom: 14,
  },
  cardTitle: { fontSize: 14, fontWeight: "700", color: "#2E211B" },

  // split row
  splitRow: { flexDirection: "row", gap: 10, marginHorizontal: 16, marginTop: 14 },
  splitCard: {
    flex: 1, borderRadius: 20, borderWidth: 1, padding: 14, overflow: "hidden",
  },
  splitCardFull:  { flex: 1 },  // takes full width when sibling is gone
  splitCardLeft:  { backgroundColor: "#FFFAF7", borderColor: "#EDE3DC" },
  splitCardRight: { backgroundColor: "#FFFAF7", borderColor: "#EDE3DC" },
  splitCardHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },

  // charts
  emptyChart: { height: 100, alignItems: "center", justifyContent: "center" },
  emptyText:  { fontSize: 13, color: "#A08880", fontStyle: "italic" },

  legendRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 10 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot:  { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 10, color: "#7A675C" },

  donutRowCompact:  { alignItems: "center" },
  donutRowExpanded: { flexDirection: "row", alignItems: "center", gap: 12 },
  donutRow:         { flexDirection: "row", alignItems: "center", gap: 12 },
  donutLegend:    { flexDirection: "column", gap: 8 },
  donutLegendItem:{ flexDirection: "row", alignItems: "center", gap: 8 },
  donutDot:       { width: 10, height: 10, borderRadius: 3 },
  donutPct:       { fontSize: 12, fontWeight: "600", color: "#3C2C24" },
  donutLabel:     { fontSize: 10, color: "#A08880", lineHeight: 14 },

  heatmapRow:  { flexDirection: "row", gap: 6 },
  heatmapCell: { flex: 1, alignItems: "center" },
  heatmapBox: {
    width: "100%", height: 40, borderRadius: 8,
    alignItems: "center", justifyContent: "center",
  },
  heatmapCount: { fontSize: 13, fontWeight: "600" },
  heatmapLabel: { fontSize: 9, color: "#A08880", marginTop: 4, textAlign: "center", lineHeight: 12 },

  // bullets / patterns
  bulletRow:  { flexDirection: "row", alignItems: "flex-start", marginTop: 10 },
  bullet:     { width: 6, height: 6, borderRadius: 3, backgroundColor: "#C4905A", marginTop: 8, marginRight: 10 },
  bulletText: { flex: 1, fontSize: 13, lineHeight: 20, color: "#3A2B24" },

  patternRow:       { flexDirection: "row", alignItems: "flex-start", paddingVertical: 10, gap: 10 },
  patternRowBorder: { borderBottomWidth: 1, borderBottomColor: "#E8D5C4" },
  patternIcon:      { fontSize: 14, marginTop: 2 },
  bestTimeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  bestTimeText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 20,
    color: "#3A2B24",
  },

  // history button
  historyButton: {
    backgroundColor: "#4A3728", borderRadius: 18,
    paddingHorizontal: 18, paddingVertical: 16, marginHorizontal: 16, marginTop: 14,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  historyLeft:      { flexDirection: "row", alignItems: "center" },
  historyIconCircle:{
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center", justifyContent: "center", marginRight: 10,
  },
  historyText: { fontSize: 14, fontWeight: "600", color: "#FFF" },

  // latest entry
  latestCard: {
    backgroundColor: "#FFF", borderRadius: 18,
    borderWidth: 1, borderColor: "#EDE3DC",
    padding: 16, marginHorizontal: 16, marginTop: 14,
  },
  latestMeta: { fontSize: 9, color: "#A08880", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 },
  latestDate: { fontSize: 13, color: "#6F5E55", lineHeight: 20 },
  tagRow:     { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  tag:        { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  tagText:    { fontSize: 11, fontWeight: "600" },
});
