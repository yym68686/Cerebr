import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/utils/image.js', async (original) => ({
    ...(await original()),
    readImageFileAsDataUrl: vi.fn(async (file) => `data:image/png;base64,${file.name}`),
}));
import { readImageFileAsDataUrl } from '../src/utils/image.js';
import { createEditorController } from '../src/runtime/input/editor-controller.js';
import {
    addImageFilesToDraft,
    appendDraftImage,
    attachNativeEditor,
    buildMessageContent,
    setMessageInputContent,
} from '../src/runtime/input/native-editor.js';
import { serializeDraftSnapshot } from '../src/runtime/input/draft-snapshot.js';

let host, input, shelf, editor, detach, send;
beforeEach(() => {
    host = document.createElement('div');
    host.dataset.composer = '';
    host.innerHTML =
        '<div data-composer-attachments></div><div id="message-input" contenteditable="true"></div>';
    document.body.append(host);
    input = host.querySelector('#message-input');
    shelf = host.querySelector('[data-composer-attachments]');
    editor = createEditorController({ messageInput: input });
    send = vi.fn();
    detach = attachNativeEditor({ messageInput: input, sendMessage: send, userQuestions: [], uiConfig: {} });
});
afterEach(() => {
    detach();
    host.remove();
    vi.restoreAllMocks();
});
const image = (data) => ({ type: 'image_url', image_url: { url: data } });

describe('Prompt Bar attachment boundary', () => {
    it('restores mixed drafts outside the editor and round-trips existing message and plugin formats', () => {
        const content = [
            { type: 'text', text: '第一行\n第二行' },
            image('data:image/png;base64,AQ=='),
            image('data:image/png;base64,Ag=='),
        ];
        setMessageInputContent(input, content);
        expect(input.querySelector('img')).toBeNull();
        expect(shelf.querySelectorAll('img')).toHaveLength(2);
        const draft = editor.getDraftSnapshot();
        expect(buildMessageContent(draft.text, draft.imageTags)).toEqual(content);
        expect(structuredClone(serializeDraftSnapshot(draft)).imageTags.map((tag) => tag.dataUrl)).toEqual(
            content.slice(1).map((part) => part.image_url.url)
        );
        editor.importText('补充', { focus: false });
        expect(editor.getDraftSnapshot().imageTags).toHaveLength(2);
        expect(editor.getDraft()).toBe('第一行\n第二行\n\n补充');
        editor.clear();
        expect(editor.hasDraft()).toBe(false);
        expect(shelf.children).toHaveLength(0);
    });

    it('pastes multiple images without replacing selected text or including filenames in the message', async () => {
        editor.setDraft('保留选中的文字');
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);
        const event = new Event('paste', { bubbles: true, cancelable: true });
        const files = ['first.png', 'second.png'].map((name) => new File(['x'], name, { type: 'image/png' }));
        Object.defineProperty(event, 'clipboardData', {
            value: {
                items: files.map((file) => ({ type: file.type, getAsFile: () => file })),
                getData: () => '',
            },
        });
        input.dispatchEvent(event);
        await vi.waitFor(() => expect(shelf.children).toHaveLength(2));
        expect(event.defaultPrevented).toBe(true);
        expect(input.textContent).toBe('保留选中的文字');
        expect(selection.toString()).toBe('保留选中的文字');
        expect(shelf.textContent).toBe('first.pngsecond.png');
        expect(editor.getDraft()).toBe('保留选中的文字');
    });

    it('accepts multiple dropped images anywhere on the composer', async () => {
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
            value: {
                files: ['a.png', 'b.png'].map((name) => new File(['x'], name, { type: 'image/png' })),
            },
        });
        shelf.dispatchEvent(event);
        await vi.waitFor(() => expect(shelf.children).toHaveLength(2));
        expect(event.defaultPrevented).toBe(true);
        expect(input.querySelector('img')).toBeNull();
    });

    it('submits an image-only draft with Enter and treats removal as an empty draft', async () => {
        appendDraftImage(input, { base64Data: 'data:image/png;base64,AQ==' });
        const draft = editor.getDraftSnapshot();
        expect(draft.empty).toBe(false);
        expect(buildMessageContent(draft.text, draft.imageTags)).toEqual([
            image('data:image/png;base64,AQ=='),
        ]);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        shelf.querySelector('.delete-btn').click();
        expect(editor.hasDraft()).toBe(false);
    });

    it.each(['clear', 'replace', 'dispose'])('does not insert a delayed image after %s', async (action) => {
        let finish;
        readImageFileAsDataUrl.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const pending = addImageFilesToDraft(input, [new File(['x'], 'late.png', { type: 'image/png' })]);
        if (action === 'clear') editor.clear();
        if (action === 'replace') setMessageInputContent(input, '另一个会话的草稿');
        if (action === 'dispose') detach();
        finish('data:image/png;base64,AQ==');
        await pending;
        expect(shelf.children).toHaveLength(0);
        expect(editor.getDraft()).toBe(action === 'replace' ? '另一个会话的草稿' : '');
    });
});
