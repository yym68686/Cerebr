// 处理数学公式和 Markdown 的函数
export function processMathAndMarkdown(text) {
    const mathExpressions = [];
    let mathIndex = 0;
    text = text.replace(/\\\[([a-zA-Z\d]+)\]/g, '[$1]');

    // 添加 \mathds 字符映射
    const mathdsMap = {
        'A': '𝔸', 'B': '𝔹', 'C': 'ℂ', 'D': '𝔻', 'E': '𝔼',
        'F': '𝔽', 'G': '𝔾', 'H': 'ℍ', 'I': '𝕀', 'J': '𝕁',
        'K': '𝕂', 'L': '𝕃', 'M': '𝕄', 'N': 'ℕ', 'O': '𝕆',
        'P': 'ℙ', 'Q': 'ℚ', 'R': 'ℝ', 'S': '𝕊', 'T': '𝕋',
        'U': '𝕌', 'V': '𝕍', 'W': '𝕎', 'X': '𝕏', 'Y': '𝕐',
        'Z': 'ℤ',
        '0': '𝟘', '1': '𝟙', '2': '𝟚', '3': '𝟛', '4': '𝟜',
        '5': '𝟝', '6': '𝟞', '7': '𝟟', '8': '𝟠', '9': '𝟡'
    };

    // 处理 \mathds 命令
    text = text.replace(/\\mathds\{([A-Z0-9])\}/g, (match, char) => {
        return mathdsMap[char] || match;
    });

    // 处理 \boxed 命令，将其包装在 \[ \] 中
    text = text.replace(/(\\\[\s*)?\\boxed\{([^}]+)\}(\s*\\\])?/g, '\\[\\boxed{$2}\\]');

    text = text.replace(/^---\n$/gm, '');

    // 处理 \textsc 命令
    text = text.replace(/\\textsc\{([^}]+)\}/g, (match, content) => {
        return content.toUpperCase();
    });

    // 处理 think 标签，将其转换为引用格式
    // 首先处理完整的 <think>...</think> 标签
    text = text.replace(/<think>([\s\S]*?)<\/think>/g, (match, content) => {
        // 处理多行文本，为每一行添加引用符号
        return content.trim().split('\n').map(line => `> ${line.trim()}`).join('\n');
    });

    // 然后处理只有开始标签的情况
    text = text.replace(/<think>\n?([\s\S]*?)(?=<\/think>|$)/g, (match, content) => {
        if (!match.includes('</think>')) {
            // 如果没有结束标签，将所有后续内容都转换为引用格式
            return content.trim().split('\n').map(line => `> ${line.trim()}`).join('\n');
        }
        return match; // 如果有结束标签，保持原样（因为已经在上一步处理过了）
    });

    text = text.replace(/%\n\s*/g, ''); // 移除换行的百分号
    text = text.replace(/（\\\((.+?)\\）/g, '（\\($1\\)）');
    // 临时替换数学公式
    text = text.replace(/(\\\\\([^]+?\\\\\))|(\\\([^]+?\\\))|(\\\[[\s\S]+?\\\])/g, (match) => {
        // 处理除号
        match = match.replace(/\\div\b/g, ' ÷ ');
        match = match.replace(/\\\[\s*(.+?)\s*\\+\]/g, '\\[ $1 \\]');
        match = match.replace(/\\\(\s*(.+?)\s*\\）/g, '\\( $1 \\)');
        match = match.replace(/\\\(\s*(.+?)\s*\\，/g, '\\( $1 \\)，');
        match = match.replace(/</g, '&lt;');
        match = match.replace(/>/g, '&gt;');
        match = match.replace(/%\s/g, '');

        // 如果是普通括号形式公式，转换为 \(...\) 形式
        if (match.startsWith('(') && match.endsWith(')') && !match.startsWith('\\(')) {
            console.log('警告：请使用 \\(...\\) 来表示行内公式');
        }

        // 为行间公式添加容器
        if (match.startsWith('\\[') || match.startsWith('$$')) {
            match = `<div class="math-display-container">${match}</div>`;
        }

        const placeholder = `%%MATH_EXPRESSION_${mathIndex}%%`;
        mathExpressions.push(match);
        mathIndex++;
        return placeholder;
    });

    // 配置 marked
    marked.setOptions({
        breaks: true,
        gfm: true,
        sanitize: false,
        highlight: function(code, lang) {
            if (lang === 'mermaid') {
                return `<div class="mermaid">${code}</div>`;
            }
            if (lang && hljs.getLanguage(lang)) {
                try {
                    return hljs.highlight(code, { language: lang }).value;
                } catch (err) {
                    console.error('代码高亮错误:', err);
                }
            }
            return hljs.highlightAuto(code).value;
        },
        renderer: Object.assign(new marked.Renderer(), {
            code(code, language) {
                // 检查是否包含数学表达式占位符
                if (code.includes('%%MATH_EXPRESSION_')) {
                    return code;  // 如果包含数学表达式，直接返回原文本
                }
                if (language === 'mermaid') {
                    return `<div class="mermaid">${code}</div>`;
                }
                const validLanguage = language && hljs.getLanguage(language) ? language : '';
                const highlighted = this.options.highlight(code, validLanguage);
                return `<pre data-language="${validLanguage || 'plaintext'}"><code>${highlighted}</code></pre>`;
            },
            listitem(text) {
                // 保持列表项的原始格式
                return `<li>${text}</li>\n`;
            }
        })
    });

    text = text.replace(/:\s\*\*/g, ':**');
    text = text.replace(/\*\*([^*]+?)\*\*[^\S\n]+/g, '@@$1@@#');
    text = text.replace(/\*\*(?=.*[^\S\n].*\*\*)([^*]+?)\*\*(?!\s)/g, '#%$1%#@');
    text = text.replace(/\*\*(?=.*：.*\*\*)([^*]+?)\*\*(?!\s)/g, '**$1** ');
    text = text.replace(/\@\@(.+?)\@\@#/g, '**$1** ');
    text = text.replace(/\#\%(.+?)\%\#\@/g, '**$1** ');
    text = text.replace(/ *\*\*([^\s]+?)\*\*(?!\s)/g, ' **$1** ');
    text = text.replace(/(\*\*.+?\*\*)\s：/g, '$1：');
    text = text.replace(/(\*\*.+?\*\*)\s，/g, '$1，');
    text = text.replace(/(\*\*.+?\*\*)\s,/g, '$1,');
    text = text.replace(/(\*\*.+?\*\*)\s\./g, '$1.');
    text = text.replace(/(\*\*.+?\*\*)\s。/g, '$1。');
    // console.log(text);
/*
完整复述下面的字符包括换行：
为 **Xmodel-2** 的针对**推理任务**进行
**第一封邮件（7月22日）**是
即 **a** ⊗ **b** ≠ **b** ⊗ **a**。
**1. 主要贡献:**
**2. A 和 B 矩阵的生成**
*   **开源:** Xmodel-2 是开源的
*   **OLMo 2-13B**：上下文长度为 **4096 个 token**。
*/

    // // 处理第一级列表（确保使用3个空格）
    // text = text.replace(/^ {3,4}\*\s+/mg, '    * ');

    // // 处理列表缩进，保持层级关系但使用4个空格
    // text = text.replace(/^( {4,})\*(\s+)/mg, (match, spaces, trailing) => {
    //     // 找出所有列表项的最小缩进空格数
    //     const minIndent = Math.min(...text.match(/^( *)\*/mg).map(s => s.length - 1));
    //     // 计算当前项相对于最小缩进的层级（每4个空格算一级）
    //     const relativeLevel = Math.floor((spaces.length - minIndent) / 4);
    //     // 根据最小缩进确定最大允许层级
    //     const maxLevel = minIndent === 0 ? 2 : (minIndent === 4 ? 3 : 4);
    //     // 限制最终层级
    //     const level = Math.min(relativeLevel, maxLevel - Math.floor(minIndent / 4));
    //     // 为每一级添加4个空格
    //     return '    '.repeat(level) + '* ';
    // });

    // console.log(text);

    // 渲染 Markdown
    let html = marked.parse(text);

    // 恢复数学公式
    html = html.replace(/%%MATH_EXPRESSION_(\d+)%%/g, (_, index) => {
        return mathExpressions[index];
    });

    // 移除数学公式容器外的 p 标签
    html = html.replace(/<p>\s*(<div class="math-display-container">[\s\S]*?<\/div>)\s*<\/p>/g, '$1');

    // 在下一个微任务中渲染 Mermaid 图表
    setTimeout(() => {
        if (window.renderMermaidDiagrams) {
            window.renderMermaidDiagrams();
        }
    }, 0);

    return html;
}

// 渲染数学公式的函数
export function renderMathInElement(element) {
    return new Promise((resolve, reject) => {
        const checkMathJax = () => {
            if (window.MathJax && window.MathJax.typesetPromise) {
                MathJax.typesetPromise([element])
                    .then(() => {
                        resolve();
                    })
                    .catch((err) => {
                        console.error('MathJax 渲染错误:', err);
                        console.error('错误堆栈:', err.stack);
                        reject(err);
                    });
            } else {
                console.log('等待 MathJax 加载...');
                setTimeout(checkMathJax, 100); // 每100ms检查一次
            }
        };
        checkMathJax();
    });
}