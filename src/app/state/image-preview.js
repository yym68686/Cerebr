import { uiStore } from './ui-store.js';

export function openImagePreview(images, index = 0) {
    if (!images[index]) return;
    uiStore.set({ image: images[index], imageGallery: { images: [...images], index }, imageTransition: null });
}

export function moveImagePreview(direction, view = { scale: 1, x: 0, y: 0 }) {
    uiStore.set((state) => {
        const gallery = state.imageGallery;
        if (!state.image || !gallery || gallery.images.length < 2) return state;
        const index = gallery.index + direction;
        if (index < 0 || index >= gallery.images.length) return state;
        return {
            ...state, image: gallery.images[index], imageGallery: { ...gallery, index },
            imageTransition: { from: state.image, direction, view: { ...view } },
        };
    });
}

export function finishImageTransition(transition) {
    uiStore.set((state) => state.imageTransition === transition ? { ...state, imageTransition: null } : state);
}

export const closeImagePreview = () => uiStore.set({ image: null, imageGallery: null, imageTransition: null });
