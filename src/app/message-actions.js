import { buildMessageContent } from '../runtime/input/native-editor.js';
import { t } from '../utils/i18n.js';
import { uiStore, notify } from './state/ui-store.js';
import { composeDraftMessage } from '../runtime/input/draft-message.js';
import { splitTextFileMessage } from '../runtime/input/draft-files.js';
import { splitQuotedMessage } from '../runtime/input/draft-quotes.js';

export function resolveMessageTarget(chat, target) {
    if (!chat || !target || target.chatId !== chat.id) return null;
    const index = target.message ? chat.messages.indexOf(target.message) : target.index;
    if (index < 0) return null;
    const message = chat.messages[index];
    if (!message && !target.placeholder) return null;
    return { chat, index, message };
}

export function isReplyTarget(chat, index, state) {
    return (
        state.phase !== 'idle' &&
        state.requestChatId === chat?.id &&
        ((state.phase === 'replying' &&
            index === chat.messages.length - 1 &&
            chat.messages[index]?.role === 'assistant') ||
            (index === chat.messages.length &&
                (state.phase === 'thinking' || chat.messages.at(-1)?.role !== 'assistant')))
    );
}

export function createMessageActions({ chatManager, editor, pipeline, setInputContent, isDraftReady = () => true }) {
    let savedDraft = null;
    let savedQuotes = [];
    let savedFiles = [];
    const captureDraft = () => {
        const draft = editor.getDraftSnapshot();
        return structuredClone(buildMessageContent(draft.text, draft.imageTags));
    };
    const cancelEdit = () => {
        if (!uiStore.getSnapshot().editing) return false;
        uiStore.set({ editing: null });
        setInputContent(savedDraft ?? '');
        editor.setQuotes?.(savedQuotes);
        editor.setFiles?.(savedFiles);
        savedDraft = null;
        savedQuotes = [];
        savedFiles = [];
        editor.focus();
        return true;
    };
    const startEdit = (target) => {
        const resolved = resolveMessageTarget(chatManager.getCurrentChat(), target);
        if (!resolved || !['user', 'assistant'].includes(resolved.message?.role)) return false;
        if (isReplyTarget(resolved.chat, resolved.index, uiStore.getSnapshot())) return false;
        if (!uiStore.getSnapshot().editing) {
            savedDraft = captureDraft();
            savedQuotes = [...(editor.getDraftSnapshot().quotes || [])];
            savedFiles = editor.getDraftSnapshot().textFiles || [];
        }
        pipeline.abortActiveReply();
        uiStore.set({
            editing: { chatId: resolved.chat.id, index: resolved.index, message: resolved.message },
            context: null,
            menu: false,
        });
        const attached = splitTextFileMessage(resolved.message);
        const split = splitQuotedMessage({ ...resolved.message, content: attached.content });
        setInputContent(split.content);
        editor.setQuotes?.(split.quotes);
        editor.setFiles?.(attached.files);
        editor.focus();
        return true;
    };
    const confirmEdit = async () => {
        if (!isDraftReady()) {
            notify(t('drop_reading'), { type: 'info' });
            return false;
        }
        const editing = uiStore.getSnapshot().editing;
        const resolved = resolveMessageTarget(chatManager.getCurrentChat(), editing);
        if (!resolved?.message) return false;
        const draft = editor.getDraftSnapshot();
        if (draft.empty) {
            notify(t('message_edit_empty'), { type: 'error' });
            editor.focus();
            return false;
        }
        const composed = composeDraftMessage(draft);
        const { content } = composed;
        if (JSON.stringify(content) === JSON.stringify(resolved.message.content)) {
            cancelEdit();
            return true;
        }
        await pipeline.abortActiveReply();
        const live = resolveMessageTarget(chatManager.getCurrentChat(), editing);
        if (!live?.message || uiStore.getSnapshot().editing !== editing) return false;
        const next = { ...live.message, content };
        delete next.selectionQuotes;
        delete next.selectionQuestion;
        delete next.textFiles;
        Object.assign(next, composed);
        // An edited tutorial message belongs to the user and must no longer be relocalized.
        for (const key of ['reasoning_content', 'updating', 'seedId', 'seedVersion', 'seedLocaleBound'])
            delete next[key];
        await chatManager.updateMessageAt(live.chat.id, live.index, next);
        await chatManager.flushNow();
        cancelEdit();
        notify(t('toast_message_edited'), { type: 'success' });
        return true;
    };
    const deleteMessage = async (target) => {
        const initial = resolveMessageTarget(chatManager.getCurrentChat(), target);
        if (!initial) return false;
        await pipeline.abortActiveReply();
        const live = resolveMessageTarget(chatManager.getCurrentChat(), target);
        if (!live) return false;
        // The first-token placeholder is UI-only, so aborting is sufficient until it receives data.
        if (!live.message) return !!target.placeholder;
        const editing = uiStore.getSnapshot().editing;
        if (editing?.message === live.message) cancelEdit();
        live.chat.messages.splice(live.index, 1);
        if (live.chat.kind === 'default') live.chat.seedMessagesDismissed = true;
        if (editing && editing.message !== live.message && editing.chatId === live.chat.id) {
            uiStore.set({ editing: { ...editing, index: live.chat.messages.indexOf(editing.message) } });
        }
        chatManager.markChatDirty(live.chat.id);
        await chatManager.saveChats({ touchCurrentChat: false });
        await chatManager.flushNow();
        return true;
    };
    const regenerateMessage = async (target) => {
        await pipeline.abortActiveReply();
        const live = resolveMessageTarget(chatManager.getCurrentChat(), target);
        if (!live?.message || live.message.seedLocaleBound) return false;
        cancelEdit();
        return pipeline.regenerateMessage(live.index);
    };
    return { startEdit, cancelEdit, confirmEdit, deleteMessage, regenerateMessage };
}
