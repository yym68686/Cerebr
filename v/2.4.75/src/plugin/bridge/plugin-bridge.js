export const CEREBR_PLUGIN_BRIDGE_TYPE = 'CEREBR_PLUGIN_BRIDGE';

export function createPluginBridgeMessage(target, command, payload = {}, meta = null) {
    const message = {
        type: CEREBR_PLUGIN_BRIDGE_TYPE,
        target,
        command,
        payload,
    };

    if (meta && typeof meta === 'object') {
        message.meta = { ...meta };
    }

    return message;
}

export function isPluginBridgeMessage(data, target = null) {
    if (!data || typeof data !== 'object') return false;
    if (data.type !== CEREBR_PLUGIN_BRIDGE_TYPE) return false;
    if (typeof data.command !== 'string' || !data.command) return false;
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
