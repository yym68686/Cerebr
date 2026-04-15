import { isExtensionEnvironment } from './storage-adapter.js';

const BACKUP_FORMAT = 'cerebr-backup';
const BACKUP_VERSION = 1;

const IDB_DB_NAME = 'CerebrData';
const IDB_DB_VERSION = 1;
const IDB_STORE_NAME = 'keyValueStore';

const CHATS_INDEX_V2_KEY = 'cerebr_chats_index_v2';
const CHAT_V2_PREFIX = 'cerebr_chat_v2_';
const READING_PROGRESS_V1_PREFIX = 'cerebr_reading_progress_v1_';
const WEB_SYNC_PREFIX = 'sync_';

let dbPromise = null;

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneStorageMap(value) {
    if (!isPlainObject(value)) return {};
    return Object.fromEntries(Object.entries(value));
}

function isChatStorageKey(key) {
    return key === CHATS_INDEX_V2_KEY ||
        (typeof key === 'string' && (key.startsWith(CHAT_V2_PREFIX) || key.startsWith(READING_PROGRESS_V1_PREFIX)));
}

function getDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
                    db.createObjectStore(IDB_STORE_NAME);
                }
            };

            request.onsuccess = (event) => {
                resolve(event.target.result);
            };

            request.onerror = (event) => {
                reject(event.target.error);
            };
        });
    }

    return dbPromise;
}

async function readIndexedDbSnapshot() {
    const db = await getDb();
    if (!db) return {};

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IDB_STORE_NAME], 'readonly');
        const store = transaction.objectStore(IDB_STORE_NAME);
        const entries = Object.create(null);
        const request = store.openCursor();

        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve(Object.fromEntries(Object.entries(entries)));
                return;
            }

            entries[String(cursor.key)] = cursor.value;
            cursor.continue();
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };

        transaction.onerror = (event) => {
            reject(event.target.error);
        };

        transaction.onabort = (event) => {
            reject(event?.target?.error || new Error('IndexedDB transaction aborted'));
        };
    });
}

async function replaceIndexedDbSnapshot(entries) {
    const db = await getDb();
    if (!db) {
        throw new Error('IndexedDB is not available');
    }

    const normalizedEntries = cloneStorageMap(entries);

    return new Promise((resolve, reject) => {
        const transaction = db.transaction([IDB_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(IDB_STORE_NAME);
        let cleared = false;

        const clearRequest = store.clear();
        clearRequest.onerror = (event) => {
            reject(event.target.error);
        };

        clearRequest.onsuccess = () => {
            cleared = true;
            Object.entries(normalizedEntries).forEach(([key, value]) => {
                const request = store.put(value, key);
                request.onerror = (event) => {
                    transaction.abort();
                    reject(event.target.error);
                };
            });
        };

        transaction.oncomplete = () => {
            if (!cleared) {
                reject(new Error('IndexedDB store was not cleared before restore'));
                return;
            }
            resolve();
        };

        transaction.onerror = (event) => {
            reject(event.target.error);
        };

        transaction.onabort = (event) => {
            reject(event?.target?.error || new Error('IndexedDB restore transaction aborted'));
        };
    });
}

async function readExtensionStorageSnapshot(areaName) {
    if (!isExtensionEnvironment) return {};

    const area = chrome.storage?.[areaName];
    if (!area?.get) return {};

    const result = await area.get(null);
    return cloneStorageMap(result);
}

async function replaceExtensionStorageSnapshot(areaName, entries) {
    if (!isExtensionEnvironment) return;

    const area = chrome.storage?.[areaName];
    if (!area?.get || !area?.set) return;

    const normalizedEntries = cloneStorageMap(entries);
    const current = await area.get(null);
    const currentKeys = Object.keys(current || {});
    if (currentKeys.length > 0) {
        await area.remove(currentKeys);
    }
    if (Object.keys(normalizedEntries).length > 0) {
        await area.set(normalizedEntries);
    }
}

function readWebSyncStorageSnapshot() {
    if (typeof localStorage === 'undefined') return {};

    const snapshot = Object.create(null);
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(WEB_SYNC_PREFIX)) continue;

        const rawValue = localStorage.getItem(key);
        if (rawValue == null) continue;

        try {
            snapshot[key.slice(WEB_SYNC_PREFIX.length)] = JSON.parse(rawValue);
        } catch (error) {
            throw new Error(`Failed to parse local storage key "${key}": ${error?.message || error}`);
        }
    }

    return Object.fromEntries(Object.entries(snapshot));
}

function replaceWebSyncStorageSnapshot(entries) {
    if (typeof localStorage === 'undefined') {
        throw new Error('localStorage is not available');
    }

    const normalizedEntries = cloneStorageMap(entries);
    const keysToRemove = [];
    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key && key.startsWith(WEB_SYNC_PREFIX)) {
            keysToRemove.push(key);
        }
    }

    keysToRemove.forEach((key) => localStorage.removeItem(key));
    Object.entries(normalizedEntries).forEach(([key, value]) => {
        localStorage.setItem(`${WEB_SYNC_PREFIX}${key}`, JSON.stringify(value));
    });
}

