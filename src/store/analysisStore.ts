import AsyncStorage from "@react-native-async-storage/async-storage";
import { getCurrentUserSafe } from "@/lib/supabase";

import { BookmarkStore } from "../data/bookmarkStore";
import { flushQueuedHistorySync, pullHistoryFromSupabase, syncHistoryDeletionToSupabase, syncHistoryRecordToSupabase } from "../services/historySync";
import { AnalysisRecord } from "../types/analysis";

const LATEST_ANALYSIS_KEY = "acidex_latest_analysis";
const ANALYSIS_HISTORY_KEY = "acidex_analysis_history";
const ANALYSIS_MIGRATION_KEY = "acidex_analysis_user_scoped_migration_v1";
const ANON_SCOPE = "anonymous";

const latestAnalysisCacheByScope: Record<string, AnalysisRecord | null> = {};

async function getUserScopeId(): Promise<string> {
  try {
    const user = await getCurrentUserSafe();
    return user?.id ?? ANON_SCOPE;
  } catch {
    return ANON_SCOPE;
  }
}

function scopedKey(baseKey: string, scopeId: string): string {
  return `${baseKey}:${scopeId}`;
}

async function maybeMigrateLegacyAnalysisKeys(scopeId: string): Promise<void> {
  try {
    const migrationDone = await AsyncStorage.getItem(ANALYSIS_MIGRATION_KEY);
    if (migrationDone) return;
    if (scopeId === ANON_SCOPE) return;

    const [legacyLatest, legacyHistory, scopedLatest, scopedHistory] = await AsyncStorage.multiGet([
      LATEST_ANALYSIS_KEY,
      ANALYSIS_HISTORY_KEY,
      scopedKey(LATEST_ANALYSIS_KEY, scopeId),
      scopedKey(ANALYSIS_HISTORY_KEY, scopeId),
    ]);

    const legacyLatestValue = legacyLatest?.[1];
    const legacyHistoryValue = legacyHistory?.[1];
    const scopedLatestValue = scopedLatest?.[1];
    const scopedHistoryValue = scopedHistory?.[1];

    const writes: [string, string][] = [];
    if (!scopedLatestValue && legacyLatestValue) {
      writes.push([scopedKey(LATEST_ANALYSIS_KEY, scopeId), legacyLatestValue]);
    }
    if (!scopedHistoryValue && legacyHistoryValue) {
      writes.push([scopedKey(ANALYSIS_HISTORY_KEY, scopeId), legacyHistoryValue]);
    }
    writes.push([ANALYSIS_MIGRATION_KEY, scopeId]);

    await AsyncStorage.multiSet(writes);
  } catch (error) {
    console.log("maybeMigrateLegacyAnalysisKeys error:", error);
  }
}

export function getLatestCachedAnalysis(): AnalysisRecord | null {
  return latestAnalysisCacheByScope[ANON_SCOPE] ?? null;
}

export function setLatestCachedAnalysis(record: AnalysisRecord | null): void {
  latestAnalysisCacheByScope[ANON_SCOPE] = record;
}

export async function getLatestStoredAnalysis(): Promise<AnalysisRecord | null> {
  try {
    const scopeId = await getUserScopeId();
    await maybeMigrateLegacyAnalysisKeys(scopeId);
    const raw = await AsyncStorage.getItem(scopedKey(LATEST_ANALYSIS_KEY, scopeId));
    const parsed = raw ? (JSON.parse(raw) as AnalysisRecord) : null;
    latestAnalysisCacheByScope[scopeId] = parsed;
    latestAnalysisCacheByScope[ANON_SCOPE] = parsed;
    return parsed;
  } catch (error) {
    console.log("getLatestStoredAnalysis error:", error);
    return null;
  }
}

