// All extension resources live beside the compiled background entry. A source
// checkout mounts that directory at dist/; a packaged extension mounts it at /.
export function extensionAssetPath(path, manifest = chrome.runtime.getManifest()) {
    const entry = manifest.background?.service_worker || manifest.background?.scripts?.[0] || '';
    const directory = entry.slice(0, entry.lastIndexOf('/') + 1);
    return `${directory}${path.replace(/^\/+/, '')}`;
}

// Public resources are rooted at the app document, never at a bundled chunk.
export function appAssetUrl(path) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
        return chrome.runtime.getURL(extensionAssetPath(path));
    return new URL(path, document.baseURI).href;
}
