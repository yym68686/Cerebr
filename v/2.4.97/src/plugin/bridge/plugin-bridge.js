export const CEREBR_PLUGIN_BRIDGE_TYPE = 'CEREBR_PLUGIN_BRIDGE';
export const CEREBR_PLUGIN_BRIDGE_SCHEMA_VERSION = 2;

function createBridgeMessageId() {
    return `bridge:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export function createPluginBridgeMessage(target, command, payload = {}, meta = null) {
    const message = {
        type: CEREBR_PLUGIN_BRIDGE_TYPE,
        schemaVersion: CEREBR_PLUGIN_BRIDGE_SCHEMA_VERSION,
        messageId: createBridgeMessageId(),
        target,
        command,
        payload,
    };

    if (meta && typeof meta === 'object') {
        message.meta = {
            timestamp: Date.now(),
            ...meta,
        };
    } else {
        message.meta = {
            timestamp: Date.now(),
        };
    }

    return message;
}

export function isPluginBridgeMessage(data, target = null) {
    if (!data || typeof data !== 'object') return false;
    if (data.type !== CEREBR_PLUGIN_BRIDGE_TYPE) return false;
    if (typeof data.command !== 'string' || !data.command) return false;
    if (Object.prototype.hasOwnProperty.call(data, 'schemaVersion')) {
        const schemaVersion = Number(data.schemaVersion);
        if (!Number.isFinite(schemaVersion) || schemaVersion < 1 || schemaVersion > CEREBR_PLUGIN_BRIDGE_SCHEMA_VERSION) {
            return false;
        }
    }
    if (target && data.target !== target) return false;
    return true;
}

export function postPluginBridgeMessage(targetWindow, target, command, payload = {}) {
    if (!targetWindow || typeof targetWindow.postMessage !== 'function') {
        return false;
    }

    try {
        targetWindow.postMessage(createPluginBridgeMessage(target, command, payload), '*');
        return true;
    } catch {
        return false;
    }
}
