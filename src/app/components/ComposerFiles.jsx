import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';
import { t } from '../../utils/i18n.js';
import { setDraftFiles } from '../../runtime/input/draft-files.js';
import { isDocx } from '../../runtime/input/docx-limits.js';
import { isPdf } from '../../runtime/input/pdf-limits.js';

const isDocument = (file) => isDocx(file) || isPdf(file);

function download(file) {
    const url = URL.createObjectURL(new Blob([file.text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = isDocx(file) ? `${file.name}.md` : isPdf(file) ? `${file.name}.txt` : file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function DocumentPreview({ file, onClose }) {
    const ref = useRef(null);
    useLayoutEffect(() => {
        const dialog = ref.current;
        const focused = document.activeElement;
        if (dialog.showModal) dialog.showModal();
        else dialog.setAttribute('open', '');
        return () => {
            dialog.close?.();
            if (focused?.isConnected) focused.focus({ preventScroll: true });
        };
    }, []);
    return createPortal(
        <dialog
            ref={ref}
            className="document-text-preview"
            aria-label={file.name}
            onCancel={onClose}
            onClose={onClose}
            onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                onClose();
            }}
        >
            <header>
                <strong>{file.name}</strong>
                <button type="button" onClick={onClose} aria-label={t('docx_close_preview')}>
                    <Icon name="close" />
                </button>
            </header>
            <pre tabIndex={0}>{file.text}</pre>
            <button type="button" onClick={() => download(file)}>
                {t(isPdf(file) ? 'pdf_download_text' : 'docx_download_text')}
            </button>
        </dialog>,
        document.body
    );
}

export function TextFiles({ files = [], onRemove }) {
    const [preview, setPreview] = useState(null);
    if (!files.length) return null;
    return (
        <div className="text-file-attachments" aria-label={t('composer_text_files')}>
            {files.map((file, index) => (
                <div className="text-file-chip" key={file.id || index}>
                    <button
                        type="button"
                        className="text-file-label"
                        title={file.name}
                        aria-label={t(isDocument(file) ? 'docx_preview' : 'composer_download_file', [
                            file.name,
                        ])}
                        onClick={() => (isDocument(file) ? setPreview(file) : download(file))}
                    >
                        <Icon name="attachment" />
                        <span>{file.name}</span>
                        <small>
                            {file.size < 1024
                                ? `${file.size} B`
                                : file.size < 1024 * 1024
                                  ? `${Math.ceil(file.size / 1024)} KB`
                                  : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
                        </small>
                    </button>
                    {onRemove && (
                        <button
                            type="button"
                            className="text-file-remove"
                            aria-label={t('composer_remove_file', [file.name])}
                            onClick={() => onRemove(index)}
                        >
                            <Icon name="close" />
                        </button>
                    )}
                </div>
            ))}
            {preview && files.includes(preview) && (
                <DocumentPreview file={preview} onClose={() => setPreview(null)} />
            )}
        </div>
    );
}

export function ComposerFiles({ files = [], reading, inputRef }) {
    return (
        <>
            {reading && (
                <div className="document-text-note" role="status">
                    {t('drop_reading')}
                </div>
            )}
            <TextFiles
                files={files}
                onRemove={(index) => {
                    setDraftFiles(
                        inputRef.current,
                        files.filter((_, i) => i !== index)
                    );
                    inputRef.current.focus({ preventScroll: true });
                }}
            />
        </>
    );
}
