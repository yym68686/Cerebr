import { IDBFactory } from 'fake-indexeddb';
import { upgradeReplica } from '../../src/runtime/sync/replica.js';

export async function createTestSyncDatabase() {
    const factory = new IDBFactory();
    return new Promise((resolve, reject) => {
        const request = factory.open('test', 2);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('keyValueStore');
            upgradeReplica(request.result);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
