import { getCurrentUserSafe, supabase } from "@/lib/supabase";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { Appearance, Modal, Pressable, ScrollView, StyleSheet, Switch, TouchableOpacity, View } from "react-native";

import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";
import Colors from "@/constants/colors";
import { useThemeColor } from "@/hooks/use-theme-color";
import { getStoredThemeMode, saveThemeMode } from "@/src/data/themeStore";
import { TastePreset, UserPreferences, UserPreferencesStore } from "@/src/data/userPreferencesStore";
import { loadSyncStatus, subscribeSyncStatus, syncAllLocalUpdatesNow, SyncStatus } from "@/src/services/historySync";

const DEFAULT_AVATARS = [
  require("../../assets/images/avatars/avatar1.png"),
  require("../../assets/images/avatars/avatar2.png"),
  require("../../assets/images/avatars/avatar3.png"),
  require("../../assets/images/avatars/avatar4.png"),
];

function MenuHeader({
  icon,
  title,
  subtitle,
  open,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  open: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.menuHeader} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.headerIconWrap}>
        <Ionicons name={icon} size={18} color="#6B7280" />
      </View>
      <View style={styles.headerTextCol}>
        <ThemedText style={styles.headerTitle}>{title}</ThemedText>
        <ThemedText style={styles.headerSubtitle}>{subtitle}</ThemedText>
      </View>
      <Ionicons
        name="chevron-down"
        size={18}
        color="#6B7280"
        style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
      />
    </TouchableOpacity>
  );
}

function MenuRow({
  icon,
  title,
  subtitle,
  onPress,
  trailing,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
}) {
  const Wrapper = onPress ? TouchableOpacity : View;

  return (
    <Wrapper style={styles.menuRow} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.rowIconWrap}>
        <Ionicons name={icon} size={18} color="#6B7280" />
      </View>
      <View style={styles.rowTextCol}>
        <ThemedText style={styles.rowTitle}>{title}</ThemedText>
        <ThemedText style={styles.rowSubtitle}>{subtitle}</ThemedText>
      </View>
      {trailing ?? (onPress ? <Ionicons name="chevron-forward" size={18} color="#6B7280" /> : null)}
    </Wrapper>
  );
}

