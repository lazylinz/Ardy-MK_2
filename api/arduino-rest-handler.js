const fs = require('fs');
const path = require('path');
const axios = require('axios');

function createArduinoService(options = {}) {
    const dataDir = String(options.dataDir || '').trim();
    const onVariableWrite = typeof options.onVariableWrite === 'function' ? options.onVariableWrite : null;
    if (!dataDir) {
        throw new Error('createArduinoService: dataDir is required');
    }

    const arduinoVariableStoreFile = path.join(dataDir, 'arduino-variables.json');
    const cloudConfig = buildCloudConfig();
    const tokenState = { accessToken: '', expiresAtMs: 0 };
    const cloudEnabled = hasCloudConfig(cloudConfig);

    return {
        async getAllVariables({ sessionId }) {
            const sid = String(sessionId || '').trim();
            if (!sid) {
                const err = new Error('sessionId is required');
                err.status = 400;
                throw err;
            }

            if (cloudEnabled) {
                const variables = await getAllVariablesFromCloud(cloudConfig, tokenState);
                persistVariablesToLocalStore(variables, sid, arduinoVariableStoreFile, dataDir);
                console.log(`[Arduino] get-all-variables source=arduino-cloud count=${Object.keys(variables).length}`);
                return {
                    source: 'arduino-cloud',
                    variables,
                    count: Object.keys(variables).length,
                    updatedAt: Date.now()
                };
            }

            const local = getLocalVariables(sid, arduinoVariableStoreFile, dataDir);
            console.log(`[Arduino] get-all-variables source=local count=${Object.keys(local.variables).length}`);
            return {
                source: 'local',
                variables: local.variables,
                count: Object.keys(local.variables).length,
                updatedAt: local.updatedAt
            };
        },

        async readVariable({ sessionId, name }) {
            const sid = String(sessionId || '').trim();
            const variableName = sanitizeArduinoVariableName(name);
            if (!sid) {
                const err = new Error('sessionId is required');
                err.status = 400;
                throw err;
            }
            if (!variableName) {
                const err = new Error('name is required');
                err.status = 400;
                throw err;
            }

            if (cloudEnabled) {
                const entry = await readVariableFromCloud(variableName, cloudConfig, tokenState);
                persistOneVariableToLocalStore(variableName, entry, sid, arduinoVariableStoreFile, dataDir);
                console.log(`[Arduino] read-variable source=arduino-cloud name=${variableName}`);
                return {
                    source: 'arduino-cloud',
                    name: variableName,
                    value: entry.value,
                    updatedAt: entry.updatedAt
                };
            }

            const local = getLocalVariables(sid, arduinoVariableStoreFile, dataDir);
            const entry = local.variables[variableName];
            if (!entry) {
                const err = new Error(`Variable "${variableName}" not found`);
                err.status = 404;
                throw err;
            }
            console.log(`[Arduino] read-variable source=local name=${variableName}`);
            return {
                source: 'local',
                name: variableName,
                value: entry.value,
                updatedAt: entry.updatedAt
            };
        },

        async writeVariable({ sessionId, name, value, sourceMacroId = '', sourceMacroName = '' }) {
            const sid = String(sessionId || '').trim();
            const variableName = sanitizeArduinoVariableName(name);
            const macroId = String(sourceMacroId || '').trim();
            const macroName = String(sourceMacroName || '').trim();
            if (!sid) {
                const err = new Error('sessionId is required');
                err.status = 400;
                throw err;
            }
            if (!variableName) {
                const err = new Error('name is required');
                err.status = 400;
                throw err;
            }
            const nextValue = sanitizeArduinoVariableValue(value);

            if (cloudEnabled) {
                const entry = await writeVariableToCloud(variableName, nextValue, cloudConfig, tokenState);
                persistOneVariableToLocalStore(variableName, entry, sid, arduinoVariableStoreFile, dataDir);
                console.log(`[Arduino] write-variable source=arduino-cloud name=${variableName} sourceMacroId=${macroId || 'n/a'}`);
                if (onVariableWrite) {
                    onVariableWrite({
                        sessionId: sid,
                        variableName,
                        value: entry.value,
                        sourceMacroId: macroId,
                        sourceMacroName: macroName
                    });
                }
                return {
                    source: 'arduino-cloud',
                    ok: true,
                    name: variableName,
                    value: entry.value,
                    updatedAt: entry.updatedAt
                };
            }

            const now = Date.now();
            const localEntry = { value: nextValue, updatedAt: now };
            persistOneVariableToLocalStore(variableName, localEntry, sid, arduinoVariableStoreFile, dataDir);
            console.log(`[Arduino] write-variable source=local name=${variableName} sourceMacroId=${macroId || 'n/a'}`);
            if (onVariableWrite) {
                onVariableWrite({
                    sessionId: sid,
                    variableName,
                    value: localEntry.value,
                    sourceMacroId: macroId,
                    sourceMacroName: macroName
                });
            }
            return {
                source: 'local',
                ok: true,
                name: variableName,
                value: localEntry.value,
                updatedAt: localEntry.updatedAt
            };
        },

        getOsTime({ locale, timezone }) {
            return getOsTimePayload({ locale, timezone });
        }
    };
}

