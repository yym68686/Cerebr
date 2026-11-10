import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentials } from '../server/auth.js';

const password = 'Test-only-password-29!';

test('accepts email account names, including an email used as the password', () => {
    const email = 'reader+sync@example.test';
    assert.deepEqual(credentials({ username: ` ${email.toUpperCase()} `, password: email }), {
        username: email,
        password: email,
    });
    const longEmail = 'longer-than-the-old-username-limit@example.test';
    assert.equal(credentials({ username: longEmail, password }).username, longEmail);
});

test('only allows existing plain usernames for login and does not normalize passwords', () => {
    const originalPassword = ' Case-sensitive password ';
    const body = { username: ' Existing_User-1.2 ', password: originalPassword };
    assert.throws(() => credentials(body), { statusCode: 400, message: '请使用有效的邮箱地址（最多 254 位）。' });
    assert.deepEqual(credentials(body, { allowLegacyUsername: true }), {
        username: 'existing_user-1.2',
        password: originalPassword,
    });
});

test('rejects malformed email addresses and overlong account names', () => {
    for (const username of [
        'reader@@example.test', 'reader@example', 'reader name@example.test',
        '.reader@example.test', 'reader..sync@example.test', 'reader@-example.test',
        'reader@example..test', 'a'.repeat(65) + '@example.test',
        'a'.repeat(64) + '@' + ['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63)].join('.'),
        'ordinary_user', 'a'.repeat(33), 'ab', '',
    ]) {
        assert.throws(() => credentials({ username, password }), { statusCode: 400 });
    }
});

test('retains the password length and type requirements for email accounts', () => {
    for (const invalidPassword of ['', 'short', 'a'.repeat(129), null, 1234567890]) {
        assert.throws(() => credentials({ username: 'reader@example.test', password: invalidPassword }), {
            statusCode: 400,
            message: '密码需为 10–128 位。',
        });
    }
});
