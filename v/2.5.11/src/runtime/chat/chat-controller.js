import { createChatPipeline } from './chat-pipeline.js';

export function createChatController(options = {}) {
    return createChatPipeline(options);
}
