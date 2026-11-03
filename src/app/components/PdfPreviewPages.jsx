import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openPdfPreview, TextLayer } from '../../runtime/input/pdf-preview.js';
import { t } from '../../utils/i18n.js';

function PdfPage({ pdf, number, width, defaultSize, scrollRoot }) {
    const root = useRef(null),
        canvas = useRef(null),
        text = useRef(null);
    const [visible, setVisible] = useState(false);
    const [size, setSize] = useState(defaultSize);
    const [error, setError] = useState(false);
    useEffect(() => {
        const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
            root: scrollRoot,
            rootMargin: '800px 0px',
        });
        observer.observe(root.current);
        return () => observer.disconnect();
    }, [scrollRoot]);
    useEffect(() => {
        if (!visible || !width) return;
        let cancelled = false,
            render,
            layer;
        const surface = canvas.current,
            container = text.current;
        setError(false);
        void (async () => {
            const page = await pdf.getPage(number);
            if (cancelled) return;
            const original = page.getViewport({ scale: 1 });
            setSize({ width: original.width, height: original.height });
            const viewport = page.getViewport({ scale: width / original.width });
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            surface.width = Math.ceil(viewport.width * ratio);
            surface.height = Math.ceil(viewport.height * ratio);
            container.style.setProperty('--total-scale-factor', viewport.scale * page.userUnit);
            render = page.render({
                canvasContext: surface.getContext('2d'),
                viewport,
                transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
            });
            layer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
            await Promise.all([render.promise, layer.render()]);
        })().catch(() => {
            if (!cancelled) setError(true);
        });
        return () => {
            cancelled = true;
            render?.cancel();
            layer?.cancel();
            container.replaceChildren();
            // Release offscreen backing stores, including high DPI canvases.
            surface.width = surface.height = 0;
        };
    }, [pdf, number, visible, width]);
    return (
        <section
            ref={root}
            className="pdf-preview-page"
            aria-label={t('pdf_preview_page', [number])}
            style={{ width, height: (width * size.height) / size.width }}
        >
            {visible && (
                <>
                    <canvas ref={canvas} aria-hidden="true" />
                    <div ref={text} className="pdf-preview-text-layer" />
                </>
            )}
            {error && <p role="alert">{t('pdf_invalid')}</p>}
        </section>
    );
}

export default function PdfPreviewPages({ source, onReady }) {
    const root = useRef(null);
    const [document, setDocument] = useState(null);
    const [error, setError] = useState(false);
    const [width, setWidth] = useState(0);
    const restored = useRef(false);
    useLayoutEffect(() => {
        if (document && width && !restored.current) {
            restored.current = true;
            onReady?.();
        }
    }, [document, width, onReady]);
    useEffect(() => {
        let cancelled = false,
            loading;
        setDocument(null);
        setError(false);
        restored.current = false;
        void (async () => {
            loading = openPdfPreview(source);
            const pdf = await loading.promise;
            if (cancelled) return;
            const page = await pdf.getPage(1);
            const viewport = page.getViewport({ scale: 1 });
            if (!cancelled) setDocument({ pdf, size: { width: viewport.width, height: viewport.height } });
        })().catch(() => {
            if (!cancelled) setError(true);
        });
        return () => {
            cancelled = true;
            void loading?.destroy().catch(() => {});
        };
    }, [source]);
    useEffect(() => {
        const measure = () => setWidth(Math.max(0, Math.floor(root.current.getBoundingClientRect().width)));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(root.current);
        return () => observer.disconnect();
    }, []);
    return (
        <div ref={root} className="pdf-preview-pages">
            {error ? (
                <p role="alert">{t('pdf_invalid')}</p>
            ) : !document ? (
                <div className="pdf-preview-loading" role="status" aria-label={t('drop_reading')}>
                    <span className="pdf-preview-spinner" aria-hidden="true" />
                </div>
            ) : (
                Array.from({ length: document.pdf.numPages }, (_, index) => (
                    <PdfPage
                        key={index}
                        pdf={document.pdf}
                        number={index + 1}
                        width={width}
                        defaultSize={document.size}
                        scrollRoot={root.current?.parentElement}
                    />
                ))
            )}
        </div>
    );
}
