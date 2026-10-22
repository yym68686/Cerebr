import { Icon } from './Icon.jsx';
import { t } from '../../utils/i18n.js';
import { setDraftFiles } from '../../runtime/input/draft-files.js';

function download(file) {
    const url = URL.createObjectURL(new Blob([file.text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function TextFiles({ files = [], onRemove }) {
    if (!files.length) return null;
    return <div className="text-file-attachments" aria-label={t('composer_text_files')}>
        {files.map((file, index) => <div className="text-file-chip" key={file.id || index}>
            <button type="button" className="text-file-label" title={file.name}
                aria-label={t('composer_download_file', [file.name])} onClick={() => download(file)}>
                <Icon name="attachment" />
                <span>{file.name}</span>
                <small>{file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024
                    ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}</small>
            </button>
            {onRemove && <button type="button" className="text-file-remove"
                aria-label={t('composer_remove_file', [file.name])} onClick={() => onRemove(index)}>
                <Icon name="close" />
            </button>}
        </div>)}
    </div>;
}

export function ComposerFiles({ files = [], inputRef }) {
    return <TextFiles files={files} onRemove={index => {
        setDraftFiles(inputRef.current, files.filter((_, i) => i !== index));
        inputRef.current.focus({ preventScroll: true });
    }} />;
}