function normalizeBackupSnapshot(rawSnapshot) {
    if (!isPlainObject(rawSnapshot)) {
        throw new Error('Backup payload must be an object');
    }

    if (rawSnapshot.format !== BACKUP_FORMAT) {
        throw new Error('Unsupported backup format');
    }

    if (rawSnapshot.version !== BACKUP_VERSION) {
        throw new Error(`Unsupported backup version: ${rawSnapshot.version}`);
    }

    const storage = isPlainObject(rawSnapshot.storage) ? rawSnapshot.storage : {};

    const normalized = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: typeof rawSnapshot.exportedAt === 'string' ? rawSnapshot.exportedAt : new Date().toISOString(),
        source: isPlainObject(rawSnapshot.source) ? { ...rawSnapshot.source } : {},
        storage: {
            indexedDb: cloneStorageMap(storage.indexedDb),
            local: cloneStorageMap(storage.local),
            sync: cloneStorageMap(storage.sync),
        }
    };

    return {
        ...normalized,
        summary: summarizeDataBackupSnapshot(normalized)
    };
}

export function summarizeDataBackupSnapshot(snapshot) {
    const normalized = snapshot?.storage &&
        snapshot?.format === BACKUP_FORMAT &&
        snapshot?.version === BACKUP_VERSION
        ? {
            storage: {
                indexedDb: cloneStorageMap(snapshot.storage.indexedDb),
                local: cloneStorageMap(snapshot.storage.local),
                sync: cloneStorageMap(snapshot.storage.sync),
            }
        }
        : normalizeBackupSnapshot(snapshot);

    const indexedDbKeys = Object.keys(normalized.storage.indexedDb).length;
    const localKeys = Object.keys(normalized.storage.local).length;
    const syncKeys = Object.keys(normalized.storage.sync).length;

    return {
        indexedDbKeys,
        localKeys,
        syncKeys,
        totalKeys: indexedDbKeys + localKeys + syncKeys,
    };
}

function padTwoDigits(value) {
    return String(value).padStart(2, '0');
}

export function buildDataBackupFilename(date = new Date()) {
    const year = date.getFullYear();
    const month = padTwoDigits(date.getMonth() + 1);
    const day = padTwoDigits(date.getDate());
    const hours = padTwoDigits(date.getHours());
    const minutes = padTwoDigits(date.getMinutes());
    const seconds = padTwoDigits(date.getSeconds());
    return `cerebr-backup-${year}${month}${day}-${hours}${minutes}${seconds}.json`;
}

export async function createDataBackupSnapshot({ appVersion = '' } = {}) {
    const [indexedDb, local, sync] = isExtensionEnvironment
        ? await Promise.all([
            readIndexedDbSnapshot(),
            readExtensionStorageSnapshot('local'),
            readExtensionStorageSnapshot('sync')
        ])
        : await Promise.all([
            readIndexedDbSnapshot(),
            Promise.resolve({}),
            Promise.resolve(readWebSyncStorageSnapshot())
        ]);

    const snapshot = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        source: {
            environment: isExtensionEnvironment ? 'extension' : 'web',
            appVersion: String(appVersion || '').trim(),
        },
        storage: {
            indexedDb,
            local,
            sync,
        }
    };

    return {
        ...snapshot,
        summary: summarizeDataBackupSnapshot(snapshot)
    };
}

export function downloadDataBackup(snapshot, { filename = buildDataBackupFilename() } = {}) {
    const normalizedSnapshot = normalizeBackupSnapshot(snapshot);
    const blob = new Blob([JSON.stringify(normalizedSnapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function readFileAsText(file) {
    if (!file) {
        return Promise.reject(new Error('No backup file selected'));
    }

    if (typeof file.text === 'function') {
        return file.text();
    }

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Failed to read backup file'));
        reader.readAsText(file);
    });
}

export async function parseDataBackupFile(file) {
    if (!file) {
        throw new Error('No backup file selected');
    }

    const text = await readFileAsText(file);
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new Error(`Backup file is not valid JSON: ${error?.message || error}`);
    }

    return normalizeBackupSnapshot(parsed);
}

function buildRestorePayload(snapshot) {
    const normalizedSnapshot = normalizeBackupSnapshot(snapshot);
    const mergedLocalData = {
        ...normalizedSnapshot.storage.local,
        ...normalizedSnapshot.storage.indexedDb,
    };

    const indexedDbEntries = {};
    const localEntries = {};

    Object.entries(mergedLocalData).forEach(([key, value]) => {
        if (isChatStorageKey(key)) {
            indexedDbEntries[key] = value;
            return;
        }
        localEntries[key] = value;
    });

    return {
        snapshot: normalizedSnapshot,
        indexedDbEntries,
        localEntries,
        syncEntries: cloneStorageMap(normalizedSnapshot.storage.sync),
    };
}

export async function restoreDataBackup(snapshot) {
    const restorePayload = buildRestorePayload(snapshot);

    if (isExtensionEnvironment) {
        await Promise.all([
            replaceIndexedDbSnapshot(restorePayload.indexedDbEntries),
            replaceExtensionStorageSnapshot('local', restorePayload.localEntries),
            replaceExtensionStorageSnapshot('sync', restorePayload.syncEntries),
        ]);
    } else {
        await Promise.all([
            replaceIndexedDbSnapshot({
                ...restorePayload.localEntries,
                ...restorePayload.indexedDbEntries,
            }),
            Promise.resolve().then(() => replaceWebSyncStorageSnapshot(restorePayload.syncEntries)),
        ]);
    }

    return {
        snapshot: restorePayload.snapshot,
        summary: restorePayload.snapshot.summary,
    };
}
