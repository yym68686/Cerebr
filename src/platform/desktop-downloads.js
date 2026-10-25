export const DESKTOP_RELEASES_URL = 'https://github.com/yym68686/Cerebr/releases/latest';

// Stable aliases are published alongside the versioned installers on every release.
export const DESKTOP_DOWNLOADS = [
    { id: 'darwin-arm64', label: 'macOS · Apple Silicon', file: 'Cerebr-macOS-arm64.dmg' },
    { id: 'darwin-x64', label: 'macOS · Intel', file: 'Cerebr-macOS-x64.dmg' },
    { id: 'win32-x64', label: 'Windows · x64', file: 'Cerebr-Windows-x64.exe' },
];

export function desktopDownloadUrl(target) {
    const download = DESKTOP_DOWNLOADS.find(({ id }) => id === target);
    return download ? `${DESKTOP_RELEASES_URL}/download/${download.file}` : null;
}

export async function detectDesktopDownload(navigatorInfo = globalThis.navigator) {
    const agent = navigatorInfo?.userAgent || '';
    const platform = navigatorInfo?.userAgentData?.platform || navigatorInfo?.platform || '';
    // iPadOS can identify itself as a Mac. Never suggest a desktop installer on mobile.
    if (
        /Android|iPhone|iPad|iPod/i.test(agent) ||
        (/Mac/i.test(platform) && navigatorInfo?.maxTouchPoints > 1)
    )
        return { platform: 'other', target: '' };
    if (/Win/i.test(platform || agent)) return { platform: 'windows', target: 'win32-x64' };
    if (!/Mac/i.test(platform || agent)) return { platform: 'other', target: '' };
    try {
        const hints = await navigatorInfo.userAgentData?.getHighEntropyValues(['architecture', 'bitness']);
        if (hints?.architecture === 'arm') return { platform: 'mac', target: 'darwin-arm64' };
        if (hints?.architecture === 'x86') return { platform: 'mac', target: 'darwin-x64' };
    } catch {
        // Safari, Firefox and privacy settings may not expose the CPU architecture.
    }
    // "Intel Mac OS X" also appears on Apple Silicon; it is not an architecture hint.
    return { platform: 'mac', target: '' };
}
