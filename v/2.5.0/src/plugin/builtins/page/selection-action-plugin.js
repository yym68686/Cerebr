import { definePlugin } from '../../shared/define-plugin.js';

const MIN_SELECTION_LENGTH = 2;
const MAX_SELECTION_LENGTH = 4000;

function normalizeSelectionText(value) {
    return String(value || '').trim();
}

function canShowForSelection(selection) {
    const text = normalizeSelectionText(selection?.text);
    if (!text) return false;
    if (selection?.collapsed) return false;
    if (selection?.insideEditable) return false;
    if (selection?.insideCodeBlock) return false;
    if (!selection?.rect) return false;
    if (text.length < MIN_SELECTION_LENGTH) return false;
    if (text.length > MAX_SELECTION_LENGTH) return false;
    return true;
}

export const selectionActionPlugin = definePlugin({
    id: 'builtin.selection-action',
    displayName: 'Selection Action',
    activationEvents: ['page.ready'],
    async setup(api) {
        let actionHandle = null;
        let latestSelectionText = '';

        const hideAction = () => {
            actionHandle?.dispose?.();
            actionHandle = null;
            latestSelectionText = '';
        };

        const label = api.page.getMessage(
            'plugin_selection_import_aria',
            undefined,
            'Open Cerebr with the selected text'
        );
        const title = api.page.getMessage(
            'plugin_selection_import_title',
            undefined,
            'Ask Cerebr about this selection'
        );

        const onSelectionChange = (selection) => {
            if (!canShowForSelection(selection)) {
                hideAction();
                return;
            }

            latestSelectionText = normalizeSelectionText(selection.text);
            const nextConfig = {
                rect: selection.rect,
                label,
                title,
                icon: 'dot',
                onClick: () => {
                    const textToImport = latestSelectionText;
                    hideAction();
                    api.shell.importText(textToImport, { focus: true });
                    api.page.clearSelection();
                },
            };

            if (actionHandle) {
                actionHandle.update(nextConfig);
                return;
            }

            actionHandle = api.ui.showAnchoredAction(nextConfig);
        };

        const unsubscribe = api.page.watchSelection(onSelectionChange);

        return () => {
            unsubscribe?.();
            hideAction();
        };
    },
});