function registerArduinoRestRoutes(app, options = {}) {
    const requireWhitelistedIp = options.requireWhitelistedIp;
    const requireAuth = options.requireAuth;
    const dataDir = String(options.dataDir || '').trim();
    const service = options.service || createArduinoService(options);

    if (!app || typeof app.post !== 'function') {
        throw new Error('registerArduinoRestRoutes: app is required');
    }
    if (typeof requireWhitelistedIp !== 'function' || typeof requireAuth !== 'function') {
        throw new Error('registerArduinoRestRoutes: requireWhitelistedIp and requireAuth are required');
    }
    if (!dataDir) {
        throw new Error('registerArduinoRestRoutes: dataDir is required');
    }
    const resolveSessionId = typeof options.resolveSessionId === 'function'
        ? options.resolveSessionId
        : ((req) => String(req?.authSessionId || req?.session?.userKey || req?.sessionID || '').trim());

    app.post('/api/arduino/get-all-variables', requireWhitelistedIp, requireAuth, async (req, res) => {
        try {
            const payload = await service.getAllVariables({ sessionId: resolveSessionId(req) });
            return res.json(payload);
        } catch (error) {
            return res.status(getHttpStatus(error)).json({ error: { message: formatCloudError(error) } });
        }
    });

    app.post('/api/arduino/read-variable', requireWhitelistedIp, requireAuth, async (req, res) => {
        try {
            const payload = await service.readVariable({ sessionId: resolveSessionId(req), name: req.body?.name });
            return res.json(payload);
        } catch (error) {
            return res.status(getHttpStatus(error)).json({ error: { message: formatCloudError(error) } });
        }
    });

    app.post('/api/arduino/write-variable', requireWhitelistedIp, requireAuth, async (req, res) => {
        try {
            if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'value')) {
                return res.status(400).json({ error: { message: 'value is required' } });
            }
            const payload = await service.writeVariable({
                sessionId: resolveSessionId(req),
                name: req.body?.name,
                value: req.body?.value,
                sourceMacroId: req.body?.sourceMacroId,
                sourceMacroName: req.body?.sourceMacroName
            });
            return res.json(payload);
        } catch (error) {
            return res.status(getHttpStatus(error)).json({ error: { message: formatCloudError(error) } });
        }
    });

    app.post('/api/os/time', requireWhitelistedIp, requireAuth, (req, res) => {
        const payload = service.getOsTime({
            locale: req.body?.locale,
            timezone: req.body?.timezone
        });
        return res.json(payload);
    });

    return service;
}

