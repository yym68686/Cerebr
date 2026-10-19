import { afterEach, expect, it } from 'vitest';
import { attachChatSelectAll } from '../src/app/chat-selection.js';
let detach;
afterEach(() => { detach?.(); document.body.innerHTML = ''; window.getSelection().removeAllRanges(); });
function setup() {
    document.body.innerHTML = '<aside>Sidebar title</aside><div id="chat"><p>Question</p><p>Answer</p></div><div><input value="Draft"><span>Model name</span></div>';
    detach = attachChatSelectAll(document.getElementById('chat'), () => true);
}
it('selects chat contents without navigation or composer labels', () => {
    setup();
    const key = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(window.getSelection().toString()).toBe('QuestionAnswer');
});
it('leaves native select-all inside editable inputs', () => {
    setup(); document.querySelector('input').focus();
    const key = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    expect(window.getSelection().toString()).toBe('');
});
