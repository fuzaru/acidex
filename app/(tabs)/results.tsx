import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
    Animated,
    DimensionValue,
    Modal,
    Pressable,
    ScrollView,
    Share,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";

import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import Colors from "@/constants/colors";
import { BookmarkStore } from "@/src/data/bookmarkStore";
import { CollectionStore } from "@/src/data/collectionStore";
import { UserPreferencesStore } from "@/src/data/userPreferencesStore";
import {
    getNarrativeWithFallback,
} from "@/src/services/aiAnalysisService";
import { buildRuleBasedNarrative } from "@/src/services/analysisService";
import { shareAnalysisPdf } from "@/src/services/exportService";
import { syncHistoryRecordToSupabase } from "@/src/services/historySync";
import { getLatestCachedAnalysis, getLatestStoredAnalysis, getStoredAnalysisHistory, saveAnalysisRecord } from "@/src/store/analysisStore";
import { AnalysisNarrative, AnalysisRecord } from "@/src/types/analysis";

const CLASSIFICATION_COLORS = {
  "Highly Acidic": { bg: "#FCDEDE", text: "#8C1A1A", badge: "#E74C3C" },
  Moderate: { bg: "#FEF0D6", text: "#7A4A00", badge: "#F39C12" },
  "Low Acidic": { bg: "#DCF0E4", text: "#1A5C34", badge: "#27AE60" },
} as const;

const RISK_COLORS = {
  "High Risk": { bg: "#FCDEDE", text: "#8C1A1A" },
  "Moderate Risk": { bg: "#FEF0D6", text: "#7A4A00" },
  "Low Risk": { bg: "#DCF0E4", text: "#1A5C34" },
} as const;

const UX_DISCLAIMER_TEXT =
  "For awareness only, not medical care. This is not a diagnosis or treatment plan. For reflux, GERD, or dental concerns, consult a qualified healthcare professional.";

type ToastType = "save" | "bookmark" | "unbookmark";

const TOAST_CONFIG: Record<
  ToastType,
  { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string; border: string; label: string }
> = {
  save: {
    icon: "checkmark-circle-outline",
    color: "#27AE60",
    bg: "#DCF0E4",
    border: "#C8DFCE",
    label: "notes saved",
  },
  bookmark: {
    icon: "bookmark",
    color: "#4A3728",
    bg: "#FFFAF7",
    border: "#EDE3DC",
    label: "bookmarked",
  },
  unbookmark: {
    icon: "bookmark-outline",
    color: "#A08880",
    bg: "#F4EEEA",
    border: "#E0D5CC",
    label: "bookmark removed",
  },
};

function getTipRows(item: AnalysisRecord, texts: string[]) {
  return [
    { icon: "food", text: texts[0] ?? "Have coffee after meals whenever possible" },
    { icon: "cup-water", text: texts[1] ?? "Stay hydrated: drink water alongside coffee" },
    { icon: "coffee-outline", text: texts[2] ?? "Limit intake: keep it to 1-2 cups per day" },
    {
      icon: "coffee-maker-outline",
      text:
        texts[3] ??
        (item.classification === "Highly Acidic"
          ? "Switch to lower-acidity instant options or decaf"
          : "Avoid drinking coffee too quickly to reduce irritation"),
    },
  ];
}

function getScalePct(item: AnalysisRecord): number {
  const clamped = Math.max(4.0, Math.min(6.0, item.ph));
  return ((6.0 - clamped) / 2.0) * 100;
}

function isDefaultCoffeeName(value?: string): boolean {
  if (!value) return false;
  return /^Sample\s+\d+$/i.test(value.trim());
}

function getAcidityFactorItems(item: AnalysisRecord): string[] {
  const factors: string[] = [
    `Instant coffee product/brand (${item.coffeeType})`,
    "Coffee-to-water ratio (how concentrated you mix it)",
    "Serving size and how many cups you drink",
  ];

  if (item.stomachState === "Empty stomach") {
    factors.push("Empty stomach can increase perceived irritation");
  } else if (item.stomachState === "After meal") {
    factors.push("Having coffee after a meal can reduce irritation");
  }

  if ((item.cupsToday ?? 0) >= 2) {
    factors.push("Multiple cups increase total acid exposure");
  }

  return factors.slice(0, 4);
}

function Toast({ visible, type }: { visible: boolean; type: ToastType }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(10)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          speed: 22,
          bounciness: 5,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 8,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY, visible]);

  const config = TOAST_CONFIG[type];

  return (
    <Animated.View
      style={[
        r.toast,
        {
          opacity,
          transform: [{ translateY }],
          backgroundColor: config.bg,
          borderColor: config.border,
        },
      ]}
    >
      <Ionicons name={config.icon} size={15} color={config.color} />
      <ThemedText style={[r.toastText, { color: config.color }]}>
        {config.label}
      </ThemedText>
    </Animated.View>
  );
}