function getOsTimePayload({ locale, timezone }) {
    const requestedLocale = String(locale || '').trim() || 'en-US';
    const requestedTimezone = String(timezone || '').trim();
    const normalizedTimezone = isValidIanaTimeZone(requestedTimezone) ? requestedTimezone : 'UTC';
    const now = new Date();

    let formatted = now.toISOString();
    try {
        formatted = new Intl.DateTimeFormat(requestedLocale, {
            timeZone: normalizedTimezone,
            dateStyle: 'full',
            timeStyle: 'long'
        }).format(now);
    } catch (error) {
        formatted = now.toISOString();
    }

    return {
        nowIso: now.toISOString(),
        epochMs: now.getTime(),
        epochSec: Math.floor(now.getTime() / 1000),
        locale: requestedLocale,
        timezone: normalizedTimezone,
        formatted
    };
}

function buildCloudConfig() {
    const rawBaseUrl = String(process.env.ARDUINO_CLOUD_API_BASE_URL || 'https://api2.arduino.cc/iot/v2').trim();
    const baseUrl = normalizeCloudBaseUrl(rawBaseUrl);
    let origin = 'https://api2.arduino.cc';
    try {
        origin = new URL(baseUrl).origin;
    } catch (error) {
        origin = 'https://api2.arduino.cc';
    }

    return {
        baseUrl,
        tokenUrl: `${origin}/iot/v1/clients/token`,
        audience: String(process.env.ARDUINO_CLOUD_AUDIENCE || 'https://api2.arduino.cc/iot').trim(),
        clientId: String(process.env.ARDUINO_CLOUD_CLIENT_ID || '').trim(),
        clientSecret: String(process.env.ARDUINO_CLOUD_CLIENT_SECRET || '').trim(),
        thingId: String(process.env.ARDUINO_CLOUD_THING_ID || '').trim()
    };
}

function normalizeCloudBaseUrl(rawBaseUrl) {
    const trimmed = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
    if (!trimmed) return 'https://api2.arduino.cc/iot/v2';
    if (/\/iot\/v2$/i.test(trimmed)) return trimmed;
    if (/\/iot$/i.test(trimmed)) return `${trimmed}/v2`;
    if (/^https?:\/\/[^/]+$/i.test(trimmed)) return `${trimmed}/iot/v2`;
    return trimmed;
}

function hasCloudConfig(cloudConfig) {
    return Boolean(cloudConfig?.baseUrl && cloudConfig?.tokenUrl && cloudConfig?.clientId && cloudConfig?.clientSecret && cloudConfig?.thingId);
}

async function getAllVariablesFromCloud(cloudConfig, tokenState) {
    const properties = await listThingProperties(cloudConfig, tokenState);
    const variables = {};
    properties.forEach((prop) => {
        const name = sanitizeArduinoVariableName(getPropertyName(prop)) || sanitizeArduinoVariableName(String(prop?.id || ''));
        if (!name) return;
        variables[name] = {
            value: sanitizeArduinoVariableValue(getPropertyValue(prop)),
            updatedAt: normalizeUpdatedAt(getPropertyUpdatedAt(prop))
        };
    });
    return variables;
}

async function readVariableFromCloud(name, cloudConfig, tokenState) {
    const property = await getPropertyByName(name, cloudConfig, tokenState);
    const detail = await getThingPropertyDetail(property.id, cloudConfig, tokenState);
    return {
        value: sanitizeArduinoVariableValue(getPropertyValue(detail)),
        updatedAt: normalizeUpdatedAt(getPropertyUpdatedAt(detail))
    };
}

async function writeVariableToCloud(name, value, cloudConfig, tokenState) {
    const property = await getPropertyByName(name, cloudConfig, tokenState);
    const body = { value: sanitizeArduinoVariableValue(value) };

    const published = await requestWithAuth(cloudConfig, tokenState, async (token) => {
        const url = `${cloudConfig.baseUrl}/things/${encodeURIComponent(cloudConfig.thingId)}/properties/${encodeURIComponent(property.id)}/publish`;
        const response = await axios.put(url, body, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });
        return response.data;
    });

    return {
        value: sanitizeArduinoVariableValue(getPropertyValue(published, body.value)),
        updatedAt: normalizeUpdatedAt(getPropertyUpdatedAt(published, Date.now()))
    };
}

