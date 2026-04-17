export function createHostServiceRegistry({
    services = {},
} = {}) {
    const serviceEntries = Object.entries(services)
        .filter(([serviceName, definition]) => {
            return !!serviceName && definition && typeof definition === 'object';
        });

    const createPluginApi = (entry = {}) => {
        const api = {};

        serviceEntries.forEach(([serviceName, definition]) => {
            if (typeof definition.createApi !== 'function') {
                return;
            }

            const serviceApi = definition.createApi(entry, {
                api,
            });

            if (typeof serviceApi !== 'undefined') {
                api[serviceName] = serviceApi;
            }
        });

        return api;
    };

    const createHookContext = (entry = {}, baseContext = {}, options = {}) => {
        const api = options.api && typeof options.api === 'object'
            ? options.api
            : createPluginApi(entry);
        const context = {
            ...baseContext,
        };

        serviceEntries.forEach(([serviceName, definition]) => {
            if (typeof definition.createContext === 'function') {
                const contextValue = definition.createContext(entry, {
                    api,
                    context,
                    baseContext,
                });
                if (typeof contextValue !== 'undefined') {
                    context[serviceName] = contextValue;
                }
                return;
            }

            if (Object.prototype.hasOwnProperty.call(api, serviceName)) {
                context[serviceName] = api[serviceName];
            }
        });

        return {
            api,
            context,
        };
    };

    return {
        createPluginApi,
        createHookContext,
        getServiceNames() {
            return serviceEntries.map(([serviceName]) => serviceName);
        },
    };
}
