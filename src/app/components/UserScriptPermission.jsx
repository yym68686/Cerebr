import { useEffect, useState } from 'react';
import { t } from '../../utils/i18n.js';
import { notify } from '../state/ui-store.js';

const permission = { permissions: ['userScripts'] };

export function UserScriptPermission({ visible }) {
    const api = globalThis.chrome?.permissions;
    const [granted, setGranted] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!visible || !api?.contains || !api?.request) return;
        let active = true;
        const refresh = () => {
            void api.contains(permission).then(
                (value) => { if (active) setGranted(value); },
                () => { if (active) setGranted(null); }
            );
        };
        refresh();
        api.onAdded?.addListener(refresh);
        api.onRemoved?.addListener(refresh);
        return () => {
            active = false;
            api.onAdded?.removeListener(refresh);
            api.onRemoved?.removeListener(refresh);
        };
    }, [api, visible]);

    async function requestPermission() {
        setBusy(true);
        try {
            // Request directly from the click so Firefox retains the user gesture.
            setGranted(await api.request(permission));
        } catch (error) {
            notify(error.message, { type: 'error' });
        } finally {
            setBusy(false);
        }
    }

    if (!visible || granted !== false) return null;
    return (
        <div className="plugin-dev-import" id="plugin-user-scripts-permission">
            <p className="plugin-dev-import__hint">{t('plugin_user_scripts_permission_hint')}</p>
            <button className="plugin-action-button" disabled={busy} onClick={requestPermission}>
                {t('plugin_user_scripts_permission_allow')}
            </button>
        </div>
    );
}
