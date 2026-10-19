import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import foundation from './foundation.css?inline';
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';

// CSS @property registrations are not applied inside shadow trees. Preserve
// Tailwind's own initial values locally so the original ring/shadow utilities work.
const propertyDefaults = [...foundation.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]+)\}/g)]
    .flatMap(([, name, block]) => {
        const initial = block.match(/initial-value:\s*([^;}]+)/);
        return initial ? [`${name}:${initial[1]};`] : [];
    })
    .join('');
const fontDocuments = new WeakSet();
export function SelectionSurface({ hostRef, children }) {
    const [shadow, setShadow] = useState(null);
    const [dark, setDark] = useState(false);
    useEffect(() => {
        const host = hostRef.current;
        const owner = host.ownerDocument;
        const enclosingHost = host.getRootNode().host;
        const themeRoot = enclosingHost || owner.documentElement;
        const media = window.matchMedia?.('(prefers-color-scheme: dark)');
        const apply = () =>
            setDark(
                enclosingHost
                    ? enclosingHost.hasAttribute('data-dark')
                    : themeRoot.classList.contains('dark-theme') ||
                          (!themeRoot.classList.contains('light-theme') && !!media?.matches)
            );
        apply();
        const observer = new MutationObserver(apply);
        observer.observe(themeRoot, { attributes: true, attributeFilter: ['class', 'data-dark'] });
        media?.addEventListener('change', apply);
        setShadow(host.shadowRoot || host.attachShadow({ mode: 'open' }));
        // Fonts must be registered on the document, including for a nested page shadow root.
        if (owner.fonts && typeof FontFace !== 'undefined' && !fontDocuments.has(owner)) {
            fontDocuments.add(owner);
            const font = new FontFace('Cerebr Selection Inter', `url(${interUrl})`, {
                weight: '100 900',
                style: 'normal',
            });
            owner.fonts.add(font);
            void font.load().catch(() => {
                fontDocuments.delete(owner);
            });
        }
        return () => {
            observer.disconnect();
            media?.removeEventListener('change', apply);
        };
    }, [hostRef]);
    if (!shadow) return null;
    return createPortal(
        <>
            <style>{foundation}</style>
            <style>{`@layer properties { :host, *, ::before, ::after { ${propertyDefaults} } }`}</style>
            <style>{`:host { --spacing: 4px; --font-inter: 'Cerebr Selection Inter'; font-size: 14px; line-height: 1.5; letter-spacing: -.01em; font-feature-settings: 'cv11', 'ss01'; -webkit-font-smoothing: antialiased; } .cerebr-selection-theme { width: max-content; font-family: var(--font-inter), ui-sans-serif, system-ui, sans-serif; } [data-selection-pill], .selection-customizer, .selection-error { pointer-events: auto; cursor: default; } input, textarea { cursor: text; } button:not(:disabled) { cursor: pointer; } button:disabled { cursor: default; } button :is(svg, span), button svg * { pointer-events: none; cursor: inherit; }`}</style>
            <div className={`cerebr-selection-theme primitive-showcase${dark ? ' dark' : ''}`}>
                {children}
            </div>
        </>,
        shadow
    );
}
