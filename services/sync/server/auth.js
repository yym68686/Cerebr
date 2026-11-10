import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
    return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function checkPassword(password, encoded) {
    const [, salt, stored] = encoded.split(':');
    const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
    const expected = Buffer.from(stored, 'hex');
    return expected.length === hash.length && timingSafeEqual(expected, hash);
}
function validEmail(username) {
    if (username.length > 254) return false;
    const parts = username.split('@');
    if (parts.length !== 2) return false;
    const [local, domain] = parts;
    return (
        local.length <= 64 &&
        /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) &&
        domain.includes('.') &&
        domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    );
}
export function credentials(body, { allowLegacyUsername = false } = {}) {
    const username = String(body?.username || '').trim().toLowerCase(), password = body?.password;
    const legacyUsername = allowLegacyUsername && /^[a-z0-9_][a-z0-9_.-]{2,31}$/.test(username);
    if (!validEmail(username) && !legacyUsername)
        throw Object.assign(new Error('请使用有效的邮箱地址（最多 254 位）。'), { statusCode: 400 });
    if (typeof password !== 'string' || password.length < 10 || password.length > 128)
        throw Object.assign(new Error('密码需为 10–128 位。'), { statusCode: 400 });
    return { username, password };
}
