/**
 * 标签页相关性判断服务
 * 使用大模型判断哪些标签页与当前页面最相关
 */

import { callAPI } from './chat.js';

/**
 * 发送聊天请求（简化版，用于相关性分析）
 * @param {Object} params - 请求参数
 * @returns {Promise<Object>} 响应结果
 */
async function sendChatRequest({ messages, apiConfig, userLanguage, webpageInfo }) {
    try {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey) {
            throw new Error('API 配置不完整');
        }

        const response = await fetch(apiConfig.baseUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiConfig.apiKey}`
            },
            body: JSON.stringify({
                model: apiConfig.modelName || 'gpt-4o',
                messages: messages,
                temperature: 0.1, // 低温度确保结果稳定
                max_tokens: 1000
            })
        });

        if (!response.ok) {
            throw new Error(`API请求失败: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        if (data.choices && data.choices[0] && data.choices[0].message) {
            return {
                content: data.choices[0].message.content
            };
        } else {
            throw new Error('API响应格式不正确');
        }
    } catch (error) {
        console.error('发送聊天请求失败:', error);
        throw error;
    }
}

// 相关性分析结果缓存
const relevanceCache = new Map();
const CACHE_EXPIRY_TIME = 5 * 60 * 1000; // 5分钟缓存

/**
 * 生成缓存键
 * @param {string} currentTitle - 当前页面标题
 * @param {Array} tabTitles - 其他标签页标题数组
 * @returns {string} 缓存键
 */
function generateCacheKey(currentTitle, tabTitles) {
    const sortedTitles = [...tabTitles].sort();
    return `${currentTitle}|${sortedTitles.join('|')}`;
}

/**
 * 获取缓存的相关性分析结果
 * @param {string} cacheKey - 缓存键
 * @returns {Array|null} 缓存的结果或null
 */
function getCachedResult(cacheKey) {
    const cached = relevanceCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY_TIME) {
        console.log('使用缓存的相关性分析结果');
        return cached.result;
    }
    if (cached) {
        relevanceCache.delete(cacheKey);
    }
    return null;
}

/**
 * 缓存相关性分析结果
 * @param {string} cacheKey - 缓存键
 * @param {Array} result - 分析结果
 */
function setCachedResult(cacheKey, result) {
    relevanceCache.set(cacheKey, {
        result,
        timestamp: Date.now()
    });

    // 清理过期缓存
    for (const [key, value] of relevanceCache.entries()) {
        if (Date.now() - value.timestamp >= CACHE_EXPIRY_TIME) {
            relevanceCache.delete(key);
        }
    }
}

/**
 * 使用大模型判断标签页相关性
 * @param {string} currentPageTitle - 当前页面标题
 * @param {Array} allTabs - 所有标签页信息数组
 * @param {Object} apiConfig - API配置
 * @returns {Promise<Array>} 相关标签页ID数组
 */
