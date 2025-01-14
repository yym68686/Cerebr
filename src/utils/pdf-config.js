import * as pdfjsLib from '../../lib/pdf.js';

// 检测是否在Chrome扩展环境中
const isExtensionEnvironment = typeof chrome !== 'undefined' && chrome.runtime;

// 配置PDF.js worker
if (isExtensionEnvironment) {
    // 在扩展环境中使用扩展URL
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.js');
} else {
    // 在web环境中使用相对路径
    pdfjsLib.GlobalWorkerOptions.workerSrc = '../../lib/pdf.worker.js';
}

// PDF文本提取函数
export async function extractTextFromPDF(url) {
    try {
        console.log('开始处理PDF文件:', url);

        // 加载PDF文件
        const loadingTask = pdfjsLib.getDocument(url);
        const pdf = await loadingTask.promise;

        console.log('PDF加载成功，页数:', pdf.numPages);

        // 提取所有页面的文本
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');
            fullText += pageText + '\\n';
        }

        return fullText.trim();
    } catch (error) {
        console.error('PDF处理过程中出错:', error);
        console.error('错误堆栈:', error.stack);
        throw error;
    }
}