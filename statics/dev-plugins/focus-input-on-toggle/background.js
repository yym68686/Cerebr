import { definePlugin } from '../../../src/plugin/shared/define-plugin.js';

async function focusShellInput(ctx, tabId = null) {
    const normalizedTabId = Number.isFinite(Number(tabId))
        ? Math.floor(Number(tabId))
        : null;
    const resolvedTabId = normalizedTabId ?? (await ctx.browser.getCurrentTab())?.id;

    if (!Number.isFinite(Number(resolvedTabId))) {
        return;
    }

    await ctx.bridge.sendToTab(resolvedTabId, 'shell', 'editor.focus');
}

export default definePlugin({
    id: 'local.focus-input-on-toggle',
    setup() {},
    async onActionClicked(tab, ctx) {
        await focusShellInput(ctx, tab?.id);
    },
    async onCommand(command, ctx) {
        if (command !== 'toggle_sidebar') {
            return;
        }

        await focusShellInput(ctx);
    },
});
