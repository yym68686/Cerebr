import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageActions } from '../src/app/message-actions.js';
import { uiStore } from '../src/app/state/ui-store.js';
import { createEditorController } from '../src/runtime/input/editor-controller.js';
import { setMessageInputContent } from '../src/runtime/input/native-editor.js';
import { composeDraftMessage } from '../src/runtime/input/draft-message.js';
import { splitTextFileMessage } from '../src/runtime/input/draft-files.js';
import { buildDefaultChatSeedMessages, syncDefaultChatForLocale } from '../src/utils/default-chat.js';

let chat, manager, editor, actions, input, pipeline, persisted;
const target = (index) => ({ chatId: chat.id, index, message: chat.messages[index] });
beforeEach(() => {
    vi.useFakeTimers();
    uiStore.set({ editing: null, context: null, phase: 'idle', requestChatId: null, toasts: [] });
    chat = {
        id: 'test-chat',
        kind: 'default',
        titleLocaleBound: true,
        messages: buildDefaultChatSeedMessages('zh_CN'),
    };
    manager = {
        getCurrentChat: () => chat,
        updateMessageAt: async (_id, index, message) => {
            chat.messages[index] = message;
        },
        markChatDirty: vi.fn(),
        saveChats: async () => {
            persisted = structuredClone(chat);
        },
        flushNow: async () => {
            persisted = structuredClone(chat);
        },
    };
    pipeline = { abortActiveReply: vi.fn(async () => {}), regenerateMessage: vi.fn(async () => true) };
    input = document.createElement('div');
    document.body.append(input);
    editor = createEditorController({ messageInput: input });
    actions = createMessageActions({
        chatManager: manager,
        editor,
        pipeline,
        setInputContent: (content) => setMessageInputContent(input, content),
    });
});
afterEach(() => {
    input.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe('message editing and deletion', () => {
    it('edits the question separately from its quote and restores the original quoted draft', async () => {
        chat.messages.push({
            role: 'user',
            content: '> Source\n\nQuestion',
            selectionQuotes: ['Source'],
            selectionQuestion: 'Question',
        });
        editor.setDraft('Unsent');
        editor.addQuote('Draft quote');
        actions.startEdit(target(chat.messages.length - 1));
        expect(editor.getDraft()).toBe('Question');
        expect(editor.getDraftSnapshot().quotes).toEqual(['Source']);
        input.textContent = 'Edited';
        await actions.confirmEdit();
        expect(chat.messages.at(-1)).toMatchObject({
            content: '> Source\n\nEdited',
            selectionQuestion: 'Edited',
            selectionQuotes: ['Source'],
        });
        expect(editor.getDraft()).toBe('Unsent');
        expect(editor.getDraftSnapshot().quotes).toEqual(['Draft quote']);
    });
    it.each([0, 1])(
        'edits tutorial message %i, persists it and restores the previous image draft',
        async (index) => {
            const draft = [
                { type: 'text', text: 'unsent draft' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
            ];
            setMessageInputContent(input, draft);
            expect(actions.startEdit(target(index))).toBe(true);
            editor.setDraft('My edited message');
            expect(await actions.confirmEdit()).toBe(true);
            expect(persisted.messages[index]).toEqual({
                role: index === 0 ? 'user' : 'assistant',
                content: 'My edited message',
            });
            chat = structuredClone(persisted);
            syncDefaultChatForLocale(chat, 'en');
            expect(chat.messages[index].content).toBe('My edited message');
            expect(editor.getDraft()).toBe('unsent draft');
            expect(editor.getDraftSnapshot().imageTags).toHaveLength(1);
            expect(uiStore.getSnapshot().editing).toBe(null);
        }
    );
    it('preserves seed localization and reasoning when confirming without changes', async () => {
        chat.messages[1].reasoning_content = 'reasoning';
        const before = structuredClone(chat.messages[1]);
        actions.startEdit(target(1));
        await actions.confirmEdit();
        expect(chat.messages[1]).toEqual(before);
    });
    it('rejects an empty edit and keeps editing with feedback', async () => {
        actions.startEdit(target(0));
        editor.clear();
        expect(await actions.confirmEdit()).toBe(false);
        expect(uiStore.getSnapshot().editing).not.toBe(null);
        expect(uiStore.getSnapshot().toasts).toHaveLength(1);
    });
    it('allows deleting every tutorial bubble without reinserting them on reload or language change', async () => {
        while (chat.messages.length) expect(await actions.deleteMessage(target(0))).toBe(true);
        chat = structuredClone(persisted);
        syncDefaultChatForLocale(chat, 'en', { insertSeedsWhenEmpty: true });
        expect(chat.messages).toEqual([]);
    });
    it('updates the correct edited message after deleting an earlier bubble', async () => {
        editor.setDraft('previous draft');
        actions.startEdit(target(3));
        editor.setDraft('edited answer');
        await actions.deleteMessage(target(0));
        expect(uiStore.getSnapshot().editing.index).toBe(2);
        await actions.confirmEdit();
        expect(chat.messages[2].content).toBe('edited answer');
        expect(editor.getDraft()).toBe('previous draft');
    });
    it('cancels editing and restores the draft when the edited bubble is deleted', async () => {
        editor.setDraft('previous draft');
        const selected = target(1);
        actions.startEdit(selected);
        await actions.deleteMessage(selected);
        expect(uiStore.getSnapshot().editing).toBe(null);
        expect(editor.getDraft()).toBe('previous draft');
    });
    it('does not delete from a different conversation after an asynchronous abort', async () => {
        const selected = target(0),
            original = chat;
        pipeline.abortActiveReply.mockImplementation(async () => {
            chat = { id: 'other', messages: [{ role: 'user', content: 'keep' }] };
        });
        expect(await actions.deleteMessage(selected)).toBe(false);
        expect(original.messages).toHaveLength(6);
        expect(chat.messages[0].content).toBe('keep');
    });
    it('blocks edits to the active reply and can delete a pre-token placeholder by aborting', async () => {
        chat.messages = [{ role: 'user', content: 'question' }];
        uiStore.set({ phase: 'thinking', requestChatId: chat.id });
        expect(await actions.deleteMessage({ chatId: chat.id, index: 1, placeholder: true })).toBe(true);
        expect(pipeline.abortActiveReply).toHaveBeenCalledOnce();
        expect(chat.messages).toHaveLength(1);
        chat.messages.push({ role: 'assistant', content: 'partial' });
        uiStore.set({ phase: 'replying' });
        expect(actions.startEdit(target(1))).toBe(false);
    });
    it('regenerates a normal message through the session and keeps untouched tutorials protected', async () => {
        expect(await actions.regenerateMessage(target(0))).toBe(false);
        chat.messages[1] = { role: 'assistant', content: 'edited' };
        expect(await actions.regenerateMessage(target(1))).toBe(true);
        expect(pipeline.regenerateMessage).toHaveBeenCalledWith(1);
    });
});

it('edits an attached file question and restores the unrelated file draft', async () => {
    const file = {id:'sent',name:'sent.txt',text:'full file content',size:17};
    chat.messages.push({role:'user',...composeDraftMessage({text:'Question',imageTags:[],textFiles:[file],quotes:['Quote']})});
    editor.setDraft('Unsent');
    editor.setFiles([{id:'draft',name:'draft.txt',text:'draft body',size:10}]);
    actions.startEdit(target(chat.messages.length - 1));
    expect(editor.getDraft()).toBe('Question');
    expect(editor.getDraftSnapshot().textFiles).toEqual([file]);
    input.textContent = 'Changed question';
    await actions.confirmEdit();
    expect(splitTextFileMessage(chat.messages.at(-1))).toMatchObject({content:'> Quote\n\nChanged question',files:[file]});
    expect(editor.getDraft()).toBe('Unsent');
    expect(editor.getDraftSnapshot().textFiles[0].name).toBe('draft.txt');
});
