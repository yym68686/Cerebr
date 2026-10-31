import { modelsUrl } from '../../utils/api-url.js';

// Discovery is optional. Providers without this endpoint still support manual names.
export async function fetchModelNames(config, signal) {
    try {
        const response = await fetch(modelsUrl(config.baseUrl), {
            headers: { Authorization: `Bearer ${config.apiKey.trim()}` },
            signal,
        });
        if (!response.ok) return [];
        const body = await response.json();
        if (!Array.isArray(body?.data)) return [];
        return [
            ...new Set(
                body.data.flatMap((model) =>
                    typeof model?.id === 'string' && model.id.trim() ? [model.id.trim()] : []
                )
            ),
        ];
    } catch {
        return [];
    }
}
