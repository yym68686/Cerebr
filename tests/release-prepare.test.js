// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRelease, nextReleaseVersion } from '../scripts/prepare-release.mjs';
import { versionFiles } from '../scripts/release-version.mjs';

const execute = promisify(execFile);
let root, source, github, context, core;
const git = async (...args) => (await execute('git', args, { cwd: root })).stdout.trim();
const prepare = () => prepareRelease({ github, context, core, root });

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cerebr-release-prepare-'));
    await mkdir(path.join(root, 'desktop'));
    for (const file of versionFiles)
        await writeFile(
            path.join(root, file),
            JSON.stringify({ name: file, version: '2.6.14', keep: true }, null, 2) + '\n'
        );
    await writeFile(
        path.join(root, 'package-lock.json'),
        JSON.stringify(
            {
                version: '2.6.14',
                lockfileVersion: 3,
                packages: {
                    '': { version: '2.6.14' },
                    desktop: { version: '2.6.14' },
                    'node_modules/example': { version: '1.0.0' },
                },
            },
            null,
            2
        ) + '\n'
    );
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Test');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'commit.gpgsign', 'false');
    await git('add', '.');
    await git('commit', '-m', 'Previous release');
    await git('tag', 'v2.6.14');
    await writeFile(path.join(root, 'feature.txt'), 'new feature');
    await git('add', '.');
    await git('commit', '-m', 'Feature push');
    source = await git('rev-parse', 'HEAD');
    context = { repo: { owner: 'owner', repo: 'repo' }, sha: source, ref: 'refs/heads/main' };
    core = { setOutput: vi.fn(), notice: vi.fn() };
    github = {
        rest: {
            git: {
                createTree: vi.fn(async () => ({ data: { sha: 'new-tree' } })),
                createCommit: vi.fn(async () => ({ data: { sha: 'new-commit' } })),
                createRef: vi.fn(async () => ({})),
                getRef: vi.fn(async () => ({ data: { object: { sha: source } } })),
                updateRef: vi.fn(async () => ({})),
            },
        },
    };
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it('automatically increments above all stable tags, while honoring a larger declared version', () => {
    expect(nextReleaseVersion('2.6.14', ['v2.6.9', 'v2.6.14', 'v3.0.0-beta'])).toBe('2.6.15');
    expect(nextReleaseVersion('2.6.14', ['v2.7.9', 'v2.7.10'])).toBe('2.7.11');
    expect(nextReleaseVersion('3.0.0', ['v2.6.14'])).toBe('3.0.0');
    expect(nextReleaseVersion('1.0.0', [])).toBe('1.0.0');
});

it('reserves one tag with consistent package/manifest/lock versions and fast-forwards main', async () => {
    expect(await prepare()).toEqual({ sha: 'new-commit', tag: 'v2.6.15', version: '2.6.15' });
    const { base_tree, tree } = github.rest.git.createTree.mock.calls[0][0];
    expect(base_tree).toBe(await git('rev-parse', 'HEAD^{tree}'));
    expect(tree.map((entry) => entry.path)).toEqual([...versionFiles, 'package-lock.json']);
    for (const entry of tree) {
        const data = JSON.parse(entry.content);
        expect(data.version).toBe('2.6.15');
        if (entry.path !== 'package-lock.json') expect(data.keep).toBe(true);
        else {
            expect(data.packages[''].version).toBe('2.6.15');
            expect(data.packages.desktop.version).toBe('2.6.15');
            expect(data.packages['node_modules/example'].version).toBe('1.0.0');
        }
    }
    expect(github.rest.git.createCommit).toHaveBeenCalledWith(
        expect.objectContaining({
            parents: [source],
            message: expect.stringContaining(`Cerebr-Release-Source: ${source}`),
        })
    );
    expect(github.rest.git.createRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: 'refs/tags/v2.6.15', sha: 'new-commit' })
    );
    expect(github.rest.git.updateRef).toHaveBeenCalledWith(
        expect.objectContaining({ ref: 'heads/main', sha: 'new-commit', force: false })
    );
    expect(core.setOutput).toHaveBeenCalledWith('sha', 'new-commit');
    // Preparation only writes the new Git tree, not the original source checkout.
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version).toBe('2.6.14');
});

async function reserveExistingVersion() {
    await prepare();
    for (const entry of github.rest.git.createTree.mock.calls[0][0].tree)
        await writeFile(path.join(root, entry.path), entry.content);
    await git('add', '.');
    await git('commit', '-m', `chore(release): v2.6.15\n\nCerebr-Release-Source: ${source}`);
    await git('tag', 'v2.6.15');
    const sha = await git('rev-parse', 'HEAD');
    await git('checkout', '--detach', source);
    vi.clearAllMocks();
    return sha;
}

it('reuses a reserved tag after a failed build or a complete workflow rerun', async () => {
    const sha = await reserveExistingVersion();
    expect(await prepare()).toEqual({ sha, tag: 'v2.6.15', version: '2.6.15' });
    expect(github.rest.git.createTree).not.toHaveBeenCalled();
    expect(github.rest.git.createRef).not.toHaveBeenCalled();
    expect(github.rest.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ sha }));
});

it('reuses a release commit when manually publishing main again', async () => {
    const sha = await reserveExistingVersion();
    await git('checkout', '--detach', sha);
    context.sha = sha;
    expect(await prepare()).toEqual({ sha, tag: 'v2.6.15', version: '2.6.15' });
    expect(github.rest.git.createRef).not.toHaveBeenCalled();
    expect(github.rest.git.updateRef).not.toHaveBeenCalled();
});

it('keeps the source-specific release if main already has a newer push', async () => {
    github.rest.git.getRef.mockResolvedValue({ data: { object: { sha: 'newer-push' } } });
    expect((await prepare()).version).toBe('2.6.15');
    expect(github.rest.git.createRef).toHaveBeenCalledOnce();
    expect(github.rest.git.updateRef).not.toHaveBeenCalled();
});

it('tolerates a concurrent fast-forward race without ever force pushing', async () => {
    github.rest.git.getRef
        .mockResolvedValueOnce({ data: { object: { sha: source } } })
        .mockResolvedValue({ data: { object: { sha: 'newer-push' } } });
    github.rest.git.updateRef.mockRejectedValue(
        Object.assign(new Error('Not fast forward'), { status: 422 })
    );
    expect((await prepare()).version).toBe('2.6.15');
    expect(github.rest.git.updateRef).toHaveBeenCalledTimes(1);
    expect(github.rest.git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
});

it('surfaces branch protection errors instead of reporting a successful version write', async () => {
    github.rest.git.updateRef.mockRejectedValue(
        Object.assign(new Error('Protected branch'), { status: 422 })
    );
    await expect(prepare()).rejects.toThrow('Protected branch');
    expect(core.setOutput).not.toHaveBeenCalled();
});

it('fails before writing refs when versions disagree or the checkout is not the event commit', async () => {
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: '2.6.13' }));
    await expect(prepare()).rejects.toThrow('Release versions must match');
    context.sha = 'unexpected';
    await expect(prepare()).rejects.toThrow('Checkout does not match');
    expect(github.rest.git.createRef).not.toHaveBeenCalled();
});

it('does not move main if tag reservation fails', async () => {
    github.rest.git.createRef.mockRejectedValue(Object.assign(new Error('Tag exists'), { status: 422 }));
    await expect(prepare()).rejects.toThrow('Tag exists');
    expect(github.rest.git.updateRef).not.toHaveBeenCalled();
    expect(core.setOutput).not.toHaveBeenCalled();
});
