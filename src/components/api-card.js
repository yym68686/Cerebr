/**
 * API卡片配置接口
 * @typedef {Object} APIConfig
 * @property {string} apiKey - API密钥
 * @property {string} baseUrl - API的基础URL
 * @property {string} modelName - 模型名称
 * @property {Object} advancedSettings - 高级设置
 * @property {string} advancedSettings.systemPrompt - 系统提示
 * @property {boolean} advancedSettings.isExpanded - 高级设置是否展开
 */

/**
 * 渲染 API 卡片
 * @param {Object} params - 渲染参数
 * @param {Array<APIConfig>} params.apiConfigs - API配置列表
 * @param {HTMLElement} params.apiCardsContainer - 卡片容器元素
 * @param {HTMLElement} params.templateCard - 模板卡片元素
 * @param {function} params.onCardCreate - 卡片创建回调函数
 * @param {function} params.onCardSelect - 卡片选择回调函数
 * @param {function} params.onCardDuplicate - 卡片复制回调函数
 * @param {function} params.onCardDelete - 卡片删除回调函数
 * @param {function} params.onCardChange - 卡片内容变更回调函数
 * @param {number} params.selectedIndex - 当前选中的卡片索引
 */
export function renderAPICards({
    apiConfigs,
    apiCardsContainer,
    templateCard,
    onCardCreate,
    onCardSelect,
    onCardDuplicate,
    onCardDelete,
    onCardChange,
    selectedIndex
}) {
    if (!templateCard) {
        console.error('找不到模板卡片元素');
        return;
    }

    // 保存模板的副本
    const templateClone = templateCard.cloneNode(true);

    // 清空现有卡片
    apiCardsContainer.innerHTML = '';

    // 先重新添加模板（保持隐藏状态）
    apiCardsContainer.appendChild(templateClone);

    // 移除所有卡片的选中状态
    document.querySelectorAll('.api-card').forEach(card => {
        card.classList.remove('selected');
    });

    // 渲染实际的卡片
    apiConfigs.forEach((config, index) => {
        const card = createAPICard({
            config,
            index,
            templateCard: templateClone,
            onSelect: onCardSelect,
            onDuplicate: onCardDuplicate,
            onDelete: onCardDelete,
            onChange: onCardChange,
            isSelected: index === selectedIndex
        });
        apiCardsContainer.appendChild(card);
        if (onCardCreate) {
            onCardCreate(card, index);
        }
    });
}

/**
 * 创建单个 API 卡片
 * @param {Object} params - 创建参数
 * @param {APIConfig} params.config - API配置
 * @param {number} params.index - 卡片索引
 * @param {HTMLElement} params.templateCard - 模板卡片元素
 * @param {function} params.onSelect - 选择回调
 * @param {function} params.onDuplicate - 复制回调
 * @param {function} params.onDelete - 删除回调
 * @param {function} params.onChange - 变更回调
 * @param {boolean} params.isSelected - 是否选中
 * @returns {HTMLElement} 创建的卡片元素
 */
