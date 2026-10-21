import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { processMathAndMarkdown, textMayContainMath } from '../htmd/latex.js';

beforeAll(() => {
    // Exercise the bundled parser and highlighter used by the application.
    const globals = {};
    for (const file of ['marked.min.js', 'highlight.min.js']) {
        runInNewContext(readFileSync(`htmd/${file}`, 'utf8'), globals);
    }
    vi.stubGlobal('marked', globals.marked);
    vi.stubGlobal('hljs', globals.hljs);
});

afterAll(() => vi.unstubAllGlobals());

function render(markdown) {
    const container = document.createElement('div');
    container.innerHTML = processMathAndMarkdown(markdown);
    return container;
}

it.each(['50%', '99.999999999999999999999999999999%', String.raw`50\%`])(
    'recognizes a percentage formula inside bold Chinese text: %s', (percentage) => {
        const source = `我有 **$${percentage}$ 的概率**。`;
        expect(textMayContainMath(source)).toBe(true);
        const container = render(source);
        expect(container.querySelector('strong')?.textContent).toBe(
            `\\(${percentage.replace(/(?<!\\)%/, '\\%')}\\) 的概率`
        );
        expect(container.querySelector('strong')?.textContent).not.toContain('$');
    }
);

it.each([
    ['**$$50%$$**', String.raw`$$50\%$$`],
    [String.raw`**\(50%\)**`, String.raw`\(50\%\)`],
    [String.raw`**\[99.99%\]**`, String.raw`\[ 99.99\% \]`],
    [String.raw`**\(50\% \)**`, String.raw`\(50\% \)`],
])('normalizes a numeric percent for TeX without losing its delimiters: %s', (source, expected) => {
    expect(render(source).textContent).toContain(expected);
});

it('leaves currency, ordinary percentages and dollar examples in code unchanged', () => {
    const source = '价格 $50 和 $100，概率 50%。`$50%$`\n\n```text\n$99.99%$\n```';
    expect(textMayContainMath(source)).toBe(false);
    const container = render(source);
    expect(container.textContent).toContain('价格 $50 和 $100，概率 50%。');
    expect([...container.querySelectorAll('code')].map(el => el.textContent)).toEqual(['$50%$', '$99.99%$']);
});

it('preserves percentage line breaks and legitimate TeX comments', () => {
    const text = '概率为 50%\n下一行保留。';
    const container = render(text);
    expect(container.textContent).toContain('50%');
    expect(container.querySelector('br')).not.toBeNull();
    const formula = String.raw`$$x=1 % explanation` + '\n+2$$';
    expect(render(formula).textContent).toContain(formula);
});

it('recognizes a streamed percentage only when its closing dollar arrives', () => {
    const source = '**$99.999999%$ 的概率**';
    expect(textMayContainMath('**$99.999999%')).toBe(false);
    expect(textMayContainMath(source)).toBe(true);
    expect(render(source).querySelector('strong')?.textContent).toBe(String.raw`\(99.999999\%\) 的概率`);
});

it('preserves numeric ranges in the reported list without striking through the text between them', () => {
    const container = render(
        '- **操作**：使用凉水（10~15°C），持续 **15 ~ 30 秒**。\n' +
            '- **效果**：重复 2~3 次，心跳变得平稳，HRV 往往能立刻跳升 15~30ms。'
    );
    expect(container.querySelector('del')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelectorAll('strong')).toHaveLength(3);
    expect(container.textContent).toContain('10~15°C');
    expect(container.textContent).toContain('15 ~ 30 秒');
    expect(container.textContent).toContain('重复 2~3 次，心跳变得平稳，HRV 往往能立刻跳升 15~30ms。');
});

it.each(['~', ' ~ ', '-', ' - ', '～', '–', '—'])(
    'keeps ranges separated by %s intact, including decimals and negative numbers',
    (separator) => {
        const text = `温度 -10${separator}-5°C，时间 1.5${separator}2.5 小时，数量 2${separator}3 个。`;
        const container = render(text);
        expect(container.querySelector('del')).toBeNull();
        expect(container.textContent.trim()).toBe(text);
    }
);

it('only treats paired double tildes as strikethrough and preserves nested markup and ranges', () => {
    const container = render(
        '2~3 次，~~旧值 *10~15ms*~~，新值 15~30ms，~~[已删除](https://example.com)~~，~普通文字~。'
    );
    const deleted = container.querySelectorAll('del');
    expect([...deleted].map((element) => element.textContent)).toEqual(['旧值 10~15ms', '已删除']);
    expect(deleted[0].querySelector('em')?.textContent).toBe('10~15ms');
    expect(deleted[1].querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.textContent).toContain('2~3 次');
    expect(container.textContent).toContain('新值 15~30ms');
    expect(container.textContent).toContain('~普通文字~');
});

it('preserves literal tildes in code, escaped text, and link destinations', () => {
    const literal = '2~3 ~~literal~~ 15~30';
    const container = render(
        '`' +
            literal +
            '`\n\n~~~text\n' +
            literal +
            '\n~~~\n\n' +
            String.raw`\~\~不是删除线\~\~ [范围 2~3](https://example.com/~user/15~30)`
    );
    expect(container.querySelector('del')).toBeNull();
    expect([...container.querySelectorAll('code')].map((element) => element.textContent)).toEqual([
        literal,
        literal,
    ]);
    expect(container.textContent).toContain('~~不是删除线~~');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/~user/15~30');
});

