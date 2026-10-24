// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishRelease } from '../scripts/publish-release.mjs';
let directory, github, core, context;
const version = '1.2.3',
    tag = 'v1.2.3';
const assets = [
    'cerebr.zip',
    'cerebr-firefox.zip',
    'Cerebr-1.2.3-arm64.dmg',
    'Cerebr-1.2.3-x64.dmg',
    'Cerebr-darwin-arm64-1.2.3.zip',
    'Cerebr-darwin-x64-1.2.3.zip',
    'Cerebr-1.2.3-win32-x64-Setup.exe',
    'Cerebr-win32-x64-1.2.3.zip',
    'RELEASES',
    'Cerebr-1.2.3-full.nupkg',
    ...['darwin-arm64', 'darwin-x64', 'win32-x64'].map((target) => `Cerebr-1.2.3-${target}-SHA256SUMS.txt`),
];
beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cerebr-release-'));
    await Promise.all(assets.map((name) => writeFile(path.join(directory, name), 'fixture')));
    github = {
        rest: {
            git: { getRef: vi.fn(async () => ({ data: { object: { type: 'commit', sha: 'current' } } })) },
            repos: {
                getReleaseByTag: vi.fn(async () => {
                    throw Object.assign(new Error('Not found'), { status: 404 });
                }),
                createRelease: vi.fn(async () => ({ data: { id: 1, draft: true } })),
                listReleaseAssets: vi.fn(),
                deleteReleaseAsset: vi.fn(),
                uploadReleaseAsset: vi.fn(async () => ({})),
                updateRelease: vi.fn(async () => ({ data: { html_url: 'https://example.com/release' } })),
            },
        },
        paginate: vi.fn(async () => []),
    };
    core = { notice: vi.fn(), summary: { addLink: () => ({ write: vi.fn(async () => {}) }) } };
    context = { repo: { owner: 'owner', repo: 'repo' }, sha: 'current' };
});
afterEach(async () => rm(directory, { recursive: true, force: true }));
const publish = () => publishRelease({ github, context, core, directory, version, tag });
it('publishes only after all installers have uploaded to a draft', async () => {
    await publish();
    expect(github.rest.repos.createRelease).toHaveBeenCalledWith(
        expect.objectContaining({ draft: true, tag_name: tag, target_commitish: 'current' })
    );
    expect(github.rest.repos.uploadReleaseAsset).toHaveBeenCalledTimes(13);
    expect(github.rest.repos.updateRelease.mock.invocationCallOrder[0]).toBeGreaterThan(
        Math.max(...github.rest.repos.uploadReleaseAsset.mock.invocationCallOrder)
    );
});
it('does not create a release when a platform installer is missing', async () => {
    await rm(path.join(directory, 'Cerebr-1.2.3-win32-x64-Setup.exe'));
    await expect(publish()).rejects.toThrow('Missing release asset');
    expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
});
it('leaves the release as a draft if an upload fails', async () => {
    github.rest.repos.uploadReleaseAsset.mockRejectedValueOnce(new Error('Upload failed'));
    await expect(publish()).rejects.toThrow('Upload failed');
    expect(github.rest.repos.updateRelease).not.toHaveBeenCalled();
});
it('refuses to attach a build to an existing tag from another commit', async () => {
    github.rest.git.getRef.mockResolvedValue({ data: { object: { type: 'commit', sha: 'other' } } });
    await expect(publish()).rejects.toThrow('different commit');
    expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
});
it('succeeds without changing already published releases on reruns', async () => {
    github.rest.repos.getReleaseByTag.mockResolvedValue({
        data: { id: 1, draft: false, html_url: 'https://example.com/release' },
    });
    await publish();
    expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
    expect(github.rest.repos.deleteReleaseAsset).not.toHaveBeenCalled();
    expect(github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
    expect(github.rest.repos.updateRelease).not.toHaveBeenCalled();
});
it('still refuses a published release whose tag points to another commit', async () => {
    github.rest.repos.getReleaseByTag.mockResolvedValue({ data: { id: 1, draft: false } });
    github.rest.git.getRef.mockResolvedValue({ data: { object: { type: 'commit', sha: 'other' } } });
    await expect(publish()).rejects.toThrow('different commit');
    expect(github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled();
});
it('resumes a draft by replacing its incomplete assets before publication', async () => {
    github.rest.repos.getReleaseByTag.mockResolvedValue({ data: { id: 1, draft: true } });
    github.paginate.mockResolvedValue([{ id: 7, name: 'cerebr.zip' }]);
    await publish();
    expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
    expect(github.rest.repos.deleteReleaseAsset).toHaveBeenCalledWith(
        expect.objectContaining({ asset_id: 7 })
    );
    expect(github.rest.repos.uploadReleaseAsset).toHaveBeenCalledTimes(13);
    expect(github.rest.repos.updateRelease).toHaveBeenCalledWith(expect.objectContaining({ draft: false }));
});
