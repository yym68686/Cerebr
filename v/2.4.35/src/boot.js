const isExtensionProtocol = () => {
    const protocol = window.location?.protocol || '';
    return protocol === 'chrome-extension:' || protocol === 'moz-extension:';
};

let appHeightRafId = 0;
let appHeightBurstRafId = 0;
let appHeightBurstUntilMs = 0;

const isTextInputLike = (el) => {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tagName = el.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA';
};

const updateAppHeight = () => {
    appHeightRafId = 0;
    // Keep --app-height tied to the *layout* viewport height. On iOS Safari the keyboard
    // only shrinks the visual viewport (not window.innerHeight), and keyboard compensation
    // is handled separately via `utils/viewport.js` to avoid double-offset / bouncing.
    const height = window.innerHeight || document.documentElement?.clientHeight || 0;
    if (!height) return;
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
};

const scheduleAppHeightUpdate = () => {
    if (appHeightRafId) return;
    appHeightRafId = requestAnimationFrame(updateAppHeight);
};

const scheduleAppHeightBurst = (durationMs = 1800) => {
    const now = performance.now();
    appHeightBurstUntilMs = Math.max(appHeightBurstUntilMs, now + durationMs);
    if (appHeightBurstRafId) return;

    const tick = () => {
        appHeightBurstRafId = 0;
        updateAppHeight();
        if (performance.now() < appHeightBurstUntilMs) {
            appHeightBurstRafId = requestAnimationFrame(tick);
        }
    };

    appHeightBurstRafId = requestAnimationFrame(tick);
};

const initAppHeight = () => {
    scheduleAppHeightUpdate();

    window.addEventListener('resize', scheduleAppHeightUpdate, { passive: true });
    window.addEventListener('orientationchange', scheduleAppHeightUpdate, { passive: true });
    window.addEventListener('pageshow', scheduleAppHeightUpdate, { passive: true });

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleAppHeightUpdate);
        window.visualViewport.addEventListener('scroll', scheduleAppHeightUpdate);
    }

    document.addEventListener(
        'focusin',
        (event) => {
            scheduleAppHeightUpdate();
            if (isTextInputLike(event?.target)) scheduleAppHeightBurst();
        },
        true
    );
    document.addEventListener(
        'focusout',
        (event) => {
            scheduleAppHeightUpdate();
            if (isTextInputLike(event?.target)) scheduleAppHeightBurst(600);
        },
        true
    );
};

const toSafePathSegment = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return /^[0-9A-Za-z._-]+$/.test(raw) ? raw : null;
};

const applyVersionedStylesheet = (version) => {
    const safeVersion = toSafePathSegment(version);
    if (!safeVersion) return;

    const versionedHref = new URL(`../v/${safeVersion}/styles/main.css`, import.meta.url).toString();

    const existingLink = document.querySelector?.(
        'link[rel="stylesheet"][href$="styles/main.css"], link[rel="stylesheet"][href$="/styles/main.css"]'
    );

    if (existingLink) {
        existingLink.href = versionedHref;
        return;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = versionedHref;
    document.head?.appendChild(link);
};

const tryImport = async (specifier) => {
    try {
        await import(specifier);
        return true;
    } catch (error) {
        console.warn(`[Cerebr] Failed to import: ${specifier}`, error);
        return false;
    }
};

const fetchManifestVersion = async () => {
    const candidates = [
        new URL('../manifest.json', import.meta.url),
        new URL('../manifest.firefox.json', import.meta.url)
    ];

    for (const url of candidates) {
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) continue;
            const manifest = await response.json();
            const version = toSafePathSegment(manifest?.version);
            if (version) return version;
        } catch {
            // ignore and continue
        }
    }

    return null;
};

const boot = async () => {
    initAppHeight();

    // Extension pages keep using the unversioned module graph.
    if (isExtensionProtocol()) {
        await tryImport('./main.js');
        return;
    }

    // Web: try versioned module graph first to avoid Safari ESM cache sticking to old code.
    const version = await fetchManifestVersion();
    if (version) {
        applyVersionedStylesheet(version);
        const ok = await tryImport(`../v/${version}/src/main.js`);
        if (ok) return;
    }

    await tryImport('./main.js');
};

boot();
