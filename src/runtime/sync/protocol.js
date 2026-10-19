export const SYNC_PORT = 43179;
export const SYNC_PROTOCOL = 1;
export const SYNC_RECORDS = 'syncRecords';
export const SYNC_META = 'syncMeta';
export const CHAT_PREFIX = 'cerebr_chat_v2_';
export const CHAT_INDEX = 'cerebr_chats_index_v2';
export const API_CONFIG_PREFIX = 'cerebr_api_config_v1_';
export const API_SELECTION = 'cerebr_api_selection_v1';
export function isSyncedKey(key) {
    return (
        typeof key === 'string' &&
        (key.startsWith(CHAT_PREFIX) ||
            key.startsWith(API_CONFIG_PREFIX) ||
            key === API_SELECTION ||
            key.startsWith('cerebr_reading_progress_v1_') ||
            key.startsWith('cerebr_draft_v1_') ||
            key.startsWith('cerebr_youtube_transcript_v1_') ||
            key === 'cerebr_chat_organization_v1')
    );
}
export function compareVersions(a, b) {
    return (
        (Number(a?.clock) || 0) - (Number(b?.clock) || 0) ||
        String(a?.actor || '').localeCompare(String(b?.actor || ''))
    );
}
export function validRecord(record) {
    if (
        !record ||
        !isSyncedKey(record.key) ||
        !Number.isSafeInteger(record.version?.clock) ||
        record.version.clock < 0 ||
        typeof record.version.actor !== 'string' ||
        record.version.actor.length > 100 ||
        !record.version.actor
    )
        return false;
    if (!record.deleted && record.key.startsWith(CHAT_PREFIX)) {
        return (
            record.value?.id === record.key.slice(CHAT_PREFIX.length) &&
            typeof record.value.title === 'string' &&
            Array.isArray(record.value.messages)
        );
    }
    if (!record.deleted && record.key.startsWith(API_CONFIG_PREFIX))
        return (
            record.value?.config?.id === record.key.slice(API_CONFIG_PREFIX.length) &&
            typeof record.value.config.apiKey === 'string' &&
            typeof record.value.config.baseUrl === 'string' &&
            typeof record.value.config.modelName === 'string'
        );
    if (!record.deleted && record.key === API_SELECTION) return typeof record.value === 'string';
    return record.deleted === true || record.value !== undefined;
}
