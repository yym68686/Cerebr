import { createRoot } from 'react-dom/client';
import { SelectionActions } from '../../app/components/SelectionActions.jsx';
import { initI18n } from '../../utils/i18n.js';
import { syncStorageAdapter } from '../../utils/storage-adapter.js';
const scope = () => document.body;

// A content overlay reuses the same React component as the chat UI. Its closed
// shadow root isolates it from page CSS and keeps action controls out of host DOM.
export async function mountPageSelectionActions({ onAction }) {
    await initI18n();
    const host = document.createElement('cerebr-selection');
    host.style.cssText =
        'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;cursor:default;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const container = document.createElement('div');
    shadow.append(container);
    document.documentElement.append(host);
    let theme = (await syncStorageAdapter.get('theme')).theme || 'system';
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
        host.toggleAttribute('data-dark', theme === 'dark' || (theme === 'system' && media.matches));
    const changed = (changes, area) => {
        if (area === 'sync' && changes.theme) {
            theme = changes.theme.newValue || 'system';
            apply();
        }
    };
    apply();
    media.addEventListener('change', apply);
    chrome.storage?.onChanged?.addListener(changed);
    const root = createRoot(container);
    root.render(
        <SelectionActions
            page
            scope={scope}
            onAdd={(text) => onAction({ action: 'add', text })}
            onSend={(text, prompt) => onAction({ action: 'send', text, prompt })}
        />
    );
    return () => {
        root.unmount();
        host.remove();
        media.removeEventListener('change', apply);
        chrome.storage?.onChanged?.removeListener(changed);
    };
}
