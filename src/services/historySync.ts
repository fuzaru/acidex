import { getCurrentUserSafe, supabase } from "@/lib/supabase";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { BookmarkStore } from "@/src/data/bookmarkStore";
import { AnalysisRecord } from "@/src/types/analysis";

type HistoryRow = {
  id: string;
  profile_id: string;
  created_at: string;
  coffee_type: string;
  ph: number;
  classification: AnalysisRecord["classification"];
  binary_label: AnalysisRecord["binaryLabel"] | null;
  ml_confidence: number | null;
  ml_model_key: AnalysisRecord["mlModelKey"] | null;
  ml_model_name: AnalysisRecord["mlModelName"] | null;
  stabilization_time_sec: number | null;
  average_voltage: number | null;
  samples_collected: number | null;
  sample_id: string | null;
  note: string | null;
  stomach_state: AnalysisRecord["stomachState"] | null;
  cups_today: number | null;
  risk_level: AnalysisRecord["riskLevel"] | null;
  narrative: AnalysisRecord["narrative"] | null;
  is_bookmarked: boolean;
  is_deleted: boolean;
};

function toAnalysisRecord(row: HistoryRow): AnalysisRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    coffeeType: row.coffee_type,
    ph: row.ph,
    classification: row.classification,
    binaryLabel: row.binary_label ?? undefined,
    mlConfidence: row.ml_confidence ?? undefined,
    mlModelKey: row.ml_model_key ?? undefined,
    mlModelName: row.ml_model_name ?? undefined,
    stabilizationTimeSec: row.stabilization_time_sec ?? undefined,
    averageVoltage: row.average_voltage ?? undefined,
    samplesCollected: row.samples_collected ?? undefined,
    sampleId: row.sample_id ?? undefined,
    note: row.note ?? undefined,
    stomachState: row.stomach_state ?? undefined,
    cupsToday: row.cups_today ?? undefined,
    riskLevel: row.risk_level ?? undefined,
    narrative: row.narrative ?? undefined,
  };
}

type QueuedSyncItem = {
  record: AnalysisRecord;
  isBookmarked: boolean;
  isDeleted: boolean;
  queuedAt: string;
};

export type SyncStatus = {
  pendingCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  isSyncing: boolean;
};

const SYNC_QUEUE_KEY = "acidex_sync_queue_v1";
const SYNC_STATUS_KEY = "acidex_sync_status_v1";
const ANALYSIS_HISTORY_KEY = "acidex_analysis_history";
const ANON_SCOPE = "anonymous";

let inMemoryStatus: SyncStatus = {
  pendingCount: 0,
  lastSyncedAt: null,
  lastError: null,
  isSyncing: false,
};
const syncListeners = new Set<(status: SyncStatus) => void>();
const unsupportedHistoryColumns = new Set<string>();

function notifySyncStatus() {
  syncListeners.forEach((listener) => listener({ ...inMemoryStatus }));
}

async function persistSyncStatus() {
  try {
    await AsyncStorage.setItem(SYNC_STATUS_KEY, JSON.stringify(inMemoryStatus));
  } catch (error) {
    console.log("persistSyncStatus error:", error);
  }
}

async function setSyncStatus(next: Partial<SyncStatus>) {
  inMemoryStatus = { ...inMemoryStatus, ...next };
  notifySyncStatus();
  await persistSyncStatus();
}

async function getSyncQueue(): Promise<QueuedSyncItem[]> {
  try {
    const raw = await AsyncStorage.getItem(SYNC_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedSyncItem[]) : [];
  } catch (error) {
    console.log("getSyncQueue error:", error);
    return [];
  }
}

async function saveSyncQueue(nextQueue: QueuedSyncItem[]) {
  try {
    await AsyncStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(nextQueue));
  } catch (error) {
    console.log("saveSyncQueue error:", error);
  }
  await setSyncStatus({ pendingCount: nextQueue.length });
}

