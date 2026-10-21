import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from '../../utils/i18n.js';
import {
    Brain,
    ChatBubble,
    ChatBubbleQuestion,
    EditPencil,
    Plus,
    Search,
    Spark,
    WindowTabs,
    Xmark,
} from 'iconoir-react';
import BeautifulSelectionActions from './beautiful-ui/SelectionActions';
import { SelectionSurface } from './beautiful-ui/SelectionSurface.jsx';
import { Button } from './beautiful-ui/Button';
const icons = {
    sparkle: Spark,
    brain: Brain,
    search: Search,
    compose: EditPencil,
    'chat-list': ChatBubble,
    tabs: WindowTabs,
    close: Xmark,
};
function ActionIcon({ name }) {
    const Component = icons[name] || Spark;
    return <Component width={14} height={14} strokeWidth={1.8} aria-hidden />;
}
import { watchTextSelection } from '../../runtime/selection/watch-selection.js';
import { highlightPassage } from '../../runtime/selection/passage-highlight.js';
import {
    selectionStore,
    loadSelectionSettings,
    subscribeSelectionSettings,
    saveSelectionAction,
    removeSelectionAction,
    ACTION_ICONS,
} from '../../runtime/selection/selection-store.js';

export function SelectionActions({ scope, page = false, disabled = false, onAdd, onSend }) {
    const settings = useSyncExternalStore(selectionStore.subscribe, selectionStore.getSnapshot);
    const [selection, setSelection] = useState(null);
    const [customize, setCustomize] = useState(false);
    const [action, setAction] = useState({ name: '', prompt: '', icon: 'sparkle' });
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [inputWidth, setInputWidth] = useState(145);
    const [position, setPosition] = useState({ left: 8, top: 8, ready: false });
    const root = useRef(null);
    const selectedText = useRef('');
    const enabled = !disabled && (!page || settings.pageEnabled);
    useEffect(() => {
        void loadSelectionSettings().catch((e) => setError(e.message));
        return subscribeSelectionSettings();
    }, []);
    useEffect(() => {
        if (!enabled) {
            setSelection(null);
            return;
        }
        return watchTextSelection({
            scope,
            excludeChat: page,
            toolbar: () => root.current,
            onChange: (next) => {
                if (next?.text !== selectedText.current) {
                    setCustomize(false);
                    setError('');
                }
                selectedText.current = next?.text;
                setSelection(next);
            },
        });
    }, [enabled, scope, page]);
    useLayoutEffect(() => {
        if (enabled && selection?.range) return highlightPassage(selection.range);
    }, [enabled, selection]);
    useLayoutEffect(() => {
        if (!selection || !root.current) return;
        const place = () => {
            const rect = root.current.getBoundingClientRect();
            const viewport = window.visualViewport;
            const leftEdge = viewport?.offsetLeft || 0,
                topEdge = viewport?.offsetTop || 0;
            const width = viewport?.width || window.innerWidth,
                height = viewport?.height || window.innerHeight;
            const left = Math.max(
                leftEdge + 8,
                Math.min(selection.centerX - rect.width / 2, leftEdge + width - rect.width - 8)
            );
            const below = selection.rect.bottom + 8;
            const above = selection.rect.top - rect.height - 8;
            // Preserve the upstream 145px input until the viewport needs a compact bar.
            setInputWidth(Math.min(145, Math.max(0, width - 48 - 224 - 8)));
            const top = Math.max(
                topEdge + 8,
                Math.min(
                    below + rect.height <= topEdge + height - 8 ? below : above,
                    topEdge + height - rect.height - 8
                )
            );
            const ready = rect.width > 0 && rect.height > 0;
            setPosition((p) =>
                p.left === left && p.top === top && p.ready === ready ? p : { left, top, ready }
            );
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(root.current);
        window.visualViewport?.addEventListener('resize', place);
        return () => {
            observer.disconnect();
            window.visualViewport?.removeEventListener('resize', place);
        };
    }, [selection, customize]);
    const dismiss = () => {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
    };
    const send = async (prompt) => {
        if (!prompt.trim() || !selection || busy) return;
        setBusy(true);
        setError('');
        try {
            if ((await onSend(selection.text, prompt.trim())) !== false) dismiss();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    if (!enabled || !selection) return null;
    return (
        <div
            ref={root}
            data-selection-actions
            className="cerebr-selection-host"
            style={{
                left: position.left,
                top: position.top,
                visibility: position.ready ? 'visible' : 'hidden',
                position: 'fixed',
                zIndex: page ? 2147483647 : 2200,
                width: 'max-content',
                maxWidth: 'calc(100vw - 16px)',
                pointerEvents: 'none',
            }}
            role="dialog"
            aria-label={t('selection_actions')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    dismiss();
                }
            }}
        >
            <SelectionSurface hostRef={root}>
                <BeautifulSelectionActions
                    key={selection.text}
                    external
                    pending={busy}
                    inputWidth={inputWidth}
                    labels={{
                        placeholder: t('selection_follow_up'),
                        send: t('composer_send'),
                        more: t('selection_customize'),
                        fewer: t('selection_customize'),
                    }}
                    actions={{
                        primary: [
                            {
                                id: 'explain',
                                label: t('selection_explain'),
                                action: 'explain',
                                icon: (
                                    <ChatBubbleQuestion
                                        width={14}
                                        height={14}
                                        strokeWidth={1.8}
                                        aria-hidden
                                    />
                                ),
                            },
                            {
                                id: 'add',
                                label: t('selection_add'),
                                action: 'add',
                                icon: <Plus width={14} height={14} strokeWidth={1.8} aria-hidden />,
                            },
                        ],
                        more: [
                            ...settings.actions.map((item) => ({
                                id: item.id,
                                label: item.name,
                                action: item.id,
                                icon: <ActionIcon name={item.icon} />,
                            })),
                            {
                                id: 'customize',
                                label: t('selection_customize'),
                                action: 'customize',
                                icon: <EditPencil width={14} height={14} strokeWidth={1.8} aria-hidden />,
                            },
                        ],
                    }}
                    onPrompt={(prompt) => void send(prompt)}
                    onAction={async (id) => {
                        if (id === 'customize') {
                            setCustomize((value) => !value);
                            return;
                        }
                        if (id === 'add') {
                            try {
                                await onAdd(selection.text);
                                dismiss();
                            } catch (e) {
                                setError(e.message);
                            }
                            return;
                        }
                        void send(
                            id === 'explain'
                                ? t('selection_explain_prompt')
                                : settings.actions.find((item) => item.id === id)?.prompt || id
                        );
                    }}
                />
                {customize && (
                    <div className="selection-customizer mt-2 max-h-[min(360px,60dvh)] w-[320px] max-w-[calc(100vw-48px)] overflow-y-auto rounded-2xl bg-surface p-3 font-sans text-[12px] text-ink shadow-overlay">
                        {settings.actions.length > 0 && (
                            <div className="selection-saved-actions mb-2">
                                {settings.actions.map((item) => (
                                    <div key={item.id} className="flex items-center justify-between">
                                        <Button
                                            type="button"
                                            variant="quiet"
                                            size="xs"
                                            onClick={() => setAction(item)}
                                        >
                                            <ActionIcon name={item.icon} />
                                            {item.name}
                                        </Button>
                                        <Button
                                            variant="quiet"
                                            size="xs"
                                            type="button"
                                            aria-label={`${t('selection_delete_action')}: ${item.name}`}
                                            onClick={() =>
                                                void removeSelectionAction(item.id).catch((e) =>
                                                    setError(e.message)
                                                )
                                            }
                                        >
                                            <ActionIcon name="close" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <form
                            onSubmit={async (event) => {
                                event.preventDefault();
                                try {
                                    await saveSelectionAction(action);
                                    setAction({ name: '', prompt: '', icon: 'sparkle' });
                                    setCustomize(false);
                                } catch (e) {
                                    setError(e.message);
                                }
                            }}
                        >
                            <label className="my-2 block text-ink-2">
                                {t('selection_action_name')}
                                <input
                                    className="mt-1 block w-full rounded-lg bg-inset p-2 text-ink"
                                    value={action.name}
                                    maxLength={40}
                                    required
                                    onChange={(event) => setAction({ ...action, name: event.target.value })}
                                />
                            </label>
                            <div
                                className="selection-icon-options flex gap-1"
                                role="group"
                                aria-label={t('selection_action_icon')}
                            >
                                {ACTION_ICONS.map((icon) => (
                                    <Button
                                        variant="quiet"
                                        size="xs"
                                        className="aria-pressed:bg-hover"
                                        key={icon}
                                        type="button"
                                        aria-label={t(`selection_icon_${icon.replaceAll('-', '_')}`)}
                                        aria-pressed={action.icon === icon}
                                        onClick={() => setAction({ ...action, icon })}
                                    >
                                        <ActionIcon name={icon} />
                                    </Button>
                                ))}
                            </div>
                            <label className="my-2 block text-ink-2">
                                {t('selection_action_prompt')}
                                <textarea
                                    className="mt-1 block w-full resize-y rounded-lg bg-inset p-2 text-ink"
                                    value={action.prompt}
                                    maxLength={8000}
                                    rows={3}
                                    required
                                    onChange={(event) => setAction({ ...action, prompt: event.target.value })}
                                />
                            </label>
                            <Button
                                variant="primary"
                                size="sm"
                                className="selection-save w-full"
                                type="submit"
                                disabled={!action.name.trim() || !action.prompt.trim()}
                            >
                                {t('selection_save_action')}
                            </Button>
                        </form>
                    </div>
                )}
                {error && (
                    <p
                        className="selection-error mt-2 max-w-[320px] rounded-lg bg-surface p-2 text-[12px] text-ink shadow-overlay"
                        role="alert"
                    >
                        {error}
                    </p>
                )}
            </SelectionSurface>
        </div>
    );
}