function SectionCard({
  title,
  accent = "cream",
  children,
  trailing,
}: {
  title: string;
  accent?: "cream" | "warm" | "sage" | "slate" | "peach";
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const accentMap = {
    cream: { bg: "#FFFAF7", border: "#EDE3DC" },
    warm: { bg: "#FDF6F0", border: "#E8D5C4" },
    sage: { bg: "#F2F8F4", border: "#C8DFCE" },
    slate: { bg: "#F2F5F8", border: "#C8D4DF" },
    peach: { bg: "#FDF5EE", border: "#EDD8C5" },
  } as const;

  const col = accentMap[accent];

  return (
    <View style={[r.card, { backgroundColor: col.bg, borderColor: col.border }]}>
      <View style={r.cardHeader}>
        <ThemedText style={r.cardTitle}>{title}</ThemedText>
        {trailing ?? null}
      </View>
      {children}
    </View>
  );
}

function InnerBlock({ children }: { children: React.ReactNode }) {
  return <View style={r.innerBlock}>{children}</View>;
}

function BulletItem({ text }: { text: string }) {
  return (
    <View style={r.bulletRow}>
      <View style={r.bullet} />
      <ThemedText style={r.bulletText}>{text}</ThemedText>
    </View>
  );
}

function Tag({ label, bg, color }: { label: string; bg: string; color: string }) {
  return (
    <View style={[r.tag, { backgroundColor: bg }]}>
      <ThemedText style={[r.tagText, { color }]}>{label}</ThemedText>
    </View>
  );
}

function SkeletonLine({ width = "100%", height = 12, marginTop = 0 }: { width?: DimensionValue; height?: number; marginTop?: number }) {
  return <View style={[r.skeletonLine, { width, height, marginTop }]} />;
}

function ResultsSkeleton() {
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 700,
          useNativeDriver: true,
        }),
      ])
    );

    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View style={[r.skeletonWrap, { opacity: pulse }]}
    >
      <View style={r.skeletonCard}>
        <View style={r.skeletonCardHeader}>
          <SkeletonLine width={110} height={16} />
          <SkeletonLine width={18} height={18} />
        </View>
        <View style={r.skeletonInner}>
          <View style={r.skeletonSummaryTop}>
            <View style={r.skeletonCircle} />
            <View style={r.skeletonSummaryRight}>
              <SkeletonLine width={120} height={16} />
              <SkeletonLine width={165} height={14} marginTop={8} />
              <SkeletonLine width={92} height={20} marginTop={8} />
            </View>
          </View>
          <View style={r.skeletonScale}>
            <SkeletonLine width="100%" height={12} />
            <View style={r.skeletonScaleLabels}>
              <SkeletonLine width={58} height={10} />
              <SkeletonLine width={58} height={10} />
            </View>
          </View>
          <SkeletonLine width="90%" height={12} />
          <SkeletonLine width="76%" height={12} marginTop={8} />
          <SkeletonLine width="64%" height={12} marginTop={8} />
        </View>
        <View style={r.skeletonTagsRow}>
          <SkeletonLine width={72} height={22} />
          <SkeletonLine width={88} height={22} />
        </View>
      </View>

      <View style={r.skeletonCard}>
        <View style={r.skeletonCardHeader}>
          <SkeletonLine width={70} height={16} />
          <SkeletonLine width={18} height={18} />
        </View>
        <View style={r.skeletonInner}>
          <SkeletonLine width="95%" height={12} />
          <SkeletonLine width="70%" height={12} marginTop={10} />
          <View style={r.skeletonActionRow}>
            <SkeletonLine width={76} height={26} />
          </View>
        </View>
      </View>

      <View style={r.skeletonCard}>
        <View style={r.skeletonCardHeader}>
          <SkeletonLine width={150} height={16} />
        </View>
        <View style={r.skeletonInner}>
          <SkeletonLine width="88%" height={12} />
          <SkeletonLine width="78%" height={12} marginTop={8} />
          <SkeletonLine width="68%" height={12} marginTop={8} />
        </View>
      </View>

      <View style={r.skeletonCard}>
        <View style={r.skeletonCardHeader}>
          <SkeletonLine width={180} height={16} />
        </View>
        <View style={r.skeletonInner}>
          {[0, 1, 2].map((index) => (
            <View key={index} style={r.skeletonTipRow}>
              <View style={r.skeletonTipIcon} />
              <View style={r.skeletonTipTextWrap}>
                <SkeletonLine width="92%" height={12} />
                <SkeletonLine width="80%" height={12} marginTop={8} />
              </View>
            </View>
          ))}
        </View>
      </View>

      <View style={r.skeletonCard}>
        <View style={r.skeletonCardHeader}>
          <SkeletonLine width={130} height={16} />
        </View>
        <View style={r.skeletonInner}>
          <SkeletonLine width="90%" height={12} />
          <SkeletonLine width="62%" height={12} marginTop={8} />
        </View>
      </View>

      <View style={r.skeletonCard}>
        <View style={r.skeletonCardHeader}>
          <SkeletonLine width={120} height={16} />
        </View>
        <View style={r.skeletonInner}>
          <SkeletonLine width="94%" height={12} />
          <SkeletonLine width="84%" height={12} marginTop={8} />
          <SkeletonLine width="70%" height={12} marginTop={8} />
        </View>
      </View>

      <View style={r.skeletonCard}>
        <View style={r.skeletonCardHeader}>
          <SkeletonLine width={110} height={16} />
        </View>
        <View style={r.skeletonInner}>
          <SkeletonLine width="92%" height={12} />
          <SkeletonLine width="76%" height={12} marginTop={8} />
        </View>
      </View>
    </Animated.View>
  );
}

function EmptyResultsOverlay() {
  return (
    <View style={r.emptyOverlay} pointerEvents="none">
      <View style={r.emptyPopup}>
        <Ionicons name="information-circle-outline" size={26} color="#8B6A55" />
        <ThemedText style={r.emptyPopupText}>No results yet.</ThemedText>
      </View>
    </View>
  );
}