function createAPICard({
    config,
    index,
    templateCard,
    onSelect,
    onDuplicate,
    onDelete,
    onChange,
    isSelected
}) {
    // 克隆模板
    const template = templateCard.cloneNode(true);
    template.classList.remove('template');
    template.style.display = '';
    template.setAttribute('tabindex', '0');

    // 设置选中状态
    if (isSelected) {
        template.classList.add('selected');
    } else {
        template.classList.remove('selected');
    }

    const apiKeyInput = template.querySelector('.api-key');
    const baseUrlInput = template.querySelector('.base-url');
    const modelNameInput = template.querySelector('.model-name');
    const modelListDropdown = template.querySelector('.model-list-dropdown');
    const refreshModelsBtn = template.querySelector('.refresh-models-btn');
    const systemPromptInput = template.querySelector('.system-prompt');
    const advancedSettingsHeader = template.querySelector('.advanced-settings-header');
    const advancedSettingsContent = template.querySelector('.advanced-settings-content');
    const toggleIcon = template.querySelector('.toggle-icon');

    // 模型列表缓存
    let modelCache = {};
    let highlightedIndex = -1;

    // 设置初始值
    apiKeyInput.value = config.apiKey || '';
    baseUrlInput.value = config.baseUrl || 'https://api.openai.com/v1/chat/completions';
    modelNameInput.value = config.modelName || 'gpt-4o';

    // 设置系统提示的默认值
    systemPromptInput.value = config.advancedSettings?.systemPrompt || '';

    // 设置高级设置的展开/折叠状态
    const isExpanded = config.advancedSettings?.isExpanded || false;
    advancedSettingsContent.style.display = isExpanded ? 'block' : 'none';
    toggleIcon.style.transform = isExpanded ? 'rotate(180deg)' : '';

    // 添加高级设置的展开/折叠功能
    advancedSettingsHeader.addEventListener('click', (e) => {
        e.stopPropagation();
        const isCurrentlyExpanded = advancedSettingsContent.style.display === 'block';
        advancedSettingsContent.style.display = isCurrentlyExpanded ? 'none' : 'block';
        toggleIcon.style.transform = isCurrentlyExpanded ? '' : 'rotate(180deg)';

        // 更新配置
        onChange(index, {
            ...config,
            advancedSettings: {
                ...config.advancedSettings,
                isExpanded: !isCurrentlyExpanded
            }
        });
    });

    // 监听系统提示的变化
    systemPromptInput.addEventListener('change', () => {
        onChange(index, {
            ...config,
            advancedSettings: {
                ...config.advancedSettings,
                systemPrompt: systemPromptInput.value
            }
        });
    });

    // 阻止输入框和按钮点击事件冒泡
    const stopPropagation = (e) => {
        e.stopPropagation();
        e.preventDefault();
    };

    // 为输入框添加点击事件阻止冒泡
    [apiKeyInput, baseUrlInput, modelNameInput, systemPromptInput].forEach(input => {
        input.addEventListener('click', stopPropagation);
        input.addEventListener('focus', stopPropagation);
    });

    // 获取模型列表
    async function fetchModels(force = false) {
        const apiKey = apiKeyInput.value;
        const baseUrl = baseUrlInput.value.replace(/\/chat\/completions$/, '');
        const cacheKey = `${baseUrl}:${apiKey}`;

        if (!apiKey || !baseUrl) {
            modelListDropdown.innerHTML = '<div class="model-list-item">请输入API Key和Base URL</div>';
            modelListDropdown.classList.add('visible');
            return;
        }

        if (!force && modelCache[cacheKey]) {
            renderModelList(modelCache[cacheKey]);
            return;
        }

        modelListDropdown.innerHTML = '<div class="model-list-item">加载中...</div>';
        modelListDropdown.classList.add('visible');

        try {
            const response = await fetch(`${baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                }
            });

            if (!response.ok) {
                throw new Error('无法获取模型列表');
            }

            const data = await response.json();
            const models = data.data.map(model => model.id);
            modelCache[cacheKey] = models;
            renderModelList(models);
        } catch (error) {
            console.error(error);
            modelListDropdown.innerHTML = `<div class="model-list-item">${error.message}</div>`;
        }
    }

    function renderModelList(models) {
        modelListDropdown.innerHTML = '';
        if (models.length === 0) {
            modelListDropdown.classList.remove('visible');
            return;
        }
        models.forEach((model, idx) => {
            const item = document.createElement('div');
            item.className = 'model-list-item';
            item.textContent = model;
            item.dataset.index = idx;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                modelNameInput.value = model;
                modelListDropdown.classList.remove('visible');
                onChange(index, { ...config, modelName: model });
            });
            modelListDropdown.appendChild(item);
        });
        modelListDropdown.classList.add('visible');
        highlightedIndex = -1; // Reset highlight when list is re-rendered
    }

    function updateHighlight() {
        const items = modelListDropdown.querySelectorAll('.model-list-item');
        items.forEach((item, idx) => {
            if (idx === highlightedIndex) {
                item.classList.add('highlighted');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('highlighted');
            }
        });
    }

    modelNameInput.addEventListener('focus', () => {
        fetchModels();
        highlightedIndex = -1;
    });

    modelNameInput.addEventListener('input', () => {
        const searchTerm = modelNameInput.value.toLowerCase();
        const cacheKey = `${baseUrlInput.value.replace(/\/chat\/completions$/, '')}:${apiKeyInput.value}`;
        if (modelCache[cacheKey]) {
            const filteredModels = modelCache[cacheKey].filter(model => model.toLowerCase().includes(searchTerm));
            renderModelList(filteredModels);
        }
    });
    refreshModelsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        fetchModels(true);
    });

    document.addEventListener('click', (e) => {
        if (!template.contains(e.target)) {
            modelListDropdown.classList.remove('visible');
        }
    });

    // 添加输入法状态跟踪
    let isComposing = false;

    // 监听输入法开始
    [apiKeyInput, baseUrlInput, modelNameInput, systemPromptInput].forEach(input => {
        input.addEventListener('compositionstart', () => {
            isComposing = true;
        });

        // 监听输入法结束
        input.addEventListener('compositionend', () => {
            isComposing = false;
        });

        // 修改键盘事件处理
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                if (isComposing) {
                    // 如果正在使用输入法，不触发选择
                    return;
                }
                e.preventDefault();
                onSelect(template, index);
            }
        });
    });

    modelNameInput.addEventListener('keydown', (e) => {
        if (!modelListDropdown.classList.contains('visible')) return;

        const items = modelListDropdown.querySelectorAll('.model-list-item');
        if (items.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                highlightedIndex = (highlightedIndex + 1) % items.length;
                updateHighlight();
                break;
            case 'ArrowUp':
                e.preventDefault();
                highlightedIndex = (highlightedIndex - 1 + items.length) % items.length;
                updateHighlight();
                break;
            case 'Enter':
                e.preventDefault();
                e.stopPropagation();
                if (highlightedIndex > -1) {
                    items[highlightedIndex].click();
                }
                break;
            case 'Escape':
                e.preventDefault();
                modelListDropdown.classList.remove('visible');
                break;
        }
    });

    // 为按钮添加点击事件阻止冒泡
    template.querySelectorAll('.card-button').forEach(button => {
        button.addEventListener('click', stopPropagation);
    });

    // 添加回车键选择功能
    template.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !isComposing) {
            e.preventDefault();
            onSelect(template, index);
        }
    });

    // 监听输入框变化
    [apiKeyInput, baseUrlInput, modelNameInput].forEach(input => {
        input.addEventListener('change', () => {
            onChange(index, {
                apiKey: apiKeyInput.value,
                baseUrl: baseUrlInput.value,
                modelName: modelNameInput.value
            });
        });
    });

    // 复制配置
    template.querySelector('.duplicate-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        onDuplicate(config, index);
    });

    // 删除配置
    template.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        onDelete(index);
    });

    // 选择配置
    template.addEventListener('click', (e) => {
        // 如果点击的是输入框或按钮，不触发选择
        if (e.target.matches('input') || e.target.matches('.card-button') || e.target.closest('.card-button')) {
            return;
        }
        onSelect(template, index);
    });

    return template;
}

/**
 * 创建API卡片回调处理函数
 * @param {Object} params - 参数对象
 * @param {function} params.selectCard - 选择卡片的函数
 * @param {Array<APIConfig>} params.apiConfigs - API配置列表
 * @param {number} params.selectedConfigIndex - 当前选中的配置索引
 * @param {function} params.saveAPIConfigs - 保存API配置的函数
 * @param {function} params.renderAPICardsWithCallbacks - 重新渲染卡片的函数
 * @param {function} params.updatePlaceholder - 更新 placeholder 的函数
 * @returns {Object} 回调函数对象
 */
export function createCardCallbacks({
    selectCard,
    apiConfigs,
    selectedConfigIndex,
    saveAPIConfigs,
    renderAPICardsWithCallbacks,
    updatePlaceholder
}) {
    return {
        onCardSelect: selectCard,
        onCardDuplicate: (config, index) => {
            // 在当前选中卡片后面插入新卡片
            apiConfigs.splice(index + 1, 0, {...config});
            // 保存配置但不改变选中状态
            saveAPIConfigs();
            // 重新渲染所有卡片，保持原来的选中状态
            renderAPICardsWithCallbacks();
        },
        onCardDelete: (index) => {
            if (apiConfigs.length > 1) {
                apiConfigs.splice(index, 1);
                if (selectedConfigIndex >= apiConfigs.length) {
                    selectedConfigIndex = apiConfigs.length - 1;
                }
                saveAPIConfigs();
                renderAPICardsWithCallbacks();
                updatePlaceholder();
            }
        },
        onCardChange: (index, newConfig) => {
            apiConfigs[index] = newConfig;
            saveAPIConfigs();
            if (index === selectedConfigIndex) {
                updatePlaceholder();
            }
        }
    };
}

/**
 * 选择API卡片的函数
 * @param {Object} params - 参数对象
 * @param {Object} params.template - 模板对象
 * @param {number} params.index - 选中的索引
 * @param {function} params.onIndexChange - 索引变更回调函数
 * @param {function} params.onSave - 保存配置的回调函数
 * @param {string} params.cardSelector - 卡片元素的CSS选择器
 * @param {function} params.onSelect - 选中后的回调函数
 * @returns {void}
 */
export function selectCard({
    template,
    index,
    onIndexChange,
    onSave,
    cardSelector = '.api-card',
    onSelect
}) {
    // 更新选中索引
    onIndexChange(index);

    // 保存配置
    onSave();

    // 更新UI状态
    document.querySelectorAll(cardSelector).forEach(card => {
        card.classList.remove('selected');
    });

    // 选中当前卡片
    const selectedCard = document.querySelectorAll(cardSelector)[index];
    if (selectedCard) {
        selectedCard.classList.add('selected');
    }

    // 执行选中后的回调
    if (onSelect) {
        onSelect(selectedCard, index);
    }

    return selectedCard;
}