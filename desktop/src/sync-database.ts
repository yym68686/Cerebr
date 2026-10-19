import { DatabaseSync } from 'node:sqlite';
import { compareVersions, validRecord } from '../../src/runtime/sync/protocol.js';
import { createHash } from 'node:crypto';
import { summarizeRecords } from '../../src/runtime/sync/summary.js';
export class SyncDatabase {
    db: DatabaseSync;
    stats = new Map<string, { chats: number; messages: number }>();
    constructor(file: string) {
        this.db = new DatabaseSync(file);
        this.db.exec(
            'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revisions (key TEXT NOT NULL, version TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key, version));'
        );
        for (const row of this.db
            .prepare(
                "SELECT key, json_extract(body, '$.deleted') AS deleted, json_array_length(body, '$.value.messages') AS messages FROM records"
            )
            .all()) {
            const isChat = String(row.key).startsWith('cerebr_chat_v2_') && !row.deleted;
            this.stats.set(String(row.key), {
                chats: isChat ? 1 : 0,
                messages: isChat ? Number(row.messages) || 0 : 0,
            });
        }
    }
    get(key: string): any {
        const row = this.db.prepare('SELECT body FROM records WHERE key=?').get(key);
        return row ? JSON.parse(String(row.body)) : null;
    }
    manifest() {
        return this.db
            .prepare('SELECT body FROM records')
            .all()
            .map((row) => {
                const { key, version, deleted } = JSON.parse(String(row.body));
                return { key, version, deleted };
            });
    }
    put(incoming: any) {
        if (!validRecord(incoming)) throw new Error('Invalid history record');
        const record = {
            key: incoming.key,
            value: incoming.value ?? null,
            deleted: !!incoming.deleted,
            version: incoming.version,
        };
        const previous = this.get(record.key);
        const order = compareVersions(record.version, previous?.version);
        const body = JSON.stringify(record);
        // Keep different-actor losing revisions for recovery instead of silently
        // discarding a concurrent edit. Same-actor streaming checkpoints coalesce.
        this.db.exec('BEGIN IMMEDIATE');
        try {
            if (
                previous &&
                previous.version.actor !== record.version.actor &&
                JSON.stringify(previous.value) !== JSON.stringify(record.value)
            ) {
                const loser = order > 0 ? previous : record;
                this.db
                    .prepare('INSERT OR IGNORE INTO revisions VALUES (?, ?, ?)')
                    .run(loser.key, JSON.stringify(loser.version), JSON.stringify(loser));
            }
            if (!previous || order > 0)
                this.db
                    .prepare(
                        'INSERT INTO records VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body'
                    )
                    .run(record.key, body);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        if (!previous || order > 0) {
            const isChat = record.key.startsWith('cerebr_chat_v2_') && !record.deleted;
            this.stats.set(record.key, {
                chats: isChat ? 1 : 0,
                messages: isChat ? record.value.messages.length : 0,
            });
        }
        return { record: !previous || order > 0 ? record : previous, changed: !previous || order > 0 };
    }
    setting(key: string, value?: any) {
        if (value !== undefined)
            this.db
                .prepare(
                    'INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
                )
                .run(key, JSON.stringify(value));
        const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
        return row ? JSON.parse(String(row.value)) : null;
    }
    summary(integrity = false) {
        const counts = { records: this.stats.size, chats: 0, messages: 0 };
        for (const stat of this.stats.values()) {
            counts.chats += stat.chats;
            counts.messages += stat.messages;
        }
        const revisions = this.db.prepare('SELECT count(*) AS count FROM revisions').get()?.count;
        if (!integrity) return { ...counts, revisions };
        const records = this.db
            .prepare('SELECT body FROM records ORDER BY key')
            .all()
            .map((row) => JSON.parse(String(row.body)));
        const { serialized } = summarizeRecords(records);
        return { ...counts, digest: createHash('sha256').update(serialized).digest('hex'), revisions };
    }
    close() {
        this.db.close();
    }
}
