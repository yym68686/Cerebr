import { expect, it } from 'vitest';
import {
    DESKTOP_DOWNLOADS,
    desktopDownloadUrl,
    detectDesktopDownload,
} from '../src/platform/desktop-downloads.js';

it('selects the Windows installer and never selects desktop packages for mobile or unsupported systems', async () => {
    expect(await detectDesktopDownload({ platform: 'Win32' })).toEqual({
        platform: 'windows',
        target: 'win32-x64',
    });
    for (const navigatorInfo of [
        { platform: 'MacIntel', maxTouchPoints: 5 },
        { platform: 'Linux armv8', userAgent: 'Android' },
        { platform: 'iPhone', userAgent: 'iPhone' },
        { platform: 'Linux x86_64' },
    ])
        expect((await detectDesktopDownload(navigatorInfo)).target).toBe('');
});

it.each([
    ['arm', 'darwin-arm64'],
    ['x86', 'darwin-x64'],
])('uses reliable Mac architecture hints: %s', async (architecture, target) => {
    expect(
        await detectDesktopDownload({
            userAgentData: {
                platform: 'macOS',
                getHighEntropyValues: async () => ({ architecture, bitness: '64' }),
            },
        })
    ).toEqual({ platform: 'mac', target });
});

it('asks for the Mac chip when browser privacy hides it instead of trusting the Intel user agent', async () => {
    const navigatorInfo = {
        platform: 'MacIntel',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    };
    expect(await detectDesktopDownload(navigatorInfo)).toEqual({ platform: 'mac', target: '' });
    navigatorInfo.userAgentData = {
        getHighEntropyValues: async () => {
            throw new Error('Blocked');
        },
    };
    expect(await detectDesktopDownload(navigatorInfo)).toEqual({ platform: 'mac', target: '' });
});

it('links directly to stable latest-release installers for every selectable system', () => {
    for (const { id, file } of DESKTOP_DOWNLOADS)
        expect(desktopDownloadUrl(id)).toBe(
            `https://github.com/yym68686/Cerebr/releases/latest/download/${file}`
        );
    expect(desktopDownloadUrl('linux')).toBeNull();
});
