function getManifestVersionFromRuntime() {
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
            return chrome.runtime.getManifest().version || '';
        }
        if (typeof browser !== 'undefined' && browser.runtime?.getManifest) {
            return browser.runtime.getManifest().version || '';
        }
    } catch {
        // ignore
    }

    return '';
}

async function fetchManifestVersion(path) {
    try {
        const response = await fetch(new URL(path, window.location.href), { cache: 'no-store' });
        if (!response.ok) return '';
        const manifest = await response.json();
        return manifest?.version ? String(manifest.version) : '';
    } catch {
        return '';
    }
}

export async function getAppVersion() {
    const runtimeVersion = getManifestVersionFromRuntime();
    if (runtimeVersion) return runtimeVersion;

    const metaVersion = document.querySelector('meta[name="cerebr-version"]')?.getAttribute('content');
    if (metaVersion) return metaVersion;

    return await fetchManifestVersion('./manifest.json')
        || await fetchManifestVersion('/manifest.json')
        || await fetchManifestVersion('./manifest.firefox.json')
        || await fetchManifestVersion('/manifest.firefox.json')
        || '';
}