function dedupeQueue(items: QueuedSyncItem[]): QueuedSyncItem[] {
  const byId = new Map<string, QueuedSyncItem>();
  items.forEach((item) => byId.set(item.record.id, item));
  return Array.from(byId.values()).sort(
    (a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime()
  );
}

function scopedAnalysisHistoryKey(scopeId: string): string {
  return `${ANALYSIS_HISTORY_KEY}:${scopeId}`;
}

function dedupeRecordsById(records: AnalysisRecord[]): AnalysisRecord[] {
  const byId = new Map<string, AnalysisRecord>();
  records.forEach((record) => byId.set(record.id, record));
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

async function getAllLocalHistoryForSync(scopeId: string): Promise<AnalysisRecord[]> {
  try {
    const keys = [
      scopedAnalysisHistoryKey(scopeId),
      scopedAnalysisHistoryKey(ANON_SCOPE),
      ANALYSIS_HISTORY_KEY,
    ];
    const entries = await AsyncStorage.multiGet(keys);
    const parsed = entries.flatMap((entry) => {
      const raw = entry?.[1];
      if (!raw) return [] as AnalysisRecord[];
      try {
        const value = JSON.parse(raw) as AnalysisRecord[];
        return Array.isArray(value) ? value : [];
      } catch {
        return [] as AnalysisRecord[];
      }
    });
    return dedupeRecordsById(parsed);
  } catch (error) {
    console.log("getAllLocalHistoryForSync error:", error);
    return [];
  }
}

async function enqueueForLater(
  record: AnalysisRecord,
  isBookmarked: boolean,
  isDeleted: boolean,
  error: string | null,
) {
  const queue = await getSyncQueue();
  const nextQueue = dedupeQueue([
    ...queue,
    { record, isBookmarked, isDeleted, queuedAt: new Date().toISOString() },
  ]);
  await saveSyncQueue(nextQueue);
  await setSyncStatus({ lastError: error });
}

function toHistoryRow(
  record: AnalysisRecord,
  profileId: string,
  isBookmarked: boolean,
  isDeleted: boolean,
): HistoryRow {
  return {
    id: record.id,
    profile_id: profileId,
    created_at: record.createdAt,
    coffee_type: record.coffeeType,
    ph: record.ph,
    classification: record.classification,
    binary_label: record.binaryLabel ?? null,
    ml_confidence: record.mlConfidence ?? null,
    ml_model_key: record.mlModelKey ?? null,
    ml_model_name: record.mlModelName ?? null,
    stabilization_time_sec: record.stabilizationTimeSec ?? null,
    average_voltage: record.averageVoltage ?? null,
    samples_collected: record.samplesCollected ?? null,
    sample_id: record.sampleId ?? null,
    note: record.note ?? null,
    stomach_state: record.stomachState ?? null,
    cups_today: record.cupsToday ?? null,
    risk_level: record.riskLevel ?? null,
    narrative: record.narrative ?? null,
    is_bookmarked: isBookmarked,
    is_deleted: isDeleted,
  };
}

function extractMissingHistoryColumn(errorMessage: string): string | null {
  const match = errorMessage.match(/Could not find the '([^']+)' column of 'history'/i);
  return match?.[1] ?? null;
}

function buildHistoryPayload(row: HistoryRow): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...row };
  unsupportedHistoryColumns.forEach((column) => {
    delete payload[column];
  });
  return payload;
}

async function upsertHistoryRow(row: HistoryRow): Promise<string | null> {
  const maxAttempts = Object.keys(row).length + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const payload = buildHistoryPayload(row);
    const { error } = await supabase.from("history").upsert(payload, { onConflict: "id" });
    if (!error) return null;

    const missingColumn = extractMissingHistoryColumn(error.message);
    if (!missingColumn) return error.message;

    if (missingColumn === "id") {
      return "Supabase table 'history' must keep id for bookmark sync.";
    }

    if (unsupportedHistoryColumns.has(missingColumn)) {
      return error.message;
    }
    unsupportedHistoryColumns.add(missingColumn);
  }

  return "Unable to sync history: table schema is missing too many expected columns.";
}

