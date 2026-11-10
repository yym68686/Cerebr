import pg from 'pg';
import { randomUUID } from 'node:crypto';

// LISTEN/NOTIFY reaches clients attached to a draining deployment as well as
// the new instance. Large live frames use a short-lived row, never an 8 KB
// NOTIFY payload. Durable records only publish their key.
export async function createSyncBus(database, { receive, unavailable, logger }) {
    const source = randomUUID();
    let listener, retry, stopped = false, queue = Promise.resolve();
    async function listen() {
        const connection = new pg.Client(database.pool.options);
        listener = connection;
        const lost = () => {
            if (listener !== connection) return;
            listener = null;
            void connection.end().catch(() => {});
            if (!stopped) {
                unavailable();
                retry = setTimeout(() => void listen().catch(lost), 1000);
            }
        };
        connection.on('error', lost);
        connection.on('end', lost);
        connection.on('notification', ({ payload }) => {
            queue = queue.then(async () => {
                const event = JSON.parse(payload);
                if (event.source === source) return;
                if (event.id) {
                    const row = (await database.query('SELECT user_id, message FROM sync_events WHERE id=$1', [event.id])).rows[0];
                    if (!row) return;
                    await receive(row.user_id, row.message);
                } else await receive(event.userId, event.message);
            }).catch(error => logger.warn({ message: error.message }, 'Cross-instance sync notification failed'));
        });
        try { await connection.connect(); await connection.query('LISTEN cerebr_sync'); }
        catch (error) { lost(); throw error; }
    }
    await listen();
    const cleanup = setInterval(() => {
        void database.query("DELETE FROM sync_events WHERE created_at < now()-interval '30 seconds'").catch(() => {});
    }, 15000);
    cleanup.unref();
    return {
        async publish(userId, message) {
            if (message.type === 'live-chat') {
                const { rows } = await database.query('INSERT INTO sync_events(user_id,message) VALUES($1,$2) RETURNING id', [userId, message]);
                await database.query("SELECT pg_notify('cerebr_sync',$1)", [JSON.stringify({ source, id: rows[0].id })]);
            } else {
                await database.query("SELECT pg_notify('cerebr_sync',$1)", [JSON.stringify({ source, userId, message })]);
            }
        },
        async close() { stopped = true; clearTimeout(retry); clearInterval(cleanup); await listener?.end(); await queue; },
    };
}
