import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachNativeEditor, getFormattedMessageContent, setMessageInputText } from '../src/runtime/input/native-editor.js';
import { readEditorText } from '../src/runtime/input/editor-text.js';
import { setDraftFiles, getDraftFiles } from '../src/runtime/input/draft-files.js';

let input, detach;
beforeEach(() => {
    input = document.createElement('div');
    input.contentEditable = 'true';
    document.body.append(input);
    detach = attachNativeEditor({ messageInput: input, sendMessage: vi.fn(), userQuestions: [], uiConfig: {} });
});
afterEach(() => { detach(); input.remove(); window.getSelection().removeAllRanges(); });
const select = (start, end, startOffset = 0, endOffset = end.length) => {
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
};
const key = (key, options = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    input.dispatchEvent(event);
    return event;
};

it.each(['Backspace', 'Delete', 'beforeinput'])('clears a native text-node full selection with %s, preserves files, and supports undo/redo', (kind) => {
    const text = '长文本 <literal>\n'.repeat(10000);
    setMessageInputText(input, text);
    expect(input.childNodes.length).toBeLessThanOrEqual(2);
    setDraftFiles(input, [{ name: 'keep.txt', text: 'keep', size: 4 }]);
    select(input.firstChild, input.lastChild, 0, input.lastChild.length - 1);
    const event = kind === 'beforeinput'
        ? new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }) : null;
    if (event) input.dispatchEvent(event);
    expect((event || key(kind)).defaultPrevented).toBe(true);
    expect(input.textContent).toBe('');
    expect(getDraftFiles(input)[0].name).toBe('keep.txt');
    expect(key('z', { metaKey: true }).defaultPrevented).toBe(true);
    expect(getFormattedMessageContent(input).message).toBe(text);
    key('z', { metaKey: true, shiftKey: true });
    expect(input.textContent).toBe('');
    key('z', { ctrlKey: true });
    expect(input.textContent).toBe(text);
    key('y', { ctrlKey: true });
    expect(input.textContent).toBe('');
});

it('handles an existing legacy draft with thousands of line elements and nested boundaries', () => {
    input.innerHTML = '<div>一行文字</div>'.repeat(3000);
    const expected = readEditorText(input);
    select(input.firstChild.firstChild, input.lastChild.firstChild);
    expect(key('Backspace').defaultPrevented).toBe(true);
    expect(input.childNodes).toHaveLength(0);
    key('z', { ctrlKey: true });
    expect(readEditorText(input)).toBe(expected);
});

it('leaves partial selection, small native edits, and IME deletion to the browser', () => {
    setMessageInputText(input, 'x'.repeat(20000));
    select(input.firstChild, input.firstChild, 1, 19999);
    expect(key('Backspace').defaultPrevented).toBe(false);
    select(input.firstChild, input.firstChild);
    expect(key('Backspace', { isComposing: true }).defaultPrevented).toBe(false);
    setMessageInputText(input, 'small');
    select(input.firstChild, input.firstChild);
    expect(key('Delete').defaultPrevented).toBe(false);
});

it('never restores another chat’s cleared text through the fast undo record', () => {
    setMessageInputText(input, 'x'.repeat(20000));
    select(input.firstChild, input.firstChild);
    key('Backspace');
    setMessageInputText(input, 'another chat');
    expect(key('z', { metaKey: true }).defaultPrevented).toBe(false);
    expect(input.textContent).toBe('another chat');
});

it('reads existing line markup and literal entities without HTML serialization/parsing', () => {
    input.innerHTML = 'first &lt;x&gt;&nbsp;<div>second</div><div><br></div>third<br>fourth';
    Object.defineProperty(input, 'innerHTML', { get() { throw new Error('must not serialize'); } });
    expect(getFormattedMessageContent(input).message).toBe('first <x> \nsecond\nthird\nfourth');
});