export async function syncHistoryRecordToSupabase(
  record: AnalysisRecord,
  isBookmarked: boolean,
): Promise<void> {
  try {
    const user = await getCurrentUserSafe();
    if (!user) {
      await enqueueForLater(record, isBookmarked, false, "Signed out. Sync paused.");
      return;
    }

    const upsertErrorMessage = await upsertHistoryRow(toHistoryRow(record, user.id, isBookmarked, false));
    if (upsertErrorMessage) {
      console.log("syncHistoryRecordToSupabase upsert error:", upsertErrorMessage);
      await enqueueForLater(record, isBookmarked, false, upsertErrorMessage);
      return;
    }

    await setSyncStatus({
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (error) {
    console.log("syncHistoryRecordToSupabase error:", error);
    await enqueueForLater(
      record,
      isBookmarked,
      false,
      error instanceof Error ? error.message : "Unknown sync error",
    );
  }
}

export async function syncHistoryDeletionToSupabase(record: AnalysisRecord): Promise<void> {
  try {
    const user = await getCurrentUserSafe();
    if (!user) {
      await enqueueForLater(record, false, true, "Signed out. Sync paused.");
      return;
    }

    const upsertErrorMessage = await upsertHistoryRow(toHistoryRow(record, user.id, false, true));
    if (upsertErrorMessage) {
      console.log("syncHistoryDeletionToSupabase upsert error:", upsertErrorMessage);
      await enqueueForLater(record, false, true, upsertErrorMessage);
      return;
    }

    await setSyncStatus({
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (error) {
    console.log("syncHistoryDeletionToSupabase error:", error);
    await enqueueForLater(
      record,
      false,
      true,
      error instanceof Error ? error.message : "Unknown sync error",
    );
  }
}

export async function loadSyncStatus(): Promise<SyncStatus> {
  try {
    const [statusRaw, queue] = await Promise.all([
      AsyncStorage.getItem(SYNC_STATUS_KEY),
      getSyncQueue(),
    ]);
    const parsed = statusRaw ? (JSON.parse(statusRaw) as Partial<SyncStatus>) : {};
    inMemoryStatus = {
      pendingCount: queue.length,
      lastSyncedAt: parsed.lastSyncedAt ?? null,
      lastError: parsed.lastError ?? null,
      isSyncing: false,
    };
    notifySyncStatus();
    return { ...inMemoryStatus };
  } catch (error) {
    console.log("loadSyncStatus error:", error);
    return { ...inMemoryStatus };
  }
}

export function subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void {
  syncListeners.add(listener);
  listener({ ...inMemoryStatus });
  return () => syncListeners.delete(listener);
}

export async function flushQueuedHistorySync(): Promise<void> {
  if (inMemoryStatus.isSyncing) return;
  await setSyncStatus({ isSyncing: true });

  try {
    const queue = await getSyncQueue();
    if (!queue.length) {
      await setSyncStatus({ isSyncing: false });
      return;
    }

    const user = await getCurrentUserSafe();
    if (!user) {
      await setSyncStatus({
        isSyncing: false,
        pendingCount: queue.length,
        lastError: "Sign in to continue sync.",
      });
      return;
    }

    let remaining = [...queue];
    for (const item of queue) {
      const upsertErrorMessage = await upsertHistoryRow(
        toHistoryRow(item.record, user.id, item.isBookmarked, item.isDeleted)
      );
      if (upsertErrorMessage) {
        await setSyncStatus({
          isSyncing: false,
          lastError: upsertErrorMessage,
          pendingCount: remaining.length,
        });
        await saveSyncQueue(remaining);
        return;
      }

      remaining = remaining.filter((queued) => queued.record.id !== item.record.id);
      await saveSyncQueue(remaining);
    }

    await setSyncStatus({
      isSyncing: false,
      pendingCount: 0,
      lastError: null,
      lastSyncedAt: new Date().toISOString(),
    });
  } catch (error) {
    await setSyncStatus({
      isSyncing: false,
      lastError: error instanceof Error ? error.message : "Unknown sync error",
    });
  }
}

export async function syncAllLocalUpdatesNow(): Promise<void> {
  if (inMemoryStatus.isSyncing) return;

  try {
    const user = await getCurrentUserSafe();
    if (!user) {
      const queue = await getSyncQueue();
      await setSyncStatus({
        pendingCount: queue.length,
        lastError: "Sign in to continue sync.",
      });
      return;
    }

    const localHistory = await getAllLocalHistoryForSync(user.id);
    const bookmarkedIds = new Set(BookmarkStore.getAll().map((item) => item.id));

    console.log("syncAllLocalUpdatesNow start:", {
      userId: user.id,
      localHistoryCount: localHistory.length,
      bookmarkedCount: bookmarkedIds.size,
      pendingCount: inMemoryStatus.pendingCount,
    });

      for (const record of localHistory) {
        await enqueueForLater(record, bookmarkedIds.has(record.id), false, null);
    }

    await flushQueuedHistorySync();

    console.log("syncAllLocalUpdatesNow complete:", {
      userId: user.id,
      pendingCount: inMemoryStatus.pendingCount,
      lastSyncedAt: inMemoryStatus.lastSyncedAt,
      lastError: inMemoryStatus.lastError,
    });
  } catch (error) {
    console.log("syncAllLocalUpdatesNow error:", error);
    await setSyncStatus({
      lastError: error instanceof Error ? error.message : "Unknown sync error",
    });
  }
}

export async function pullHistoryFromSupabase(): Promise<AnalysisRecord[] | null> {
  try {
    const user = await getCurrentUserSafe();
    if (!user) return null;

    const { data, error } = await supabase
      .from("history")
      .select("*")
      .eq("profile_id", user.id)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false });

    if (error) {
      console.log("pullHistoryFromSupabase error:", error.message);
      return null;
    }

    return ((data ?? []) as HistoryRow[]).map(toAnalysisRecord);
  } catch (error) {
    console.log("pullHistoryFromSupabase exception:", error);
    return null;
  }
}
