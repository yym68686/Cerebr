const isExtensionProtocol = () => {
    const protocol = window.location?.protocol || '';
    return protocol === 'chrome-extension:' || protocol === 'moz-extension:';
};

const toSafePathSegment = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return /^[0-9A-Za-z._-]+$/.test(raw) ? raw : null;
};

const normalizeThemePreference = (value) => (
    value === 'dark' || value === 'light' || value === 'system' ? value : 'system'
);

const resolveStoredThemePreference = () => {
    try {
        const raw = localStorage.getItem('sync_theme');
        if (!raw) return 'system';
        return normalizeThemePreference(JSON.parse(raw));
    } catch {
        return 'system';
    }
};

const applyInitialThemePreference = () => {
    const root = document.documentElement;
    if (!root) return;

    const themePreference = resolveStoredThemePreference();
    root.classList.remove('dark-theme', 'light-theme');

    if (themePreference === 'dark') {
        root.classList.add('dark-theme');
    } else if (themePreference === 'light') {
        root.classList.add('light-theme');
    }

    const prefersDark = themePreference === 'dark'
        || (themePreference === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)')?.matches);
    const themeColorMeta = document.getElementById('theme-color-meta');
    if (themeColorMeta) {
        themeColorMeta.content = prefersDark ? '#262B33' : '#ffffff';
    }
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
    // Extension pages keep using the unversioned module graph.
    if (isExtensionProtocol()) {
        await tryImport('./main.js');
        return;
    }

    applyInitialThemePreference();

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
