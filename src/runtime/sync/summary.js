import { CHAT_PREFIX } from './protocol.js';

// Normalize record metadata and ordering identically in Node and Chromium.
// Values stay intact, so images, quotes and reasoning participate in the check.
export function summarizeRecords(records) {
    const ordered = records
        .map(({ key, value, deleted, version }) => ({
            key,
            value: value ?? null,
            deleted: !!deleted,
            version: { clock: version.clock, actor: version.actor },
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const chats = ordered.filter((record) => record.key.startsWith(CHAT_PREFIX) && !record.deleted);
    return {
        serialized: JSON.stringify(ordered),
        counts: {
            records: ordered.length,
            chats: chats.length,
            messages: chats.reduce((total, record) => total + record.value.messages.length, 0),
        },
    };
}

export async function browserSummary(records) {
    const { serialized, counts } = summarizeRecords(records);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    return {
        ...counts,
        digest: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
}