export async function getStoredAnalysisHistory(): Promise<AnalysisRecord[]> {
  try {
    const scopeId = await getUserScopeId();
    await maybeMigrateLegacyAnalysisKeys(scopeId);
    const raw = await AsyncStorage.getItem(scopedKey(ANALYSIS_HISTORY_KEY, scopeId));
    const localHistory = raw ? (JSON.parse(raw) as AnalysisRecord[]) : [];

    const remoteHistory = await pullHistoryFromSupabase();
    if (!remoteHistory) return localHistory;

    const mergedById = new Map<string, AnalysisRecord>();
    localHistory.forEach((item) => mergedById.set(item.id, item));
    remoteHistory.forEach((item) => mergedById.set(item.id, item));
    const merged = Array.from(mergedById.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const mergedLatest = merged[0] ?? null;
    latestAnalysisCacheByScope[scopeId] = mergedLatest;
    latestAnalysisCacheByScope[ANON_SCOPE] = mergedLatest;
    await AsyncStorage.multiSet([
      [scopedKey(ANALYSIS_HISTORY_KEY, scopeId), JSON.stringify(merged)],
      [scopedKey(LATEST_ANALYSIS_KEY, scopeId), JSON.stringify(mergedLatest)],
    ]);

    return merged;
  } catch (error) {
    console.log("getStoredAnalysisHistory error:", error);
    return [];
  }
}

export async function saveAnalysisRecord(record: AnalysisRecord): Promise<void> {
  try {
    const scopeId = await getUserScopeId();
    await maybeMigrateLegacyAnalysisKeys(scopeId);
    latestAnalysisCacheByScope[scopeId] = record;
    latestAnalysisCacheByScope[ANON_SCOPE] = record;
    const historyRaw = await AsyncStorage.getItem(scopedKey(ANALYSIS_HISTORY_KEY, scopeId));
    const history = historyRaw ? (JSON.parse(historyRaw) as AnalysisRecord[]) : [];
    const dedupedHistory = history.filter((item) => item.id !== record.id);
    const nextHistory = [record, ...dedupedHistory].slice(0, 100);

    await AsyncStorage.multiSet([
      [scopedKey(LATEST_ANALYSIS_KEY, scopeId), JSON.stringify(record)],
      [scopedKey(ANALYSIS_HISTORY_KEY, scopeId), JSON.stringify(nextHistory)],
    ]);

    // Keep the UI responsive: persist locally first, then sync in background.
    void (async () => {
      await syncHistoryRecordToSupabase(record, BookmarkStore.isBookmarked(record.id));
      await flushQueuedHistorySync();
    })();
  } catch (error) {
    console.log("saveAnalysisRecord error:", error);
  }
}

export async function deleteAnalysisRecord(recordId: string): Promise<void> {
  try {
    const scopeId = await getUserScopeId();
    await maybeMigrateLegacyAnalysisKeys(scopeId);
    const historyRaw = await AsyncStorage.getItem(scopedKey(ANALYSIS_HISTORY_KEY, scopeId));
    const history = historyRaw ? (JSON.parse(historyRaw) as AnalysisRecord[]) : [];
    const deletedRecord = history.find((item) => item.id === recordId) ?? null;
    const nextHistory = history.filter((item) => item.id !== recordId);

    const latestRaw = await AsyncStorage.getItem(scopedKey(LATEST_ANALYSIS_KEY, scopeId));
    const latest = latestRaw ? (JSON.parse(latestRaw) as AnalysisRecord) : null;
    const nextLatest =
      latest?.id === recordId ? (nextHistory[0] ?? null) : latest;

    latestAnalysisCacheByScope[scopeId] = nextLatest;
    latestAnalysisCacheByScope[ANON_SCOPE] = nextLatest;

    await AsyncStorage.multiSet([
      [scopedKey(LATEST_ANALYSIS_KEY, scopeId), JSON.stringify(nextLatest)],
      [scopedKey(ANALYSIS_HISTORY_KEY, scopeId), JSON.stringify(nextHistory)],
    ]);

    if (deletedRecord) {
      void syncHistoryDeletionToSupabase(deletedRecord);
    }
  } catch (error) {
    console.log("deleteAnalysisRecord error:", error);
  }
}
