const path = require('node:path');
const { version } = require('./package.json');
module.exports = {
    outDir: path.resolve(__dirname, '../artifacts/desktop'),
    packagerConfig: {
        asar: true,
        appBundleId: 'app.cerebr.desktop',
        executableName: 'Cerebr',
        icon: path.resolve(__dirname, '../icons/cerebr'),
        appCategoryType: 'public.app-category.productivity',
        ignore: (file) => !!file && !file.startsWith('/.vite') && file !== '/package.json',
    },
    makers: [
        { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32', 'linux'] },
        { name: '@electron-forge/maker-dmg', config: { format: 'ULFO' } },
        {
            name: '@electron-forge/maker-squirrel',
            config: (arch) => ({
                name: 'Cerebr',
                setupExe: `Cerebr-${version}-win32-${arch}-Setup.exe`,
                setupIcon: path.resolve(__dirname, '../icons/cerebr.ico'),
            }),
        },
    ],
};