export default function ProfileScreen() {
  const router = useRouter();

  const text = useThemeColor({}, "text");

  const [email, setEmail] = useState("username");
  const [fullName, setFullName] = useState("full name");
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [preferencesModalVisible, setPreferencesModalVisible] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences>(UserPreferencesStore.defaults);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    pendingCount: 0,
    lastError: null,
    lastSyncedAt: null,
    isSyncing: false,
  });

  const [googleAvatarUrl, setGoogleAvatarUrl] = useState<string | null>(null);
  const [avatarIndex, setAvatarIndex] = useState<number>(0);

  useEffect(() => {
    const loadProfile = async () => {
      await UserPreferencesStore.load();
      setPreferences(UserPreferencesStore.get());
      const initialSyncStatus = await loadSyncStatus();
      setSyncStatus(initialSyncStatus);

      const storedTheme = await getStoredThemeMode();
      if (storedTheme) {
        setIsDarkMode(storedTheme === "dark");
      } else {
        setIsDarkMode((Appearance.getColorScheme() ?? "light") === "dark");
      }

      const user = await getCurrentUserSafe();
      if (!user) return;

      setEmail(user.email ?? "username");
      setFullName(user.user_metadata?.full_name ?? "full name");

      const avatarSource = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
      setGoogleAvatarUrl(typeof avatarSource === "string" ? avatarSource : null);

      const { data: profile, error: profileErr } = await supabase
        .from("profiles")
        .select("avatar_index")
        .eq("id", user.id)
        .single();

      if (profileErr) {
        console.log("profile fetch error:", profileErr.message);
        return;
      }

      const idx = Number(profile?.avatar_index);
      if (!Number.isNaN(idx) && idx >= 0 && idx < DEFAULT_AVATARS.length) {
        setAvatarIndex(idx);
      }
    };

    loadProfile();
    const unsubscribe = UserPreferencesStore.subscribe(setPreferences);
    const unsubscribeSync = subscribeSyncStatus(setSyncStatus);
    return () => {
      unsubscribe();
      unsubscribeSync();
    };
  }, []);

  const handleThemeToggle = async (enabled: boolean) => {
    setIsDarkMode(enabled);
    await saveThemeMode(enabled ? "dark" : "light");
    Appearance.setColorScheme?.(enabled ? "dark" : "light");
  };

  const updatePreferences = async (next: Partial<UserPreferences>) => {
    await UserPreferencesStore.update(next);
  };

  const handleSyncNow = async () => {
    console.log("sync now pressed:", {
      pendingCount: syncStatus.pendingCount,
      lastSyncedAt: syncStatus.lastSyncedAt,
      lastError: syncStatus.lastError,
      isSyncing: syncStatus.isSyncing,
    });

    await syncAllLocalUpdatesNow();
  };

  const handleSwitchAccount = async () => {
    try {
      await supabase.auth.signOut();
      router.replace("/(auth)/login");
    } catch (error) {
      console.log("switch account error:", error);
      router.replace("/(auth)/login");
    }
  };

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();

      router.replace("/(auth)/login");
    } catch (error) {
      console.log("logout error:", error);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={12}>
            <ThemedText style={[styles.backText, { color: text }]}>←</ThemedText>
          </TouchableOpacity>
        </View>

        <View style={styles.profileRow}>
          <View style={[styles.avatarRing, { borderColor: text }]}>
            {googleAvatarUrl ? (
              <Image source={{ uri: googleAvatarUrl }} style={styles.avatar} contentFit="cover" />
            ) : (
              <Image source={DEFAULT_AVATARS[avatarIndex]} style={styles.avatar} contentFit="cover" />
            )}
          </View>

          <View style={styles.nameCol}>
            <ThemedText style={[styles.fullName, { color: text }]}>{fullName}</ThemedText>
            <ThemedText style={[styles.username, { color: text, opacity: 0.6 }]}>{email}</ThemedText>
          </View>
        </View>

        <View style={styles.listSection}>
          <MenuHeader
            icon="settings-outline"
            title="settings & privacy"
            subtitle="your app preferences"
            open={settingsOpen}
            onPress={() => setSettingsOpen((value) => !value)}
          />
          {settingsOpen ? (
            <View style={styles.menuContent}>
              <MenuRow
                icon="cafe-outline"
                title="coffee preferences"
                subtitle="presets, reminders, and accessibility"
                onPress={() => setPreferencesModalVisible(true)}
              />
              <MenuRow
                icon="moon-outline"
                title="dark mode"
                subtitle="switch the app between light and dark"
                trailing={
                  <Switch
                    value={isDarkMode}
                    onValueChange={handleThemeToggle}
                    trackColor={{ false: "#D1D5DB", true: "#6B7280" }}
                    thumbColor={isDarkMode ? "#F5F5F5" : "#FFFFFF"}
                  />
                }
              />
              <MenuRow
                icon={syncStatus.pendingCount > 0 ? "cloud-upload-outline" : "cloud-done-outline"}
                title="sync status"
                subtitle={
                  syncStatus.pendingCount > 0
                    ? `${syncStatus.pendingCount} pending change${syncStatus.pendingCount === 1 ? "" : "s"}`
                    : syncStatus.lastSyncedAt
                    ? `last synced ${new Date(syncStatus.lastSyncedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                    : "all changes synced"
                }
                trailing={
                  <TouchableOpacity onPress={() => void handleSyncNow()} activeOpacity={0.8} style={styles.syncButton}>
                    <ThemedText style={styles.syncButtonText}>
                      {syncStatus.isSyncing ? "syncing..." : "sync now"}
                    </ThemedText>
                  </TouchableOpacity>
                }
              />
              <MenuRow
                icon="shield-checkmark-outline"
                title="privacy policy"
                subtitle="what we collect and how it's used"
                onPress={() => router.push("/policy")}
              />
              <MenuRow
                icon="document-text-outline"
                title="terms of use"
                subtitle="rules for using Acidex"
                onPress={() => router.push("/terms")}
              />
            </View>
          ) : null}
        </View>

        <Modal
          transparent
          animationType="fade"
          visible={preferencesModalVisible}
          onRequestClose={() => setPreferencesModalVisible(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setPreferencesModalVisible(false)}>
            <Pressable style={styles.preferencesModal} onPress={() => null}>
              <View style={styles.modalHeader}>
                <ThemedText style={[styles.modalTitle, { color: text }]}>coffee preferences</ThemedText>
                <ThemedText style={styles.modalSubtitle}>
                  Automatic reminders stay on unless you turn them off.
                </ThemedText>
              </View>

              <View style={styles.modalSection}>
                <ThemedText style={styles.sectionLabel}>taste preset</ThemedText>
                <View style={styles.presetRow}>
                  {([
                    { key: "gentle", label: "Gentle" },
                    { key: "balanced", label: "Balanced" },
                    { key: "bold", label: "Bold" },
                    { key: "custom", label: "Custom" },
                  ] as { key: TastePreset; label: string }[]).map((item) => {
                    const active = preferences.tastePreset === item.key;
                    return (
                      <TouchableOpacity
                        key={item.key}
                        activeOpacity={0.8}
                        onPress={() => updatePreferences({ tastePreset: item.key })}
                        style={[styles.presetChip, active && styles.presetChipActive]}
                      >
                        <ThemedText style={[styles.presetChipText, active && styles.presetChipTextActive]}>
                          {item.label}
                        </ThemedText>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.modalSection}>
                <ThemedText style={styles.sectionLabel}>automatic reminders</ThemedText>
                <View style={styles.toggleRow}>
                  <View style={styles.toggleTextCol}>
                    <ThemedText style={styles.toggleTitle}>after-coffee reminder</ThemedText>
                    <ThemedText style={styles.toggleSubtitle}>
                      Sends a local reminder after analysis to hydrate or wait before another cup.
                    </ThemedText>
                  </View>
                  <Switch
                    value={preferences.remindersEnabled}
                    onValueChange={(value) => updatePreferences({ remindersEnabled: value })}
                    trackColor={{ false: "#D1D5DB", true: "#6B7280" }}
                    thumbColor={preferences.remindersEnabled ? "#F5F5F5" : "#FFFFFF"}
                  />
                </View>
                <View style={styles.optionRow}>
                  {[15, 30, 60].map((minutes) => {
                    const active = preferences.reminderDelayMinutes === minutes;
                    return (
                      <TouchableOpacity
                        key={minutes}
                        activeOpacity={0.8}
                        onPress={() => updatePreferences({ reminderDelayMinutes: minutes })}
                        style={[styles.optionChip, active && styles.optionChipActive]}
                      >
                        <ThemedText style={[styles.optionChipText, active && styles.optionChipTextActive]}>
                          {minutes}m
                        </ThemedText>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.modalSection}>
                <ThemedText style={styles.sectionLabel}>accessibility</ThemedText>
                <MenuRow
                  icon="contrast-outline"
                  title="high contrast"
                  subtitle="increase visibility across cards and charts"
                  trailing={
                    <Switch
                      value={preferences.highContrastEnabled}
                      onValueChange={(value) => updatePreferences({ highContrastEnabled: value })}
                      trackColor={{ false: "#D1D5DB", true: "#6B7280" }}
                      thumbColor={preferences.highContrastEnabled ? "#F5F5F5" : "#FFFFFF"}
                    />
                  }
                />
                <MenuRow
                  icon="text-outline"
                  title="large text"
                  subtitle="make the reading view easier to scan"
                  trailing={
                    <Switch
                      value={preferences.largeTextEnabled}
                      onValueChange={(value) => updatePreferences({ largeTextEnabled: value })}
                      trackColor={{ false: "#D1D5DB", true: "#6B7280" }}
                      thumbColor={preferences.largeTextEnabled ? "#F5F5F5" : "#FFFFFF"}
                    />
                  }
                />
              </View>

              <TouchableOpacity
                style={styles.closeModalButton}
                onPress={() => setPreferencesModalVisible(false)}
                activeOpacity={0.85}
              >
                <ThemedText style={styles.closeModalText}>done</ThemedText>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>

        <View style={styles.bottomGroup}>
          <TouchableOpacity style={styles.bottomRow} onPress={handleSwitchAccount} activeOpacity={0.8}>
            <View style={styles.bottomIconWrap}>
              <Ionicons name="person-add-outline" size={18} color="#6B7280" />
            </View>
            <View style={styles.rowTextCol}>
              <ThemedText style={styles.rowTitle}>add account</ThemedText>
              <ThemedText style={styles.rowSubtitle}>sign in with another account</ThemedText>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#6B7280" />
          </TouchableOpacity>

          <TouchableOpacity style={styles.bottomRow} onPress={handleLogout} activeOpacity={0.8}>
            <View style={styles.bottomIconWrap}>
              <Ionicons name="log-out-outline" size={18} color="#6B7280" />
            </View>
            <View style={styles.rowTextCol}>
              <ThemedText style={styles.rowTitle}>log out</ThemedText>
              <ThemedText style={styles.rowSubtitle}>end this session on this device</ThemedText>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#6B7280" />
          </TouchableOpacity>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingTop: 35, paddingBottom: 24 },

  header: {
    flexDirection: "row",
    justifyContent: "flex-start",
    alignItems: "center",
    marginTop: 20,
    marginBottom: 18,
    paddingHorizontal: 15,
  },
  backButton: { paddingLeft: 0 },
  backText: { fontSize: 30, fontWeight: "700" },

  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 70,
    paddingHorizontal: 15,
  },
  avatarRing: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: { width: 72, height: 72, borderRadius: 36 },
  nameCol: { flex: 1 },
  fullName: { fontSize: 28, fontWeight: "800", lineHeight: 32 },
  username: { marginTop: 2, fontSize: 16, fontWeight: "500" },

  listSection: { marginTop: 8 },
  menuHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 15,
    paddingVertical: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(0,0,0,0.12)",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.12)",
  },
  headerIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  headerTextCol: { flex: 1 },
  headerTitle: { fontSize: 16, fontWeight: "700", color: "#1F2937" },
  headerSubtitle: { marginTop: 2, fontSize: 12, color: "#6B7280" },
  menuContent: {
    marginLeft: 0,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 15,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.12)",
  },
  rowIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  rowTextCol: { flex: 1 },
  rowTitle: { fontSize: 16, fontWeight: "700", color: "#1F2937", textTransform: "none" },
  rowSubtitle: { marginTop: 2, fontSize: 12, color: "#6B7280" },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  preferencesModal: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: Colors.light.background,
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: "#E5D8CB",
  },
  modalHeader: {
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 4,
  },
  modalSubtitle: {
    fontSize: 12,
    color: "#7A675C",
    lineHeight: 18,
  },
  modalSection: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#EDE3DC",
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: "#8B6A55",
    marginBottom: 10,
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  presetChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "#F4EEEA",
  },
  presetChipActive: {
    backgroundColor: "#4A3728",
  },
  presetChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#7A675C",
  },
  presetChipTextActive: {
    color: "#FFF",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  toggleTextCol: {
    flex: 1,
  },
  toggleTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#2E211B",
    marginBottom: 3,
  },
  toggleSubtitle: {
    fontSize: 12,
    color: "#7A675C",
    lineHeight: 18,
  },
  optionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
  },
  optionChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#F4EEEA",
  },
  optionChipActive: {
    backgroundColor: "#4A3728",
  },
  optionChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#7A675C",
  },
  optionChipTextActive: {
    color: "#FFF",
  },
  syncButton: {
    backgroundColor: "#F4EEEA",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  syncButtonText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#4A3728",
  },
  closeModalButton: {
    marginTop: 18,
    backgroundColor: "#4A3728",
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: "center",
  },
  closeModalText: {
    color: "#FFF",
    fontSize: 14,
    fontWeight: "600",
    textTransform: "lowercase",
  },

  bottomGroup: {
    marginTop: 0,
    paddingBottom: 8,
  },
  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 15,
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(0,0,0,0.12)",
  },
  bottomIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
});