function PdfGeneratingPopup({ visible }: { visible: boolean }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(10)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          speed: 22,
          bounciness: 5,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 8,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY, visible]);

  return (
    <Animated.View
      style={[
        r.pdfPopup,
        {
          opacity,
          transform: [{ translateY }],
        },
      ]}
    >
      <ActivityIndicator size="small" color="#8B6A55" />
      <ThemedText style={r.pdfPopupText}>generating pdf...</ThemedText>
    </Animated.View>
  );
}

export default function ResultsScreen() {
  const params = useLocalSearchParams<{ recordId?: string }>();
  const [latest, setLatest] = useState<AnalysisRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesText, setNotesText] = useState("");
  const [coffeeNameText, setCoffeeNameText] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [toastType, setToastType] = useState<ToastType>("save");
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [collectionModalVisible, setCollectionModalVisible] = useState(false);
  const [collectionNameInput, setCollectionNameInput] = useState("");
  const [selectedCollectionRecordIds, setSelectedCollectionRecordIds] = useState<string[]>([]);
  const [preferences, setPreferences] = useState(UserPreferencesStore.defaults);
  const [collections, setCollections] = useState(CollectionStore.getAll());
  const [previousRecord, setPreviousRecord] = useState<AnalysisRecord | null>(null);
  const [historyRecords, setHistoryRecords] = useState<AnalysisRecord[]>([]);

  const hasPromptedCoffeeName = useRef(false);
  const isMountedRef = useRef(true);
  const latestRef = useRef<AnalysisRecord | null>(null);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadLatest = React.useCallback(async () => {
    const cached = getLatestCachedAnalysis();
    const hasImmediateContent = Boolean(cached ?? latestRef.current);
    setIsLoading(!hasImmediateContent);

    if (isMountedRef.current) {
      setLatest(cached ?? null);
      if (cached) {
        setIsLoading(false);
      }
    }

    const [stored, history] = await Promise.all([getLatestStoredAnalysis(), getStoredAnalysisHistory()]);
    const sorted = [...history].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const requestedRecordId = typeof params.recordId === "string" ? params.recordId : undefined;
    const selectedFromHistory = requestedRecordId
      ? sorted.find((item) => item.id === requestedRecordId) ?? null
      : null;

    // Use explicit history selection when requested, otherwise newest history record.
    const next = selectedFromHistory ?? sorted[0] ?? stored ?? cached ?? null;
    if (!isMountedRef.current) return;
    setLatest(next);
    setHistoryRecords(sorted);
    const prev = sorted.find((item) => item.id !== next?.id) ?? null;
    setPreviousRecord(prev);
    setIsLoading(false);
  }, [params.recordId]);

  useEffect(() => {
    isMountedRef.current = true;
    void loadLatest();
    return () => {
      isMountedRef.current = false;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [loadLatest]);

  useFocusEffect(
    React.useCallback(() => {
      void loadLatest();
    }, [loadLatest])
  );

  useEffect(() => {
    latestRef.current = latest;
    if (!latest) return;

    setNotesText(latest.note ?? "");
    setCoffeeNameText(latest.coffeeType ?? "");
    setIsBookmarked(BookmarkStore.isBookmarked(latest.id));
  }, [latest]);

  useEffect(() => {
    void UserPreferencesStore.load();
    setPreferences(UserPreferencesStore.get());
    const unsubscribe = UserPreferencesStore.subscribe(setPreferences);
    void CollectionStore.load();
    const unsubCollections = CollectionStore.subscribe(setCollections);
    return () => {
      unsubscribe();
      unsubCollections();
    };
  }, []);

  useEffect(() => {
    if (!latest || hasPromptedCoffeeName.current) return;
    if (!isDefaultCoffeeName(latest.coffeeType)) return;

    hasPromptedCoffeeName.current = true;
    setRenameModalVisible(true);
  }, [latest]);

  const showToast = (type: ToastType) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastType(type);
    setToastVisible(true);
    toastTimer.current = setTimeout(() => setToastVisible(false), 2200);
  };

  const handleSaveNotes = async () => {
    if (!latest) return;

    console.log("note pressed:", { id: latest.id, note: notesText.trim() || undefined });
    const nextRecord: AnalysisRecord = {
      ...latest,
      note: notesText.trim() || undefined,
    };

    await saveAnalysisRecord(nextRecord);
    setLatest(nextRecord);
    setIsEditingNotes(false);
    showToast("save");
  };

  const handleSaveCoffeeName = async () => {
    if (!latest) return;

    const nextCoffeeName = coffeeNameText.trim() || latest.coffeeType;
    console.log("edit coffee_type pressed:", { id: latest.id, coffee_type: nextCoffeeName });
    const nextCupsToday = latest.cupsToday ?? 1;
    const nextRiskLevel = latest.riskLevel ?? "Low Risk";
    const nextRecord: AnalysisRecord = {
      ...latest,
      coffeeType: nextCoffeeName,
      narrative: buildRuleBasedNarrative({
        coffeeType: nextCoffeeName,
        ph: latest.ph,
        classification: latest.classification,
        riskLevel: nextRiskLevel,
        stomachState: latest.stomachState,
        cupsToday: nextCupsToday,
      }),
    };

    await saveAnalysisRecord(nextRecord);
    setLatest(nextRecord);
    setRenameModalVisible(false);
    setCoffeeNameText(nextCoffeeName);
    showToast("save");
  };

  const handleCancelCoffeeName = () => {
    setCoffeeNameText(latest?.coffeeType ?? "");
    setRenameModalVisible(false);
  };

  const handleCancelEdit = () => {
    setNotesText(latest?.note ?? "");
    setIsEditingNotes(false);
  };

  const handleBookmark = () => {
    if (!latest) return;

    if (isBookmarked) {
      console.log("bookmark pressed:", { id: latest.id, is_bookmarked: false });
      BookmarkStore.remove(latest.id);
      setIsBookmarked(false);
      void syncHistoryRecordToSupabase(latest, false);
      showToast("unbookmark");
      return;
    }

    console.log("bookmark pressed:", { id: latest.id, is_bookmarked: true });
    BookmarkStore.add(latest);
    setIsBookmarked(true);
    void syncHistoryRecordToSupabase(latest, true);
    showToast("bookmark");
  };

  const openCreateCollectionModal = () => {
    setCollectionNameInput("");
    setSelectedCollectionRecordIds(latest ? [latest.id] : []);
    setCollectionModalVisible(true);
  };

  const toggleRecordInCollectionDraft = (recordId: string) => {
    setSelectedCollectionRecordIds((current) =>
      current.includes(recordId) ? current.filter((id) => id !== recordId) : [...current, recordId]
    );
  };

  const saveCollection = async () => {
    const name = collectionNameInput.trim();
    if (!name) return;
    await CollectionStore.create(name, selectedCollectionRecordIds);
    setCollectionModalVisible(false);
  };

  const handleDeleteCollection = async (name: string) => {
    await CollectionStore.removeCollection(name);
  };

  const handleShare = async () => {
    if (!latest) return;

    const summary = [
      "ACIDEX SHARE CARD",
      `${latest.coffeeType}`,
      `pH ${latest.ph.toFixed(1)} • ${latest.classification} • ${latest.riskLevel}`,
      latest.stomachState ? `Stomach state: ${latest.stomachState}` : null,
      narrative?.safeTiming ? `Best timing: ${narrative.safeTiming}` : null,
      narrative?.summary ?? "",
      "",
      UX_DISCLAIMER_TEXT,
    ]
      .filter(Boolean)
      .join("\n");

    await Share.share({ message: summary, title: `${latest.coffeeType} result` });
  };
  const handleSharePdf = async () => {
    if (!latest) return;
    setIsGeneratingPdf(true);
    try {
      await shareAnalysisPdf(latest);
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const clsColor = latest
    ? CLASSIFICATION_COLORS[latest.classification as keyof typeof CLASSIFICATION_COLORS] ?? CLASSIFICATION_COLORS.Moderate
    : CLASSIFICATION_COLORS.Moderate;
  const riskColor = latest
    ? RISK_COLORS[latest.riskLevel as keyof typeof RISK_COLORS] ?? RISK_COLORS["Low Risk"]
    : RISK_COLORS["Low Risk"];
  const scalePct = latest ? getScalePct(latest) : 0;
  const narrative = latest
    ? (getNarrativeWithFallback(latest) as AnalysisNarrative)
    : null;
  const tips = latest ? getTipRows(latest, narrative?.tips ?? []) : [];
  const effects = narrative?.likelyEffectItems ?? [];
  const impacts = narrative?.impactItems ?? [];
  const acidityFactors = latest ? getAcidityFactorItems(latest) : [];
  const showEmptyOverlay = !isLoading && !latest;
  const showSkeleton = isLoading || showEmptyOverlay;
  const contrastTextColor = preferences.highContrastEnabled ? "#1A1411" : undefined;

  const bookmarkButton = latest ? (
    <View style={r.headerActions}>
      <TouchableOpacity
        onPress={handleShare}
        activeOpacity={0.7}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="share-social-outline" size={17} color="#C4A882" />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleSharePdf}
        activeOpacity={0.7}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="document-outline" size={17} color="#C4A882" />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleBookmark}
        activeOpacity={0.7}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons
          name={isBookmarked ? "bookmark" : "bookmark-outline"}
          size={17}
          color={isBookmarked ? "#4A3728" : "#C4A882"}
        />
      </TouchableOpacity>
    </View>
  ) : null;

  return (
    <ThemedView style={r.screen}>
      <ScrollView
        style={r.scroll}
        contentContainerStyle={r.content}
        showsVerticalScrollIndicator={false}
      >
        <ThemedView style={r.header}>
          <View style={r.headerMiddle}>
            <ThemedText
              style={r.title}
              lightColor={Colors.light.text}
              darkColor={Colors.light.text}
            >
              results.
            </ThemedText>
            <ThemedText
              style={r.subtitle}
              lightColor={Colors.light.text}
              darkColor={Colors.light.text}
            >
              your latest coffee analysis
            </ThemedText>
          </View>
        </ThemedView>

        {showSkeleton ? (
          <View style={showEmptyOverlay ? r.skeletonDimmed : undefined}>
            <ResultsSkeleton />
          </View>
        ) : latest ? (
          <>
            <SectionCard title="Acidity Summary" accent="cream" trailing={bookmarkButton}>
              <InnerBlock>
                <View style={r.summaryTop}>
                  <View style={r.coffeeIconWrap}>
                    <MaterialCommunityIcons name="coffee" size={52} color="#8B5E3C" />
                  </View>
                  <View style={r.summaryRight}>
                    <View style={r.coffeeNameRow}>
                      <ThemedText style={r.coffeeName}>{latest.coffeeType}</ThemedText>
                      <TouchableOpacity
                        onPress={() => setRenameModalVisible(true)}
                        activeOpacity={0.7}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        style={r.editCoffeeButton}
                      >
                        <Ionicons name="pencil" size={13} color="#8B6A55" />
                      </TouchableOpacity>
                    </View>
                    <View style={r.phRow}>
                      <ThemedText style={r.phText}>pH {latest.ph.toFixed(1)}</ThemedText>
                      <View style={[r.badge, { backgroundColor: clsColor.badge }]}>
                        <ThemedText style={r.badgeText}>{latest.classification}</ThemedText>
                      </View>
                    </View>
                    <View style={[r.riskTag, { backgroundColor: riskColor.bg }]}>
                      <ThemedText style={[r.riskTagText, { color: riskColor.text }]}>
                        {latest.riskLevel}
                      </ThemedText>
                    </View>
                  </View>
                </View>

                <View style={r.scaleBlock}>
                  <View style={r.scaleTopLabels}>
                    <ThemedText style={r.scaleLabelSmall}>Low acid</ThemedText>
                    <ThemedText style={r.scaleLabelSmall}>High acid</ThemedText>
                  </View>
                  <View style={r.scaleBar}>
                    <View style={[r.scaleSegment, { backgroundColor: "#A8C69F" }]} />
                    <View style={[r.scaleSegment, { backgroundColor: "#E7CFAB" }]} />
                    <View style={[r.scaleSegment, { backgroundColor: "#E49B92" }]} />
                    <View style={[r.scaleDot, { left: `${Math.min(scalePct, 88)}%` }]} />
                  </View>
                  <View style={r.scaleBottomLabels}>
                    <ThemedText style={r.scaleBottomSmall}>pH 6.0+</ThemedText>
                    <ThemedText style={r.scaleBottomSmall}>pH {latest.ph.toFixed(1)}</ThemedText>
                    <ThemedText style={r.scaleBottomSmall}>pH 4.0</ThemedText>
                  </View>
                </View>

                <ThemedText style={[r.summaryText, preferences.largeTextEnabled && r.summaryTextLarge, contrastTextColor ? { color: contrastTextColor } : null]}>{narrative?.summary}</ThemedText>
                <ThemedText style={[r.disclaimerText, preferences.largeTextEnabled && r.summaryTextLarge, contrastTextColor ? { color: contrastTextColor } : null]}>
                  {UX_DISCLAIMER_TEXT}
                </ThemedText>
              </InnerBlock>

              <View style={r.tagRow}>
                <Tag
                  label={new Date(latest.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                  bg="#F4EEEA"
                  color="#8B6A55"
                />
                {latest.stomachState && (
                  <Tag label={latest.stomachState} bg="#F4EEEA" color="#8B6A55" />
                )}
                <Tag
                  label={`${preferences.tastePreset} mode`}
                  bg={preferences.tastePreset === "bold" ? "#E8D5C4" : "#F4EEEA"}
                  color="#8B6A55"
                />
              </View>
            </SectionCard>

            <SectionCard title="Notes" accent="warm">
              <InnerBlock>
                {isEditingNotes ? (
                  <View>
                    <TextInput
                      style={r.notesInput}
                      value={notesText}
                      onChangeText={setNotesText}
                      placeholder="Add your notes about this coffee analysis..."
                      placeholderTextColor="#A08880"
                      multiline
                      maxLength={500}
                      autoFocus
                    />
                    <View style={r.notesActions}>
                      <TouchableOpacity
                        style={[r.notesBtn, r.cancelBtn]}
                        onPress={handleCancelEdit}
                        activeOpacity={0.7}
                      >
                        <ThemedText style={r.cancelBtnText}>cancel</ThemedText>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[r.notesBtn, r.saveBtn]}
                        onPress={handleSaveNotes}
                        activeOpacity={0.7}
                      >
                        <ThemedText style={r.saveBtnText}>save</ThemedText>
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <View>
                    {latest.note ? (
                      <ThemedText style={r.notesText}>{latest.note}</ThemedText>
                    ) : (
                      <ThemedText style={r.noNotesText}>
                        No notes yet. Add some thoughts about this analysis.
                      </ThemedText>
                    )}
                    <TouchableOpacity
                      style={r.editNotesButton}
                      onPress={() => setIsEditingNotes(true)}
                      activeOpacity={0.7}
                    >
                      <View style={r.editNotesIconCircle}>
                        <Ionicons name="pencil" size={13} color="#8B6A55" />
                      </View>
                      <ThemedText style={r.editNotesText}>
                        {latest.note ? "edit notes" : "add notes"}
                      </ThemedText>
                    </TouchableOpacity>
                  </View>
                )}
              </InnerBlock>
            </SectionCard>

            <SectionCard title="Collections" accent="warm">
              <InnerBlock>
                <View style={r.collectionRow}>
                  {Object.keys(collections).map((name) => {
                    const active = latest ? (collections[name] ?? []).includes(latest.id) : false;
                    return (
                      <View key={name} style={[r.collectionChip, active && r.collectionChipActive, r.collectionChipRow]}>
                        <TouchableOpacity
                          onPress={() => latest && void CollectionStore.toggle(name, latest.id)}
                          activeOpacity={0.8}
                          style={r.collectionChipLabelWrap}
                        >
                          <ThemedText style={[r.collectionChipText, active && r.collectionChipTextActive]}>
                            {name}
                          </ThemedText>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => void handleDeleteCollection(name)} activeOpacity={0.7}>
                          <Ionicons name="trash-outline" size={13} color={active ? "#FFF" : "#8B6A55"} />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                  <TouchableOpacity style={r.collectionCreateBtn} onPress={openCreateCollectionModal} activeOpacity={0.8}>
                    <Ionicons name="add" size={14} color="#4A3728" />
                    <ThemedText style={r.collectionCreateText}>new collection</ThemedText>
                  </TouchableOpacity>
                </View>
              </InnerBlock>
            </SectionCard>

            {latest && previousRecord && (
              <SectionCard title="Latest vs Previous Result" accent="slate">
                <InnerBlock>
                  <ThemedText style={r.compareLine}>
                    {latest.coffeeType}: pH {latest.ph.toFixed(1)} ({latest.riskLevel})
                  </ThemedText>
                  <ThemedText style={r.compareLine}>
                    {previousRecord.coffeeType}: pH {previousRecord.ph.toFixed(1)} ({previousRecord.riskLevel})
                  </ThemedText>
                  <ThemedText style={r.compareDelta}>
                    Delta: {(latest.ph - previousRecord.ph).toFixed(1)} pH
                  </ThemedText>
                </InnerBlock>
              </SectionCard>
            )}

            <SectionCard title="Likely Effects & Advisory" accent="peach">
              <InnerBlock>
                <View style={r.warningRow}>
                  <Ionicons name="warning-outline" size={17} color="#C38C49" />
                  <ThemedText style={r.warningTitle}>
                    {narrative?.likelyEffectTitle}
                  </ThemedText>
                </View>
                {effects.map((item: string, index: number) => (
                  <BulletItem key={`${item}-${index}`} text={item} />
                ))}
                <View style={r.divider} />
                <ThemedText style={r.advisoryText}>{narrative?.advisory}</ThemedText>
              </InnerBlock>
            </SectionCard>

            <SectionCard title="Tips to Minimize Discomfort" accent="sage">
              <InnerBlock>
                {tips.map((tip, index: number) => (
                  <View
                    key={`${tip.text}-${index}`}
                    style={[r.tipRow, index < tips.length - 1 && r.tipRowBorder]}
                  >
                    <View style={r.tipIconCircle}>
                      <MaterialCommunityIcons
                        name={tip.icon as never}
                        size={16}
                        color="#6B8F76"
                      />
                    </View>
                    <ThemedText style={r.tipText}>{tip.text}</ThemedText>
                  </View>
                ))}
              </InnerBlock>
            </SectionCard>

            <SectionCard title="Potential Impact" accent="slate">
              <InnerBlock>
                {impacts.map((item: string, index: number) => (
                  <BulletItem key={`${item}-${index}`} text={item} />
                ))}
                <TouchableOpacity
                  style={r.favoriteHistoryButton}
                  onPress={() => router.push({ pathname: "/(tabs)/history", params: { filter: "Favorites" } })}
                  activeOpacity={0.8}
                >
                  <Ionicons name="bookmark" size={14} color="#4A3728" />
                  <ThemedText style={r.favoriteHistoryButtonText}>open favorites in history</ThemedText>
                </TouchableOpacity>
              </InnerBlock>
            </SectionCard>

            <SectionCard
              title="Safe Coffee Timing"
              accent="slate"
              trailing={<Ionicons name="time-outline" size={17} color="#5B7FA6" />}
            >
              <View style={r.timingRow}>
                <View style={r.timingIconCircle}>
                  <Ionicons name="time-outline" size={16} color="#5B7FA6" />
                </View>
                <ThemedText style={r.timingText}>{narrative?.safeTiming ?? "Timing guidance unavailable."}</ThemedText>
              </View>
            </SectionCard>

            <SectionCard title="What's Coffee Acidity?" accent="warm">
              <ThemedText style={r.infoParagraph}>
                Coffee acidity refers to the acidic content of the drink, measured as
                pH. Lower pH means higher acidity.
              </ThemedText>
              <InnerBlock>
                <ThemedText style={r.innerBlockTitle}>What impacts acidity?</ThemedText>
                {acidityFactors.map((item: string, index: number) => (
                  <BulletItem key={`${item}-${index}`} text={item} />
                ))}
              </InnerBlock>
            </SectionCard>
          </>
        ) : null}

      </ScrollView>

      {showEmptyOverlay ? <EmptyResultsOverlay /> : null}

      <Modal
        transparent
        animationType="fade"
        visible={collectionModalVisible}
        onRequestClose={() => setCollectionModalVisible(false)}
      >
        <Pressable style={r.renameOverlay} onPress={() => setCollectionModalVisible(false)}>
          <Pressable style={r.renameModal} onPress={() => null}>
            <View style={r.renameHeader}>
              <ThemedText style={r.renameTitle}>Create collection</ThemedText>
              <ThemedText style={r.renameSubtitle}>Select coffees from your history</ThemedText>
            </View>
            <TextInput
              style={r.titleInput}
              value={collectionNameInput}
              onChangeText={setCollectionNameInput}
              placeholder="e.g., low acid picks"
              placeholderTextColor="#A08880"
              maxLength={40}
            />
            <ScrollView style={r.collectionModalList} showsVerticalScrollIndicator={false}>
              {historyRecords.map((record) => {
                const selected = selectedCollectionRecordIds.includes(record.id);
                return (
                  <TouchableOpacity
                    key={record.id}
                    style={[r.collectionPickRow, selected && r.collectionPickRowActive]}
                    onPress={() => toggleRecordInCollectionDraft(record.id)}
                    activeOpacity={0.8}
                  >
                    <View style={r.collectionPickMeta}>
                      <ThemedText style={r.collectionPickTitle}>{record.coffeeType}</ThemedText>
                      <ThemedText style={r.collectionPickSub}>
                        {new Date(record.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} • pH {record.ph.toFixed(1)}
                      </ThemedText>
                    </View>
                    <Ionicons
                      name={selected ? "checkmark-circle" : "ellipse-outline"}
                      size={18}
                      color={selected ? "#4A3728" : "#A08880"}
                    />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <View style={r.modalActions}>
              <TouchableOpacity
                style={[r.notesBtn, r.cancelBtn]}
                onPress={() => setCollectionModalVisible(false)}
                activeOpacity={0.7}
              >
                <ThemedText style={r.cancelBtnText}>cancel</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity
                style={[r.notesBtn, r.saveBtn]}
                onPress={() => void saveCollection()}
                activeOpacity={0.7}
              >
                <ThemedText style={r.saveBtnText}>create</ThemedText>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={renameModalVisible}
        onRequestClose={handleCancelCoffeeName}
      >
        <Pressable style={r.renameOverlay} onPress={handleCancelCoffeeName}>
          <Pressable style={r.renameModal} onPress={() => null}>
            <View style={r.renameHeader}>
              <ThemedText style={r.renameTitle}>Name this coffee</ThemedText>
              <ThemedText style={r.renameSubtitle}>Make it easier to find later</ThemedText>
            </View>
            <TextInput
              style={r.titleInput}
              value={coffeeNameText}
              onChangeText={setCoffeeNameText}
              placeholder="e.g., Morning espresso"
              placeholderTextColor="#A08880"
              maxLength={40}
              autoFocus
            />
            <View style={r.modalActions}>
              <TouchableOpacity
                style={[r.notesBtn, r.cancelBtn]}
                onPress={handleCancelCoffeeName}
                activeOpacity={0.7}
              >
                <ThemedText style={r.cancelBtnText}>cancel</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity
                style={[r.notesBtn, r.saveBtn]}
                onPress={handleSaveCoffeeName}
                activeOpacity={0.7}
              >
                <ThemedText style={r.saveBtnText}>save</ThemedText>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <View style={r.toastWrapper} pointerEvents="none">
        <Toast visible={toastVisible} type={toastType} />
      </View>
      <View style={r.pdfPopupWrapper} pointerEvents="none">
        <PdfGeneratingPopup visible={isGeneratingPdf} />
      </View>
    </ThemedView>
  );
}

const r = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F6F1EC" },
  scroll: { flex: 1 },
  content: { flexGrow: 1, paddingBottom: 40 },

  skeletonWrap: {
    paddingBottom: 40,
  },
  skeletonDimmed: {
    opacity: 0.34,
  },
  skeletonCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#EDE3DC",
    backgroundColor: Colors.light.background,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 14,
  },
  skeletonCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  skeletonInner: {
    backgroundColor: "rgba(139,94,60,0.05)",
    borderRadius: 14,
    padding: 14,
  },
  skeletonSummaryTop: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  skeletonCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(139,94,60,0.08)",
    marginRight: 14,
  },
  skeletonSummaryRight: { flex: 1 },
  skeletonScale: { marginBottom: 14 },
  skeletonScaleLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 6,
  },
  skeletonTagsRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: 12,
  },
  skeletonActionRow: {
    marginTop: 12,
    alignItems: "flex-start",
  },
  skeletonTipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  skeletonTipIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(104,143,118,0.12)",
  },
  skeletonTipTextWrap: { flex: 1 },
  skeletonLine: {
    borderRadius: 999,
    backgroundColor: "rgba(139,94,60,0.14)",
  },

  emptyOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(46, 33, 27, 0.28)",
    paddingHorizontal: 24,
  },
  emptyPopup: {
    alignItems: "center",
    gap: 10,
    minWidth: 190,
    maxWidth: 280,
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderRadius: 20,
    backgroundColor: Colors.light.background,
    borderWidth: 1,
    borderColor: "#E5D8CB",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  emptyPopupText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#2E211B",
    textAlign: "center",
  },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingTop: 50,
    paddingBottom: 14,
    backgroundColor: Colors.light.background,
  },
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
  headerMiddle: {
    flex: 1.6,
    alignItems: "center",
    justifyContent: "center",
  },

  card: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 14,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  cardTitle: { fontSize: 14, fontWeight: "700", color: "#2E211B" },

  innerBlock: {
    backgroundColor: "rgba(139,94,60,0.07)",
    borderRadius: 14,
    padding: 14,
  },
  innerBlockTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#2E211B",
    marginBottom: 10,
  },

  summaryTop: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
  coffeeIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(139,94,60,0.1)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  summaryRight: { flex: 1 },
  coffeeName: { fontSize: 15, fontWeight: "700", color: "#2E211B", marginBottom: 6 },
  phRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  phText: { fontSize: 15, fontWeight: "600", color: "#3C2C24" },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { color: "#FFF", fontSize: 11, fontWeight: "700" },
  riskTag: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  riskTagText: { fontSize: 11, fontWeight: "600" },

  scaleBlock: { marginBottom: 14 },
  scaleTopLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  scaleLabelSmall: { fontSize: 11, color: "#A08880" },
  scaleBar: {
    flexDirection: "row",
    height: 12,
    borderRadius: 999,
    overflow: "hidden",
    position: "relative",
    marginBottom: 6,
  },
  scaleSegment: { flex: 1 },
  scaleDot: {
    position: "absolute",
    top: -3,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#E74C3C",
    borderWidth: 2,
    borderColor: "#FFF",
  },
  scaleBottomLabels: { flexDirection: "row", justifyContent: "space-between" },
  scaleBottomSmall: { fontSize: 10, color: "#A08880" },
  summaryText: { fontSize: 13, lineHeight: 20, color: "#4B3A33", marginTop: 4 },
  summaryTextLarge: { fontSize: 15, lineHeight: 22 },
  disclaimerText: { fontSize: 12, lineHeight: 18, color: "#6C564B", marginTop: 8 },

  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12 },
  tag: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { fontSize: 11, fontWeight: "600" },

  bulletRow: { flexDirection: "row", alignItems: "flex-start", marginBottom: 8 },
  bullet: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "#C4905A",
    marginTop: 8,
    marginRight: 10,
    flexShrink: 0,
  },
  bulletText: { flex: 1, fontSize: 13, lineHeight: 20, color: "#4E3D35" },

  warningRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  warningTitle: { fontSize: 13, fontWeight: "700", color: "#2E211B" },
  divider: { height: 1, backgroundColor: "rgba(139,94,60,0.15)", marginVertical: 10 },
  advisoryText: { fontSize: 13, lineHeight: 20, color: "#4B3A33" },

  tipRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  tipRowBorder: { borderBottomWidth: 1, borderBottomColor: "rgba(104,143,118,0.2)" },
  tipIconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(104,143,118,0.15)",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  tipText: { flex: 1, fontSize: 13, lineHeight: 20, color: "#4E3D35" },

  timingRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 2 },
  timingIconCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "rgba(91,127,166,0.15)",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  timingText: { flex: 1, fontSize: 13, lineHeight: 20, color: "#4E3D35" },
  favoriteHistoryButton: {
    marginTop: 8,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#EAF0F6",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  favoriteHistoryButtonText: {
    fontSize: 12,
    color: "#4A3728",
    fontWeight: "600",
    textTransform: "lowercase",
  },

  infoParagraph: { fontSize: 13, lineHeight: 20, color: "#4B3A33", marginBottom: 12 },

  notesInput: {
    borderWidth: 1,
    borderColor: "#E0D5C4",
    borderRadius: 10,
    padding: 12,
    fontSize: 13,
    color: "#2E211B",
    minHeight: 80,
    textAlignVertical: "top",
    backgroundColor: "#FFF",
  },
  titleInput: {
    borderWidth: 1,
    borderColor: "#E0D5C4",
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    fontWeight: "600",
    color: "#2E211B",
    backgroundColor: "#FFF",
  },
  titleDisplayText: { fontSize: 14, fontWeight: "600", color: "#2E211B", lineHeight: 20 },
  noTitleText: { fontSize: 13, color: "#A08880", fontStyle: "italic" },
  coffeeNameRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  editCoffeeButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(139,94,60,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  renameOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  renameModal: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#FFFAF7",
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: "#EDE3DC",
  },
  renameHeader: { marginBottom: 12 },
  renameTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#2E211B",
    marginBottom: 4,
  },
  renameSubtitle: { fontSize: 12, color: "#7A675C" },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 14,
  },
  notesActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 12,
  },
  notesBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999 },
  cancelBtn: { backgroundColor: "#F4EEEA" },
  cancelBtnText: {
    fontSize: 13,
    color: "#8B6A55",
    fontWeight: "500",
    textTransform: "lowercase",
  },
  saveBtn: { backgroundColor: "#4A3728" },
  saveBtnText: {
    fontSize: 13,
    color: "#FFF",
    fontWeight: "600",
    textTransform: "lowercase",
  },
  notesText: { fontSize: 13, lineHeight: 20, color: "#4B3A33" },
  noNotesText: { fontSize: 13, color: "#A08880", fontStyle: "italic" },
  editNotesButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    alignSelf: "flex-start",
  },
  editNotesIconCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(139,94,60,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  editNotesText: {
    fontSize: 13,
    color: "#8B6A55",
    fontWeight: "500",
    textTransform: "lowercase",
  },

  toastWrapper: {
    position: "absolute",
    bottom: 28,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  toastText: { fontSize: 13, fontWeight: "600", textTransform: "lowercase" },
  pdfPopupWrapper: {
    position: "absolute",
    bottom: 78,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  pdfPopup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FFFAF7",
    borderWidth: 1,
    borderColor: "#EDE3DC",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  pdfPopupText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#8B6A55",
    textTransform: "lowercase",
  },
  collectionRow: {
    flexDirection: "row",
    gap: 8,
  },
  collectionChip: {
    backgroundColor: "#F4EEEA",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 999,
  },
  collectionChipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  collectionChipLabelWrap: {
    maxWidth: 140,
  },
  collectionChipActive: {
    backgroundColor: "#4A3728",
  },
  collectionChipText: {
    fontSize: 12,
    color: "#7A675C",
    fontWeight: "600",
  },
  collectionChipTextActive: {
    color: "#FFF",
  },
  collectionCreateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#EFE4DB",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  collectionCreateText: {
    fontSize: 12,
    color: "#4A3728",
    fontWeight: "600",
  },
  collectionModalList: {
    marginTop: 12,
    maxHeight: 260,
  },
  collectionPickRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#F4EEEA",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  collectionPickRowActive: {
    borderWidth: 1,
    borderColor: "#C8B19E",
    backgroundColor: "#F8EFE9",
  },
  collectionPickMeta: {
    flex: 1,
    marginRight: 8,
  },
  collectionPickTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#2E211B",
  },
  collectionPickSub: {
    marginTop: 2,
    fontSize: 11,
    color: "#8B6A55",
  },
  compareLine: {
    fontSize: 12,
    lineHeight: 20,
    color: "#4B3A33",
  },
  compareDelta: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: "700",
    color: "#2E211B",
  },
});
