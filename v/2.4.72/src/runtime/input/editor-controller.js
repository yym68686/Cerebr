import {
    clearMessageInput,
    getFormattedMessageContent,
    insertTextIntoMessageInput,
    moveCaretToEnd,
    setMessageInputText,
} from '../../components/message-input.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

export function createEditorController({
    messageInput,
    uiConfig,
} = {}) {
    const getDraftSnapshot = () => {
        const { message, imageTags } = getFormattedMessageContent(messageInput);
        const text = String(message ?? '');
        const normalizedImageTags = Array.isArray(imageTags) ? [...imageTags] : [];

        return {
            text,
            imageTags: normalizedImageTags,
            empty: !text.trim() && normalizedImageTags.length === 0,
        };
    };

    const focus = () => {
        messageInput?.focus?.({ preventScroll: true });
        if (messageInput) {
            moveCaretToEnd(messageInput);
        }
    };

    const setDraft = (text) => {
        if (!messageInput) return;
        setMessageInputText(messageInput, String(text ?? ''));
        focus();
    };

    const insertText = (text, options = {}) => {
        if (!messageInput) return;
        insertTextIntoMessageInput(messageInput, String(text ?? ''), options);
        focus();
    };

    const importText = (text, { focus: shouldFocus = true, separator = '\n\n' } = {}) => {
        if (!messageInput) return;

        const value = normalizeString(text);
        if (!value) return;

        const draft = getDraftSnapshot();
        if (draft.empty) {
            setMessageInputText(messageInput, value);
        } else {
            insertTextIntoMessageInput(messageInput, value, { separator });
        }

        if (shouldFocus) {
            focus();
        }
    };

    const clear = () => {
        if (!messageInput) return;
        clearMessageInput(messageInput, uiConfig);
    };

    return {
        focus,
        blur() {
            messageInput?.blur?.();
        },
        getDraft() {
            return getDraftSnapshot().text;
        },
        getDraftSnapshot,
        hasDraft() {
            return !getDraftSnapshot().empty;
        },
        setDraft,
        insertText,
        importText,
        clear,
    };
}
