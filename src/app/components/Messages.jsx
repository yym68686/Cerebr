import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    ensureMarkdownReady,
    isMarkdownReady,
    processMathAndMarkdown,
    renderMathInElement,
    requestMermaidRender,
    textMayContainMath,
} from '../../../htmd/latex.js';
import { enhanceCodeBlocks } from '../../render/message/markdown-enhancements.js';
import { morphHtml } from '../../render/message/morph-html.js';
import { uiStore } from '../state/ui-store.js';
import { t } from '../../utils/i18n.js';
import { LoadingState, ThinkingState } from './ThinkingState.jsx';
import { TextFiles } from './ComposerFiles.jsx';
import { splitTextFileMessage } from '../../runtime/input/draft-files.js';
import { splitQuotedMessage } from '../../runtime/input/draft-quotes.js';

// markdown 渲染器还没就位时的占位输出，只需要安全，不需要好看（通常只持续一帧）。
function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function contentText(content) {
    return Array.isArray(content)
        ? content
              .filter((p) => p.type === 'text')
              .map((p) => p.text || '')
              .join('\n')
        : String(content ?? '');
}
const Markup = memo(function Markup({ text, className, originalText, updating = false }) {
    const ref = useRef(null);
    // marked / highlight.js 现在是按需加载的，processMathAndMarkdown 又必须同步返回。
    // 没就位时先输出转义后的纯文本占位，加载完自增一次版本号触发重渲染。之后 isMarkdownReady()
    // 恒为 true，这个 state 不会再变。
    const [markdownReady, setMarkdownReady] = useState(isMarkdownReady);
    useEffect(() => {
        if (markdownReady) return;
        let cancelled = false;
        ensureMarkdownReady()
            .then(() => {
                if (!cancelled) setMarkdownReady(true);
            })
            .catch((error) => console.error('Markdown 渲染器加载失败:', error));
        return () => {
            cancelled = true;
        };
    }, [markdownReady]);
    const html = useMemo(
        () => (markdownReady ? processMathAndMarkdown(text) : escapeHtml(text)),
        [text, markdownReady]
    );
    // 不用 dangerouslySetInnerHTML：它每次都整块重建子树，而流式输出只是在末尾追加。
    // morphHtml 只重建变化的顶层块，语义与整块替换等价。用 layout effect 写入，避免首帧空白。
    // 返回值是本帧真正重建的块，交给下面的后处理，避免每帧扫全文。
    const changed = useRef([]);
    useLayoutEffect(() => {
        changed.current = morphHtml(ref.current, html) || [];
    }, [html]);
    // useEffect 而不是 useLayoutEffect：这里做的都是渲染后的增强（复制按钮、公式、图表），
    // 没有会导致布局跳动的读取，放在 layout 阶段只会把绘制往后推。
    useEffect(() => {
        const root = ref.current;
        if (!root) return;
        // 取完就清空：updating 翻转但 html 没变时 layout effect 不会重跑，留着旧值会把
        // 上一帧的块又增强一遍。
        const dirty = changed.current;
        changed.current = [];
        // target/rel 已经由 marked 的 link renderer 写好，不再遍历 DOM。
        // 只增强本帧重建的块：没变的 <pre> 早就处理过，且 enhanceCodeBlocks 是幂等的。
        for (const node of dirty) {
            if (node.nodeType === Node.ELEMENT_NODE) enhanceCodeBlocks(node);
        }
        // 只在真的产出了 mermaid 容器时才调度渲染，避免每条消息都触发一次全文档扫描。
        if (dirty.length && html.includes('class="mermaid"')) requestMermaidRender();
        if (!textMayContainMath(text)) return;
        // 流式期间只排版本帧新增/重建的块。整条消息每 100ms 全量 typeset 一次的话，
        // 长公式回复要重排几百次已经排好的内容；而且 typesetPromise 会插入 mjx-container，
        // 那是 morph 允许的块内改写，不影响增量。
        if (updating) {
            const targets = dirty.filter((node) => node.nodeType === Node.ELEMENT_NODE);
            if (targets.length) void renderMathInElement(targets).catch(console.error);
            return;
        }
        // 收尾时对整条消息跑一次：流式切块可能把一个公式从中间截断，前面某个块里留下没排版
        // 的残留，全量一次兜底。这一趟必须无条件执行 —— updating 翻转时 html 往往没变，
        // dirty 是空的，若按 dirty 提前返回就永远补不上这一刀。MathJax 会跳过已排版的节点。
        void renderMathInElement(root).catch(console.error);
    }, [html, text, updating]);
    return <div className={className} data-original-text={originalText} ref={ref} />;
});
export const Message = memo(function Message({
    content,
    reasoning_content: reasoning,
    role,
    updating,
    requestStartedAt,
    seedId,
    seedLocaleBound,
    index,
    onContext,
    editing,
    selectionQuotes,
    selectionQuestion,
    textFiles,
}) {
    const attached = splitTextFileMessage({ content, textFiles });
    const split = splitQuotedMessage({ content: attached.content, selectionQuotes, selectionQuestion });
    const text = contentText(split.content);
    const quotes = split.quotes;
    const images = Array.isArray(content) ? content.filter((p) => p.type === 'image_url') : [];
    const pointer = useRef(null);
    const longPress = useRef(null);
    useEffect(() => () => clearTimeout(longPress.current), []);
    return (
        <div
            className={`message ${role === 'user' ? 'user' : 'ai'}-message${images.length || quotes.length || attached.files.length ? ' has-attachments' : ''}${updating ? ' updating' : ''}${editing ? ' is-editing' : ''}`}
            data-message-index={index}
            data-original-text={contentText(content)}
            data-seed-id={seedId || undefined}
            data-seed-managed={seedLocaleBound ? '1' : undefined}
            onContextMenu={(e) => {
                e.preventDefault();
                onContext(e, index);
            }}
            onPointerDown={(e) => {
                pointer.current = { x: e.clientX, y: e.clientY };
                if (e.pointerType === 'touch') {
                    const event = { clientX: e.clientX, clientY: e.clientY, target: e.target };
                    longPress.current = setTimeout(() => onContext(event, index), 200);
                }
            }}
            onPointerMove={(e) => {
                if (
                    pointer.current &&
                    Math.hypot(e.clientX - pointer.current.x, e.clientY - pointer.current.y) > 6
                ) {
                    pointer.current = null;
                    clearTimeout(longPress.current);
                }
            }}
            onPointerUp={() => clearTimeout(longPress.current)}
            onPointerCancel={() => {
                pointer.current = null;
                clearTimeout(longPress.current);
            }}
        >
            <TextFiles files={attached.files} />
            {!!quotes.length && (
                <div className="message-quotes" aria-label={t('selection_quotes')}>
                    {quotes.map((quote, i) => (
                        <blockquote key={i}>{quote}</blockquote>
                    ))}
                </div>
            )}
            {!!images.length && (
                <div className="message-attachments" aria-label={t('composer_images')}>
                    {images.map((part, imageIndex) => (
                        <div className="message-attachment" key={imageIndex} data-image={part.image_url.url}>
                            <button
                                type="button"
                                className="message-attachment-preview"
                                aria-label={t('message_preview_image', [imageIndex + 1])}
                                onClick={() => uiStore.set({ image: part.image_url.url })}
                            >
                                <img src={part.image_url.url} alt={t('label_image')} />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {!!reasoning && (
                <ThinkingState
                    active={!!updating && !text.trim() && !images.length}
                    startedAt={requestStartedAt}
                >
                    <Markup
                        className="reasoning-text"
                        text={reasoning}
                        originalText={reasoning}
                        updating={updating}
                    />
                </ThinkingState>
            )}
            {updating && !reasoning && !text.trim() && !images.length && role === 'assistant' ? (
                <div className="main-content">
                    <LoadingState startedAt={requestStartedAt} />
                </div>
            ) : (
                ((!images.length && !attached.files.length) || !!text.trim()) && (
                    <Markup className="main-content" text={text} updating={updating} />
                )
            )}
        </div>
    );
});