export async function analyzeTabRelevance(currentPageTitle, allTabs, apiConfig) {
    try {
        // 过滤掉当前页面本身
        const otherTabs = allTabs.filter(tab => !tab.active);

        if (otherTabs.length === 0) {
            return [];
        }

        // 检查缓存
        const tabTitles = otherTabs.map(tab => tab.title);
        const cacheKey = generateCacheKey(currentPageTitle, tabTitles);
        const cachedResult = getCachedResult(cacheKey);
        if (cachedResult) {
            return cachedResult;
        }

        // 构建标签页信息字符串
        const tabsInfo = otherTabs.map((tab, index) => 
            `${index + 1}. ID: ${tab.id}, 标题: "${tab.title}", 域名: ${tab.hostname}`
        ).join('\n');

        // 构建提示词
        const systemPrompt = `你是一个网页内容相关性分析专家。你的任务是分析给定的当前网页标题与其他标签页标题的相关性，找出与当前网页内容最相关的标签页。

请根据以下标准判断相关性：
1. 主题相关性：是否讨论相同或相关的主题、概念、产品或服务
2. 内容类型相关性：是否属于同一类型的内容（如新闻、教程、文档、购物等）
3. 上下文相关性：是否可能是用户在同一个任务或研究过程中打开的页面
4. 领域相关性：是否属于同一个专业领域或行业

请严格按照以下JSON格式返回结果，不要包含任何其他文本：
{
  "relevant_tabs": [
    {
      "id": 标签页ID,
      "relevance_score": 相关性评分(0-1之间的数字),
      "reason": "相关性原因简述"
    }
  ]
}

只返回相关性评分大于0.3的标签页，最多返回5个最相关的标签页。如果没有相关的标签页，返回空数组。`;

        const userPrompt = `当前网页标题：${currentPageTitle}

其他标签页信息：
${tabsInfo}

请分析并返回与当前网页最相关的标签页。`;

        // 构建消息
        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ];

        // 调用大模型
        const response = await sendChatRequest({
            messages,
            apiConfig,
            userLanguage: 'zh-CN',
            webpageInfo: null
        });

        // 解析响应
        if (response && response.content) {
            try {
                // 提取JSON内容
                let jsonStr = response.content.trim();
                
                // 如果响应包含代码块，提取其中的JSON
                const jsonMatch = jsonStr.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
                if (jsonMatch) {
                    jsonStr = jsonMatch[1];
                } else if (jsonStr.includes('{') && jsonStr.includes('}')) {
                    // 提取第一个完整的JSON对象
                    const startIndex = jsonStr.indexOf('{');
                    const endIndex = jsonStr.lastIndexOf('}') + 1;
                    jsonStr = jsonStr.substring(startIndex, endIndex);
                }

                const result = JSON.parse(jsonStr);
                
                if (result.relevant_tabs && Array.isArray(result.relevant_tabs)) {
                    // 验证并过滤结果
                    const validTabs = result.relevant_tabs
                        .filter(tab => 
                            tab.id && 
                            typeof tab.relevance_score === 'number' && 
                            tab.relevance_score > 0.3 &&
                            tab.relevance_score <= 1.0
                        )
                        .sort((a, b) => b.relevance_score - a.relevance_score) // 按相关性评分降序排列
                        .slice(0, 5); // 最多5个

                    console.log('标签页相关性分析结果:', validTabs);

                    // 缓存结果
                    setCachedResult(cacheKey, validTabs);

                    return validTabs;
                }
            } catch (parseError) {
                console.error('解析相关性分析结果失败:', parseError);
                console.log('原始响应:', response.content);
            }
        }

        return [];
    } catch (error) {
        console.error('标签页相关性分析失败:', error);
        return [];
    }
}

/**
 * 获取相关标签页的内容
 * @param {Array} relevantTabIds - 相关标签页ID数组
 * @param {Function} getPageContentFn - 获取页面内容的函数
 * @returns {Promise<Array>} 相关标签页内容数组
 */
export async function getRelevantTabsContent(relevantTabIds, getPageContentFn) {
    const contents = [];
    
    for (const tabInfo of relevantTabIds) {
        try {
            console.log(`获取标签页 ${tabInfo.id} 的内容...`);
            const content = await getPageContentFn(true, tabInfo.id); // skipWaitContent = true
            
            if (content && !content.error && content.content) {
                contents.push({
                    tabId: tabInfo.id,
                    title: content.title,
                    url: content.url,
                    content: content.content,
                    relevanceScore: tabInfo.relevance_score,
                    relevanceReason: tabInfo.reason
                });
                console.log(`成功获取标签页 ${tabInfo.id} 的内容，长度: ${content.content.length}`);
            } else {
                console.log(`标签页 ${tabInfo.id} 内容获取失败:`, content?.error || '无内容');
            }
        } catch (error) {
            console.error(`获取标签页 ${tabInfo.id} 内容失败:`, error);
        }
    }
    
    return contents;
}

/**
 * 格式化多页面内容为聊天上下文
 * @param {Object} currentPageContent - 当前页面内容
 * @param {Array} relevantTabsContent - 相关标签页内容数组
 * @returns {Object} 格式化后的网页信息对象
 */
export function formatMultiPageContext(currentPageContent, relevantTabsContent) {
    if (!currentPageContent) {
        return null;
    }

    let contextContent = `主要页面：\n标题：${currentPageContent.title}\nURL：${currentPageContent.url}\n内容：${currentPageContent.content}`;

    if (relevantTabsContent && relevantTabsContent.length > 0) {
        contextContent += '\n\n相关页面：';
        
        relevantTabsContent.forEach((tabContent, index) => {
            contextContent += `\n\n${index + 1}. 标题：${tabContent.title}\nURL：${tabContent.url}\n相关性：${tabContent.relevanceReason}\n内容：${tabContent.content}`;
        });
    }

    return {
        title: `${currentPageContent.title}${relevantTabsContent.length > 0 ? ` (含${relevantTabsContent.length}个相关页面)` : ''}`,
        url: currentPageContent.url,
        content: contextContent
    };
}
