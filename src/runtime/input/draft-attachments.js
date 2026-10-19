// The native editor owns attachment nodes, just as it owns the editable text subtree.
const revisions = new WeakMap();

export function getAttachmentContainer(input) {
    return input?.closest('[data-composer]')?.querySelector('[data-composer-attachments]') || null;
}

export function getDraftImageTags(input) {
    return [
        ...input.querySelectorAll('.image-tag'),
        ...(getAttachmentContainer(input)?.querySelectorAll('.image-tag') || []),
    ];
}

export function invalidatePendingImages(input) {
    revisions.set(input, (revisions.get(input) || 0) + 1);
}

export function captureImageTarget(input) {
    const revision = revisions.get(input) || 0;
    return () => input.isConnected && (revisions.get(input) || 0) === revision;
}

export function clearDraftAttachments(input) {
    invalidatePendingImages(input);
    getAttachmentContainer(input)?.replaceChildren();
}
