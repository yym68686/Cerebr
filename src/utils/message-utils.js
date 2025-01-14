/**
 * 处理消息内容，将图片标签进行特殊处理
 * @param {Object} msg - 消息对象
 * @param {Function} processImageTagsFn - 处理图片标签的函数
 * @returns {Object} - 处理后的消息对象
 */
export function processMessageContent(msg, processImageTagsFn) {
    if (typeof msg.content === 'string' && msg.content.includes('image-tag')) {
        return {
            ...msg,
            content: processImageTagsFn(msg.content)
        };
    }
    return msg;
}