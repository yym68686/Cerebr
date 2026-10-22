import {
    clearMessageInput,
    getFormattedMessageContent,
    insertTextIntoMessageInput,
    moveCaretToEnd,
    setMessageInputText,
} from '../../runtime/input/native-editor.js';
import { getDraftFiles, setDraftFiles } from './draft-files.js';
import { getDraftQuotes, setDraftQuotes, addDraftQuote } from './draft-quotes.js';

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
        const normalizedImageTags = Array.from(imageTags || []);
        const quotes = [...getDraftQuotes(messageInput)];
        const textFiles = getDraftFiles(messageInput);

        return {
            text,
            imageTags: normalizedImageTags,
            quotes,
            textFiles,
            empty: !text.trim() && normalizedImageTags.length === 0 && !quotes.length && !textFiles.length,
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
        addQuote: (text) => addDraftQuote(messageInput, text),
        setFiles: (files) => setDraftFiles(messageInput, files),
        setQuotes: (quotes) => setDraftQuotes(messageInput, quotes),
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
