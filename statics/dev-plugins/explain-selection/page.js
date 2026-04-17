import { definePlugin } from '../../../src/plugin/shared/define-plugin.js';

function normalizeSelectedText(text) {
    return String(text ?? '').replace(/\s+\n/g, '\n').trim();
}

export default definePlugin({
    id: 'local.explain-selection',
    activationEvents: ['page.ready'],
    setup(api) {
        let action = null;

        const disposeSelectionWatcher = api.page.watchSelection((snapshot) => {
            const text = normalizeSelectedText(snapshot?.text);
            const shouldShow = !!text &&
                !snapshot?.collapsed &&
                !!snapshot?.rect &&
                !snapshot?.insideEditable &&
                !snapshot?.insideCodeBlock;

            if (!shouldShow) {
                action?.dispose?.();
                action = null;
                return;
            }

            const config = {
                rect: snapshot.rect,
                icon: 'dot',
                offsetX: 28,
                label: 'Explain with Cerebr',
                title: 'Explain with Cerebr',
                onClick() {
                    api.shell.importText(`请解释下面这段内容，并提炼关键信息：\n\n${text}`, {
                        focus: true,
                    });
                },
            };

            if (!action) {
                action = api.ui.showAnchoredAction(config);
                return;
            }

            action.update(config);
        });

        return () => {
            disposeSelectionWatcher?.();
            action?.dispose?.();
            action = null;
        };
    },
});
