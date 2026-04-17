import { definePlugin } from '../../../runtime/define-plugin.js';

function normalizeSelectedText(text) {
    return String(text ?? '').replace(/\s+\n/g, '\n').trim();
}

export default definePlugin({
    id: 'official.page.explain-selection',
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
                label: api.page.getMessage(
                    'plugin_official_explain_selection_action_label',
                    undefined,
                    'Explain with Cerebr'
                ),
                title: api.page.getMessage(
                    'plugin_official_explain_selection_action_title',
                    undefined,
                    'Explain with Cerebr'
                ),
                onClick() {
                    api.shell.importText(
                        api.page.getMessage(
                            'plugin_official_explain_selection_prompt',
                            [text],
                            `Explain the following passage and extract the key points:\n\n${text}`
                        ),
                        {
                            focus: true,
                        }
                    );
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
