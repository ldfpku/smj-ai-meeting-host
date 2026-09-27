import type { MeetingConfig, MeetingLiveState } from "@/data/meeting";

/**
 * 会议记录的本地存储（浏览器 IndexedDB）。
 *
 * 转写与会议状态原本只活在 React 内存里，刷新页面就全部丢失。这里把它们
 * 落到本机：刷新后仍能查看上一场会议的转写和决议，并据此生成纪要。
 *
 * 用 IndexedDB 而不是 localStorage：转写是一段一段追加的，localStorage
 * 每追加一段都要同步重写整份 JSON；IndexedDB 可以按段异步写入。
 *
 * 数据只保存在这台电脑的这个浏览器里，不会上传。
 */

const DB_NAME = "smjar-meetings";
const DB_VERSION = 1;
const SESSIONS = "sessions";
const SEGMENTS = "segments";

/** 最多保留多少场会议的记录 */
const MAX_SESSIONS = 20;

export interface StoredSegment {
  sessionId: string;
  segmentId: string;
  role: "moderator" | "room";
  text: string;
  final: boolean;
  /** 首次收到该段的时间（毫秒时间戳） */
  at: number;
}

export interface StoredIntervention {
  interventionId?: string;
  source: string;
  reason: string;
  confidence?: number | null;
  latencyMs?: number | null;
  speechStartMs?: number | null;
  /** 被人工撤销，即一次误判 */
  undone: boolean;
  at: number;
}

export interface StoredSession {
  id: string;
  config: MeetingConfig;
  liveState: MeetingLiveState;
  interventions: StoredIntervention[];
  startedAt: number;
  updatedAt: number;
}

function isAvailable(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!isAvailable()) {
    return Promise.reject(new Error("IndexedDB is not available"));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SESSIONS)) {
          db.createObjectStore(SESSIONS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(SEGMENTS)) {
          const store = db.createObjectStore(SEGMENTS, {
            keyPath: ["sessionId", "segmentId"],
          });
          store.createIndex("bySession", "sessionId");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // 打开失败（隐私模式等）后允许下次重试
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 存储只是锦上添花：任何失败都不应影响会议本身。 */
async function safely<T>(label: string, fallback: T, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    console.warn(`meeting-store: ${label} failed`, err);
    return fallback;
  }
}

export const meetingStore = {
  saveSession(session: StoredSession): Promise<void> {
    return safely("saveSession", undefined, async () => {
      const db = await openDb();
      const tx = db.transaction(SESSIONS, "readwrite");
      tx.objectStore(SESSIONS).put(session);
      await done(tx);
    });
  },

  getSession(id: string): Promise<StoredSession | undefined> {
    return safely("getSession", undefined, async () => {
      const db = await openDb();
      const tx = db.transaction(SESSIONS, "readonly");
      return result<StoredSession | undefined>(tx.objectStore(SESSIONS).get(id));
    });
  },

  /** 按最近更新时间倒序 */
  listSessions(): Promise<StoredSession[]> {
    return safely("listSessions", [] as StoredSession[], async () => {
      const db = await openDb();
      const tx = db.transaction(SESSIONS, "readonly");
      const all = await result<StoredSession[]>(tx.objectStore(SESSIONS).getAll());
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    });
  },

  putSegments(segments: StoredSegment[]): Promise<void> {
    if (segments.length === 0) return Promise.resolve();
    return safely("putSegments", undefined, async () => {
      const db = await openDb();
      const tx = db.transaction(SEGMENTS, "readwrite");
      const store = tx.objectStore(SEGMENTS);
      for (const segment of segments) store.put(segment);
      await done(tx);
    });
  },

  /** 按时间正序 */
  getSegments(sessionId: string): Promise<StoredSegment[]> {
    return safely("getSegments", [] as StoredSegment[], async () => {
      const db = await openDb();
      const tx = db.transaction(SEGMENTS, "readonly");
      const all = await result<StoredSegment[]>(
        tx.objectStore(SEGMENTS).index("bySession").getAll(sessionId)
      );
      return all.sort((a, b) => a.at - b.at);
    });
  },

  deleteSession(id: string): Promise<void> {
    return safely("deleteSession", undefined, async () => {
      const db = await openDb();
      const tx = db.transaction([SESSIONS, SEGMENTS], "readwrite");
      tx.objectStore(SESSIONS).delete(id);
      const index = tx.objectStore(SEGMENTS).index("bySession");
      const keys = await result<IDBValidKey[]>(index.getAllKeys(id));
      for (const key of keys) tx.objectStore(SEGMENTS).delete(key);
      await done(tx);
    });
  },

  /** 只保留最近 MAX_SESSIONS 场，其余连同转写一并删除 */
  async prune(): Promise<void> {
    const sessions = await meetingStore.listSessions();
    for (const stale of sessions.slice(MAX_SESSIONS)) {
      await meetingStore.deleteSession(stale.id);
    }
  },
};
