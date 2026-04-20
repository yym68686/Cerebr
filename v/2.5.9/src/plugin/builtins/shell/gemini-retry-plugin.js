import { definePlugin } from '../../shared/define-plugin.js';

const RETRYABLE_ERROR_CODES = new Set([
    'CEREBR_MISFILED_THINK_SILENTLY',
    'CEREBR_REASONING_ONLY_RESPONSE',
]);

const MAX_ATTEMPTS = 20;

export const geminiRetryPlugin = definePlugin({
    id: 'builtin.gemini-retry',
    displayName: 'Gemini Retry',
    activationEvents: ['hook:onResponseError'],
    setup() {},
    onResponseError(error, ctx) {
        const code = String(error?.code || '');
        const attempt = Number(ctx?.request?.attempt || 0);
        if (!RETRYABLE_ERROR_CODES.has(code)) {
            return;
        }
        if (attempt >= MAX_ATTEMPTS) {
            return;
        }

        ctx.chat.retry(`builtin:${code.toLowerCase()}`, {
            maxAttempts: MAX_ATTEMPTS,
        });
    },
});
