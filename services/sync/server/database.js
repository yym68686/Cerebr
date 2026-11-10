import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { hashPassword } from './auth.js';
import { compareVersions, validRecord } from './protocol.js';
import { summarizeRecords } from './summary.js';

export class Database {
    integrityChecks = new Map();
    constructor(url) { this.pool = new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 }); }
    query(sql, values) { return this.pool.query(sql, values); }
    async initialize({ username, password } = {}) {
        await this.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
        if (username && password) {
            const existing = await this.query('SELECT id FROM users WHERE username=$1', [username]);
            if (!existing.rowCount) await this.query('INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,\'admin\') ON CONFLICT(username) DO NOTHING', [randomUUID(), username, await hashPassword(password)]);
        }
    }
    async createShare(ownerId, chatId, snapshot) {
        // Re-copying a link must not silently publish subsequent private replies.
        return (await this.query(`INSERT INTO conversation_shares(id,owner_id,source_chat_id,snapshot) VALUES($1,$2,$3,$4)
            ON CONFLICT(owner_id,source_chat_id) DO UPDATE SET source_chat_id=excluded.source_chat_id RETURNING id`,
            [randomBytes(24).toString('hex'), ownerId, chatId, snapshot])).rows[0].id;
    }
    async getShare(id) {
        return (await this.query(`SELECT s.snapshot FROM conversation_shares s JOIN users u ON u.id=s.owner_id
            WHERE s.id=$1 AND u.status<>'banned'`, [id])).rows[0]?.snapshot;
    }
    async updateShare(ownerId, id, snapshot) {
        return (await this.query('UPDATE conversation_shares SET snapshot=$3,updated_at=now() WHERE owner_id=$1 AND id=$2 RETURNING id', [ownerId, id, snapshot])).rowCount > 0;
    }
    async revokeShare(ownerId, id) {
        return (await this.query('DELETE FROM conversation_shares WHERE owner_id=$1 AND id=$2 RETURNING id', [ownerId, id])).rowCount > 0;
    }
    async put(userId, incoming) {
        if (!validRecord(incoming) || incoming.key.length > 256) throw new Error('Invalid sync record');
        const record = { key: incoming.key, value: incoming.value ?? null, deleted: !!incoming.deleted, version: incoming.version };
        const connection = await this.pool.connect();
        try {
            await connection.query('BEGIN');
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [userId]);
            const old = (await connection.query('SELECT body FROM records WHERE user_id=$1 AND key=$2', [userId, record.key])).rows[0]?.body;
            const order = compareVersions(record.version, old?.version);
            if (old && old.version.actor !== record.version.actor && JSON.stringify(old.value) !== JSON.stringify(record.value)) {
                const loser = order > 0 ? old : record;
                await connection.query('INSERT INTO revisions(user_id,key,clock,actor,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [userId, loser.key, loser.version.clock, loser.version.actor, loser]);
            }
            const changed = !old || order > 0;
            if (changed) {
                const isChat = record.key.startsWith('cerebr_chat_v2_') && !record.deleted;
                await connection.query(`INSERT INTO records(user_id,key,body,clock,actor,deleted,byte_size,chats,messages) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                    ON CONFLICT(user_id,key) DO UPDATE SET body=excluded.body,clock=excluded.clock,actor=excluded.actor,deleted=excluded.deleted,byte_size=excluded.byte_size,chats=excluded.chats,messages=excluded.messages,updated_at=now()`,
                    [userId, record.key, record, record.version.clock, record.version.actor, record.deleted, Buffer.byteLength(JSON.stringify(record)), isChat ? 1 : 0, isChat ? record.value.messages.length : 0]);
            }
            await connection.query('COMMIT');
            return { changed, record: changed ? record : old };
        } catch (error) { await connection.query('ROLLBACK'); throw error; }
        finally { connection.release(); }
    }
    async deleteUser(adminId, userId, username) {
        const connection = await this.pool.connect();
        try {
            await connection.query('BEGIN');
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [userId]);
            const user = (await connection.query('SELECT id,username,role,status FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
            const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
            if (!user) throw fail('用户不存在。', 404);
            if (user.role === 'admin') throw fail('不能删除管理员账号。');
            if (username !== user.username) throw fail('删除确认的用户名不匹配，请刷新后重试。');
            await connection.query('INSERT INTO audit_log(admin_id,user_id,username,action) VALUES($1,$2,$3,\'deleted\')', [adminId, userId, user.username]);
            for (const table of ['sessions', 'sync_events', 'traffic', 'revisions', 'records', 'devices']) {
                await connection.query(`DELETE FROM ${table} WHERE user_id=$1`, [userId]);
            }
            await connection.query('DELETE FROM users WHERE id=$1', [userId]);
            await connection.query('COMMIT');
            this.integrityChecks.delete(userId);
            return user;
        } catch (error) { await connection.query('ROLLBACK'); throw error; }
        finally { connection.release(); }
    }
    async get(userId, key) { return (await this.query('SELECT body FROM records WHERE user_id=$1 AND key=$2', [userId, key])).rows[0]?.body; }
    async manifest(userId) {
        return (await this.query('SELECT key,clock,actor,deleted FROM records WHERE user_id=$1 ORDER BY key', [userId])).rows.map((r) => ({ key: r.key, deleted: r.deleted, version: { clock: Number(r.clock), actor: r.actor } }));
    }
    async summary(userId, integrity = false) {
        if (integrity) {
            if (!this.integrityChecks.has(userId)) {
                this.integrityChecks.set(userId, this.integritySummary(userId).finally(() => this.integrityChecks.delete(userId)));
            }
            return this.integrityChecks.get(userId);
        }
        const row = (await this.query('SELECT count(*)::int records,coalesce(sum(chats),0)::int chats,coalesce(sum(messages),0)::int messages,coalesce(sum(byte_size),0)::bigint bytes FROM records WHERE user_id=$1', [userId])).rows[0];
        return { ...row, bytes: Number(row.bytes) };
    }
    async integritySummary(userId) {
        // Stream a consistent snapshot. Reading every image into a single array
        // and serializing it again can exhaust the container and drop sockets.
        const connection = await this.pool.connect();
        try {
            await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const row = (await connection.query('SELECT count(*)::int records,coalesce(sum(chats),0)::int chats,coalesce(sum(messages),0)::int messages,coalesce(sum(byte_size),0)::bigint bytes FROM records WHERE user_id=$1', [userId])).rows[0];
            if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Invalid sync user id');
            await connection.query(`DECLARE sync_integrity NO SCROLL CURSOR FOR SELECT body FROM records WHERE user_id='${userId}'::uuid ORDER BY key COLLATE "C"`);
            const hash = createHash('sha256').update('[');
            let first = true;
            for (;;) {
                const { rows } = await connection.query('FETCH FORWARD 50 FROM sync_integrity');
                if (!rows.length) break;
                for (const { body } of rows) {
                    if (!first) hash.update(',');
                    first = false;
                    hash.update(summarizeRecords([body]).serialized.slice(1, -1));
                }
            }
            const digest = hash.update(']').digest('hex');
            await connection.query('COMMIT');
            return { ...row, bytes: Number(row.bytes), digest };
        } catch (error) { await connection.query('ROLLBACK'); throw error; }
        finally { connection.release(); }
    }
    close() { return this.pool.end(); }
}
