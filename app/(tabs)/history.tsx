import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import Colors from "@/constants/colors";
import { useThemeColor } from "@/hooks/use-theme-color";
import { BookmarkStore } from "@/src/data/bookmarkStore";
import { CollectionStore } from "@/src/data/collectionStore";
import { syncHistoryRecordToSupabase } from "@/src/services/historySync";
import { deleteAnalysisRecord, getStoredAnalysisHistory, saveAnalysisRecord } from "@/src/store/analysisStore";
import { AnalysisRecord } from "@/src/types/analysis";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
<<<<<<< HEAD
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
=======
  Animated,
    Modal,
    Pressable,
    ScrollView,
    Share,
  Easing,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    View,
>>>>>>> my-updates
} from "react-native";

// ─── Constants ────────────────────────────────────────────────────────────────

const CLASSIFICATION_COLORS: Record<string, { bg: string; text: string; badge: string }> = {
  "Highly Acidic": { bg: "#FCDEDE", text: "#8C1A1A", badge: "#E74C3C" },
  "Moderate":      { bg: "#FEF0D6", text: "#7A4A00", badge: "#F39C12" },
  "Low Acidic":    { bg: "#DCF0E4", text: "#1A5C34", badge: "#27AE60" },
};

const RISK_COLORS: Record<string, { bg: string; text: string }> = {
  "High Risk":     { bg: "#FCDEDE", text: "#8C1A1A" },
  "Moderate Risk": { bg: "#FEF0D6", text: "#7A4A00" },
  "Low Risk":      { bg: "#DCF0E4", text: "#1A5C34" },
};

type ToastType = "delete" | "bookmark" | "collection";

const TOAST_CONFIG: Record<
  ToastType,
  { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string; border: string; label: string }
> = {
  delete: {
    icon: "trash-outline",
    color: "#B56B5B",
    bg: "#F8EEEA",
    border: "#E6D6CF",
    label: "deleted",
  },
  bookmark: {
    icon: "bookmark",
    color: "#4A3728",
    bg: "#FFFAF7",
    border: "#EDE3DC",
    label: "bookmarked",
  },
  collection: {
    icon: "albums-outline",
    color: "#4A3728",
    bg: "#F4EEEA",
    border: "#E0D5CC",
    label: "added to collection",
  },
};

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
        s.toast,
        {
          opacity,
          transform: [{ translateY }],
          backgroundColor: config.bg,
          borderColor: config.border,
        },
      ]}
    >
      <Ionicons name={config.icon} size={15} color={config.color} />
      <ThemedText style={[s.toastText, { color: config.color }]}>
        {config.label}
      </ThemedText>
    </Animated.View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCardDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now  = new Date();
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return `Today, ${time}`;
  return `${date.toLocaleDateString("en-US", { month: "long", day: "numeric" })}, ${time}`;
}

function formatDetailDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function getHealthAdvisory(item: AnalysisRecord): string {
  if (item.riskLevel === "High Risk")
    return "High likelihood of discomfort: Consider reducing intake or drinking after meals.";
  if (item.riskLevel === "Moderate Risk")
    return "Possible discomfort: Better timing and hydration may help reduce irritation.";
  return "Lower likelihood of discomfort: Continue monitoring and drink in moderation.";
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function HistoryScreen() {
  const params = useLocalSearchParams<{ filter?: string }>();
  const hasAppliedRouteFilter = useRef(false);
  const coffee = useThemeColor({}, "coffee");
  const [records,        setRecords]        = useState<AnalysisRecord[]>([]);

  const [search,         setSearch]         = useState("");
  const [selectedFilter, setSelectedFilter] = useState("All");
  const [expandedId,     setExpandedId]     = useState<string | null>(null);
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [renameText, setRenameText] = useState("");
  const [renameTarget, setRenameTarget] = useState<AnalysisRecord | null>(null);
  const [collections, setCollections] = useState(CollectionStore.getAll());
  const [collectionModalVisible, setCollectionModalVisible] = useState(false);
  const [collectionTarget, setCollectionTarget] = useState<AnalysisRecord | null>(null);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AnalysisRecord | null>(null);
  const [deleteModalKind, setDeleteModalKind] = useState<"record" | "collection" | null>(null);
  const [deleteCollectionTarget, setDeleteCollectionTarget] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [toastType, setToastType] = useState<ToastType>("bookmark");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const loadRecords = React.useCallback(async () => {
    const stored = await getStoredAnalysisHistory();
    const sorted = [...stored].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    setRecords(sorted);
    setExpandedId((current) => current ?? sorted[0]?.id ?? null);
  }, []);

  const showToast = (type: ToastType) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToastType(type);
    setToastVisible(true);
    toastTimer.current = setTimeout(() => setToastVisible(false), 1800);
  };

  const handleExportSummary = async () => {
    if (!filteredRecords.length) return;

    const items = filteredRecords.slice(0, 5).map((item) => {
      const label = item.riskLevel ? ` • ${item.riskLevel}` : "";
      return `${item.coffeeType} - pH ${item.ph.toFixed(1)}${label}`;
    });

    await Share.share({
      title: "Acidex history summary",
      message: [`Acidex history summary`, `Showing ${filteredRecords.length} record${filteredRecords.length !== 1 ? "s" : ""}.`, ...items].join("\n"),
    });
  };

  useEffect(() => {
    void loadRecords();
    void CollectionStore.load();
    const unsubCollections = CollectionStore.subscribe(setCollections);

    return () => {
      unsubCollections();
    };
  }, [loadRecords]);

  useFocusEffect(
    React.useCallback(() => {
      void loadRecords();
    }, [loadRecords])
  );

  const filters = useMemo(() => {
    const uniqueCoffeeTypes = Array.from(new Set(records.map((item) => item.coffeeType))).filter(Boolean);
    const collectionNames = Object.keys(collections).map((name) => `Collection: ${name}`);
    return ["All", "Favorites", ...collectionNames, ...uniqueCoffeeTypes];
  }, [records, collections]);

  useEffect(() => {
    if (hasAppliedRouteFilter.current) return;
    const requestedFilter = typeof params.filter === "string" ? params.filter : undefined;
    if (!requestedFilter) return;
    if (filters.includes(requestedFilter)) {
      setSelectedFilter(requestedFilter);
      hasAppliedRouteFilter.current = true;
    }
  }, [filters, params.filter]);

  const sortedRecords = records;

  const filteredRecords = useMemo(() =>
    sortedRecords.filter((item) => {
      const isFavorite = BookmarkStore.isBookmarked(item.id);
      const matchFilter =
        selectedFilter === "All" ||
        (selectedFilter === "Favorites" && isFavorite) ||
        (selectedFilter.startsWith("Collection: ") &&
          (collections[selectedFilter.replace("Collection: ", "")] ?? []).includes(item.id)) ||
        item.coffeeType === selectedFilter;
      const q = search.trim().toLowerCase();
      const matchSearch = !q ||
        item.coffeeType.toLowerCase().includes(q) ||
        item.classification.toLowerCase().includes(q) ||
        (item.note ?? "").toLowerCase().includes(q) ||
        formatCardDate(item.createdAt).toLowerCase().includes(q);
      return matchFilter && matchSearch;
    }), [sortedRecords, selectedFilter, search, collections]);

  const openRenameModal = (item: AnalysisRecord) => {
    setRenameTarget(item);
    setRenameText(item.coffeeType ?? "");
    setRenameModalVisible(true);
  };

  const closeRenameModal = () => {
    setRenameModalVisible(false);
    setRenameTarget(null);
    setRenameText("");
  };

  const saveRename = async () => {
    if (!renameTarget) return;

    const nextName = renameText.trim() || renameTarget.coffeeType;
    console.log("edit coffee_type pressed:", { id: renameTarget.id, coffee_type: nextName });
    const nextRecord: AnalysisRecord = {
      ...renameTarget,
      coffeeType: nextName,
    };

    await saveAnalysisRecord(nextRecord);
    setRecords((current) => current.map((item) => (item.id === nextRecord.id ? nextRecord : item)));
    if (expandedId === nextRecord.id) {
      setExpandedId(nextRecord.id);
    }
    closeRenameModal();
  };

  const deleteRecord = (item: AnalysisRecord) => {
    setDeleteTarget(item);
    setDeleteCollectionTarget("");
    setDeleteModalKind("record");
    setDeleteModalVisible(true);
  };

  const deleteCollection = (collectionName: string) => {
    setDeleteTarget(null);
    setDeleteCollectionTarget(collectionName);
    setDeleteModalKind("collection");
    setDeleteModalVisible(true);
  };

  const cancelDeleteRecord = () => {
    setDeleteModalVisible(false);
    setDeleteTarget(null);
    setDeleteCollectionTarget("");
    setDeleteModalKind(null);
  };

  const confirmDeleteRecord = async () => {
    if (deleteModalKind === "collection") {
      if (!deleteCollectionTarget) return;
      console.log("delete collection pressed:", { collection: deleteCollectionTarget });
      await CollectionStore.removeCollection(deleteCollectionTarget);
      if (selectedFilter === `Collection: ${deleteCollectionTarget}`) {
        setSelectedFilter("All");
      }
      showToast("delete");
      cancelDeleteRecord();
      return;
    }

    if (!deleteTarget) return;

    console.log("delete pressed:", { id: deleteTarget.id, is_deleted: true });
    await deleteAnalysisRecord(deleteTarget.id);
    await CollectionStore.removeRecordFromAll(deleteTarget.id);
    BookmarkStore.remove(deleteTarget.id);
    setRecords((current) => current.filter((record) => record.id !== deleteTarget.id));
    if (expandedId === deleteTarget.id) {
      setExpandedId(null);
    }
    showToast("delete");
    cancelDeleteRecord();
  };

  const openCollectionModal = (item: AnalysisRecord) => {
    setCollectionTarget(item);
    setNewCollectionName("");
    setCollectionModalVisible(true);
  };

  const toggleCollectionMembership = async (collectionName: string) => {
    if (!collectionTarget) return;
    await CollectionStore.toggle(collectionName, collectionTarget.id);
    showToast("collection");
  };

  const createCollectionWithTarget = async () => {
    if (!collectionTarget) return;
    const name = newCollectionName.trim();
    if (!name) return;
    await CollectionStore.create(name, [collectionTarget.id]);
    setNewCollectionName("");
    showToast("collection");
  };

  return (
    <ThemedView style={s.screen}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Header (unchanged) ── */}
        <ThemedView style={[s.header, { backgroundColor: Colors.light.background }]}>
          <View style={s.headerMiddle}>
            <ThemedText style={[s.title, { color: coffee }]}>history.</ThemedText>
            <ThemedText style={s.subtitle}>your full analysis log</ThemedText>
          </View>
        </ThemedView>

        {/* ── Search + filters ── */}
        <View style={s.searchBlock}>
          {/* search bar */}
          <View style={s.searchRow}>
            <Ionicons name="search" size={16} color="#A08880" />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search history"
              placeholderTextColor="#C4A882"
              style={s.searchInput}
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch("")} activeOpacity={0.7}>
                <Ionicons name="close-circle" size={16} color="#C4A882" />
              </TouchableOpacity>
            )}
            <TouchableOpacity style={s.shareInlineBtn} onPress={handleExportSummary} activeOpacity={0.8}>
              <Ionicons name="share-social-outline" size={16} color="#4A3728" />
            </TouchableOpacity>
          </View>

          {/* filter chips */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.filterRow}
          >
            {filters.map((f) => {
              const active = selectedFilter === f;
              const isCollectionFilter = f.startsWith("Collection: ");
              return (
                <TouchableOpacity
                  key={f}
                  activeOpacity={0.8}
                  onPress={() => setSelectedFilter(f)}
                  onLongPress={isCollectionFilter ? () => deleteCollection(f.replace("Collection: ", "")) : undefined}
                  delayLongPress={250}
                  style={[s.filterChip, active && s.filterChipActive]}
                >
                  <ThemedText style={[s.filterChipText, active && s.filterChipTextActive]}>
                    {f}
                  </ThemedText>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

        </View>

        {/* ── Count row ── */}
        {filteredRecords.length > 0 && (
          <View style={s.countRow}>
            <ThemedText style={s.countText}>
              {filteredRecords.length} record{filteredRecords.length !== 1 ? "s" : ""}
            </ThemedText>
          </View>
        )}

        {/* ── List ── */}
        {filteredRecords.length === 0 ? (
          <View style={s.emptyCard}>
            <ThemedText style={s.emptyText}>No analysis records found.</ThemedText>
          </View>
        ) : (
          filteredRecords.map((item) =>
            expandedId === item.id
              ? <ExpandedCard key={item.id} item={item} onCollapse={() => setExpandedId(null)} onRename={() => openRenameModal(item)} onDelete={() => deleteRecord(item)} onAddToCollection={() => openCollectionModal(item)} onOpenResult={() => router.push({ pathname: "/(tabs)/results", params: { recordId: item.id } })} onBookmarkToast={() => showToast("bookmark")} />
              : <CollapsedCard key={item.id} item={item} onExpand={() => setExpandedId(item.id)} onDelete={() => deleteRecord(item)} onAddToCollection={() => openCollectionModal(item)} onOpenResult={() => router.push({ pathname: "/(tabs)/results", params: { recordId: item.id } })} onBookmarkToast={() => showToast("bookmark")} />
          )
        )}
      </ScrollView>

      <View style={s.toastWrapper} pointerEvents="none">
        <Toast visible={toastVisible} type={toastType} />
      </View>

      <Modal
        transparent
        animationType="fade"
        visible={deleteModalVisible}
        onRequestClose={cancelDeleteRecord}
      >
        <Pressable style={s.deleteOverlay} onPress={cancelDeleteRecord}>
          <Pressable style={s.deleteModalShell} onPress={(e) => e.stopPropagation()}>
            <View style={s.deleteModal}>
              <ThemedText style={s.deleteTitle}>
                {deleteModalKind === "collection" ? "Delete collection?" : "Delete record?"}
              </ThemedText>
              <ThemedText style={s.deleteSubtitle}>
                {deleteModalKind === "collection"
                  ? deleteCollectionTarget
                    ? `Remove collection "${deleteCollectionTarget}"?`
                    : "This cannot be undone."
                  : deleteTarget
                    ? `Remove "${deleteTarget.coffeeType}" from history?`
                    : "This cannot be undone."}
              </ThemedText>

              <View style={s.deleteActions}>
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[s.deleteActionBtn, s.deleteCancelBtn]}
                  onPress={cancelDeleteRecord}
                >
                  <ThemedText style={s.deleteCancelText}>cancel</ThemedText>
                </TouchableOpacity>

                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[s.deleteActionBtn, s.deleteConfirmBtn]}
                  onPress={() => void confirmDeleteRecord()}
                >
                  <ThemedText style={s.deleteConfirmText}>delete</ThemedText>
                </TouchableOpacity>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={renameModalVisible}
        onRequestClose={closeRenameModal}
      >
        <Pressable style={s.renameOverlay} onPress={closeRenameModal}>
          <Pressable style={s.renameModal} onPress={() => null}>
            <View style={s.renameHeader}>
              <ThemedText style={s.renameTitle}>Rename coffee</ThemedText>
              <ThemedText style={s.renameSubtitle}>This updates the history record</ThemedText>
            </View>
            <TextInput
              style={s.renameInput}
              value={renameText}
              onChangeText={setRenameText}
              placeholder="e.g., Afternoon coffee"
              placeholderTextColor="#A08880"
              maxLength={40}
              autoFocus
            />
            <View style={s.renameActions}>
              <TouchableOpacity
                style={[s.renameBtn, s.renameCancel]}
                onPress={closeRenameModal}
                activeOpacity={0.7}
              >
                <ThemedText style={s.renameCancelText}>cancel</ThemedText>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.renameBtn, s.renameSave]}
                onPress={saveRename}
                activeOpacity={0.7}
              >
                <ThemedText style={s.renameSaveText}>save</ThemedText>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={collectionModalVisible}
        onRequestClose={() => setCollectionModalVisible(false)}
      >
        <Pressable style={s.renameOverlay} onPress={() => setCollectionModalVisible(false)}>
          <Pressable style={s.renameModal} onPress={() => null}>
            <View style={s.renameHeader}>
              <ThemedText style={s.renameTitle}>Add to collection</ThemedText>
              <ThemedText style={s.renameSubtitle}>{collectionTarget?.coffeeType ?? ""}</ThemedText>
            </View>
            <TextInput
              style={s.renameInput}
              value={newCollectionName}
              onChangeText={setNewCollectionName}
              placeholder="new collection name"
              placeholderTextColor="#A08880"
              maxLength={40}
            />
            <TouchableOpacity style={s.collectionCreateBtn} onPress={() => void createCollectionWithTarget()} activeOpacity={0.8}>
              <Ionicons name="add" size={14} color="#4A3728" />
              <ThemedText style={s.collectionCreateText}>create and add</ThemedText>
            </TouchableOpacity>
            <ScrollView style={s.collectionList}>
              {Object.keys(collections).map((name) => {
                const selected = collectionTarget ? (collections[name] ?? []).includes(collectionTarget.id) : false;
                return (
                  <TouchableOpacity key={name} style={s.collectionRow} onPress={() => void toggleCollectionMembership(name)} activeOpacity={0.8}>
                    <ThemedText style={s.collectionName}>{name}</ThemedText>
                    <Ionicons name={selected ? "checkmark-circle" : "ellipse-outline"} size={18} color={selected ? "#4A3728" : "#A08880"} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </ThemedView>
  );
}

// ─── Collapsed Card ───────────────────────────────────────────────────────────

function CollapsedCard({ item, onExpand, onDelete, onAddToCollection, onOpenResult, onBookmarkToast }: { item: AnalysisRecord; onExpand: () => void; onDelete: () => void; onAddToCollection: () => void; onOpenResult: () => void; onBookmarkToast: () => void }) {
  const cls  = CLASSIFICATION_COLORS[item.classification] ?? CLASSIFICATION_COLORS["Moderate"];
  const risk = RISK_COLORS[item.riskLevel ?? "Low Risk"]  ?? RISK_COLORS["Low Risk"];

  const [isBookmarked, setIsBookmarked] = useState<boolean>(BookmarkStore.isBookmarked(item.id));

  useEffect(() => {
    const unsub = BookmarkStore.subscribe(() => setIsBookmarked(BookmarkStore.isBookmarked(item.id)));
    return unsub;
  }, [item.id]);

  const handleBookmarkToggle = () => {
    if (isBookmarked) {
      console.log("bookmark pressed:", { id: item.id, is_bookmarked: false });
      BookmarkStore.remove(item.id);
      onBookmarkToast();
      void syncHistoryRecordToSupabase(item, false);
      return;
    }

    console.log("bookmark pressed:", { id: item.id, is_bookmarked: true });
    BookmarkStore.add(item);
    onBookmarkToast();
    void syncHistoryRecordToSupabase(item, true);
  };

  return (
    <TouchableOpacity activeOpacity={0.85} style={s.card} onPress={onOpenResult}>
      {/* date + chevron */}
      <View style={s.cardTopRow}>
        <ThemedText style={s.cardDate}>{formatCardDate(item.createdAt)}</ThemedText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <TouchableOpacity onPress={onAddToCollection} activeOpacity={0.7}>
            <Ionicons name="add-circle-outline" size={16} color="#8B6A55" />
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete} activeOpacity={0.7}>
            <Ionicons name="trash-outline" size={16} color="#B56B5B" />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleBookmarkToggle} activeOpacity={0.7}>
            <Ionicons name={isBookmarked ? 'bookmark' : 'bookmark-outline'} size={16} color={isBookmarked ? '#4A3728' : '#C4A882'} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onExpand} activeOpacity={0.7}>
            <Ionicons name="chevron-down" size={16} color="#C4A882" />
          </TouchableOpacity>
        </View>
      </View>

      {/* icon + info */}
      <View style={s.cardBody}>
        <View style={s.coffeeCircle}>
          <MaterialCommunityIcons name="coffee" size={22} color="#8B5E3C" />
        </View>

        <View style={s.cardMain}>
          <View style={s.nameBadgeRow}>
            <ThemedText style={s.coffeeName}>{item.coffeeType}</ThemedText>
            <View style={[s.badge, { backgroundColor: cls.badge }]}>
              <ThemedText style={s.badgeText}>{item.classification}</ThemedText>
            </View>
          </View>

          <View style={s.metaRow}>
            <ThemedText style={s.phText}>pH {item.ph.toFixed(1)}</ThemedText>
            {item.riskLevel && (
              <View style={[s.riskPill, { backgroundColor: risk.bg }]}>
                <ThemedText style={[s.riskPillText, { color: risk.text }]}>
                  {item.riskLevel}
                </ThemedText>
              </View>
            )}
          </View>

          {!!item.note && (
            <ThemedText style={s.notePreview} numberOfLines={1}>{item.note}</ThemedText>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── Expanded Card ────────────────────────────────────────────────────────────

function ExpandedCard({
  item,
  onCollapse,
  onRename,
  onDelete,
  onAddToCollection,
  onOpenResult,
  onBookmarkToast,
}: {
  item: AnalysisRecord;
  onCollapse: () => void;
  onRename: () => void;
  onDelete: () => void;
  onAddToCollection: () => void;
  onOpenResult: () => void;
  onBookmarkToast: () => void;
}) {
  const cls  = CLASSIFICATION_COLORS[item.classification] ?? CLASSIFICATION_COLORS["Moderate"];
  const risk = RISK_COLORS[item.riskLevel ?? "Low Risk"]  ?? RISK_COLORS["Low Risk"];

  const [isBookmarked, setIsBookmarked] = useState<boolean>(BookmarkStore.isBookmarked(item.id));

  useEffect(() => {
    const unsub = BookmarkStore.subscribe(() => setIsBookmarked(BookmarkStore.isBookmarked(item.id)));
    return unsub;
  }, [item.id]);

  const handleBookmarkToggle = () => {
    if (isBookmarked) {
      console.log("bookmark pressed:", { id: item.id, is_bookmarked: false });
      BookmarkStore.remove(item.id);
      onBookmarkToast();
      void syncHistoryRecordToSupabase(item, false);
      return;
    }

    console.log("bookmark pressed:", { id: item.id, is_bookmarked: true });
    BookmarkStore.add(item);
    onBookmarkToast();
    void syncHistoryRecordToSupabase(item, true);
  };

  return (
    <TouchableOpacity activeOpacity={0.92} onPress={onCollapse} style={s.expandedCard}>

      {/* date + chevron */}
      <View style={s.cardTopRow}>
        <ThemedText style={s.expandedDate}>{formatDetailDate(item.createdAt)}</ThemedText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <TouchableOpacity onPress={onAddToCollection} activeOpacity={0.7}>
            <Ionicons name="add-circle-outline" size={16} color="#8B6A55" />
          </TouchableOpacity>
          <TouchableOpacity onPress={onDelete} activeOpacity={0.7}>
            <Ionicons name="trash-outline" size={16} color="#B56B5B" />
          </TouchableOpacity>
          <TouchableOpacity onPress={onRename} activeOpacity={0.7}>
            <Ionicons name="pencil" size={15} color="#C4A882" />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleBookmarkToggle} activeOpacity={0.7}>
            <Ionicons name={isBookmarked ? 'bookmark' : 'bookmark-outline'} size={16} color={isBookmarked ? '#4A3728' : '#C4A882'} />
          </TouchableOpacity>
          <Ionicons name="chevron-up" size={16} color="#C4A882" />
        </View>
      </View>

      {/* main info block */}
      <View style={s.expandedMain}>
        <View style={s.expandedIconCol}>
          <View style={s.expandedCoffeeCircle}>
            <MaterialCommunityIcons name="coffee" size={28} color="#8B5E3C" />
          </View>
        </View>

        <View style={s.expandedInfo}>
          <ThemedText style={s.expandedCoffeeName}>{item.coffeeType}</ThemedText>

          <View style={s.expandedMetaRow}>
            <Ionicons name="flame-outline" size={13} color="#A08880" />
            <ThemedText style={s.expandedMetaText}>instant coffee</ThemedText>
            {item.stomachState && (
              <>
                <View style={s.metaDot} />
                <ThemedText style={s.expandedMetaText}>{item.stomachState}</ThemedText>
              </>
            )}
          </View>

          <View style={s.expandedPhRow}>
            <ThemedText style={s.expandedPh}>pH {item.ph.toFixed(1)}</ThemedText>
            <View style={[s.badge, { backgroundColor: cls.badge }]}>
              <ThemedText style={s.badgeText}>{item.classification}</ThemedText>
            </View>
            {item.riskLevel && (
              <View style={[s.riskPill, { backgroundColor: risk.bg }]}>
                <ThemedText style={[s.riskPillText, { color: risk.text }]}>
                  {item.riskLevel}
                </ThemedText>
              </View>
            )}
          </View>
        </View>
      </View>

      {/* divider */}
      <View style={s.divider} />

      {/* health advisory */}
      <View style={s.advisoryBlock}>
        <View style={s.advisoryHeader}>
          <View style={s.advisoryIconCircle}>
            <Ionicons name="warning-outline" size={14} color="#C28A4B" />
          </View>
          <ThemedText style={s.advisoryTitle}>Health Advisory</ThemedText>
        </View>
        <ThemedText style={s.advisoryBody}>{getHealthAdvisory(item)}</ThemedText>
      </View>

      {/* personal notes */}
      <View style={s.notesBlock}>
        <ThemedText style={s.notesTitle}>Personal Notes</ThemedText>
        <ThemedText style={s.notesText}>{item.note || "No notes added."}</ThemedText>
      </View>

      <TouchableOpacity style={s.viewResultBtn} onPress={onOpenResult} activeOpacity={0.8}>
        <ThemedText style={s.viewResultBtnText} numberOfLines={2}>
          view full details
        </ThemedText>
      </TouchableOpacity>

    </TouchableOpacity>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen:  { flex: 1, backgroundColor: "#F6F1EC" },
  scroll:  { flex: 1, backgroundColor: "#F6F1EC" },
  content: { paddingHorizontal: 16, paddingBottom: 32 },

  // header — unchanged per request
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingTop: 50, paddingBottom: 14,
  },
  headerMiddle: { flex: 1.6, alignItems: "center", justifyContent: "center" },
  title:        { fontSize: 18, fontWeight: "700", lineHeight: 20, textAlign: "center", paddingTop: 1 },
  subtitle:     { fontSize: 12, opacity: 0.6, textAlign: "center" },

  // search + filter block
  searchBlock: {
    backgroundColor: "#FFFAF7",
    borderWidth: 1, borderColor: "#EDE3DC",
    borderRadius: 20, padding: 12, marginTop: 14, marginBottom: 6,
  },
  searchRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "#F4EEEA", borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1, fontSize: 13, color: "#3C2C24", paddingVertical: 0,
  },
  filterRow:           { gap: 6, paddingHorizontal: 2 },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
    backgroundColor: "#F4EEEA",
  },
  filterChipActive:    { backgroundColor: "#4A3728" },
  filterChipText:      { fontSize: 12, color: "#7A675C", fontWeight: "500" },
  filterChipTextActive:{ color: "#FFF", fontWeight: "600" },
  shareInlineBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 4,
    backgroundColor: "rgba(196,168,130,0.18)",
  },

  // count
  countRow:  { paddingHorizontal: 4, paddingTop: 12, paddingBottom: 4 },
  countText: { fontSize: 11, color: "#A08880", fontWeight: "500", textTransform: "uppercase", letterSpacing: 0.5 },

  // collapsed card
  card: {
    backgroundColor: "#FFFAF7",
    borderWidth: 1, borderColor: "#EDE3DC",
    borderRadius: 20, padding: 14, marginBottom: 10,
  },
  cardTopRow:  { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  cardDate:    { fontSize: 11, color: "#A08880", fontWeight: "500" },
  cardBody:    { flexDirection: "row", alignItems: "flex-start" },
  coffeeCircle:{
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#F4EEEA",
    alignItems: "center", justifyContent: "center", marginRight: 12,
  },
  cardMain:    { flex: 1 },
  nameBadgeRow:{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  coffeeName:  { fontSize: 14, fontWeight: "700", color: "#2E211B" },
  metaRow:     { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  phText:      { fontSize: 12, color: "#8B6A55", fontWeight: "600" },
  riskPill:    { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  riskPillText:{ fontSize: 10, fontWeight: "600" },
  notePreview: { fontSize: 12, color: "#A08880", lineHeight: 18 },

  badge:     { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  badgeText: { color: "#FFF", fontSize: 10, fontWeight: "700" },

  // expanded card
  expandedCard: {
    backgroundColor: "#FFFAF7",
    borderWidth: 1, borderColor: "#EDE3DC",
    borderRadius: 20, padding: 16, marginBottom: 10,
  },
  expandedDate:        { fontSize: 11, color: "#A08880", fontWeight: "500" },
  expandedMain:        { flexDirection: "row", alignItems: "flex-start", marginTop: 6, marginBottom: 14 },
  expandedIconCol:     { marginRight: 14 },
  expandedCoffeeCircle:{
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: "#F4EEEA",
    alignItems: "center", justifyContent: "center",
  },
  expandedInfo:        { flex: 1 },
  expandedCoffeeName:  { fontSize: 15, fontWeight: "700", color: "#2E211B", marginBottom: 6 },
  expandedMetaRow:     { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 8 },
  expandedMetaText:    { fontSize: 11, color: "#A08880" },
  metaDot:             { width: 3, height: 3, borderRadius: 1.5, backgroundColor: "#C4A882" },
  expandedPhRow:       { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  expandedPh:          { fontSize: 15, fontWeight: "700", color: "#3C2C24" },

  divider: { height: 1, backgroundColor: "#EDE3DC", marginBottom: 14 },

  // advisory
  advisoryBlock: {
    backgroundColor: "rgba(139,94,60,0.07)",
    borderRadius: 14, padding: 12, marginBottom: 12,
  },
  advisoryHeader:    { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  advisoryIconCircle:{
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: "rgba(194,138,75,0.15)",
    alignItems: "center", justifyContent: "center",
  },
  advisoryTitle: { fontSize: 13, fontWeight: "700", color: "#2E211B" },
  advisoryBody:  { fontSize: 12, lineHeight: 19, color: "#4B3A33" },

  // notes
  notesBlock: { marginBottom: 14 },
  notesTitle: { fontSize: 12, fontWeight: "700", color: "#2E211B", marginBottom: 6 },
  notesText:  { fontSize: 12, lineHeight: 19, color: "#7A675C" },
  viewResultBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: Colors.light.background,
    borderRadius: 999,
    width: "100%",
    alignSelf: "stretch",
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#E0D5CC",
    minHeight: 44,
  },
  viewResultBtnText: {
    fontSize: 11,
    color: "#4A3728",
    fontWeight: "600",
    textTransform: "lowercase",
    flex: 1,
    flexShrink: 1,
    flexWrap: "wrap",
    textAlign: "center",
  },

  toastWrapper: {
    position: "absolute",
    bottom: 28,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 1000,
    elevation: 10,
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

  deleteOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  deleteModalShell: {
    width: "100%",
    maxWidth: 360,
    alignSelf: "stretch",
  },
  deleteModal: {
    width: "100%",
    backgroundColor: Colors.light.background,
    borderRadius: 20,
    padding: 18,
    borderWidth: 1,
    borderColor: "#EDE3DC",
    alignItems: "center",
  },
  deleteTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#2E211B",
    marginBottom: 6,
    textAlign: "center",

  },
  deleteSubtitle: {
    fontSize: 13,
    lineHeight: 19,
    color: "#7A675C",
    textAlign: "center",
  },
  deleteActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
    alignSelf: "stretch",
  },
  deleteActionBtn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 30,
    paddingVertical: 11,
    borderWidth: 1,
  },
  deleteCancelBtn: {
    backgroundColor: "#F4EEEA",
    borderWidth: 1,
    borderColor: "#E0D5CC",
  },
  deleteConfirmBtn: {
    backgroundColor: "#3C2C24",
    borderColor: "#3C2C24",
  },
  deleteCancelText: {
    fontSize: 13,
    color: "#8B6A55",
    fontWeight: "600",
    textTransform: "lowercase",
  },
  deleteConfirmText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFF",
    textTransform: "lowercase",
  },

  // csv
  csvButton: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    backgroundColor: "#F4EEEA", borderRadius: 999,
    paddingVertical: 11,
  },
  csvButtonText: { fontSize: 13, fontWeight: "600", color: "#4A3728" },

  // empty
  emptyCard: {
    backgroundColor: "#FFFAF7", borderWidth: 1, borderColor: "#EDE3DC",
    borderRadius: 20, padding: 28, alignItems: "center", marginTop: 8,
  },
  emptyText: { fontSize: 13, color: "#A08880" },
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
  renameInput: {
    borderWidth: 1,
    borderColor: "#E0D5C4",
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    fontWeight: "600",
    color: "#2E211B",
    backgroundColor: "#FFF",
  },
  renameActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 14,
  },
  renameBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999 },
  renameCancel: { backgroundColor: "#F4EEEA" },
  renameCancelText: {
    fontSize: 13,
    color: "#8B6A55",
    fontWeight: "500",
    textTransform: "lowercase",
  },
  renameSave: { backgroundColor: "#4A3728" },
  renameSaveText: {
    fontSize: 13,
    color: "#FFF",
    fontWeight: "600",
    textTransform: "lowercase",
  },
  collectionCreateBtn: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#F4EEEA",
    borderRadius: 999,
    paddingVertical: 9,
  },
  collectionCreateText: {
    fontSize: 12,
    color: "#4A3728",
    fontWeight: "600",
  },
  collectionList: {
    marginTop: 10,
    maxHeight: 220,
  },
  collectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#F4EEEA",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    marginBottom: 8,
  },
  collectionName: {
    fontSize: 13,
    color: "#2E211B",
    fontWeight: "600",
  },
});
