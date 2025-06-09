import { storageAdapter } from '../utils/storage-adapter.js';

const SUMMARY_PROMPT = `### Task:
Generate a concise, 3-5 word title start with an emoji summarizing the chat history.
### Guidelines:
- The title should clearly represent the main theme or subject of the conversation.
- Use emojis that enhance understanding of the topic, but avoid quotation marks or special formatting.
- Write the title in the chat's primary language; default to English if multilingual.
- Prioritize accuracy over excessive creativity; keep it clear and simple.
### Output:
JSON format: { "title": "your concise title here" }
### Examples:
- { "title": "📉 Stock Market Trends" },
- { "title": "🍪 Perfect Chocolate Chip Recipe" },
- { "title": "🎵Evolution of Music Streaming" },
- { "title": "🤖Artificial Intelligence in Healthcare" },
- { "title": "🎮 Video Game Development Insights" }
### Chat History:
<chat_history>
{{MESSAGES:END:2}}
</chat_history>
`;

async function callNonStreamingAPI({ messages, apiConfig }) {
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
            model: apiConfig.modelName || "gpt-4o",
            messages: messages,
            stream: false,
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(error);
    }

    const data = await response.json();
    return data.choices[0].message;
}

export async function generateTitleForChat(messages, apiConfig) {
    try {
        if (!apiConfig) {
            console.log("无法生成标题：API配置未提供");
            return null;
        }

        const history = messages.slice(0, 2).map(msg => {
            if (typeof msg.content === 'string') {
                return `${msg.role}: ${msg.content}`;
            } else if (Array.isArray(msg.content)) {
                const textContent = msg.content.find(item => item.type === 'text');
                return `${msg.role}: ${textContent ? textContent.text : ''}`;
            }
            return '';
        }).join('\n');

        const prompt = SUMMARY_PROMPT.replace('{{MESSAGES:END:2}}', history);

        const response = await callNonStreamingAPI({
            messages: [{ role: 'user', content: prompt }],
            apiConfig: apiConfig
        });

        const result = JSON.parse(response.content);
        return result.title || null;
    } catch (error) {
        console.error('生成标题失败:', error);
        return null;
    }
}