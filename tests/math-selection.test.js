import { afterEach, beforeEach, expect, it } from 'vitest';
import { attachMathSelection } from '../src/render/message/math-selection.js';

const selected = '[data-cerebr-math-selected]';
let chat, selection, detach;

beforeEach(() => {
    document.body.innerHTML = `
        <div id="chat">
            <p>before <mjx-container id="inline"><mjx-math><mjx-c></mjx-c><mjx-c></mjx-c></mjx-math></mjx-container> after</p>
            <div><mjx-container id="display" display="true"><mjx-math><mjx-c></mjx-c></mjx-math></mjx-container></div>
        </div>
        <p><mjx-container id="outside"><mjx-math><mjx-c></mjx-c></mjx-math></mjx-container></p>
    `;
    chat = document.getElementById('chat');
    selection = document.getSelection();
    detach = attachMathSelection(chat);
});

afterEach(() => {
    detach();
    selection.removeAllRanges();
    document.body.replaceChildren();
});

function ids() {
    document.dispatchEvent(new Event('selectionchange'));
    return [...document.querySelectorAll(selected)].map((formula) => formula.id);
}

it('highlights only the formula crossed by a backward selection of surrounding text', () => {
    const p = chat.querySelector('p');
    selection.setBaseAndExtent(p.lastChild, 3, p.firstChild, 2);
    expect(ids()).toEqual(['inline']);
    selection.setBaseAndExtent(p.firstChild, 0, p, 1);
    expect(ids()).toEqual([]);
});

it('highlights a formula-only range with no native text and clears it when the range collapses', () => {
    const math = chat.querySelector('mjx-math');
    selection.setBaseAndExtent(math, 0, math, 2);
    expect(selection.toString()).toBe('');
    expect(ids()).toEqual(['inline']);
    selection.collapseToStart();
    expect(ids()).toEqual([]);
});

it('covers inline and block formulas on select-all but never touches formulas outside chat', () => {
    selection.selectAllChildren(document.body);
    expect(ids()).toEqual(['inline', 'display']);
    detach();
    expect(ids()).toEqual([]);
});
