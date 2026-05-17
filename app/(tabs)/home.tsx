import { getCurrentUserSafe, supabase } from "@/lib/supabase";
import { maybeEnrichAnalysisRecordWithLlm } from "@/src/services/aiAnalysisService";
import {
    buildRuleBasedNarrative,
    classifyRiskLevel,
} from "@/src/services/analysisService";
import { readSensorData } from "@/src/services/sensorService";
import {
    applyDeviceSideCalibrationFromVoltages,
    measureCalibrationBuffer,
} from "@/src/services/calibrationService";
import { schedulePostCoffeeReminder } from "@/src/services/reminderService";
import type {
    ArduinoReadProgress,
    ArduinoReadStage,
} from "@/src/services/usbService";
import {
    describeUsbDevice,
    getFirstUsbDevice,
    hasUsbDevice,
    listUsbDevices,
    requestUsbPermissionIfNeeded,
} from "@/src/services/usbService";
import { saveAnalysisRecord } from "@/src/store/analysisStore";
import type { AnalysisRecord } from "@/src/types/analysis";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
    Dimensions,
    Easing,
    FlatList,
    Modal,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Pressable,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";

import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import Colors from "@/constants/colors";
import { useThemeColor } from "@/hooks/use-theme-color";
import StreakIcon from "../../assets/images/streak.svg";

const { width } = Dimensions.get("window");

// carousel sizing
const CARD_WIDTH    = width * 0.55;
const CARD_GAP      = 16;
const ITEM_SIZE     = CARD_WIDTH + CARD_GAP;
const SIDE_SPACING  = (width - CARD_WIDTH) / 2;
const FACT_CARD_HEIGHT = CARD_WIDTH * 0.98;

const DEFAULT_AVATARS = [
  require("../../assets/images/avatars/avatar1.png"),
  require("../../assets/images/avatars/avatar2.png"),
  require("../../assets/images/avatars/avatar3.png"),
  require("../../assets/images/avatars/avatar4.png"),
];

const FACT_IMAGES = [
  require("../../assets/images/fact-1.png"),
  require("../../assets/images/fact-2.png"),
  require("../../assets/images/fact-3.png"),
  require("../../assets/images/fact-4.png"),
];

type FactType = {
  id: number;
  image: number;
  shortFact: string;
  title: string;
  fullText: string;
  suggestion: string;
  references: string[];
};

const FactCard = memo(function FactCard({
  fact,
  onPress,
}: {
  fact: FactType;
  onPress: (fact: FactType) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(fact)}
      style={({ pressed }) => [styles.cardWrapper, pressed && styles.cardWrapperPressed]}
    >
      <View style={styles.smallCard}>
        <Image source={fact.image} style={styles.coffeeImage} contentFit="contain" />
        <ThemedText style={styles.smallCardText}>{fact.shortFact}</ThemedText>
      </View>
    </Pressable>
  );
});

const factsData: FactType[] = [
  {
    id: 1,
    image: FACT_IMAGES[0],
    shortFact: "Instant coffee acidity can vary by brand and formulation.",
    title: "Instant coffee acidity varies",
    fullText:
      "Instant coffee products can differ in acidity depending on raw material, processing, and additives. Two products with similar taste may still produce different pH readings.",
    suggestion: "Compare your own readings across brands before choosing a daily option.",
    references: ["Use repeated measurements in the app for better comparison."],
  },
  {
    id: 2,
    image: FACT_IMAGES[1],
    shortFact: "Higher acidity may increase discomfort for sensitive users.",
    title: "Acidity and discomfort",
    fullText:
      "People with sensitive digestion may notice more discomfort when acidity is higher. Track both pH and how you feel to find your safer routine.",
    suggestion: "Use your pH trend with symptom notes for better personal decisions.",
    references: ["General gastrointestinal guidance from healthcare providers."],
  },
  {
    id: 3,
    image: FACT_IMAGES[2],
    shortFact: "Serving timing can affect how your stomach responds.",
    title: "Timing still matters",
    fullText:
      "Even with instant coffee, timing can influence discomfort. Some users tolerate coffee better with food than on an empty stomach.",
    suggestion: "If discomfort occurs, try having instant coffee after a meal.",
    references: ["Use your logged stomach-state trend for personal timing decisions."],
  },
  {
    id: 4,
    image: FACT_IMAGES[3],
    shortFact: "Consistency helps: repeated checks are better than one reading.",
    title: "Use trend, not one sample",
    fullText:
      "A single result can be noisy. Multiple readings over time give better insight into your personal pattern for instant coffee tolerance.",
    suggestion: "Track several entries per product before deciding what works best.",
    references: ["History trends are more reliable than one-off results."],
  },
];

const DID_YOU_KNOW_CACHE_KEY = "acidex_did_you_know_facts_v1";
const DID_YOU_KNOW_LAST_SYNC_KEY = "acidex_did_you_know_last_sync_v1";
const DID_YOU_KNOW_REFRESH_MS = 30 * 60 * 1000;
const DID_YOU_KNOW_FUNCTION_NAME =
  process.env.EXPO_PUBLIC_DID_YOU_KNOW_LLM_FUNCTION_NAME || "did-you-know-llm";
type AnalyzeStatus = "idle" | "no-device" | "usb-permission" | "analyzing" | "done" | "error";
type StomachState = "Empty stomach" | "After meal" | null;

const ANALYZE_STAGE_PROGRESS: Record<ArduinoReadStage | "persisting" | "llm", number> = {
  "device-found": 0.1,
  "port-opened": 0.2,
  "waiting-before-send": 0.3,
  "command-sent": 0.42,
  "serial-received": 0.56,
  "serial-chunk": 0.66,
  "arduino-ready": 0.72,
  "arduino-stable": 0.82,
  "arduino-collecting": 0.9,
  "result-detected": 0.97,
  llm: 0.985,
  persisting: 1,
};

const ANALYZE_STAGE_HINTS: Record<ArduinoReadStage | "persisting" | "llm", string> = {
  "device-found": "getting things ready",
  "port-opened": "starting up",
  "waiting-before-send": "settling in",
  "command-sent": "checking the sample",
  "serial-received": "locking onto the signal",
  "serial-chunk": "fine-tuning the reading",
  "arduino-ready": "sample recognized",
  "arduino-stable": "holding a steady reading",
  "arduino-collecting": "wrapping up the sample",
  "result-detected": "almost there",
  llm: "writing your insights",
  persisting: "putting everything together",
};

const STREAK_COUNT_KEY      = "acidex_streak_count";
const LAST_ANALYSIS_DATE_KEY = "acidex_last_analysis_date";

