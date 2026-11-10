import path from 'node:path';

export function applicationChunk(chunks) {
    const main = path.resolve('src/main.jsx').replaceAll('\\', '/');
    // Vite can inline the HTML facade and output its dependencies as separate
    // script tags. The chunk containing the React entry is still unambiguous.
    return chunks.find(
        (chunk) =>
            chunk.type === 'chunk' &&
            Object.keys(chunk.modules || {}).some((id) => id.replaceAll('\\', '/') === main)
    );
}
