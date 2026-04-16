export function createChatError(code, message, details = {}) {
    const error = new Error(message || code || 'Chat runtime error');
    error.name = 'CerebrChatError';
    error.code = code || 'CHAT_RUNTIME_ERROR';
    Object.assign(error, details);
    return error;
}

export function normalizeChatError(error, fallbackCode = 'CHAT_RUNTIME_ERROR') {
    if (error?.name === 'AbortError') {
        return error;
    }

    const normalized = error instanceof Error
        ? error
        : new Error(String(error ?? 'Unknown chat error'));

    if (!normalized.code) {
        normalized.code = fallbackCode;
    }

    return normalized;
}

export function isAbortError(error) {
    return error?.name === 'AbortError';
}
