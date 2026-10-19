import { useSyncExternalStore } from 'react';

// Keep in sync with chat-navigation.css; the extension panel is capped at 800px.
export const WIDE_LAYOUT_QUERY = '(min-width: 768px)';
const snapshot = () => window.matchMedia(WIDE_LAYOUT_QUERY).matches;
const subscribe = (listener) => {
    const media = window.matchMedia(WIDE_LAYOUT_QUERY);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
};
export const useWideLayout = () => useSyncExternalStore(subscribe, snapshot);
