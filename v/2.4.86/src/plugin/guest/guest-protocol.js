export const CEREBR_PLUGIN_GUEST_MESSAGE_TYPE = 'CEREBR_PLUGIN_GUEST';

export const GUEST_FRAME_READY = 'frame-ready';
export const GUEST_BOOT = 'boot';
export const GUEST_READY = 'ready';
export const GUEST_ERROR = 'error';
export const GUEST_RPC_REQUEST = 'rpc-request';
export const GUEST_RPC_RESPONSE = 'rpc-response';
export const GUEST_EVENT = 'event';
export const GUEST_RESIZE = 'resize';
export const GUEST_SHUTDOWN = 'shutdown';

export function createGuestMessage(kind, payload = {}, sessionId = '') {
    return {
        type: CEREBR_PLUGIN_GUEST_MESSAGE_TYPE,
        kind: String(kind || ''),
        sessionId: String(sessionId || ''),
        payload: payload && typeof payload === 'object' ? { ...payload } : {},
    };
}

export function isGuestMessage(data, sessionId = '') {
    if (!data || typeof data !== 'object') {
        return false;
    }
    if (data.type !== CEREBR_PLUGIN_GUEST_MESSAGE_TYPE) {
        return false;
    }
    if (typeof data.kind !== 'string' || !data.kind) {
        return false;
    }
    if (sessionId && data.sessionId !== sessionId) {
        return false;
    }
    return true;
}
