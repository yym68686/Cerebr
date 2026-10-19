import { t } from '../../utils/i18n.js';

// Exported transcripts have no React event handlers. Native details keep the
// reasoning readable and expandable in standalone HTML and existing share plugins.
export function prepareReasoningForExport(root) {
    root.querySelectorAll('.thinking-loader').forEach((loader) => loader.remove());
    root.querySelectorAll('.reasoning-wrapper').forEach((wrapper) => {
        const toggle = wrapper.querySelector('.reasoning-toggle');
        const content = wrapper.querySelector('.reasoning-content');
        if (!toggle || !content) return;
        const details = document.createElement('details');
        details.className = 'reasoning-wrapper reasoning-export';
        details.open = toggle.getAttribute('aria-expanded') === 'true';
        const summary = document.createElement('summary');
        summary.className = 'reasoning-toggle';
        summary.innerHTML = toggle.innerHTML;
        summary.querySelector('.thinking-elapsed')?.remove();
        const label = summary.querySelector('[role="status"]');
        if (label) {
            label.className = 'reasoning-label';
            label.removeAttribute('role');
            label.textContent = t('label_reasoning_process');
        }
        content.className = 'reasoning-export-content';
        for (const attribute of ['inert', 'aria-hidden', 'id']) content.removeAttribute(attribute);
        details.append(summary, content);
        wrapper.replaceWith(details);
    });
}
