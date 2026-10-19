const outline = (children) => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        {children}
    </svg>
);

const icons = {
    attachment: outline(
        <>
            <path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </>
    ),
    tabs: outline(
        <>
            <rect x="8" y="8" width="13" height="13" rx="3" />
            <path d="M16 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h2M8 12h13" />
        </>
    ),
    'new-chat': outline(
        <>
            <path d="M11 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4M9 15v-3l8-8a2.12 2.12 0 0 1 3 3l-8 8H9Z" />
        </>
    ),
    'chat-list': outline(
        <>
            <path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9 9 0 0 1-4-.9L3 21l1.9-5a9 9 0 0 1-.9-4 8.4 8.4 0 0 1 8.5-9H13a8.4 8.4 0 0 1 8 8v.5Z" />
            <path d="M8 9h8M8 13h5" />
        </>
    ),
    'api-settings-toggle': outline(
        <>
            <path d="M15.5 3a5.5 5.5 0 0 0-5.1 7.6L3 18v3h3l2-2v-2h2l3.4-3.4A5.5 5.5 0 1 0 15.5 3Z" />
            <path d="M16 7h.01" />
        </>
    ),
    'preferences-toggle': outline(
        <>
            <path d="M4 7h4m6 0h6M4 17h10m6 0h0" />
            <circle cx="11" cy="7" r="3" />
            <circle cx="17" cy="17" r="3" />
        </>
    ),
    'plugins-toggle': outline(
        <>
            <rect x="3" y="3" width="7" height="7" rx="2" />
            <rect x="14" y="3" width="7" height="7" rx="2" />
            <rect x="3" y="14" width="7" height="7" rx="2" />
            <path d="M17.5 14v7M14 17.5h7" />
        </>
    ),
    sun: outline(
        <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5" />
        </>
    ),
    moon: outline(
        <>
            <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
        </>
    ),
    monitor: outline(
        <>
            <rect x="3" y="4" width="18" height="13" rx="2.5" />
            <path d="M8 21h8m-4-4v4" />
        </>
    ),
    download: outline(
        <>
            <path d="M12 3v12m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </>
    ),
    upload: outline(
        <>
            <path d="M12 15V3m-4 4 4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </>
    ),
    eye: outline(
        <>
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
        </>
    ),
    'eye-off': outline(
        <>
            <path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3 3.9M6.2 6.2A19 19 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5-1.3M10 10a3 3 0 0 0 4 4" />
        </>
    ),
    brain: (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 5a3 3 0 0 0-6 0 4 4 0 0 0-3 6 4 4 0 0 0 1 7 4 4 0 0 0 8 1V5Zm0 0a3 3 0 0 1 6 0 4 4 0 0 1 3 6 4 4 0 0 1-1 7 4 4 0 0 1-8 1" />
            <path d="M6 5v2m12-2v2M3 11h3m15 0h-3M4 18h3m13 0h-3M8 10a3 3 0 0 1 4 3 3 3 0 0 1 4-3M8 15a3 3 0 0 1-1 3m9-3a3 3 0 0 0 1 3" />
        </svg>
    ),
    sparkle: (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z" />
        </svg>
    ),
    folder: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
    ),
    'folder-plus': (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
        >
            <path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm9 3v7m-3-3.5h6" />
        </svg>
    ),
    'sidebar-close': (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
        >
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <path d="M9 3v18m7-13-4 4 4 4" />
        </svg>
    ),
    'sidebar-open': (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
        >
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <path d="M9 3v18m4-13 4 4-4 4" />
        </svg>
    ),
    compose: (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
        >
            <path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M9 15l1-4L19 2l3 3-9 9-4 1Z" />
        </svg>
    ),
    more: (
        <svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="5" cy="12" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="19" cy="12" r="1.5" />
        </svg>
    ),
    close: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="m6 6 12 12M6 18 18 6" />
        </svg>
    ),
    search: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 4.5 4.5" />
        </svg>
    ),

    'chevron-right': (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="m9 5 7 7-7 7" />
        </svg>
    ),
    'send-arrow': (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 19V5m-7 7 7-7 7 7" />
        </svg>
    ),
    check: (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m5 12 4 4L19 6" />
        </svg>
    ),
    'chevron-down': (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m6 9 6 6 6-6" />
        </svg>
    ),
    image: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8" cy="8" r="1.5" />
            <path d="m3 16 5-5 5 5 3-3 5 5" />
        </svg>
    ),
    'scroll-to-bottom': (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
            <path
                d="M6 11l6 6 6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            ></path>
        </svg>
    ),
    'context-menu': (
        <svg viewBox="0 0 24 24">
            <rect x="8" y="8" width="12" height="12" rx="1"></rect>
            <path d="M4 16V4a1 1 0 0 1 1-1h11"></path>
        </svg>
    ),
    'copy-message': (
        <svg viewBox="0 0 24 24">
            <rect x="8" y="8" width="12" height="12" rx="1"></rect>
            <path d="M4 16V4a1 1 0 0 1 1-1h11"></path>
        </svg>
    ),
    'edit-message': (
        <svg viewBox="0 0 24 24">
            <path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-4-4L4 16v4"></path>
            <path d="M13.5 6.5l4 4"></path>
        </svg>
    ),
    'copy-code': (
        <svg viewBox="0 0 24 24">
            <path d="M16 18L22 12L16 6"></path>
            <path d="M8 6L2 12L8 18"></path>
        </svg>
    ),
    'copy-image': (
        <svg viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <circle cx="8.5" cy="8.5" r="1.5"></circle>
            <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
    ),
    'copy-math': (
        <svg viewBox="0 0 24 24">
            <path
                fill="currentColor"
                d="M6 19.5c.2 0 .32-.08.45-.25l5.75-8.5 5.65-8.2c.08-.1.1-.2.1-.28 0-.23-.2-.38-.43-.38-.2 0-.33.06-.48.28l-5.65 8.2-5.75 8.5c-.08.1-.1.2-.1.29 0 .24.2.34.46.34zM5.2 8.1v2.1c0 .27.17.42.41.42.23 0 .41-.15.41-.42V8.1h2c.27 0 .41-.17.41-.41 0-.23-.14-.41-.41-.41h-2V4.6c0-.27-.18-.42-.41-.42-.24 0-.41.15-.41.42v2.68h-2c-.27 0-.41.18-.41.41 0 .24.14.41.41.41h2zm9.2 8.6c0 .23.15.4.35.4h5.1c.27 0 .41-.17.41-.4 0-.23-.14-.4-.41-.4h-5.1c-.2 0-.35.17-.35.4z"
            ></path>
        </svg>
    ),
    'regenerate-message': (
        <svg viewBox="0 0 24 24">
            <path
                d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
                fill="currentColor"
            ></path>
        </svg>
    ),
    'stop-update': (
        <svg viewBox="0 0 24 24">
            <path d="M6 6h12v12H6z"></path>
        </svg>
    ),
    'delete-message': (
        <svg viewBox="0 0 24 24">
            <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7"></path>
            <path d="M3 7h18"></path>
            <path d="M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"></path>
        </svg>
    ),
    'input-container': (
        <svg viewBox="0 0 24 24">
            <circle cx="12" cy="6" r="2"></circle>
            <circle cx="12" cy="12" r="2"></circle>
            <circle cx="12" cy="18" r="2"></circle>
        </svg>
    ),
    'settings-button': (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
        </svg>
    ),
    'settings-menu': (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 12L10 8L6 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
        </svg>
    ),
    'webpage-qa': (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M3 9h18M8 9v11" />
        </svg>
    ),

    'api-settings': (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
        </svg>
    ),
    'preferences-settings': (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
        </svg>
    ),
    'preferences-oss': (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
                d="M11 2H14V5M14 2L7 9M14 8V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2H8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            ></path>
        </svg>
    ),
    'preferences-telegram': (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
                d="M11 2H14V5M14 2L7 9M14 8V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2H8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            ></path>
        </svg>
    ),
    'preferences-feedback': (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
                d="M11 2H14V5M14 2L7 9M14 8V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2H8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            ></path>
        </svg>
    ),
    'plugin-settings': (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
        </svg>
    ),
    'plugin-shell-page': (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
        </svg>
    ),
    'plugin-shell-page-back': (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
        </svg>
    ),
    'chat-list-page': (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
        </svg>
    ),
    back: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>
        </svg>
    ),
};
export function Icon({ name }) {
    return icons[name] || icons['webpage-qa'];
}
