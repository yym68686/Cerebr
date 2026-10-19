import { useState } from 'react';
import { Icon } from './Icon.jsx';

export function WebpageIcon({ tab }) {
    const [failed, setFailed] = useState(null);
    const url = tab?.favIconUrl;
    return url && url !== failed ? (
        <img
            className="webpage-favicon"
            src={url}
            alt=""
            aria-hidden="true"
            referrerPolicy="no-referrer"
            onError={() => setFailed(url)}
        />
    ) : (
        <Icon name="webpage-qa" />
    );
}
