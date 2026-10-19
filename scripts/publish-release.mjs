import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export async function publishRelease({
    github,
    context,
    core,
    tag = process.env.RELEASE_TAG,
    version = process.env.RELEASE_VERSION,
    directory = path.resolve('artifacts/release-all'),
}) {
    const names = (await readdir(directory)).sort();
    const expected = [
        'cerebr.zip',
        'cerebr-firefox.zip',
        `Cerebr-${version}-arm64.dmg`,
        `Cerebr-${version}-x64.dmg`,
        `Cerebr-darwin-arm64-${version}.zip`,
        `Cerebr-darwin-x64-${version}.zip`,
        `Cerebr-${version}-win32-x64-Setup.exe`,
        `Cerebr-win32-x64-${version}.zip`,
        ...['darwin-arm64', 'darwin-x64', 'win32-x64'].map(
            (target) => `Cerebr-${version}-${target}-SHA256SUMS.txt`
        ),
    ];
    for (const name of expected)
        if (!names.includes(name) || !(await stat(path.join(directory, name))).size)
            throw new Error(`Missing release asset: ${name}`);
    if (names.some((name) => !expected.includes(name))) throw new Error('Unexpected release asset');
    // Never attach a build to an older tag with the same version.
    const { owner, repo } = context.repo;
    let ref;
    try {
        ref = (await github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` })).data.object;
    } catch (error) {
        if (error.status !== 404) throw error;
    }
    if (ref) {
        while (ref.type === 'tag')
            ref = (await github.rest.git.getTag({ owner, repo, tag_sha: ref.sha })).data.object;
        if (ref.sha !== context.sha) throw new Error(`${tag} points to a different commit`);
    }
    let release;
    try {
        release = (await github.rest.repos.getReleaseByTag({ owner, repo, tag })).data;
    } catch (error) {
        if (error.status !== 404) throw error;
    }
    if (release && !release.draft)
        throw new Error(`${tag} is already published; use a new version instead of replacing public assets`);
    const notes = `## Downloads\n\n- Apple Silicon Mac: arm64 DMG\n- Intel Mac: x64 DMG\n- Windows x64: Setup.exe\n- ZIP archives are also provided. Browser extension packages: cerebr.zip and cerebr-firefox.zip.\n\nThese desktop builds are currently unsigned and not notarized. API settings and chat history can sync with a paired Cerebr browser extension on the same computer.\n`;
    if (!release)
        release = (
            await github.rest.repos.createRelease({
                owner,
                repo,
                tag_name: tag,
                target_commitish: context.sha,
                name: tag,
                draft: true,
                prerelease: false,
                generate_release_notes: true,
                body: notes,
            })
        ).data;
    const existing = await github.paginate(github.rest.repos.listReleaseAssets, {
        owner,
        repo,
        release_id: release.id,
        per_page: 100,
    });
    for (const name of expected) {
        const previous = existing.find((asset) => asset.name === name);
        if (previous) await github.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: previous.id });
        const data = await readFile(path.join(directory, name));
        await github.rest.repos.uploadReleaseAsset({
            owner,
            repo,
            release_id: release.id,
            name,
            data,
            headers: { 'content-type': 'application/octet-stream', 'content-length': data.length },
        });
    }
    release = (await github.rest.repos.updateRelease({ owner, repo, release_id: release.id, draft: false }))
        .data;
    core.notice(`Published ${release.html_url}`);
    await core.summary.addLink(`Release ${tag}`, release.html_url).write();
}
