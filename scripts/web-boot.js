// A single startup path for the compiled Web and extension applications.
// Fetch the current hashed entry without trusting Safari's module cache.
try {
    const base = new URL('./', import.meta.url);
    const response = await fetch(new URL('web-manifest.json', base), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Resource manifest: HTTP ${response.status}`);
    const manifest = await response.json();
    await Promise.all(
        manifest.css.map(
            (href) =>
                new Promise((resolve, reject) => {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = new URL(href, base);
                    link.onload = resolve;
                    link.onerror = reject;
                    document.head.append(link);
                })
        )
    );
    await import(new URL(manifest.entry, base).href);
} catch (error) {
    console.error('[Cerebr] Startup failed', error);
    const root = document.getElementById('root');
    const message = document.createElement('p');
    message.textContent = 'Cerebr could not load. Please refresh to retry.';
    const retry = document.createElement('button');
    retry.textContent = 'Reload';
    retry.onclick = () => location.reload();
    root.replaceChildren(message, retry);
}
