import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './modal.css';

export function Modal({ children, className = '', onClose, closeOnBackdrop = false, ...props }) {
    const dialog = useRef(null);
    const close = useRef(onClose);
    close.current = onClose;
    useLayoutEffect(() => {
        const previousFocus = document.activeElement;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const focusable = () => [...dialog.current.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
        )];
        (focusable()[0] || dialog.current).focus();
        const keydown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close.current?.();
            } else if (event.key === 'Tab') {
                const elements = focusable();
                const index = elements.indexOf(document.activeElement);
                if (!elements.length || index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === elements.length - 1) {
                    event.preventDefault();
                    ((event.shiftKey ? elements.at(-1) : elements[0]) || dialog.current).focus();
                }
            }
        };
        document.addEventListener('keydown', keydown);
        return () => {
            document.removeEventListener('keydown', keydown);
            document.body.style.overflow = previousOverflow;
            if (previousFocus?.isConnected) previousFocus.focus();
        };
    }, []);
    return createPortal(
        <div className="modal-backdrop" onClick={(event) => {
            if (closeOnBackdrop && event.target === event.currentTarget) close.current?.();
        }}>
            <section {...props} className={`modal ${className}`} role="dialog" aria-modal="true" tabIndex={-1} ref={dialog}>
                {children}
            </section>
        </div>,
        document.body
    );
}
