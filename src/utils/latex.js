// 处理数学公式和 Markdown 的函数
export function processMathAndMarkdown(text) {
    const mathExpressions = [];
    let mathIndex = 0;
    text = text.replace(/\\\[([a-zA-Z\d]+)\]/g, '[$1]');

    // 处理 \textsc 命令
    text = text.replace(/\\textsc\{([^}]+)\}/g, (match, content) => {
        return content.toUpperCase();
    });

    text = text.replace(/%\n\s*/g, ''); // 移除换行的百分号
    // 临时替换数学公式
    text = text.replace(/(\\\\\([^]+?\\\\\))|(\\\([^]+?\\\))|(\\\[[\s\S]+?\\\])/g, (match) => {

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
        breaks: false,
        gfm: true,
        sanitize: false,
        highlight: function(code, lang) {
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
    text = text.replace(/\*\*(?=.*[^\S\n].*\*\*)([^*]+?)\*\*(?!\s)/g, '**$1** ');
    text = text.replace(/\*\*(?=.*：.*\*\*)([^*]+?)\*\*(?!\s)/g, '**$1** ');
    text = text.replace(/\@\@(.+?)\@\@#/g, '**$1** ');

    // 处理列表缩进，保持层级关系但使用3个空格
    text = text.replace(/^(\s{4,})\*(\s+)/mg, (match, spaces, trailing) => {
        // 计算缩进层级（每4个空格算一级）
        const level = Math.floor(spaces.length / 4);
        // 为每一级添加3个空格
        return '   '.repeat(level) + '*' + trailing;
    });

    // // 处理第一级列表（确保使用3个空格）
    // text = text.replace(/^(\s{0,2})\*(\s+)/mg, '   *$2');

    // 渲染 Markdown
    let html = marked.parse(text);

    // 恢复数学公式
    html = html.replace(/%%MATH_EXPRESSION_(\d+)%%/g, (_, index) => {
        return mathExpressions[index];
    });

    // 移除数学公式容器外的 p 标签
    html = html.replace(/<p>\s*(<div class="math-display-container">[\s\S]*?<\/div>)\s*<\/p>/g, '$1');

    return html;
}

// 渲染数学公式的函数
export function renderMathInElement(element) {
    if (window.MathJax) {
        MathJax.typesetPromise([element])
            .then(() => {
                console.log('MathJax 渲染成功');
            })
            .catch((err) => {
                console.error('MathJax 渲染错误:', err);
                console.error('错误堆栈:', err.stack);
            });
    } else {
        console.error('MathJax 未加载');
    }
}