async function getPropertyByName(name, cloudConfig, tokenState) {
    const properties = await listThingProperties(cloudConfig, tokenState);
    const match = properties.find((property) => String(getPropertyName(property)).trim() === name);
    if (!match || !match.id) {
        const available = properties
            .map((property) => String(getPropertyName(property)).trim())
            .filter(Boolean)
            .slice(0, 40)
            .join(', ');
        const err = new Error(`Variable "${name}" was not found in Arduino Cloud thing "${cloudConfig.thingId}". Available: ${available || 'none'}`);
        err.status = 404;
        throw err;
    }
    return match;
}

async function listThingProperties(cloudConfig, tokenState) {
    const data = await requestWithAuth(cloudConfig, tokenState, async (token) => {
        const url = `${cloudConfig.baseUrl}/things/${encodeURIComponent(cloudConfig.thingId)}/properties`;
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 15000
        });
        return response.data;
    });
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.properties)) return data.properties;
    return [];
}

async function getThingPropertyDetail(propertyId, cloudConfig, tokenState) {
    return requestWithAuth(cloudConfig, tokenState, async (token) => {
        const url = `${cloudConfig.baseUrl}/things/${encodeURIComponent(cloudConfig.thingId)}/properties/${encodeURIComponent(propertyId)}`;
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 15000
        });
        return response.data || {};
    });
}

async function requestWithAuth(cloudConfig, tokenState, makeRequest) {
    const token = await getAccessToken(cloudConfig, tokenState);
    try {
        return await makeRequest(token);
    } catch (error) {
        if (getHttpStatus(error) === 401 || getHttpStatus(error) === 403) {
            tokenState.accessToken = '';
            tokenState.expiresAtMs = 0;
            const refreshed = await getAccessToken(cloudConfig, tokenState);
            return makeRequest(refreshed);
        }
        throw error;
    }
}

async function getAccessToken(cloudConfig, tokenState) {
    const now = Date.now();
    if (tokenState.accessToken && tokenState.expiresAtMs > (now + 15_000)) {
        return tokenState.accessToken;
    }

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cloudConfig.clientId,
        client_secret: cloudConfig.clientSecret,
        audience: cloudConfig.audience
    }).toString();

    const response = await axios.post(cloudConfig.tokenUrl, body, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });
    const token = String(response?.data?.access_token || '').trim();
    if (!token) {
        const err = new Error('Arduino Cloud token request succeeded but no access_token was returned.');
        err.status = 502;
        throw err;
    }

    const expiresInSec = Number(response?.data?.expires_in);
    const safeTtlSec = Number.isFinite(expiresInSec) ? Math.max(30, Math.floor(expiresInSec - 30)) : 3300;
    tokenState.accessToken = token;
    tokenState.expiresAtMs = Date.now() + (safeTtlSec * 1000);
    return tokenState.accessToken;
}

function getPropertyName(property) {
    if (typeof property?.name === 'string' && property.name.trim()) return property.name.trim();
    if (typeof property?.variable_name === 'string' && property.variable_name.trim()) return property.variable_name.trim();
    if (typeof property?.id === 'string' && property.id.trim()) return property.id.trim();
    return '';
}

function getPropertyValue(property, fallback = null) {
    if (Object.prototype.hasOwnProperty.call(property || {}, 'last_value')) return property.last_value;
    if (Object.prototype.hasOwnProperty.call(property || {}, 'value')) return property.value;
    return fallback;
}

function getPropertyUpdatedAt(property, fallback = null) {
    return property?.last_value_updated_at || property?.value_updated_at || property?.updated_at || fallback;
}

function normalizeUpdatedAt(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const ms = Date.parse(value);
        if (Number.isFinite(ms)) return ms;
        return value;
    }
    return Date.now();
}

