import { uiStore } from './ui-store.js';

export function openImagePreview(images, index = 0) {
    if (!images[index]) return;
    uiStore.set({ image: images[index], imageGallery: { images: [...images], index } });
}

export function moveImagePreview(direction) {
    uiStore.set((state) => {
        const gallery = state.imageGallery;
        if (!state.image || !gallery || gallery.images.length < 2) return state;
        const index = (gallery.index + direction + gallery.images.length) % gallery.images.length;
        return { ...state, image: gallery.images[index], imageGallery: { ...gallery, index } };
    });
}

export const closeImagePreview = () => uiStore.set({ image: null, imageGallery: null });