it('preserves numeric ranges in tables', () => {
    const container = render('| 次数 | 时间 |\n| --- | --- |\n| 2~3 次 | 15~30 秒 |');
    expect(container.querySelector('del')).toBeNull();
    expect([...container.querySelectorAll('td')].map((element) => element.textContent)).toEqual([
        '2~3 次',
        '15~30 秒',
    ]);
});

it('does not introduce strikethrough as numeric ranges stream in', () => {
    const text = '重复 2~3 次，等待 15~30 秒。';
    for (let end = 1; end <= text.length; end++) {
        const partial = text.slice(0, end);
        const container = render(partial);
        expect(container.querySelector('del')).toBeNull();
        expect(container.textContent.trim()).toBe(partial.trim());
    }
});

it.each([
    ['"', '"'],
    ['“', '”'],
    ['「', '」'],
])('renders the reported bold text starting with %s next to Chinese text', (open, close) => {
    const bold = `${open}超级省电模式（Ultra Power Saving Mode）${close}物理按键`;
    const container = render(`直接按下了手机的**${bold}**，一秒钟强行接管你的全身生理机能。`);
    expect(container.querySelector('strong')?.textContent).toBe(bold);
    expect(container.textContent.trim()).toBe(`直接按下了手机的${bold}，一秒钟强行接管你的全身生理机能。`);
});

it.each([
    ['**第一封邮件（7月22日）**是', '第一封邮件（7月22日）', '第一封邮件（7月22日）是'],
    ['按下**“省电模式”**按钮', '“省电模式”', '按下“省电模式”按钮'],
    ['这是**（包含 English words）**的说明', '（包含 English words）', '这是（包含 English words）的说明'],
    ['**1. 主要贡献:**', '1. 主要贡献:', '1. 主要贡献:'],
    ['**2. A 和 B 矩阵的生成**', '2. A 和 B 矩阵的生成', '2. A 和 B 矩阵的生成'],
])('renders bold punctuation boundaries without inserting spaces: %s', (source, bold, text) => {
    const container = render(source);
    expect(container.querySelector('strong')?.textContent).toBe(bold);
    expect(container.textContent.trim()).toBe(text);
});

it('keeps adjacent bold spans separate when their punctuation touches Chinese text', () => {
    const container = render('按下**“省电模式”**按钮并查看**“正常模式”**说明。');
    expect([...container.querySelectorAll('strong')].map((element) => element.textContent)).toEqual([
        '“省电模式”',
        '“正常模式”',
    ]);
    expect(container.textContent.trim()).toBe('按下“省电模式”按钮并查看“正常模式”说明。');
});

it('preserves nested emphasis, inline code, and links inside quoted bold text', () => {
    const container = render(
        '按下**“省电模式”中的 *按钮* 与 `**code**` 和 [说明](https://example.com)**即可。' +
            '另外 ***粗斜体*** 与 **粗体 *内含斜体*** 仍然有效。'
    );
    const strong = container.querySelector('strong');
    expect(strong?.querySelector('em')?.textContent).toBe('按钮');
    expect(strong?.querySelector('code')?.textContent).toBe('**code**');
    expect(strong?.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(container.querySelector('em > strong')?.textContent).toBe('粗斜体');
    expect(container.querySelectorAll('strong em')[1]?.textContent).toBe('内含斜体');
});

it('keeps bold syntax literal in code, escaped text, and link destinations', () => {
    const literal = '手机的**"quoted words"**与**原文**';
    const container = render(
        '`' +
            literal +
            '`\n\n~~~text\n' +
            literal +
            '\n~~~\n\n' +
            String.raw`手机的\*\*“quoted words”\*\*与[链接](https://example.com/**path**/end)`
    );
    expect(container.querySelector('strong')).toBeNull();
    expect([...container.querySelectorAll('code')].map((element) => element.textContent)).toEqual([
        literal,
        literal,
    ]);
    expect(container.textContent).toContain('手机的**“quoted words”**与');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/**path**/end');
});

it('preserves spaces and line breaks around standard emphasis and Chinese bold text', () => {
    const container = render(
        '前文  **普通粗体**  后文\n\n手机的**“省电模式”（Ultra Power\nSaving Mode）**按钮'
    );
    expect(container.querySelector('p')?.textContent).toBe('前文  普通粗体  后文');
    const quoted = container.querySelectorAll('strong')[1];
    expect(quoted?.querySelector('br')).not.toBeNull();
    expect(quoted?.textContent).toBe('“省电模式”（Ultra PowerSaving Mode）');
    expect(container.textContent).not.toContain('**');
});

it('renders quoted bold text when its closing delimiter arrives during streaming', () => {
    const prefix = '手机的**“超级省电模式（Ultra Power Saving Mode）”';
    expect(render(prefix).querySelector('strong')).toBeNull();
    const completed = render(`${prefix}**按钮`);
    expect(completed.querySelector('strong')?.textContent).toBe('“超级省电模式（Ultra Power Saving Mode）”');
    expect(completed.textContent.trim()).toBe('手机的“超级省电模式（Ultra Power Saving Mode）”按钮');
});

it('keeps standard emphasis and incomplete delimiters unchanged', () => {
    const standard = new marked.Marked({ gfm: true, breaks: true });
    for (const source of [
        '**bold** and *italic* and __also bold__ and _also italic_',
        '***both*** and **bold *with italics***',
        'word**bold**word and word**"quoted words"**word',
        '** leading space** and **trailing space **',
        '**unfinished',
        '**first paragraph\n\nsecond paragraph**',
    ]) {
        expect(processMathAndMarkdown(source)).toBe(standard.parse(source));
    }
});
