export function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

export function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => normalizeString(item)).filter(Boolean);
}

export function normalizeNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizePositiveInt(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0
        ? Math.max(1, Math.floor(numeric))
        : fallback;
}

export function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    return fallback;
}
