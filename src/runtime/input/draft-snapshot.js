// Guest frames receive structured-cloneable values, never editable DOM nodes.
export function serializeDraftSnapshot(snapshot = { text: '', imageTags: [], empty: true }) {
    return {
        text: snapshot.text,
        empty: snapshot.empty,
        textFiles: (snapshot.textFiles || []).map(file => ({ ...file })),
        quotes: [...(snapshot.quotes || [])],
        imageTags: Array.from(snapshot.imageTags || [], (tag) => ({
            dataUrl: tag.getAttribute('data-image') || '',
            fileName: tag.getAttribute('title') || '',
        })),
    };
}