function getLocalVariables(userKey, arduinoVariableStoreFile, dataDir) {
    const store = readArduinoVariableStore(arduinoVariableStoreFile, dataDir);
    const userState = store.users[userKey] || { variables: {}, updatedAt: null };
    return {
        variables: sanitizeArduinoVariables(userState.variables),
        updatedAt: Number.isFinite(Number(userState.updatedAt)) ? Number(userState.updatedAt) : null
    };
}

function persistVariablesToLocalStore(variables, userKey, arduinoVariableStoreFile, dataDir) {
    const store = readArduinoVariableStore(arduinoVariableStoreFile, dataDir);
    const now = Date.now();
    store.users[userKey] = {
        variables: sanitizeArduinoVariables(variables),
        updatedAt: now
    };
    writeArduinoVariableStore(store, arduinoVariableStoreFile, dataDir);
}

function persistOneVariableToLocalStore(name, entry, userKey, arduinoVariableStoreFile, dataDir) {
    const store = readArduinoVariableStore(arduinoVariableStoreFile, dataDir);
    const userState = store.users[userKey] || { variables: {}, updatedAt: null };
    const variables = sanitizeArduinoVariables(userState.variables);
    variables[name] = {
        value: sanitizeArduinoVariableValue(entry?.value),
        updatedAt: normalizeUpdatedAt(entry?.updatedAt)
    };
    const now = Date.now();
    store.users[userKey] = {
        variables,
        updatedAt: now
    };
    writeArduinoVariableStore(store, arduinoVariableStoreFile, dataDir);
}

function ensureArduinoVariableStoreFile(arduinoVariableStoreFile, dataDir) {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
    }
    if (!fs.existsSync(arduinoVariableStoreFile)) {
        fs.writeFileSync(arduinoVariableStoreFile, JSON.stringify({ users: {} }, null, 2));
    }
}

function readArduinoVariableStore(arduinoVariableStoreFile, dataDir) {
    ensureArduinoVariableStoreFile(arduinoVariableStoreFile, dataDir);
    try {
        const parsed = JSON.parse(fs.readFileSync(arduinoVariableStoreFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return { users: {} };
        if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
        return parsed;
    } catch (error) {
        return { users: {} };
    }
}

function writeArduinoVariableStore(store, arduinoVariableStoreFile, dataDir) {
    ensureArduinoVariableStoreFile(arduinoVariableStoreFile, dataDir);
    fs.writeFileSync(arduinoVariableStoreFile, JSON.stringify(store, null, 2));
}

function sanitizeArduinoVariableName(name) {
    const normalized = String(name || '').trim();
    if (!normalized) return '';
    if (normalized.length > 120) return '';
    if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) return '';
    return normalized;
}

function sanitizeArduinoVariableValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.slice(0, 4000);
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (error) {
        return String(value).slice(0, 4000);
    }
}

function sanitizeArduinoVariables(rawVariables) {
    if (!rawVariables || typeof rawVariables !== 'object' || Array.isArray(rawVariables)) {
        return {};
    }
    const cleaned = {};
    for (const [key, value] of Object.entries(rawVariables)) {
        const name = sanitizeArduinoVariableName(key);
        if (!name) continue;
        const candidate = (value && typeof value === 'object' && !Array.isArray(value))
            ? value
            : { value, updatedAt: Date.now() };
        cleaned[name] = {
            value: sanitizeArduinoVariableValue(candidate.value),
            updatedAt: normalizeUpdatedAt(candidate.updatedAt)
        };
    }
    return cleaned;
}

function isValidIanaTimeZone(timezone) {
    const zone = String(timezone || '').trim();
    if (!zone) return false;
    try {
        Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date());
        return true;
    } catch (error) {
        return false;
    }
}

function getHttpStatus(error) {
    const status = Number(error?.response?.status || error?.status || 500);
    return Number.isFinite(status) ? status : 500;
}

function formatCloudError(error) {
    const payloadMessage =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.response?.data?.detail ||
        error?.response?.data?.error_description;
    return String(payloadMessage || error?.message || 'Arduino Cloud request failed.');
}

module.exports = {
    createArduinoService,
    registerArduinoRestRoutes
};
