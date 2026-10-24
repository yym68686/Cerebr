import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readReleaseVersion, repositoryRoot, versionFiles } from './release-version.mjs';

const execute = promisify(execFile);
const compare = (a, b) => {
    const left = a.split('.').map(Number),
        right = b.split('.').map(Number);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
};

export function nextReleaseVersion(current, tags) {
    const latest = tags
        .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
        .map((tag) => tag.slice(1))
        .sort(compare)
        .at(-1);
    if (!latest || compare(current, latest) > 0) return current;
    const [major, minor, patch] = latest.split('.').map(Number);
    return `${major}.${minor}.${patch + 1}`;
}

async function versionTree(root, version) {
    return Promise.all(
        [...versionFiles, 'package-lock.json'].map(async (file) => {
            const source = await readFile(path.join(root, file), 'utf8');
            let content;
            if (file === 'package-lock.json') {
                const lock = JSON.parse(source);
                lock.version = version;
                lock.packages[''].version = version;
                lock.packages.desktop.version = version;
                content = JSON.stringify(lock, null, 2) + '\n';
            } else {
                // Preserve manifest formatting and every setting other than the version.
                content = source.replace(
                    /("version"\s*:\s*")[^"]+(")/,
                    (_, before, after) => `${before}${version}${after}`
                );
            }
            return { path: file, mode: '100644', type: 'blob', content };
        })
    );
}

export async function prepareRelease({ github, context, core, root = repositoryRoot }) {
    if (context.ref !== 'refs/heads/main') throw new Error('Automatic versioning only supports main');
    const git = async (...args) =>
        (await execute('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
    const source = await git('rev-parse', 'HEAD');
    if (source !== context.sha) throw new Error('Checkout does not match the triggering commit');
    const current = await readReleaseVersion(root);
    const tags = (await git('tag', '--list', 'v*')).split('\n').filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
    const trailer = `Cerebr-Release-Source: ${source}`;
    let result;
    // The tag is a durable reservation: reruns (including after a failed build)
    // reuse the same source and version, even after newer pushes have arrived.
    for (const tag of tags.sort((a, b) => compare(b.slice(1), a.slice(1)))) {
        const [sha, parents, ...message] = (
            await git('show', '-s', '--format=%H%n%P%n%B', `${tag}^{commit}`)
        ).split('\n');
        if ((sha === source && tag === `v${current}`) || (parents === source && message.includes(trailer))) {
            const version = JSON.parse(await git('show', `${tag}:package.json`)).version;
            if (tag !== `v${version}`)
                throw new Error(`Reserved tag ${tag} does not match its version files`);
            result = { sha, tag, version };
            break;
        }
    }
    const { owner, repo } = context.repo;
    if (!result) {
        const version = nextReleaseVersion(current, tags),
            tag = `v${version}`;
        const tree = (
            await github.rest.git.createTree({
                owner,
                repo,
                base_tree: await git('rev-parse', 'HEAD^{tree}'),
                tree: await versionTree(root, version),
            })
        ).data;
        const commit = (
            await github.rest.git.createCommit({
                owner,
                repo,
                tree: tree.sha,
                parents: [source],
                message: `chore(release): ${tag}\n\n${trailer}`,
                author: {
                    name: 'github-actions[bot]',
                    email: '41898282+github-actions[bot]@users.noreply.github.com',
                },
            })
        ).data;
        await github.rest.git.createRef({ owner, repo, ref: `refs/tags/${tag}`, sha: commit.sha });
        result = { sha: commit.sha, tag, version };
    }
    const head = async () =>
        (await github.rest.git.getRef({ owner, repo, ref: 'heads/main' })).data.object.sha;
    if (result.sha !== source && (await head()) === source) {
        try {
            // Fast-forward only: a concurrent user push must never be overwritten.
            await github.rest.git.updateRef({
                owner,
                repo,
                ref: 'heads/main',
                sha: result.sha,
                force: false,
            });
        } catch (error) {
            if (![409, 422].includes(error.status) || (await head()) === source) throw error;
            core.notice(
                'main advanced during version preparation; keeping the version commit on its release tag.'
            );
        }
    } else if (result.sha !== source) {
        core.notice('main already advanced; building the reserved release tag without changing main.');
    }
    for (const [name, value] of Object.entries(result)) core.setOutput(name, value);
    core.notice(`Prepared ${result.tag} from ${source}`);
    return result;
}
