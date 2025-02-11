// 初始化 Mermaid
window.addEventListener('DOMContentLoaded', () => {
    // 定义自定义主题
    const darkTheme = {
        dark: {
            background: 'transparent',
            primaryColor: '#fff',
            primaryTextColor: '#fff',
            primaryBorderColor: '#7C7C7C',
            lineColor: '#7C7C7C',
            secondaryColor: '#2A2A2A',
            tertiaryColor: '#2A2A2A',
            textColor: '#fff',
            mainBkg: '#1E1E1E',
            nodeBorder: '#7C7C7C',
            edgeLabelBackground: '#1E1E1E',
        }
    };

    const lightTheme = {
        default: {
            background: 'transparent',
            primaryColor: '#000',
            primaryTextColor: '#000',
            primaryBorderColor: '#CCCCCC',
            lineColor: '#CCCCCC',
            secondaryColor: '#F5F5F5',
            tertiaryColor: '#F5F5F5',
            textColor: '#000',
            mainBkg: '#FFFFFF',
            nodeBorder: '#CCCCCC',
            edgeLabelBackground: '#FFFFFF',
        }
    };

    window.mermaid.initialize({
        startOnLoad: false,
        theme: document.documentElement.classList.contains('dark-theme') ? 'dark' : 'default',
        themeVariables: document.documentElement.classList.contains('dark-theme') ? darkTheme.dark : lightTheme.default,
        securityLevel: 'loose',
        maxTextSize: 90000, // 增加最大文本大小限制
        flowchart: {
            useMaxWidth: false, // 改为 false 以允许自由缩放
            htmlLabels: true,
            curve: 'basis',
            padding: 20,
            nodeSpacing: 50,
            rankSpacing: 50,
        },
        er: {
            useMaxWidth: false
        },
        sequence: {
            useMaxWidth: false
        },
        gantt: {
            useMaxWidth: false
        }
    });
});

// 添加全局渲染函数
window.renderMermaidDiagrams = async () => {
    // 获取所有未渲染的 mermaid 图表
    const mermaidDivs = document.querySelectorAll('div.mermaid:not([data-processed])');
    if (mermaidDivs.length > 0) {
        try {
            await window.mermaid.run({
                nodes: Array.from(mermaidDivs),
                suppressErrors: true
            });

            // 为每个图表添加缩放功能
            mermaidDivs.forEach(div => {
                if (div.hasAttribute('data-processed')) {
                    // 创建一个容器来限制图表的显示区域
                    const container = document.createElement('div');
                    container.style.cssText = `
                        width: 100%;
                        height: 400px;
                        overflow: hidden;
                        position: relative;
                        border: 1px solid var(--cerebr-border-color);
                        border-radius: 8px;
                        background: var(--cerebr-bg-color);
                        margin: 10px 0;
                    `;

                    // 创建一个内部容器来处理滚动
                    const scrollContainer = document.createElement('div');
                    scrollContainer.style.cssText = `
                        width: 100%;
                        height: 100%;
                        overflow: auto;
                        position: relative;
                    `;

                    // 移动原有内容到新容器中
                    const svg = div.querySelector('svg');
                    if (svg) {
                        // 设置 SVG 样式
                        svg.style.cursor = 'grab';
                        svg.style.maxWidth = 'none';
                        svg.style.margin = '10px auto';

                        // 将原有内容包装到新容器中
                        div.parentNode.insertBefore(container, div);
                        container.appendChild(scrollContainer);
                        scrollContainer.appendChild(div);

                        // 添加缩放和平移功能
                        let isPanning = false;
                        let startPoint = { x: 0, y: 0 };
                        let currentScale = 1;
                        let currentTranslate = { x: 0, y: 0 };

                        // 鼠标滚轮缩放
                        scrollContainer.addEventListener('wheel', (e) => {
                            if (e.ctrlKey || e.metaKey) { // 仅在按住 Ctrl/Cmd 键时进行缩放
                                e.preventDefault();
                                const delta = e.deltaY;
                                const scaleChange = delta > 0 ? 0.9 : 1.1;
                                currentScale *= scaleChange;

                                // 限制缩放范围
                                currentScale = Math.min(Math.max(0.5, currentScale), 2);

                                updateTransform(svg);
                            }
                        });

                        // 鼠标拖动平移
                        svg.addEventListener('mousedown', (e) => {
                            if (e.button === 0) { // 仅响应左键
                                isPanning = true;
                                svg.style.cursor = 'grabbing';
                                startPoint = {
                                    x: e.clientX - currentTranslate.x,
                                    y: e.clientY - currentTranslate.y
                                };
                            }
                        });

                        scrollContainer.addEventListener('mousemove', (e) => {
                            if (!isPanning) return;
                            currentTranslate = {
                                x: e.clientX - startPoint.x,
                                y: e.clientY - startPoint.y
                            };
                            updateTransform(svg);
                        });

                        scrollContainer.addEventListener('mouseup', () => {
                            isPanning = false;
                            svg.style.cursor = 'grab';
                        });

                        scrollContainer.addEventListener('mouseleave', () => {
                            isPanning = false;
                            svg.style.cursor = 'grab';
                        });

                        function updateTransform(element) {
                            element.style.transform = `translate(${currentTranslate.x}px, ${currentTranslate.y}px) scale(${currentScale})`;
                        }

                        // 双击重置
                        svg.addEventListener('dblclick', () => {
                            currentScale = 1;
                            currentTranslate = { x: 0, y: 0 };
                            updateTransform(svg);
                        });

                        // 添加缩放提示
                        const hint = document.createElement('div');
                        hint.style.cssText = `
                            position: absolute;
                            bottom: 10px;
                            right: 10px;
                            background: rgba(0, 0, 0, 0.6);
                            color: white;
                            padding: 5px 10px;
                            border-radius: 4px;
                            font-size: 12px;
                            pointer-events: none;
                            opacity: 0;
                            transition: opacity 0.3s;
                        `;
                        hint.textContent = '按住 Ctrl/Cmd + 滚轮缩放';
                        container.appendChild(hint);

                        // 显示/隐藏提示
                        scrollContainer.addEventListener('mouseenter', () => {
                            hint.style.opacity = '1';
                        });
                        scrollContainer.addEventListener('mouseleave', () => {
                            hint.style.opacity = '0';
                        });
                    }
                }
            });
        } catch (error) {
            console.error('Mermaid 渲染错误:', error);
            // 在图表位置显示错误信息
            mermaidDivs.forEach(div => {
                if (!div.hasAttribute('data-processed')) {
                    div.innerHTML = `<pre style="color: red;">图表语法错误：
1. 节点标识符必须使用英文字母（如：A、B、C）
2. 节点文本中的特殊字符处理：
   - 括号()需要改用方括号[]或去掉
   - 逗号建议改用中文逗号，
   - 避免使用其他特殊符号
3. 图表支持以下操作：
   - Ctrl/Cmd + 滚轮：放大/缩小
   - 拖动：平移画布
   - 双击：重置大小和位置
例如：
A[系统名称] --> B[功能1] --> C[详细说明]
或
A[RAG系统] --> B1[混合搜索] --> B2[日志调优]</pre>`;
                    div.setAttribute('data-processed', 'true');
                }
            });
        }
    }
};