export default function HomeScreen() {
  const router       = useRouter();
  const flatListRef  = useRef<FlatList<FactType>>(null);
  const carouselIndexRef = useRef(0);
  const lastAnalyzeStageRef = useRef<ArduinoReadStage | "persisting" | "llm" | null>(null);

  const [avatarUrl,    setAvatarUrl]    = useState<string | null>(null);
  const [avatarIndex,  setAvatarIndex]  = useState<number | null>(null);
  const [userName,     setUserName]     = useState("User");
  const [facts, setFacts] = useState<FactType[]>(factsData);
  const [selectedFact, setSelectedFact] = useState<FactType | null>(null);
  const [calibrationHelpVisible, setCalibrationHelpVisible] = useState(false);
  const [cupsTodayInput, setCupsTodayInput] = useState("1");
  const [calibrationBusy, setCalibrationBusy] = useState(false);
  const [calibrationLowVoltage, setCalibrationLowVoltage] = useState<number | null>(null);
  const [calibrationHighVoltage, setCalibrationHighVoltage] = useState<number | null>(null);
  const [calibrationMessage, setCalibrationMessage] = useState<string | null>(null);

  const [streakCount,          setStreakCount]          = useState(0);
  const [streakPopupVisible,   setStreakPopupVisible]   = useState(false);
  const [isOtgConnected,       setIsOtgConnected]       = useState(false);
  const [analyzeModalVisible,  setAnalyzeModalVisible]  = useState(false);
  const [analyzeStatus,        setAnalyzeStatus]        = useState<AnalyzeStatus>("idle");
  const [stomachState,         setStomachState]         = useState<StomachState>(null);
  const [isNewCup,             setIsNewCup]             = useState(true);
  const [probeReady,           setProbeReady]           = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeStage, setAnalyzeStage] = useState<ArduinoReadStage | "persisting" | "llm" | null>(null);
  const [pendingRecord,        setPendingRecord]        = useState<AnalysisRecord | null>(null);
  const [serialDebugLines, setSerialDebugLines] = useState<string[]>([]);

  const pulseAnim = useRef(new Animated.Value(0)).current;
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  const coffee = useThemeColor({}, "coffee");
  const text   = useThemeColor({}, "text");

  const fallbackDefaultAvatar = useMemo(() => DEFAULT_AVATARS[0], []);
  const loopedFacts = useMemo(() => [...facts, ...facts, ...facts], [facts]);
  const isCarouselPaused = analyzeModalVisible || analyzeStatus === "analyzing";
  const analyzeProgress = analyzeStage ? ANALYZE_STAGE_PROGRESS[analyzeStage] : 0.08;
  const analyzeHint = analyzeStage ? ANALYZE_STAGE_HINTS[analyzeStage] : "preparing";

  // ── data loading ──────────────────────────────────────────────────────────
  useEffect(() => {
    const fetchUserAndAvatar = async () => {
      const user = await getCurrentUserSafe();
      if (!user) return;

      setUserName(user.user_metadata?.full_name || user.email || "User");

      const googleAvatar = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
      if (typeof googleAvatar === "string" && googleAvatar.length > 0) {
        setAvatarUrl(googleAvatar); return;
      }

      const { data: profile, error: profileErr } = await supabase
        .from("profiles").select("avatar_index").eq("id", user.id).single();

      if (profileErr) { console.log("profile fetch error:", profileErr.message); setAvatarIndex(0); return; }

      const existingIndex = profile?.avatar_index;
      if (existingIndex === null || existingIndex === undefined) {
        const newIndex = Math.floor(Math.random() * DEFAULT_AVATARS.length);
        const { error: updateErr } = await supabase
          .from("profiles").update({ avatar_index: newIndex }).eq("id", user.id);
        if (updateErr) { console.log("avatar_index update error:", updateErr.message); setAvatarIndex(0); return; }
        setAvatarIndex(newIndex);
      } else {
        setAvatarIndex(Math.max(0, Math.min(DEFAULT_AVATARS.length - 1, Number(existingIndex))));
      }
    };

    fetchUserAndAvatar();
    loadStreak();
    refreshOtgStatus();
    void refreshDidYouKnowFacts();
  }, []);

  useEffect(() => {
    const refreshTimer = setInterval(() => {
      void refreshDidYouKnowFacts();
    }, DID_YOU_KNOW_REFRESH_MS);
    return () => clearInterval(refreshTimer);
  }, []);

  useEffect(() => {
    if (isCarouselPaused) return;
    if (!loopedFacts.length) return;
    const rotateTimer = setInterval(() => {
      const nextIndex = (carouselIndexRef.current + 1) % loopedFacts.length;
      flatListRef.current?.scrollToIndex({ index: nextIndex, animated: true });
      carouselIndexRef.current = nextIndex;
    }, 12000);

    return () => clearInterval(rotateTimer);
  }, [isCarouselPaused, loopedFacts.length]);

  useEffect(() => {
    const timer = setTimeout(() => {
      flatListRef.current?.scrollToIndex({ index: facts.length, animated: false });
      carouselIndexRef.current = facts.length;
    }, 100);
    return () => clearTimeout(timer);
  }, [facts.length]);

  const normalizeLlmFacts = (raw: unknown): FactType[] | null => {
    let payload: unknown = raw;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw);
      } catch {
        return null;
      }
    }

    const factsRaw = Array.isArray(payload)
      ? payload
      : (payload as { facts?: unknown })?.facts;
    if (!Array.isArray(factsRaw)) return null;

    const mapped = factsRaw
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const row = item as Record<string, unknown>;
        const shortFact = typeof row.shortFact === "string" ? row.shortFact.trim() : "";
        const title = typeof row.title === "string" ? row.title.trim() : "";
        const fullText = typeof row.fullText === "string" ? row.fullText.trim() : "";
        const suggestion = typeof row.suggestion === "string" ? row.suggestion.trim() : "";
        const references = Array.isArray(row.references)
          ? row.references.filter((v): v is string => typeof v === "string").slice(0, 3)
          : [];

        if (!shortFact || !title || !fullText || !suggestion) return null;
        return {
          id: index + 1,
          image: FACT_IMAGES[index % FACT_IMAGES.length],
          shortFact: shortFact.slice(0, 140),
          title: title.slice(0, 64),
          fullText: fullText.slice(0, 480),
          suggestion: suggestion.slice(0, 180),
          references: references.length > 0 ? references : ["Generated instant-coffee insight."],
        } as FactType;
      })
      .filter((item): item is FactType => !!item);

    return mapped.length >= 3 ? mapped : null;
  };

  const refreshDidYouKnowFacts = async () => {
    try {
      const [cachedRaw, lastSyncRaw] = await Promise.all([
        AsyncStorage.getItem(DID_YOU_KNOW_CACHE_KEY),
        AsyncStorage.getItem(DID_YOU_KNOW_LAST_SYNC_KEY),
      ]);

      if (cachedRaw) {
        const parsed = normalizeLlmFacts(JSON.parse(cachedRaw));
        if (parsed) setFacts(parsed);
      }

      const lastSync = lastSyncRaw ? Number(lastSyncRaw) : 0;
      if (Date.now() - lastSync < DID_YOU_KNOW_REFRESH_MS) return;

      const { data, error } = await supabase.functions.invoke(DID_YOU_KNOW_FUNCTION_NAME, {
        body: {
          topic: "instant-coffee-only",
          maxCards: 5,
          tokenBudgetHint: 900,
          style: "short, practical, consumer-safe",
          constraints: [
            "instant coffee only",
            "no brewed coffee references",
            "no medical diagnosis claims",
          ],
        },
      });

      if (error) return;
      const parsed = normalizeLlmFacts(data);
      if (!parsed) return;

      setFacts(parsed);
      await Promise.all([
        AsyncStorage.setItem(DID_YOU_KNOW_CACHE_KEY, JSON.stringify({ facts: parsed })),
        AsyncStorage.setItem(DID_YOU_KNOW_LAST_SYNC_KEY, String(Date.now())),
      ]);
    } catch (error) {
      console.log("refreshDidYouKnowFacts error:", error);
    }
  };

  const loadStreak = async () => {
    try {
      const stored = await AsyncStorage.getItem(STREAK_COUNT_KEY);
      setStreakCount(stored ? Number(stored) : 0);
    } catch (error) { console.log("load streak error:", error); }
  };

  const getTodayString = () => {
    const now = new Date();
    return `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
  };

  const incrementStreakIfNeeded = async () => {
    try {
      const today           = getTodayString();
      const lastAnalysisDate = await AsyncStorage.getItem(LAST_ANALYSIS_DATE_KEY);
      const storedCount      = await AsyncStorage.getItem(STREAK_COUNT_KEY);
      const currentCount     = storedCount ? Number(storedCount) : 0;
      if (lastAnalysisDate === today) { setStreakCount(currentCount); return; }
      const newCount = currentCount + 1;
      await AsyncStorage.setItem(STREAK_COUNT_KEY, String(newCount));
      await AsyncStorage.setItem(LAST_ANALYSIS_DATE_KEY, today);
      setStreakCount(newCount);
    } catch (error) { console.log("increment streak error:", error); }
  };

  const refreshOtgStatus = async () => {
    try {
      const devices = await listUsbDevices();
      console.log(
        "USB devices detected:",
        devices.map((device) => describeUsbDevice(device))
      );

      const connected = await hasUsbDevice();
      setIsOtgConnected(connected);
      return connected;
    } catch (error) {
      console.log("refreshOtgStatus error:", error);
      setIsOtgConnected(false);
      return false;
    }
  };

  const handleAnalyzePress = async () => {
    const hasOtg = await refreshOtgStatus();
    if (!hasOtg) {
      console.log("No USB serial device was detected before analyze.");
    }

    setAnalyzeModalVisible(true);
    setAnalyzeError(null);
    setAnalyzeStage(null);
    lastAnalyzeStageRef.current = null;
    setPendingRecord(null);
    setSerialDebugLines([]);
    setCupsTodayInput("1");
    setIsNewCup(true);

    if (!hasOtg) {
      setAnalyzeStatus("no-device");
      return;
    }

    const device = await getFirstUsbDevice();
    if (!device) {
      setAnalyzeStatus("no-device");
      return;
    }

    const permissionGranted = await requestUsbPermissionIfNeeded(device);
    if (!permissionGranted) {
      setAnalyzeStatus("usb-permission");
      return;
    }

    setProbeReady(false);
    setAnalyzeStatus("analyzing");
    try {
      const record = await readSensorData((progress: ArduinoReadProgress) => {
        if (lastAnalyzeStageRef.current !== progress.stage) {
          lastAnalyzeStageRef.current = progress.stage;
          setAnalyzeStage(progress.stage);
        }

        if (progress.rawChunk) {
          const cleaned = progress.rawChunk.replace(/\r/g, "").trim();
          if (cleaned.length > 0) {
            setSerialDebugLines((current) => {
              const next = [...current, cleaned];
              return next.slice(-12);
            });
          }
        }
      });

      if (!record) {
        throw new Error("No valid Arduino result was parsed from the USB stream.");
      }
      await incrementStreakIfNeeded();
      setPendingRecord(record);
      setProbeReady(true);
      // only advance to done if user has already logged stomach state
      // otherwise the useEffect below will catch it when they tap
    } catch (error) {
      console.log("analysis error:", error);
      setAnalyzeError(
        error instanceof Error ? error.message : "Failed to read the OTG device."
      );
      setAnalyzeStatus("error");
    }
  };

  useEffect(() => {
    if (!probeReady || stomachState === null || analyzeStatus !== "analyzing" || !pendingRecord) {
      return;
    }

    const nextRiskLevel = classifyRiskLevel(pendingRecord.classification, stomachState);
    const nextRecord: AnalysisRecord = {
      ...pendingRecord,
      stomachState,
      cupsToday: Number(cupsTodayInput) || 1,
      isNewCup,
      riskLevel: nextRiskLevel,
      narrative: buildRuleBasedNarrative({
        coffeeType: pendingRecord.coffeeType,
        ph: pendingRecord.ph,
        classification: pendingRecord.classification,
        riskLevel: nextRiskLevel,
        stomachState,
        cupsToday: Number(cupsTodayInput) || 1,
      }),
    };

    let cancelled = false;

    const persistRecord = async () => {
      setAnalyzeStage("persisting");
      await saveAnalysisRecord(nextRecord);
      await schedulePostCoffeeReminder({
        coffeeType: nextRecord.coffeeType,
        riskLevel: nextRecord.riskLevel,
      });
      if (cancelled) return;

      // LLM enrichment is part of the loading experience so Results can render instantly.
      setAnalyzeStage("llm");
      const enriched = await maybeEnrichAnalysisRecordWithLlm(nextRecord);
      if (cancelled) return;

      setPendingRecord(enriched);
      setAnalyzeStatus("done");
    };

    persistRecord().catch((error) => {
      console.log("persist analyzed record error:", error);
      if (!cancelled) {
        setAnalyzeError("Analysis finished, but saving the stomach state failed.");
        setAnalyzeStatus("error");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [analyzeStatus, pendingRecord, probeReady, stomachState, cupsTodayInput, isNewCup]);

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return "good morning";
    if (hour < 18) return "good afternoon";
    return "good evening";
  };

  const handleInfiniteScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (isCarouselPaused) return;
    const offsetX      = event.nativeEvent.contentOffset.x;
    const contentWidth = event.nativeEvent.contentSize.width;
    const singleSetWidth = contentWidth / 3;
    if (offsetX < singleSetWidth * 0.2) {
      flatListRef.current?.scrollToOffset({ offset: offsetX + singleSetWidth, animated: false });
    } else if (offsetX > singleSetWidth * 1.8) {
      flatListRef.current?.scrollToOffset({ offset: offsetX - singleSetWidth, animated: false });
    }
  };

  const closeAnalyzeModal = () => {
    if (analyzeStatus !== "analyzing") {
      setAnalyzeModalVisible(false);
      setAnalyzeStatus("idle");
      setStomachState(null);
      setProbeReady(false);
      setPendingRecord(null);
      setSerialDebugLines([]);
      setAnalyzeError(null);
      setAnalyzeStage(null);
      setCupsTodayInput("1");
      setIsNewCup(true);
    }
  };

  const handleRunGuidedCalibration = async () => {
    setCalibrationBusy(true);
    setCalibrationMessage("Measuring pH 4.0 buffer...");
    try {
      const low = await measureCalibrationBuffer("low");
      setCalibrationLowVoltage(low.voltage);

      setCalibrationMessage("Measuring pH 7.0 buffer...");
      const high = await measureCalibrationBuffer("high");
      setCalibrationHighVoltage(high.voltage);

      setCalibrationMessage("Applying calibration...");
      const updated = await applyDeviceSideCalibrationFromVoltages({
        lowVoltage: low.voltage,
        highVoltage: high.voltage,
      });
      if (updated.type !== "updated") {
        throw new Error("Calibration update response was invalid.");
      }

      setCalibrationMessage(
        `Done. slope=${updated.slope.toFixed(4)}, intercept=${updated.intercept.toFixed(4)}`
      );
    } catch (error) {
      setCalibrationMessage(error instanceof Error ? error.message : "Calibration failed.");
    } finally {
      setCalibrationBusy(false);
    }
  };

  const defaultAvatarSource = avatarIndex !== null ? DEFAULT_AVATARS[avatarIndex] : fallbackDefaultAvatar;

  useEffect(() => {
    if (analyzeStatus !== "analyzing") return;

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    const shimmerLoop = Animated.loop(
      Animated.timing(shimmerAnim, {
        toValue: 1,
        duration: 1300,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      })
    );

    pulseLoop.start();
    shimmerLoop.start();

    return () => {
      pulseLoop.stop();
      shimmerLoop.stop();
      pulseAnim.setValue(0);
      shimmerAnim.setValue(0);
    };
  }, [analyzeStatus, pulseAnim, shimmerAnim]);

  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: analyzeProgress,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [analyzeProgress, progressAnim]);

  // ── Fact card ─────────────────────────────────────────────────────────────
  const handlePressFact = useCallback((fact: FactType) => {
    setSelectedFact(fact);
  }, []);

  const renderFactCard = useCallback(
    ({ item }: { item: FactType }) => <FactCard fact={item} onPress={handlePressFact} />,
    [handlePressFact]
  );

  // ── Streak label ──────────────────────────────────────────────────────────
  const streakLabel = streakCount === 0
    ? "no streak yet"
    : streakCount === 1
    ? "you're on your 1st day!"
    : `you're on a ${streakCount}-day streak!`;

  return (
    <ThemedView style={styles.root}>

      {/* ── Header ── */}
      <ThemedView style={[styles.customHeader, { backgroundColor: Colors.light.background }]}>
        {/* streak pill */}
        <View style={[styles.headerSide, styles.headerSideLeft]}>
          <TouchableOpacity
            activeOpacity={0.8}
            style={styles.streakPill}
            onPress={() => setStreakPopupVisible(true)}
          >
            <StreakIcon width={15} height={15} style={styles.streakPillIcon} />
            <ThemedText style={[styles.streakNumber, { color: coffee }]}>{streakCount}</ThemedText>
          </TouchableOpacity>
        </View>

        {/* brand */}
        <View style={styles.headerMiddle}>
          <ThemedText style={[styles.acidexText, { color: coffee }]}>acidex.</ThemedText>
          <ThemedText style={[styles.analyzerText, { color: coffee }]}>your coffee analyzer</ThemedText>
        </View>

        {/* avatar */}
        <View style={[styles.headerSide, styles.headerSideRight]}>
          <TouchableOpacity onPress={() => router.push("/(auth)/profile")} activeOpacity={0.7}>
            <Image
              source={avatarUrl ? { uri: avatarUrl } : defaultAvatarSource}
              style={styles.avatarImage}
              contentFit="cover"
            />
          </TouchableOpacity>
        </View>
      </ThemedView>

      {/* ── Body ── */}
      <ThemedView style={styles.body}>

        {/* hero card */}
        <ThemedView style={[styles.darkCard, { backgroundColor: Colors.light.surface }]}>
          <Image
            source={require("../../assets/images/home-illustration.png")}
            style={styles.illustration}
            contentFit="contain"
          />
          <ThemedText style={styles.greetingText}>
            {getGreeting()}, {userName.split(" ")[0]}.
          </ThemedText>
          <TouchableOpacity
            style={[styles.analyzeButton, { backgroundColor: Colors.light.background }]}
            onPress={handleAnalyzePress}
            activeOpacity={0.85}
          >
            <ThemedText style={[styles.analyzeButtonText, { color: coffee }]}>
              analyze your coffee
            </ThemedText>
          </TouchableOpacity>
          <TouchableOpacity style={styles.devOtgToggle} onPress={refreshOtgStatus}>
            <ThemedText style={[styles.devOtgToggleText, { color: "rgba(255,255,255,0.6)" }]}>
              otg: {isOtgConnected ? "connected" : "not connected"}
            </ThemedText>
          </TouchableOpacity>
        </ThemedView>

        {/* did you know */}
        <ThemedText style={[styles.didYouKnowText, { color: text }]}>did you know?</ThemedText>

        {/* carousel */}
        <FlatList
          ref={flatListRef}
          data={loopedFacts}
          keyExtractor={(item, index) => `${item.id}-${index}`}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.horizontalScrollContent}
          renderItem={renderFactCard}
          onScroll={handleInfiniteScroll}
          onMomentumScrollEnd={(event) => {
            const raw = Math.round(event.nativeEvent.contentOffset.x / ITEM_SIZE);
            const next = loopedFacts.length > 0 ? ((raw % loopedFacts.length) + loopedFacts.length) % loopedFacts.length : 0;
            carouselIndexRef.current = next;
          }}
          scrollEventThrottle={16}
          decelerationRate="fast"
          snapToInterval={ITEM_SIZE}
          snapToAlignment="start"
          bounces={false}
          disableIntervalMomentum={false}
          getItemLayout={(_, index) => ({ length: ITEM_SIZE, offset: ITEM_SIZE * index, index })}
        />
      </ThemedView>

      {/* ── Streak popup ── */}
      <Modal
        visible={streakPopupVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setStreakPopupVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setStreakPopupVisible(false)}>
          <Pressable onPress={(e) => e.stopPropagation()}>
            <View style={styles.streakModal}>
              {/* flame icon area */}
              <View style={[styles.streakModalIconWrap, { backgroundColor: coffee + "18" }]}>
                <StreakIcon width={36} height={36} />
              </View>

              <ThemedText style={[styles.streakModalCount, { color: coffee }]}>
                {streakCount}
              </ThemedText>
              <ThemedText style={styles.streakModalDayLabel}>
                day{streakCount !== 1 ? "s" : ""} in a row
              </ThemedText>
              <ThemedText style={styles.streakModalMessage}>
                {streakLabel}
              </ThemedText>

              {/* progress dots */}
              {streakCount > 0 && (
                <View style={styles.streakDots}>
                  {Array.from({ length: Math.min(streakCount, 7) }).map((_, i) => (
                    <View
                      key={i}
                      style={[
                        styles.streakDot,
                        { backgroundColor: i < streakCount ? coffee : "#EDE3DC" },
                      ]}
                    />
                  ))}
                </View>
              )}

              <TouchableOpacity
                activeOpacity={0.85}
                style={[styles.streakModalClose, { backgroundColor: coffee }]}
                onPress={() => setStreakPopupVisible(false)}
              >
                <ThemedText style={styles.streakModalCloseText}>okay</ThemedText>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Fact detail modal ── */}
      <Modal
        visible={!!selectedFact}
        animationType="slide"
        transparent
        onRequestClose={() => setSelectedFact(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {selectedFact && (
              <>
                <FlatList
                  data={[selectedFact]}
                  keyExtractor={(item) => String(item.id)}
                  showsVerticalScrollIndicator={false}
                  renderItem={({ item }) => (
                    <View>
                      <Image source={item.image} style={styles.modalImage} contentFit="contain" />
                      <ThemedText style={[styles.modalTitle, { color: coffee }]}>{item.title}</ThemedText>
                      <ThemedText style={[styles.modalText, { color: text }]}>{item.fullText}</ThemedText>
                      <View style={styles.modalSuggestionBlock}>
                        <Ionicons name="bulb-outline" size={14} color={coffee} />
                        <ThemedText style={[styles.modalSuggestion, { color: coffee }]}>
                          {item.suggestion}
                        </ThemedText>
                      </View>
                    </View>
                  )}
                />
                <Pressable
                  style={[styles.closeButton, { backgroundColor: coffee }]}
                  onPress={() => setSelectedFact(null)}
                >
                  <ThemedText style={styles.closeButtonText}>close</ThemedText>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* ── Analyze modal ── */}
      <Modal
        visible={analyzeModalVisible}
        animationType="fade"
        transparent
        onRequestClose={closeAnalyzeModal}
      >
        <Pressable style={styles.modalOverlay} onPress={closeAnalyzeModal}>
          <Pressable onPress={(e) => e.stopPropagation()}>
            <View style={styles.analyzeModalContent}>

              {/* no device */}
              {analyzeStatus === "no-device" && (
                <>
                  <View style={[styles.analyzeIconCircle, { backgroundColor: "#FEF0D6" }]}>
                    <Ionicons name="hardware-chip-outline" size={28} color="#C38C49" />
                  </View>
                  <ThemedText style={[styles.analyzeModalTitle, { color: coffee }]}>
                    insert device
                  </ThemedText>
                  <ThemedText style={styles.analyzeModalText}>
                    No OTG-connected device was detected. Please insert the probe before analyzing.
                  </ThemedText>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={[styles.actionButton, { backgroundColor: coffee }]}
                    onPress={closeAnalyzeModal}
                  >
                    <ThemedText style={styles.actionButtonText}>okay</ThemedText>
                  </TouchableOpacity>
                </>
              )}

              {/* permission prompt */}
              {analyzeStatus === "usb-permission" && (
                <>
                  <View style={[styles.analyzeIconCircle, { backgroundColor: "#FEF0D6" }]}>
                    <Ionicons name="shield-checkmark-outline" size={28} color="#C38C49" />
                  </View>
                  <ThemedText style={[styles.analyzeModalTitle, { color: coffee }]}>
                    allow usb access
                  </ThemedText>
                  <ThemedText style={styles.analyzeModalText}>
                    Please allow access to the connected probe first, then tap continue to start analyzing.
                  </ThemedText>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={[styles.actionButton, { backgroundColor: coffee }]}
                    onPress={handleAnalyzePress}
                  >
                    <ThemedText style={styles.actionButtonText}>continue</ThemedText>
                  </TouchableOpacity>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={styles.dismissLink}
                    onPress={closeAnalyzeModal}
                  >
                    <ThemedText style={[styles.dismissLinkText, { color: coffee }]}>not now</ThemedText>
                  </TouchableOpacity>
                </>
              )}

              {/* error */}
              {analyzeStatus === "error" && (
                <>
                  <View style={[styles.analyzeIconCircle, { backgroundColor: "#FDE8E8" }]}>
                    <Ionicons name="alert-circle-outline" size={28} color="#D14B4B" />
                  </View>
                  <ThemedText style={[styles.analyzeModalTitle, { color: coffee }]}>
                    analysis failed
                  </ThemedText>
                  <ThemedText style={styles.analyzeModalText}>
                    {analyzeError ?? "The Arduino did not return a result in time. Please try again."}
                  </ThemedText>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={[styles.actionButton, { backgroundColor: coffee }]}
                    onPress={handleAnalyzePress}
                  >
                    <ThemedText style={styles.actionButtonText}>try again</ThemedText>
                  </TouchableOpacity>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={styles.dismissLink}
                    onPress={closeAnalyzeModal}
                  >
                    <ThemedText style={[styles.dismissLinkText, { color: coffee }]}>close</ThemedText>
                  </TouchableOpacity>
                </>
              )}

              {/* analyzing — parallel stomach log */}
              {analyzeStatus === "analyzing" && (
                <>
                  {/* spinner header */}
                  <Animated.View
                    style={[
                      styles.analyzeIconCircle,
                      {
                        backgroundColor: coffee + "18",
                        transform: [
                          {
                            scale: pulseAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0.96, 1.04],
                            }),
                          },
                        ],
                        opacity: pulseAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.78, 1],
                        }),
                      },
                    ]}
                  >
                    <ActivityIndicator size="small" color={coffee} />
                  </Animated.View>
                  <ThemedText style={[styles.analyzeModalTitle, { color: coffee }]}>
                    reading pH...
                  </ThemedText>
                  <ThemedText style={styles.analyzeModalText}>
                    While the probe reads, tell us your stomach state.
                  </ThemedText>

                  <View style={styles.analyzeProgressWrap}>
                    <View style={styles.analyzeProgressTrack}>
                      <Animated.View
                        style={[
                          styles.analyzeProgressFill,
                          {
                            backgroundColor: coffee,
                            width: progressAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: ["8%", "100%"],
                            }),
                          },
                        ]}
                      />
                      <Animated.View
                        pointerEvents="none"
                        style={[
                          styles.analyzeProgressShimmer,
                          {
                            transform: [
                              {
                                translateX: shimmerAnim.interpolate({
                                  inputRange: [0, 1],
                                  outputRange: [-80, width * 0.62],
                                }),
                              },
                            ],
                          },
                        ]}
                      />
                    </View>
                    <ThemedText style={[styles.analyzeProgressText, { color: coffee }]}>
                      {analyzeHint}
                    </ThemedText>
                  </View>

                  {/* stomach log card */}
                  <View style={styles.stomachCard}>
                    <View style={styles.stomachCardHeader}>
                      <Ionicons name="body-outline" size={14} color="#8B5E3C" />
                      <ThemedText style={styles.stomachCardTitle}>stomach state</ThemedText>
                    </View>

                    <View style={styles.stomachOptions}>
                      {(["Empty stomach", "After meal"] as StomachState[]).map((opt) => {
                        const active = stomachState === opt;
                        const icon   = opt === "Empty stomach" ? "time-outline" : "restaurant-outline";
                        return (
                          <TouchableOpacity
                            key={opt}
                            activeOpacity={0.8}
                            style={[styles.stomachOption, active && { backgroundColor: coffee, borderColor: coffee }]}
                            onPress={() => setStomachState(opt)}
                          >
                            <Ionicons
                              name={icon}
                              size={18}
                              color={active ? "#FFF" : "#8B5E3C"}
                            />
                            <ThemedText style={[styles.stomachOptionText, active && { color: "#FFF" }]}>
                              {opt}
                            </ThemedText>
                            {active && (
                              <Ionicons name="checkmark-circle" size={15} color="rgba(255,255,255,0.75)" />
                            )}
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <View style={styles.newCupRow}>
                      <ThemedText style={styles.newCupLabel}>new cup?</ThemedText>
                      <View style={styles.newCupOptions}>
                        <TouchableOpacity
                          activeOpacity={0.8}
                          style={[styles.newCupOption, isNewCup && { backgroundColor: coffee, borderColor: coffee }]}
                          onPress={() => setIsNewCup(true)}
                        >
                          <ThemedText style={[styles.newCupOptionText, isNewCup && { color: "#FFF" }]}>yes</ThemedText>
                        </TouchableOpacity>
                        <TouchableOpacity
                          activeOpacity={0.8}
                          style={[styles.newCupOption, !isNewCup && { backgroundColor: coffee, borderColor: coffee }]}
                          onPress={() => setIsNewCup(false)}
                        >
                          <ThemedText style={[styles.newCupOptionText, !isNewCup && { color: "#FFF" }]}>no</ThemedText>
                        </TouchableOpacity>
                      </View>
                    </View>
                    <View style={styles.cupsRow}>
                      <ThemedText style={styles.cupsLabel}>cups today</ThemedText>
                      <TextInput
                        value={cupsTodayInput}
                        onChangeText={setCupsTodayInput}
                        keyboardType="number-pad"
                        style={styles.cupsInput}
                        maxLength={2}
                      />
                    </View>

                    {stomachState ? (
                      <View style={styles.stomachConfirmed}>
                        <Ionicons name="checkmark-circle-outline" size={13} color="#27AE60" />
                        <ThemedText style={styles.stomachConfirmedText}>logged — you can still change it</ThemedText>
                      </View>
                    ) : probeReady ? (
                      <View style={styles.stomachConfirmed}>
                        <Ionicons name="alert-circle-outline" size={13} color="#C38C49" />
                        <ThemedText style={[styles.stomachConfirmedText, { color: "#C38C49" }]}>
                          probe done — please log your stomach state to continue
                        </ThemedText>
                      </View>
                    ) : (
                      <ThemedText style={styles.stomachHint}>optional, but helps with health advice</ThemedText>
                    )}
                  </View>

                </>
              )}

              {/* done */}
              {analyzeStatus === "done" && (
                <>
                  <View style={[styles.analyzeIconCircle, { backgroundColor: "#DCF0E4" }]}>
                    <Ionicons name="checkmark-circle-outline" size={28} color="#27AE60" />
                  </View>
                  <ThemedText style={[styles.analyzeModalTitle, { color: coffee }]}>
                    analysis complete
                  </ThemedText>
                  <ThemedText style={styles.analyzeModalText}>
                    Your result is ready. Tap below to view your latest coffee analysis.
                  </ThemedText>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={[styles.actionButton, { backgroundColor: coffee }]}
                    onPress={() => {
                      closeAnalyzeModal();
                      router.push("/(tabs)/results");
                    }}
                  >
                    <ThemedText style={styles.actionButtonText}>view results</ThemedText>
                  </TouchableOpacity>
                  <TouchableOpacity
                    activeOpacity={0.7}
                    style={styles.dismissLink}
                    onPress={closeAnalyzeModal}
                  >
                    <ThemedText style={[styles.dismissLinkText, { color: coffee }]}>dismiss</ThemedText>
                  </TouchableOpacity>
                </>
              )}

              <TouchableOpacity
                activeOpacity={0.7}
                style={styles.dismissLink}
                onPress={() => setCalibrationHelpVisible(true)}
              >
                <ThemedText style={[styles.dismissLinkText, { color: coffee }]}>
                  open calibration helper
                </ThemedText>
              </TouchableOpacity>

            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={calibrationHelpVisible}
        onRequestClose={() => setCalibrationHelpVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setCalibrationHelpVisible(false)}>
          <Pressable style={styles.calibrationModal} onPress={() => null}>
            <ThemedText style={styles.calibrationTitle}>calibration helper</ThemedText>
            <ThemedText style={styles.calibrationSubtitle}>
              Follow these steps before your next analysis.
            </ThemedText>

            {[
              { icon: "water-outline", text: "Rinse probe and place it in pH 4.0 buffer." },
              { icon: "pause-circle-outline", text: "Wait until reading stabilizes for 10-15 seconds." },
              { icon: "flask-outline", text: "Rinse probe, then place it in pH 7.0 buffer." },
              { icon: "checkmark-done-outline", text: "Run calibration and verify slope/intercept update." },
            ].map((step, index) => (
              <View key={step.text} style={styles.calibrationStepRow}>
                <View style={styles.calibrationStepIndex}>
                  <ThemedText style={styles.calibrationStepIndexText}>{index + 1}</ThemedText>
                </View>
                <Ionicons name={step.icon as keyof typeof Ionicons.glyphMap} size={16} color="#8B5E3C" />
                <ThemedText style={styles.calibrationStepText}>{step.text}</ThemedText>
              </View>
            ))}

            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.actionButton, { backgroundColor: coffee, marginTop: 16 }]}
              onPress={handleRunGuidedCalibration}
              disabled={calibrationBusy}
            >
              <ThemedText style={styles.actionButtonText}>
                {calibrationBusy ? "running..." : "run guided calibration"}
              </ThemedText>
            </TouchableOpacity>
            {calibrationLowVoltage !== null && (
              <ThemedText style={styles.calibrationMeta}>
                pH 4.0 voltage: {calibrationLowVoltage.toFixed(4)}
              </ThemedText>
            )}
            {calibrationHighVoltage !== null && (
              <ThemedText style={styles.calibrationMeta}>
                pH 7.0 voltage: {calibrationHighVoltage.toFixed(4)}
              </ThemedText>
            )}
            {calibrationMessage && (
              <ThemedText style={styles.calibrationMeta}>{calibrationMessage}</ThemedText>
            )}
            <TouchableOpacity
              activeOpacity={0.7}
              style={styles.dismissLink}
              onPress={() => setCalibrationHelpVisible(false)}
            >
              <ThemedText style={[styles.dismissLinkText, { color: coffee }]}>close</ThemedText>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

    </ThemedView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },

  // header
  customHeader: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 50, paddingBottom: 15,
  },
  headerSide:      { flex: 1, justifyContent: "center" },
  headerSideLeft:  { alignItems: "flex-start" },
  headerSideRight: { alignItems: "flex-end" },
  headerMiddle:    { flex: 1, alignItems: "center", justifyContent: "center" },

  streakPill: {
    flexDirection: "row", alignItems: "center",
    borderWidth: 1, borderColor: "rgba(60,44,36,0.22)",
    borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5,
  },
  streakPillIcon: { marginRight: 5 },
  streakNumber:   { fontSize: 13, fontWeight: "600" },
  acidexText:     { fontSize: 18, fontWeight: "700", lineHeight: 20, textAlign: "center" },
  analyzerText:   { fontSize: 12, opacity: 0.6, textAlign: "center" },
  avatarImage:    { width: 35, height: 35, borderRadius: 16 },

  // body
  body: { flex: 1, paddingTop: 5, paddingBottom: 12 },

  // hero card
  darkCard: {
    borderRadius: 20, paddingHorizontal: 20,
    marginTop: 12, marginBottom: 40, marginHorizontal: 16,
    alignItems: "center",
  },
  illustration: {
    width: 240, height: 135, alignSelf: "center", marginTop: 40, marginBottom: 4,
  },
  greetingText: {
    color: Colors.light.background, fontSize: 19, fontWeight: "600",
    marginTop: 6, marginBottom: 45, textAlign: "center",
  },
  analyzeButton: {
    paddingVertical: 11, paddingHorizontal: 30, borderRadius: 30,
  },
  analyzeButtonText: { fontSize: 15, fontWeight: "700", textTransform: "lowercase" },

  devOtgToggle:     { marginTop: 8, marginBottom: 10, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 },
  devOtgToggleText: { fontSize: 10, textTransform: "lowercase" },

  // carousel
  didYouKnowText: {
    fontSize: 17, fontStyle: "italic", fontWeight: "600",
    marginBottom: 10, textAlign: "center",
  },
  horizontalScrollContent: {
    paddingLeft: SIDE_SPACING, paddingRight: SIDE_SPACING - CARD_GAP,
    paddingTop: 4, paddingBottom: 10,
  },
  cardWrapper: { width: CARD_WIDTH, marginRight: CARD_GAP },
  cardWrapperPressed: { transform: [{ scale: 0.985 }] },
  smallCard: {
    width: "100%", height: FACT_CARD_HEIGHT,
    borderRadius: 18, padding: 10,
    alignItems: "center", justifyContent: "flex-start",
    backgroundColor: "#FFFAF7",
    borderWidth: 1, borderColor: "#EDE3DC",
    shadowColor: "#6B4E3D",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  coffeeImage:   { width: "85%", height: 120, marginBottom: 6 },
  smallCardText: { fontSize: 12, textAlign: "center", fontWeight: "500", lineHeight: 17, paddingHorizontal: 4, color: "#4B3A33" },

  // modal shared
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center", alignItems: "center", padding: 20,
  },

  // streak popup
  streakModal: {
    width: width * 0.78, backgroundColor: "#FFFAF7",
    borderRadius: 24, padding: 24, alignItems: "center",
    borderWidth: 1, borderColor: "#EDE3DC",
  },
  streakModalIconWrap: {
    width: 70, height: 70, borderRadius: 35,
    alignItems: "center", justifyContent: "center", marginBottom: 14,
  },
  streakModalCount: {
    fontSize: 48, fontWeight: "700", lineHeight: 52, letterSpacing: -1,
  },
  streakModalDayLabel: {
    fontSize: 13, color: "#A08880", marginTop: 2, marginBottom: 8,
  },
  streakModalMessage: {
    fontSize: 14, fontWeight: "600", color: "#3C2C24",
    textAlign: "center", marginBottom: 16,
  },
  streakDots:  { flexDirection: "row", gap: 6, marginBottom: 20 },
  streakDot:   { width: 8, height: 8, borderRadius: 4 },
  streakModalClose: {
    width: "100%", paddingVertical: 12, borderRadius: 999, alignItems: "center",
  },
  streakModalCloseText: { color: "#FFF", fontSize: 14, fontWeight: "600", textTransform: "lowercase" },

  // fact modal
  modalContent: {
    width: "100%", maxHeight: "85%",
    backgroundColor: "#FFFAF7", borderRadius: 22, padding: 20,
    borderWidth: 1, borderColor: "#EDE3DC",
  },
  modalImage:  { width: "100%", height: 180, marginBottom: 15 },
  modalTitle:  { fontSize: 17, fontWeight: "700", marginBottom: 10, textAlign: "center" },
  modalText:   { fontSize: 13, lineHeight: 21, marginBottom: 14, color: "#4B3A33", textAlign: "justify" },
  modalSuggestionBlock: {
    flexDirection: "row", alignItems: "flex-start", gap: 6,
    backgroundColor: "rgba(139,94,60,0.07)", borderRadius: 12,
    padding: 10, marginBottom: 16,
  },
  modalSuggestion:      { flex: 1, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  closeButton:     { marginTop: 16, paddingVertical: 12, borderRadius: 999, alignItems: "center" },
  closeButtonText: { color: "#FFF", fontSize: 14, fontWeight: "600", textTransform: "lowercase" },

  // analyze modal
  analyzeModalContent: {
    width: width * 0.82, backgroundColor: "#FFFAF7",
    borderRadius: 24, padding: 24, alignItems: "center",
    borderWidth: 1, borderColor: "#EDE3DC",
  },
  analyzeIconCircle: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: "center", justifyContent: "center", marginBottom: 16,
  },
  analyzeModalTitle: {
    fontSize: 17, fontWeight: "700", textAlign: "center",
    textTransform: "lowercase", marginBottom: 8,
  },
  analyzeModalText: {
    fontSize: 13, lineHeight: 20, textAlign: "center",
    color: "#7A675C", marginBottom: 20,
  },
  analyzeProgressText: {
    fontSize: 12,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 8,
    fontWeight: "600",
    textTransform: "lowercase",
  },
  analyzeProgressWrap: {
    width: "100%",
    marginBottom: 16,
  },
  analyzeProgressTrack: {
    width: "100%",
    height: 10,
    backgroundColor: "#E9DDD5",
    borderRadius: 999,
    overflow: "hidden",
  },
  analyzeProgressFill: {
    height: "100%",
    borderRadius: 999,
  },
  analyzeProgressShimmer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 70,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.45)",
  },

  actionButton: {
    width: "100%", paddingVertical: 12, borderRadius: 999,
    alignItems: "center", justifyContent: "center",
  },
  actionButtonText: { color: "#FFF", fontSize: 14, fontWeight: "600", textTransform: "lowercase", textAlign: "center" },
  dismissLink:      { marginTop: 12, paddingVertical: 4 },
  dismissLinkText:  { fontSize: 13, fontWeight: "500", opacity: 0.7, textTransform: "lowercase" },

  // stomach log (shown during analysis)
  stomachCard: {
    width: "100%",
    backgroundColor: "#F4EEEA",
    borderRadius: 16, padding: 14,
    marginBottom: 16,
  },
  stomachCardHeader: {
    flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12,
  },
  stomachCardTitle: {
    fontSize: 12, fontWeight: "700", color: "#3C2C24", textTransform: "lowercase",
  },
  stomachOptions: { gap: 8 },
  stomachOption: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: "#FFFAF7",
    borderWidth: 1, borderColor: "#EDE3DC",
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
  },
  stomachOptionText: {
    flex: 1, fontSize: 13, fontWeight: "600", color: "#3C2C24",
  },
  newCupRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  newCupLabel: {
    fontSize: 12,
    color: "#3C2C24",
    fontWeight: "600",
    textTransform: "lowercase",
  },
  newCupOptions: { flexDirection: "row", gap: 8 },
  newCupOption: {
    minWidth: 54,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#EDE3DC",
    backgroundColor: "#FFFAF7",
  },
  newCupOptionText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#3C2C24",
    textTransform: "lowercase",
  },
  stomachConfirmed: {
    flexDirection: "row", alignItems: "center", gap: 5, marginTop: 10,
  },
  stomachConfirmedText: {
    fontSize: 11, color: "#27AE60", fontWeight: "500",
  },
  stomachHint: {
    fontSize: 11, color: "#A08880", marginTop: 10, textAlign: "center",
  },
  cupsRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FFFAF7",
    borderWidth: 1,
    borderColor: "#EDE3DC",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  cupsLabel: {
    fontSize: 12,
    color: "#3C2C24",
    fontWeight: "600",
    textTransform: "lowercase",
  },
  cupsInput: {
    minWidth: 40,
    textAlign: "center",
    backgroundColor: "#F4EEEA",
    borderRadius: 8,
    paddingVertical: 6,
    color: "#2E211B",
    fontWeight: "700",
  },
  calibrationModal: {
    width: width * 0.86,
    backgroundColor: "#FFFAF7",
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: "#EDE3DC",
  },
  calibrationTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#2E211B",
    textTransform: "lowercase",
  },
  calibrationSubtitle: {
    marginTop: 4,
    marginBottom: 12,
    fontSize: 12,
    color: "#7A675C",
  },
  calibrationStepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },
  calibrationStepIndex: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#F4EEEA",
    alignItems: "center",
    justifyContent: "center",
  },
  calibrationStepIndexText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#8B5E3C",
  },
  calibrationStepText: {
    flex: 1,
    fontSize: 12,
    color: "#4B3A33",
    lineHeight: 18,
  },
  calibrationMeta: {
    marginTop: 8,
    fontSize: 11,
    color: "#6C564B",
    lineHeight: 16,
  },
  serialDebugCard: {
    width: "100%",
    backgroundColor: "#F8F1EA",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#E7D8CC",
    padding: 12,
    marginBottom: 16,
  },
  serialDebugHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  serialDebugTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#3C2C24",
    textTransform: "lowercase",
  },
  serialDebugList: {
    maxHeight: 120,
  },
  serialDebugLine: {
    fontSize: 11,
    lineHeight: 16,
    color: "#5E4A40",
    fontFamily: "monospace",
    marginBottom: 4,
  },
});

