import { lazy, Suspense, useCallback, useLayoutEffect, useRef } from 'react';
import { t } from '../../utils/i18n.js';
import { Icon } from './Icon.jsx';
import { SelectionActions } from './SelectionActions.jsx';

const PdfPages = lazy(() => import('./PdfPreviewPages.jsx'));

export function PdfPreview({ file, onClose, disabled = false, onAdd, onSend }) {
    const root = useRef(null);
    const scope = useCallback(() => root.current?.querySelector('.pdf-preview-body'), []);
    useLayoutEffect(() => {
        const element = root.current;
        const focused = document.activeElement;
        document.body.dataset.pdfPreview = 'true';
        root.current?.querySelector('.pdf-preview-close')?.focus({ preventScroll: true });
        return () => {
            const selection = window.getSelection();
            if (element.contains(selection?.anchorNode)) selection.removeAllRanges();
            delete document.body.dataset.pdfPreview;
            if (focused?.isConnected) focused.focus({ preventScroll: true });
        };
    }, []);
    return (
        <aside
            ref={root}
            className="pdf-preview"
            aria-label={t('pdf_preview_title', [file.name])}
            inert={disabled}
        >
            <header className="pdf-preview-header">
                <strong title={file.name}>{file.name}</strong>
                {file.originalPdf && (
                    <a
                        href={file.originalPdf}
                        download={file.name}
                        aria-label={t('composer_download_file', [file.name])}
                    >
                        <Icon name="download" />
                    </a>
                )}
                <button
                    type="button"
                    className="pdf-preview-close"
                    onClick={onClose}
                    aria-label={t('docx_close_preview')}
                >
                    <Icon name="close" />
                </button>
            </header>
            <div className="pdf-preview-body" tabIndex={0}>
                {file.originalPdf ? (
                    <Suspense fallback={<p role="status">{t('drop_reading')}</p>}>
                        <PdfPages source={file.originalPdf} />
                    </Suspense>
                ) : (
                    <pre className="pdf-preview-legacy-text">{file.text}</pre>
                )}
            </div>
            <SelectionActions scope={scope} disabled={disabled} onAdd={onAdd} onSend={onSend} />
        </aside>
    );
}
