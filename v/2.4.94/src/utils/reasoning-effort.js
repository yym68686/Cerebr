export const REASONING_EFFORT_OPTIONS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
export const DEFAULT_REASONING_EFFORT = 'off';

export function normalizeReasoningEffort(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return REASONING_EFFORT_OPTIONS.includes(normalized)
        ? normalized
        : DEFAULT_REASONING_EFFORT;
}

export function modelSupportsReasoningEffort(modelName) {
    return String(modelName ?? '').trim().toLowerCase().startsWith('gpt');
}
