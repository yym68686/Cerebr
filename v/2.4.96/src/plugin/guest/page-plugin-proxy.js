import {
    createGuestMessage,
    isGuestMessage,
} from './guest-protocol.js';

const pendingMessages = [];
let guestFrame = null;
let guestFrameReady = false;

function postToParent(message) {
    if (!isGuestMessage(message)) {
        return;
    }

    window.parent?.postMessage?.(message, '*');
}

function postToGuest(message) {
    if (!isGuestMessage(message)) {
        return;
    }

    if (!guestFrame?.contentWindow || !guestFrameReady) {
        pendingMessages.push(message);
        return;
    }

    guestFrame.contentWindow.postMessage(message, '*');
}

function flushPendingMessages() {
    if (!guestFrame?.contentWindow || !guestFrameReady || pendingMessages.length === 0) {
        return;
    }

    const messages = pendingMessages.splice(0);
    messages.forEach((message) => {
        guestFrame.contentWindow.postMessage(message, '*');
    });
}

function createGuestFrame() {
    guestFrame = document.createElement('iframe');
    guestFrame.hidden = true;
    guestFrame.setAttribute('aria-hidden', 'true');
    guestFrame.style.position = 'fixed';
    guestFrame.style.width = '0';
    guestFrame.style.height = '0';
    guestFrame.style.opacity = '0';
    guestFrame.style.pointerEvents = 'none';
    guestFrame.style.border = '0';
    guestFrame.style.inset = '0 auto auto 0';
    guestFrame.src = new URL('./page-plugin-guest.html', import.meta.url).toString();
    document.body.appendChild(guestFrame);
}

window.addEventListener('message', (event) => {
    if (!isGuestMessage(event.data)) {
        return;
    }

    if (event.source === window.parent) {
        postToGuest(event.data);
        return;
    }

    if (event.source === guestFrame?.contentWindow) {
        if (event.data.kind === 'frame-ready') {
            guestFrameReady = true;
            flushPendingMessages();
            return;
        }
        postToParent(event.data);
    }
});

createGuestFrame();

postToParent(createGuestMessage('frame-ready', {}));
