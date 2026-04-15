function normalizeSegment(value) {
    const numeric = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeVersionParts(version) {
    return String(version || '')
        .trim()
        .split('.')
        .map(normalizeSegment);
}

export function compareVersions(a, b) {
    const left = normalizeVersionParts(a);
    const right = normalizeVersionParts(b);
    const maxLength = Math.max(left.length, right.length);

    for (let index = 0; index < maxLength; index += 1) {
        const lhs = left[index] ?? 0;
        const rhs = right[index] ?? 0;
        if (lhs > rhs) return 1;
        if (lhs < rhs) return -1;
    }

    return 0;
}

export function isVersionNewer(nextVersion, prevVersion) {
    if (!nextVersion || !prevVersion) return false;
    return compareVersions(nextVersion, prevVersion) > 0;
}

function evaluateComparator(version, comparator) {
    const match = String(comparator || '').trim().match(/^(<=|>=|<|>|=)?\s*([0-9]+(?:\.[0-9]+)*)$/);
    if (!match) return true;

    const operator = match[1] || '=';
    const target = match[2];
    const comparison = compareVersions(version, target);

    if (operator === '>') return comparison > 0;
    if (operator === '>=') return comparison >= 0;
    if (operator === '<') return comparison < 0;
    if (operator === '<=') return comparison <= 0;
    return comparison === 0;
}

export function satisfiesVersionRange(version, range) {
    const normalizedVersion = String(version || '').trim();
    if (!normalizedVersion) return false;

    const normalizedRange = String(range || '').trim();
    if (!normalizedRange) return true;

    return normalizedRange
        .split(/\s+/)
        .filter(Boolean)
        .every((comparator) => evaluateComparator(normalizedVersion, comparator));
}
