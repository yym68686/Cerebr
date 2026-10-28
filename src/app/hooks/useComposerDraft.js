import { useEffect, useLayoutEffect, useState } from 'react';
import { getAttachmentContainer, getDraftImageTags } from '../../runtime/input/draft-attachments.js';
import { adjustTextareaHeight } from '../../utils/ui.js';
import { getDraftFiles } from '../../runtime/input/draft-files.js';
import { getDraftQuotes } from '../../runtime/input/draft-quotes.js';
import { hasPendingFileImports } from '../../runtime/input/file-import-state.js';

// Observe the native editor; React never rewrites its text, selection or undo history.
export function useComposerDraft(inputRef, rowRef, hasSources = false) {
    const [state, setState] = useState({ empty: true, textEmpty: true, expanded: false, composing: false });
    useEffect(() => {
        const input = inputRef.current;
        const row = rowRef.current;
        const shelf = getAttachmentContainer(input);
        const canvas = document.createElement('canvas');
        let frame = 0;
        let composing = false;
        let previousWidth = 0;
        let previousMaxHeight = '';
        const update = () => {
            frame = 0;
            const text = input.textContent || '';
            const hasText = !!text.trim();
            const hasImages = getDraftImageTags(input).length > 0;
            const quotes = getDraftQuotes(input);
            const textFiles = getDraftFiles(input);
            const readingFiles = hasPendingFileImports(input);
            const style = getComputedStyle(input);
            const rowStyle = getComputedStyle(row);
            const composer = input.closest('[data-composer]');
            composer.style.setProperty(
                '--composer-menu-max-height',
                `${Math.max(60, composer.getBoundingClientRect().top - 16)}px`
            );
            const controls = [...row.children].filter(
                (node) =>
                    !node.classList.contains('message-input-shell') &&
                    getComputedStyle(node).position !== 'absolute' &&
                    getComputedStyle(node).display !== 'none'
            );
            const available =
                row.clientWidth -
                controls.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0) -
                (parseFloat(rowStyle.columnGap) || 0) * controls.length -
                (parseFloat(style.paddingLeft) || 0) -
                (parseFloat(style.paddingRight) || 0);
            const context = canvas.getContext('2d');
            if (context) context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const multiline = /\n/.test(text) || !!input.querySelector('br, div');
            const expanded =
                hasImages ||
                quotes.length > 0 ||
                textFiles.length > 0 ||
                (hasText &&
                    (multiline ||
                        text.length > 1000 ||
                        (available > 0 && context && context.measureText(text).width > available)));
            setState((previous) => {
                const next = {
                    empty: !hasText && !hasImages && !quotes.length && !textFiles.length,
                    quotes,
                    textFiles,
                    readingFiles,
                    textEmpty: !hasText,
                    expanded: composing ? previous.expanded : !!expanded,
                    composing,
                };
                return Object.keys(next).every((key) => next[key] === previous[key]) ? previous : next;
            });
            if (input.clientWidth !== previousWidth || style.maxHeight !== previousMaxHeight) {
                previousWidth = input.clientWidth;
                previousMaxHeight = style.maxHeight;
                adjustTextareaHeight({ textarea: input });
            }
        };
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(update);
        };
        const start = () => {
            composing = true;
            schedule();
        };
        const end = () => {
            composing = false;
            schedule();
        };
        input.addEventListener('input', schedule);
        input.addEventListener('cerebr:filesReading', schedule);
        input.addEventListener('compositionstart', start);
        input.addEventListener('compositionend', end);
        const changes = new MutationObserver(schedule);
        changes.observe(input, { childList: true, characterData: true, subtree: true });
        if (shelf) changes.observe(shelf, { childList: true, subtree: true });
        const sizes = new ResizeObserver(schedule);
        sizes.observe(row);
        sizes.observe(input);
        sizes.observe(input.closest('[data-composer]'));
        window.addEventListener('resize', schedule);
        window.visualViewport?.addEventListener('resize', schedule);
        window.visualViewport?.addEventListener('scroll', schedule);
        schedule();
        return () => {
            cancelAnimationFrame(frame);
            changes.disconnect();
            sizes.disconnect();
            window.removeEventListener('resize', schedule);
            window.visualViewport?.removeEventListener('resize', schedule);
            window.visualViewport?.removeEventListener('scroll', schedule);
            input.removeEventListener('input', schedule);
            input.removeEventListener('cerebr:filesReading', schedule);
            input.removeEventListener('compositionstart', start);
            input.removeEventListener('compositionend', end);
        };
    }, [inputRef, rowRef]);
    useLayoutEffect(() => {
        if (inputRef.current) adjustTextareaHeight({ textarea: inputRef.current });
    }, [state.expanded, state.textEmpty, hasSources, inputRef]);
    return { ...state, expanded: state.expanded || hasSources };
}
