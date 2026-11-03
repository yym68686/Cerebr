import { lazy, Suspense, useCallback, useLayoutEffect, useRef } from 'react';
import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
import { SelectionActions } from './SelectionActions.jsx';

const PdfPages = lazy(() => import('./PdfPreviewPages.jsx'));

export function PdfPreview({ file, files = [file], onSelect, onClose, disabled = false, onAdd, onSend }) {
    const root = useRef(null);
    const body = useRef(null);
    const positions = useRef(new Map());
    const scope = useCallback(() => root.current?.querySelector('.pdf-preview-body'), []);
    const restorePosition = useCallback(() => {
        if (body.current) body.current.scrollTop = positions.current.get(file.id) || 0;
    }, [file.id]);
    useLayoutEffect(() => {
        const element = root.current;
        const focused = document.activeElement;
        document.body.dataset.pdfPreview = 'true';
        root.current?.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
        return () => {
            const selection = window.getSelection();
            if (element.contains(selection?.anchorNode)) selection.removeAllRanges();
            delete document.body.dataset.pdfPreview;
            if (focused?.isConnected) focused.focus({ preventScroll: true });
        };
    }, []);
    useLayoutEffect(() => {
        const element = body.current;
        window.getSelection()?.removeAllRanges();
        element.scrollTop = 0;
        if (!file.originalPdf) restorePosition();
        root.current
            .querySelector('[aria-selected="true"]')
            ?.closest('.pdf-preview-tab')
            ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [file.id, file.originalPdf, restorePosition]);
    useLayoutEffect(() => {
        const ids = new Set(files.map((tab) => tab.id));
        for (const id of positions.current.keys()) if (!ids.has(id)) positions.current.delete(id);
    }, [files]);
    const closeTab = (tab) => {
        onClose(tab.id);
        requestAnimationFrame(() =>
            root.current?.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true })
        );
    };
    return (
        <aside
            ref={root}
            className="pdf-preview"
            aria-label={t('pdf_preview_title', [file.name])}
            inert={disabled}
        >
            <div className="pdf-preview-tabs" role="tablist" aria-label={t('pdf_preview_files')}>
                {files.map((tab, index) => (
                    <div className={`pdf-preview-tab${tab.id === file.id ? ' is-active' : ''}`} key={tab.id}>
                        <button
                            type="button"
                            role="tab"
                            id={`pdf-tab-${tab.id}`}
                            aria-controls={`pdf-panel-${tab.id}`}
                            aria-selected={tab.id === file.id}
                            tabIndex={tab.id === file.id ? 0 : -1}
                            title={tab.name}
                            onClick={() => onSelect?.(tab)}
                            onKeyDown={(event) => {
                                if (event.key === 'Delete') {
                                    event.preventDefault();
                                    closeTab(tab);
                                    return;
                                }
                                const next =
                                    event.key === 'ArrowRight'
                                        ? (index + 1) % files.length
                                        : event.key === 'ArrowLeft'
                                          ? (index + files.length - 1) % files.length
                                          : event.key === 'Home'
                                            ? 0
                                            : event.key === 'End'
                                              ? files.length - 1
                                              : -1;
                                if (next < 0) return;
                                event.preventDefault();
                                onSelect?.(files[next]);
                                const tabs = root.current.querySelectorAll('[role="tab"]');
                                tabs[next]?.focus({ preventScroll: true });
                            }}
                        >
                            {tab.name}
                        </button>
                        <button
                            type="button"
                            className="pdf-preview-close"
                            tabIndex={-1}
                            onClick={() => closeTab(tab)}
                            aria-label={t('pdf_preview_close_file', [tab.name])}
                        >
                            <Icon name="close" />
                        </button>
                    </div>
                ))}
            </div>
            <div
                ref={body}
                key={`body-${file.id}`}
                className="pdf-preview-body"
                tabIndex={0}
                role="tabpanel"
                onScroll={(event) => positions.current.set(file.id, event.currentTarget.scrollTop)}
                id={`pdf-panel-${file.id}`}
                aria-labelledby={`pdf-tab-${file.id}`}
            >
                {file.originalPdf ? (
                    <Suspense key={file.id} fallback={<p role="status">{t('drop_reading')}</p>}>
                        <PdfPages source={file.originalPdf} onReady={restorePosition} />
                    </Suspense>
                ) : (
                    <pre className="pdf-preview-legacy-text">{file.text}</pre>
                )}
            </div>
            <SelectionActions
                key={`selection-${file.id}`}
                scope={scope}
                disabled={disabled}
                onAdd={onAdd}
                onSend={onSend}
            />
        </aside>
    );
}
