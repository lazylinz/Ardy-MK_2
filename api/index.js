const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const cors = require('cors');
const session = require('express-session');
const https = require('https');
const crypto = require('crypto');
const { Readable } = require('stream');
const selfsigned = require('selfsigned');
const { createArduinoService, registerArduinoRestRoutes } = require('./arduino-rest-handler');
let JSDOM = null;
let ResourceLoader = null;
let VirtualConsole = null;
try {
    ({ JSDOM, ResourceLoader, VirtualConsole } = require('jsdom'));
} catch (error) {
    // jsdom is optional at runtime; visitSite falls back to static extraction if unavailable.
}

const app = express();
const IS_VERCEL = Boolean(process.env.VERCEL);

// Environment/configuration -------------------------------------------------
//
// - PASSWORD: the secret users must submit on the login page.  Defaults to
//   "changeme" if not set; you should override this in production.
// - IP_WHITELIST: comma-separated list of allowed client IPs.  If empty,
//   no whitelist is enforced.  The middleware uses the value of the
//   `cf-connecting-ip` header (Cloudflare's original visitor IP) or
//   `x-forwarded-for`/req.ip.
// - SESSION_SECRET: secret used by express-session.  Change it for security.
//
// The application protects all routes other than `/`, `/login` and `/logout`.
// Any other request (including `/api/*` and static assets) must come from an
// authenticated session and optionally pass an IP whitelist.  The login page
// accepts a password; a POST to `/login` checks it server-side and establishes
// a session.

// if you prefer hard‑coding keys for testing you can set defaults here;
// in production you should supply real secrets via environment variables.

// SSL certificate handling --------------------------------------------------
// an asynchronous helper will create a self-signed cert in ./ssl if necessary
// before the server starts.  We then load the files into `sslOptions`.

const sslDir = path.join(__dirname, '../ssl');
const certFile = path.join(sslDir, 'cert.pem');
const keyFile = path.join(sslDir, 'key.pem');
let sslOptions; // defined later after certs exist
const dataDir = IS_VERCEL ? '/tmp/ardy-data' : path.join(__dirname, '../data');
const chatStoreFile = path.join(dataDir, 'chats.json');
const macroStoreFile = path.join(dataDir, 'macros.json');

// application secrets -------------------------------------------------------
const PASSWORD = process.env.PASSWORD || 'changeme';
const IP_WHITELIST = (process.env.IP_WHITELIST || '').split(',').filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || 'keyboard cat';
const IFLOW_API_KEY = process.env.IFLOW_API_KEY || '';
const IFLOW_API_URL = 'https://apis.iflow.cn/v1/chat/completions';
const AUTH_COOKIE_NAME = 'ardy_auth';
const AUTH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const QUICK_SIGNIN_TTL_MS = 5 * 60 * 1000;
const quickSigninTokens = new Map();
const MACRO_FIRING_WINDOW_MS = 5000;
const MACRO_TICK_INTERVAL_MS = 1000;
const macroIdleTimers = new Map();
let macroRuntimeTickInProgress = false;

function stripHtmlTags(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeHtmlEntities(value) {
    const source = String(value || '');
    const namedDecoded = source
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>');

    return namedDecoded.replace(/&#(x?[0-9a-f]+);/gi, (match, code) => {
        try {
            const numeric = String(code || '').toLowerCase().startsWith('x')
                ? parseInt(String(code).slice(1), 16)
                : parseInt(String(code), 10);
            if (!Number.isFinite(numeric)) return match;
            return String.fromCodePoint(numeric);
        } catch (error) {
            return match;
        }
    });
}

function cleanLineNoise(text) {
    return String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => {
            const lower = line.toLowerCase();
            if (line.length < 2) return false;
            if (/^(javascript|css|html)\s*[:{]/i.test(line)) return false;
            if (/(function\s*\(|=>|const\s+|let\s+|var\s+|class\s+\w+|import\s+|export\s+)/i.test(line)) return false;
            if (/\b(queryselector|addeventlistener|dataset|innerhtml|textcontent|appendchild|getelementbyid|offsetwidth)\b/i.test(line)) return false;
            if (/\b(this\.|window\.|document\.)/i.test(line)) return false;
            if ((line.match(/[{};<>=]/g) || []).length > Math.max(8, Math.floor(line.length * 0.12))) return false;
            if ((line.match(/[()[\]]/g) || []).length > Math.max(10, Math.floor(line.length * 0.2))) return false;
            if (/^(home|menu|search|login|sign in|privacy policy|terms|cookie settings)$/i.test(lower)) return false;
            return true;
        })
        .join('\n');
}

function textQualityScore(text) {
    const source = String(text || '').trim();
    if (!source) return 0;
    const lengthScore = Math.min(source.length, 5000);
    const letters = (source.match(/[A-Za-z]/g) || []).length;
    const alphaRatio = letters / Math.max(source.length, 1);
    const codeHints = (source.match(/\b(function|const|let|var|class|import|export|return)\b|=>|[{};]{2,}|<\/?[a-z][^>]*>/gi) || []).length;
    const urlHints = (source.match(/https?:\/\/|www\./gi) || []).length;
    return lengthScore + Math.round(alphaRatio * 900) - (codeHints * 120) - (urlHints * 8);
}

function extractReadableFromHtml(html) {
    const src = String(html || '');
    if (!src) return '';

    const htmlNoComments = src.replace(/<!--[\s\S]*?-->/g, ' ');
    const htmlNoNoise = htmlNoComments
        .replace(/<(script|style|noscript|svg|canvas|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<(script|style|noscript|svg|canvas|template|iframe)[^>]*\/>/gi, ' ');

    const candidates = [];

    const titleMatch = htmlNoNoise.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch?.[1]) {
        candidates.push(decodeHtmlEntities(stripHtmlTags(titleMatch[1])));
    }

    const mainBlocks = htmlNoNoise.match(/<(article|main)[^>]*>[\s\S]*?<\/\1>/gi) || [];
    for (const block of mainBlocks.slice(0, 3)) {
        candidates.push(decodeHtmlEntities(stripHtmlTags(block)));
    }

    const paraMatches = htmlNoNoise.match(/<(p|h1|h2|h3|li|blockquote)[^>]*>[\s\S]*?<\/\1>/gi) || [];
    if (paraMatches.length) {
        candidates.push(decodeHtmlEntities(stripHtmlTags(paraMatches.slice(0, 250).join('\n'))));
    }

    const bodyMatch = htmlNoNoise.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    candidates.push(decodeHtmlEntities(stripHtmlTags(bodyMatch?.[1] || htmlNoNoise)));

    const normalizedCandidates = candidates
        .map((candidate) => cleanLineNoise(String(candidate || '').replace(/\r/g, '\n').replace(/\n{2,}/g, '\n')))
        .map((candidate) => candidate.replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim())
        .filter(Boolean);

    if (!normalizedCandidates.length) return '';
    normalizedCandidates.sort((a, b) => textQualityScore(b) - textQualityScore(a));
    return normalizedCandidates[0].slice(0, 5000);
}

function cleanTextResponse(text) {
    const decoded = decodeHtmlEntities(String(text || ''));
    const compact = decoded.replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return cleanLineNoise(compact).slice(0, 5000);
}

function isLowQualityExtraction(text) {
    const source = String(text || '').trim();
    if (!source || source.length < 220) return true;
    const score = textQualityScore(source);
    return score < 320;
}

function finalizeReadableText(primaryText, fallbackText = '') {
    const primary = String(primaryText || '').trim();
    const fallback = String(fallbackText || '').trim();
    const winner = textQualityScore(fallback) > textQualityScore(primary) ? fallback : primary;
    return isLowQualityExtraction(winner) ? '' : winner;
}

async function renderDynamicPageText(url, html, locale) {
    if (!JSDOM || !ResourceLoader || !VirtualConsole) return '';

    class MinimalResourceLoader extends ResourceLoader {
        fetch(resourceUrl, options) {
            const target = String(resourceUrl || '').toLowerCase();
            if (
                target.endsWith('.css') ||
                target.includes('stylesheet') ||
                target.match(/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)(\?|$)/)
            ) {
                return null;
            }
            return super.fetch(resourceUrl, options);
        }
    }

    const virtualConsole = new VirtualConsole();
    virtualConsole.on('error', () => undefined);
    virtualConsole.on('warn', () => undefined);

    const dom = new JSDOM(String(html || ''), {
        url,
        contentType: 'text/html',
        runScripts: 'dangerously',
        resources: new MinimalResourceLoader({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ArdyAssistant/1.0',
            strictSSL: true
        }),
        pretendToBeVisual: true,
        virtualConsole
    });

    try {
        const { window } = dom;
        Object.defineProperty(window.navigator, 'language', { value: locale || 'en-US', configurable: true });
        Object.defineProperty(window.navigator, 'languages', { value: [locale || 'en-US'], configurable: true });

        const waitForInitialLoad = new Promise((resolve) => {
            const finish = () => resolve();
            if (window.document.readyState === 'complete') {
                finish();
                return;
            }
            window.addEventListener('load', finish, { once: true });
            window.setTimeout(finish, 1600);
        });
        await waitForInitialLoad;

        const waitForMutationQuiet = new Promise((resolve) => {
            let lastMutation = Date.now();
            const observer = new window.MutationObserver(() => {
                lastMutation = Date.now();
            });
            observer.observe(window.document.documentElement, { childList: true, subtree: true, characterData: true });

            const started = Date.now();
            const interval = window.setInterval(() => {
                const quietFor = Date.now() - lastMutation;
                const elapsed = Date.now() - started;
                if (quietFor >= 350 || elapsed >= 2200) {
                    window.clearInterval(interval);
                    observer.disconnect();
                    resolve();
                }
            }, 120);
        });
        await waitForMutationQuiet;

        const renderedHtml = window.document.documentElement?.outerHTML || '';
        return extractReadableFromHtml(renderedHtml);
    } finally {
        dom.window.close();
    }
}

function decodeDuckDuckGoLink(rawHref) {
    if (!rawHref) return '';
    if (rawHref.startsWith('/l/?')) {
        try {
            const normalizedHref = rawHref.replace(/&amp;/g, '&');
            const wrapped = new URL(normalizedHref, 'https://duckduckgo.com');
            const uddg = wrapped.searchParams.get('uddg');
            return uddg ? decodeURIComponent(uddg) : wrapped.toString();
        } catch (error) {
            return rawHref;
        }
    }
    return rawHref;
}

function mapLocaleToDuckDuckGoRegion(locale) {
    const normalized = String(locale || '').toLowerCase();
    if (!normalized) return 'wt-wt';
    if (normalized.startsWith('en-us')) return 'us-en';
    if (normalized.startsWith('en-ph') || normalized.startsWith('fil-ph') || normalized.startsWith('tl-ph')) return 'ph-en';
    if (normalized.startsWith('en-gb')) return 'uk-en';
    return 'wt-wt';
}

async function searchDuckDuckGo(query, locale) {
    const region = mapLocaleToDuckDuckGoRegion(locale);
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${encodeURIComponent(region)}`;
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ArdyAssistant/1.0',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': locale || 'en-US,en;q=0.9'
        }
    });
    if (!response.ok) {
        throw new Error(`Search upstream failed: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const results = [];
    const blockRegex = /<div class="result(?:.|\n|\r)*?<\/div>\s*<\/div>/gi;
    const blocks = html.match(blockRegex) || [];

    for (const block of blocks) {
        if (results.length >= 6) break;
        const linkMatch = block.match(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;
        const title = stripHtmlTags(linkMatch[2]);
        const rawLink = linkMatch[1];
        const link = decodeDuckDuckGoLink(rawLink);
        const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
            || block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
        const snippet = stripHtmlTags(snippetMatch ? snippetMatch[1] : '');
        if (!title || !link) continue;
        results.push({ title, url: link, snippet });
    }
    return results;
}

async function searchWikipedia(query) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json&srlimit=5`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return [];
    const data = await response.json().catch(() => null);
    const items = data?.query?.search || [];
    return items.slice(0, 5).map((item) => ({
        title: stripHtmlTags(item.title),
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, '_'))}`,
        snippet: stripHtmlTags(item.snippet)
    }));
}

async function visitSite(url, locale) {
    const cleanBody = (rawBody, contentType) => {
        const type = String(contentType || '').toLowerCase();
        if (type.includes('text/html') || /<html[\s>]/i.test(String(rawBody || ''))) {
            return extractReadableFromHtml(rawBody);
        }
        return cleanTextResponse(String(rawBody || ''));
    };

    const visitReaderFallback = async () => {
        const proxyUrl = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`;
        const proxyResp = await fetch(proxyUrl, {
            method: 'GET',
            headers: {
                'Accept': 'text/plain',
                'Accept-Language': locale || 'en-US,en;q=0.9'
            },
            redirect: 'follow'
        });
        if (!proxyResp.ok) {
            throw new Error(`Fallback visit failed: ${proxyResp.status} ${proxyResp.statusText}`);
        }
        const raw = await proxyResp.text();
        return {
            url,
            contentType: 'text/plain',
            fetchMode: 'reader-fallback',
            text: cleanTextResponse(raw)
        };
    };

    const directHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': locale || 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
    };

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: directHeaders,
            redirect: 'follow'
        });
        if (!response.ok) {
            throw new Error(`Visit failed: ${response.status} ${response.statusText}`);
        }
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const raw = await response.text();
        let dynamicText = '';
        if (contentType.includes('text/html') || /<html[\s>]/i.test(String(raw || ''))) {
            try {
                dynamicText = await renderDynamicPageText(url, raw, locale);
            } catch (renderErr) {
                dynamicText = '';
            }
        }
        const primary = {
            url,
            contentType,
            fetchMode: dynamicText ? 'direct-rendered' : 'direct',
            text: finalizeReadableText(cleanBody(raw, contentType), dynamicText)
        };
        if (!isLowQualityExtraction(primary.text)) {
            return {
                ...primary,
                text: finalizeReadableText(primary.text)
            };
        }

        try {
            const fallback = await visitReaderFallback();
            const finalText = finalizeReadableText(primary.text, fallback.text);
            const useFallback = textQualityScore(fallback.text) > textQualityScore(primary.text);
            return {
                ...(useFallback ? fallback : primary),
                text: finalText
            };
        } catch (fallbackErr) {
            return {
                ...primary,
                text: finalizeReadableText(primary.text)
            };
        }
    } catch (directErr) {
        try {
            const fallback = await visitReaderFallback();
            return {
                ...fallback,
                text: finalizeReadableText('', fallback.text)
            };
        } catch (fallbackErr) {
            const directCause = directErr?.cause?.message ? ` (${directErr.cause.message})` : '';
            const fallbackCause = fallbackErr?.cause?.message ? ` (${fallbackErr.cause.message})` : '';
            throw new Error(`Visit fetch failed. direct="${directErr.message}${directCause}" fallback="${fallbackErr.message}${fallbackCause}"`);
        }
    }
}


// Middleware ----------------------------------------------------------------
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse form bodies (for login)
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

// helper to extract client IP (for whitelist)
function getClientIp(req) {
    return (
        (req.headers['x-forwarded-for'] || '').split(',')[0] ||
        req.ip
    );
}

function parseCookies(req) {
    const header = String(req.headers?.cookie || '');
    if (!header) return {};
    return header.split(';').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx <= 0) return acc;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!key) return acc;
        try {
            acc[key] = decodeURIComponent(value);
        } catch (error) {
            acc[key] = value;
        }
        return acc;
    }, {});
}

function signAuthPayload(encodedPayload) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(String(encodedPayload || '')).digest('base64url');
}

function createAuthToken(sessionId) {
    const payload = {
        sid: String(sessionId || ''),
        iat: Date.now()
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = signAuthPayload(encodedPayload);
    return `${encodedPayload}.${signature}`;
}

function verifyAuthToken(token) {
    const source = String(token || '').trim();
    if (!source || !source.includes('.')) return null;
    const [encodedPayload, providedSig] = source.split('.');
    if (!encodedPayload || !providedSig) return null;

    const expectedSig = signAuthPayload(encodedPayload);
    const providedBuffer = Buffer.from(providedSig);
    const expectedBuffer = Buffer.from(expectedSig);
    if (providedBuffer.length !== expectedBuffer.length) return null;
    if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return null;

    try {
        const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf8');
        const payload = JSON.parse(decoded);
        const sid = String(payload?.sid || '').trim();
        if (!sid) return null;
        return { sid };
    } catch (error) {
        return null;
    }
}

function getSignedAuth(req) {
    const cookies = parseCookies(req);
    const token = cookies[AUTH_COOKIE_NAME];
    return verifyAuthToken(token);
}

function setAuthCookie(req, res, sessionId) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const shouldUseSecure = IS_VERCEL || forwardedProto === 'https' || req.secure;
    res.cookie(AUTH_COOKIE_NAME, createAuthToken(sessionId), {
        httpOnly: true,
        sameSite: 'lax',
        secure: shouldUseSecure,
        path: '/',
        maxAge: AUTH_COOKIE_MAX_AGE_MS
    });
}

function clearAuthCookie(req, res) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const shouldUseSecure = IS_VERCEL || forwardedProto === 'https' || req.secure;
    res.clearCookie(AUTH_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: shouldUseSecure,
        path: '/'
    });
}

function getSessionUserKey(req) {
    const fromAuth = String(req.authSessionId || '').trim();
    if (fromAuth) return fromAuth;
    const fromSignedCookie = String(getSignedAuth(req)?.sid || '').trim();
    if (fromSignedCookie) return fromSignedCookie;
    const fromExpressSession = String(req.sessionID || '').trim();
    if (fromExpressSession) return fromExpressSession;
    return `anon-${crypto.randomBytes(12).toString('hex')}`;
}

function establishAuthenticatedRequest(req, res) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    if (req.session) req.session.authenticated = true;
    req.authSessionId = sessionId;
    setAuthCookie(req, res, sessionId);
    return sessionId;
}

function destroyAuthenticatedRequest(req, res) {
    clearAuthCookie(req, res);
    if (!req.session) return;
    req.session.destroy(() => undefined);
}



// IP whitelist middleware
function requireWhitelistedIp(req, res, next) {
    if (IP_WHITELIST.length === 0) {
        // no whitelist configured, allow
        return next();
    }
    const ip = getClientIp(req);
    if (!IP_WHITELIST.includes(ip)) {
        return res.status(403).send('Access denied. IP not whitelisted.');
    }
    next();
}

// authentication check
function requireAuth(req, res, next) {
    const signedAuth = getSignedAuth(req);
    if (signedAuth?.sid) {
        req.authSessionId = signedAuth.sid;
        if (req.session) req.session.authenticated = true;
        return next();
    }
    if (req.session && req.session.authenticated) {
        req.authSessionId = String(req.sessionID || '').trim() || crypto.randomBytes(16).toString('hex');
        return next();
    }
    // APIs should return an auth error instead of HTML redirect.
    if (req.path.startsWith('/api/') || req.path === '/api' || req.path === '/chats') {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    // redirect to login page if not logged in
    return res.redirect('/');
}

// --- authentication routes ---
app.post('/login', (req, res) => {
    const pwd = req.body.password;
    if (pwd === PASSWORD) {
        establishAuthenticatedRequest(req, res);
        return res.json({ success: true });
    }
    return res.status(401).json({ success: false, message: 'Invalid password' });
});

app.get('/logout', (req, res) => {
    destroyAuthenticatedRequest(req, res);
    return res.redirect('/');
});

app.get('/quick-signin', (req, res) => {
    const token = String(req.query?.t || '').trim();
    if (!token) {
        return res.status(400).send('Missing quick sign-in token.');
    }
    const consumed = consumeQuickSigninToken(token);
    if (!consumed) {
        return res.status(401).send('Invalid or expired quick sign-in token.');
    }
    establishAuthenticatedRequest(req, res);
    return res.redirect('/chat.html');
});

// --- 1. THE API ENDPOINT ---
app.get('/api', (req, res) => {
    res.json({
        message: "API is working!",
        status: "Functioning properly, to be configured later.",
        timestamp: new Date().toISOString(),
        judgeNote: "This is a custom Node.js server response."
    });
});

app.post('/api/data', (req, res) => {
    console.log('Received data:', req.body);
    res.json({ reply: "Data received successfully", yourData: req.body });
});

app.post('/api/quick-signin-token', requireWhitelistedIp, requireAuth, (req, res) => {
    const token = mintQuickSigninToken(getSessionUserKey(req));
    const origin = getRequestOrigin(req);
    const url = `${origin}/quick-signin?t=${encodeURIComponent(token)}`;
    return res.json({
        token,
        url,
        expiresAt: new Date(Date.now() + QUICK_SIGNIN_TTL_MS).toISOString()
    });
});

app.post('/api/iflow/chat', requireWhitelistedIp, requireAuth, async (req, res) => {
    if (!IFLOW_API_KEY) {
        return res.status(500).json({ error: { message: 'IFLOW_API_KEY is not configured on the server.' } });
    }

    try {
        const payload = {
            model: req.body?.model || 'glm-4.6',
            messages: Array.isArray(req.body?.messages) ? req.body.messages : [],
            temperature: typeof req.body?.temperature === 'number' ? req.body.temperature : 0.4,
            stream: Boolean(req.body?.stream),
            tools: Array.isArray(req.body?.tools) ? req.body.tools : undefined,
            tool_choice: req.body?.tool_choice,
        };

        const upstream = await fetch(IFLOW_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${IFLOW_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (payload.stream) {
            if (!upstream.ok || !upstream.body) {
                const errData = await upstream.json().catch(() => ({ error: { message: 'iFlow stream failed.' } }));
                return res.status(upstream.status).json(errData);
            }
            res.status(upstream.status);
            res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            Readable.fromWeb(upstream.body).pipe(res);
            return;
        }

        const data = await upstream.json().catch(() => ({ error: { message: 'Invalid response from iFlow.' } }));
        return res.status(upstream.status).json(data);
    } catch (error) {
        return res.status(500).json({ error: { message: error.message } });
    }
});

app.post('/api/web-search', requireWhitelistedIp, requireAuth, async (req, res) => {
    const query = String(req.body?.query || '').trim();
    const locale = String(req.body?.locale || '').trim();
    const timezone = String(req.body?.timezone || '').trim();
    if (!query) {
        return res.status(400).json({ error: { message: 'query is required' } });
    }
    try {
        let results = [];
        try {
            results = await searchDuckDuckGo(query, locale);
        } catch (err) {
            results = [];
        }
        if (!results.length) {
            results = await searchWikipedia(query);
        }
        return res.json({
            query,
            locale,
            timezone,
            source: results.length ? 'web' : 'none',
            results: results.slice(0, 6)
        });
    } catch (error) {
        return res.status(500).json({ error: { message: error.message } });
    }
});

app.post('/api/visit-site', requireWhitelistedIp, requireAuth, async (req, res) => {
    const url = String(req.body?.url || '').trim();
    const locale = String(req.body?.locale || '').trim();
    const timezone = String(req.body?.timezone || '').trim();
    if (!url) {
        return res.status(400).json({ error: { message: 'url is required' } });
    }
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            return res.status(400).json({ error: { message: 'Only http/https URLs are allowed' } });
        }
        const result = await visitSite(parsed.toString(), locale);
        return res.json({
            url: parsed.toString(),
            locale,
            timezone,
            result
        });
    } catch (error) {
        return res.status(500).json({ error: { message: error.message } });
    }
});

const arduinoService = createArduinoService({
    dataDir,
    onVariableWrite: handleMacroVariableWriteEvent
});

registerArduinoRestRoutes(app, {
    requireWhitelistedIp,
    requireAuth,
    dataDir,
    service: arduinoService
});

startMacroRuntimeEngine(arduinoService);

app.get('/api/server-location', requireWhitelistedIp, requireAuth, (req, res) => {
    const origin = getRequestOrigin(req);
    return res.json({
        origin,
        url: `${origin}/chat.html`,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/macros', requireWhitelistedIp, requireAuth, (req, res) => {
    const store = readMacroStore();
    const userKey = getSessionUserKey(req);
    const userState = store.users[userKey] || { macros: [] };
    return res.json({
        macros: sanitizeMacros(userState.macros)
    });
});

app.post('/api/macros', requireWhitelistedIp, requireAuth, (req, res) => {
    const name = String(req.body?.name || '').trim();
    const triggerLua = String(req.body?.triggerLua || req.body?.condition || '').trim();
    const thenLuaScript = String(req.body?.thenLuaScript || req.body?.luaScript || '').trim();
    const elseLuaScript = String(req.body?.elseLuaScript || '').trim();
    const enabled = req.body?.enabled !== false;
    if (!name || !triggerLua || !thenLuaScript) {
        return res.status(400).json({ error: { message: 'name, triggerLua, and thenLuaScript are required' } });
    }

    const store = readMacroStore();
    const userKey = getSessionUserKey(req);
    const existing = sanitizeMacros(store.users[userKey]?.macros || []);
    const now = Date.now();
    const macro = {
        id: `macro-${now}-${Math.floor(Math.random() * 1000)}`,
        name,
        triggerLua,
        thenLuaScript,
        elseLuaScript,
        // Backward-compatible aliases for older clients.
        condition: triggerLua,
        luaScript: thenLuaScript,
        enabled,
        runtimeState: enabled ? 'running' : 'idling',
        lastFiredAt: null,
        lastStateChangeAt: now,
        lastRuntimeEvent: enabled ? 'macro created and running' : 'macro created and idling',
        createdAt: now,
        updatedAt: now,
    };
    const macros = [macro, ...existing].slice(0, 500);
    store.users[userKey] = { macros, updatedAt: now };
    writeMacroStore(store);
    console.log(`[Macro] create id=${macro.id} name="${macro.name}" enabled=${macro.enabled} state=${macro.runtimeState}`);
    return res.json({ ok: true, macro, macros });
});

app.put('/api/macros/:id', requireWhitelistedIp, requireAuth, (req, res) => {
    const macroId = String(req.params?.id || '').trim();
    if (!macroId) return res.status(400).json({ error: { message: 'macro id is required' } });

    const store = readMacroStore();
    const userKey = getSessionUserKey(req);
    const macros = sanitizeMacros(store.users[userKey]?.macros || []);
    const idx = macros.findIndex((macro) => macro.id === macroId);
    if (idx === -1) return res.status(404).json({ error: { message: 'Macro not found' } });

    const hasName = typeof req.body?.name === 'string';
    const hasTriggerLua = typeof req.body?.triggerLua === 'string' || typeof req.body?.condition === 'string';
    const hasThenLuaScript = typeof req.body?.thenLuaScript === 'string' || typeof req.body?.luaScript === 'string';
    const hasElseLuaScript = typeof req.body?.elseLuaScript === 'string';
    const hasEnabled = typeof req.body?.enabled === 'boolean';

    if (hasName) macros[idx].name = String(req.body.name || '').trim();
    if (hasTriggerLua) {
        macros[idx].triggerLua = String(req.body.triggerLua || req.body.condition || '').trim();
        macros[idx].condition = macros[idx].triggerLua;
    }
    if (hasThenLuaScript) {
        macros[idx].thenLuaScript = String(req.body.thenLuaScript || req.body.luaScript || '').trim();
        macros[idx].luaScript = macros[idx].thenLuaScript;
    }
    if (hasElseLuaScript) macros[idx].elseLuaScript = String(req.body.elseLuaScript || '').trim();
    if (hasEnabled) {
        macros[idx].enabled = req.body.enabled;
        macros[idx].runtimeState = req.body.enabled ? 'running' : 'idling';
        macros[idx].lastStateChangeAt = Date.now();
        macros[idx].lastRuntimeEvent = req.body.enabled ? 'macro enabled and running' : 'macro disabled and idling';
    }
    macros[idx].updatedAt = Date.now();

    const sanitized = sanitizeMacros(macros);
    store.users[userKey] = { macros: sanitized, updatedAt: Date.now() };
    writeMacroStore(store);
    const updatedMacro = sanitized.find((macro) => macro.id === macroId) || null;
    if (updatedMacro) {
        console.log(`[Macro] update id=${updatedMacro.id} enabled=${updatedMacro.enabled} state=${updatedMacro.runtimeState}`);
    }
    return res.json({ ok: true, macro: updatedMacro, macros: sanitized });
});

app.delete('/api/macros/:id', requireWhitelistedIp, requireAuth, (req, res) => {
    const macroId = String(req.params?.id || '').trim();
    if (!macroId) return res.status(400).json({ error: { message: 'macro id is required' } });

    const store = readMacroStore();
    const userKey = getSessionUserKey(req);
    const macros = sanitizeMacros(store.users[userKey]?.macros || []);
    const filtered = macros.filter((macro) => macro.id !== macroId);
    store.users[userKey] = { macros: filtered, updatedAt: Date.now() };
    writeMacroStore(store);
    console.log(`[Macro] delete id=${macroId}`);
    return res.json({ ok: true, macros: filtered });
});

function ensureChatStoreFile() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
    }
    if (!fs.existsSync(chatStoreFile)) {
        fs.writeFileSync(chatStoreFile, JSON.stringify({ users: {} }, null, 2));
    }
}

function readChatStore() {
    ensureChatStoreFile();
    try {
        const parsed = JSON.parse(fs.readFileSync(chatStoreFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return { users: {} };
        if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
        return parsed;
    } catch (error) {
        return { users: {} };
    }
}

function writeChatStore(store) {
    ensureChatStoreFile();
    fs.writeFileSync(chatStoreFile, JSON.stringify(store, null, 2));
}

function ensureMacroStoreFile() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
    }
    if (!fs.existsSync(macroStoreFile)) {
        fs.writeFileSync(macroStoreFile, JSON.stringify({ users: {} }, null, 2));
    }
}

function readMacroStore() {
    ensureMacroStoreFile();
    try {
        const parsed = JSON.parse(fs.readFileSync(macroStoreFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return { users: {} };
        if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
        return parsed;
    } catch (error) {
        return { users: {} };
    }
}

function writeMacroStore(store) {
    ensureMacroStoreFile();
    fs.writeFileSync(macroStoreFile, JSON.stringify(store, null, 2));
}

function sanitizeMacros(rawMacros) {
    if (!Array.isArray(rawMacros)) return [];
    return rawMacros
        .map((macro) => {
            const enabled = macro?.enabled !== false;
            const runtimeStateRaw = String(macro?.runtimeState || '').trim().toLowerCase();
            const baseRuntimeState = ['running', 'firing', 'idling'].includes(runtimeStateRaw)
                ? runtimeStateRaw
                : (enabled ? 'running' : 'idling');
            const lastFiredAt = Number.isFinite(Number(macro?.lastFiredAt)) ? Number(macro.lastFiredAt) : null;
            const runtimeState = baseRuntimeState === 'firing' && lastFiredAt && (Date.now() - lastFiredAt > MACRO_FIRING_WINDOW_MS)
                ? 'idling'
                : baseRuntimeState;
            return {
                id: typeof macro?.id === 'string' && macro.id.trim()
                    ? macro.id.trim()
                    : `macro-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                name: String(macro?.name || '').trim(),
                triggerLua: String(macro?.triggerLua || macro?.condition || '').trim(),
                thenLuaScript: String(macro?.thenLuaScript || macro?.luaScript || '').trim(),
                elseLuaScript: String(macro?.elseLuaScript || '').trim(),
                // Backward-compatible aliases for older clients.
                condition: String(macro?.triggerLua || macro?.condition || '').trim(),
                luaScript: String(macro?.thenLuaScript || macro?.luaScript || '').trim(),
                enabled,
                runtimeState,
                lastFiredAt,
                lastStateChangeAt: Number.isFinite(Number(macro?.lastStateChangeAt)) ? Number(macro.lastStateChangeAt) : null,
                lastRuntimeEvent: String(macro?.lastRuntimeEvent || '').trim(),
                createdAt: Number.isFinite(Number(macro?.createdAt)) ? Number(macro.createdAt) : Date.now(),
                updatedAt: Number.isFinite(Number(macro?.updatedAt)) ? Number(macro.updatedAt) : Date.now(),
            };
        })
        .filter((macro) => macro.name && macro.triggerLua && macro.thenLuaScript);
}

function getMacroTimerKey(sessionId, macroId) {
    return `${String(sessionId || '')}::${String(macroId || '')}`;
}

function scheduleMacroToIdle(sessionId, macroId) {
    const key = getMacroTimerKey(sessionId, macroId);
    const existing = macroIdleTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
        try {
            const store = readMacroStore();
            const userState = store.users[sessionId] || { macros: [] };
            const macros = sanitizeMacros(userState.macros);
            const idx = macros.findIndex((macro) => macro.id === macroId);
            if (idx === -1) return;
            if (macros[idx].enabled === false) return;
            macros[idx].runtimeState = 'idling';
            macros[idx].lastStateChangeAt = Date.now();
            macros[idx].lastRuntimeEvent = 'macro idling (no recent variable write)';
            macros[idx].updatedAt = Date.now();
            store.users[sessionId] = { macros, updatedAt: Date.now() };
            writeMacroStore(store);
            console.log(`[Macro] idling id=${macroId} session=${sessionId}`);
        } catch (error) {
            console.error(`[Macro] failed to set idling id=${macroId}: ${error.message}`);
        } finally {
            macroIdleTimers.delete(key);
        }
    }, MACRO_FIRING_WINDOW_MS);

    macroIdleTimers.set(key, timer);
}

function handleMacroVariableWriteEvent(event) {
    const sessionId = String(event?.sessionId || '').trim();
    const sourceMacroId = String(event?.sourceMacroId || '').trim();
    const sourceMacroName = String(event?.sourceMacroName || '').trim();
    const variableName = String(event?.variableName || '').trim();
    if (!sessionId) return;
    if (!sourceMacroId && !sourceMacroName) return;

    const store = readMacroStore();
    const userState = store.users[sessionId] || { macros: [] };
    const macros = sanitizeMacros(userState.macros);
    const idx = sourceMacroId
        ? macros.findIndex((macro) => macro.id === sourceMacroId)
        : (sourceMacroName ? macros.findIndex((macro) => macro.name === sourceMacroName) : -1);

    if (idx === -1) {
        console.log(`[Macro] variable write has no macro match session=${sessionId} variable=${variableName}`);
        return;
    }

    const now = Date.now();
    const macro = macros[idx];
    macro.runtimeState = 'firing';
    macro.lastFiredAt = now;
    macro.lastStateChangeAt = now;
    macro.lastRuntimeEvent = `changed variable "${variableName}"`;
    macro.updatedAt = now;

    store.users[sessionId] = { macros, updatedAt: now };
    writeMacroStore(store);
    console.log(`[Macro] firing id=${macro.id} name="${macro.name}" variable=${variableName}`);

    scheduleMacroToIdle(sessionId, macro.id);
}

function startMacroRuntimeEngine(arduinoService) {
    setInterval(async () => {
        if (macroRuntimeTickInProgress) return;
        macroRuntimeTickInProgress = true;
        try {
            await runMacroRuntimeTick(arduinoService);
        } catch (error) {
            console.error(`[Macro] runtime tick failed: ${error.message}`);
        } finally {
            macroRuntimeTickInProgress = false;
        }
    }, MACRO_TICK_INTERVAL_MS);
    console.log(`[Macro] runtime engine started intervalMs=${MACRO_TICK_INTERVAL_MS}`);
}

async function runMacroRuntimeTick(arduinoService) {
    const store = readMacroStore();
    const users = store.users && typeof store.users === 'object' ? store.users : {};
    let changed = false;

    for (const [sessionId, userState] of Object.entries(users)) {
        const macros = sanitizeMacros(userState?.macros || []);
        let userChanged = false;
        for (const macro of macros) {
            if (!macro.enabled) continue;
            const didChange = await executeMacroRuntimeForOne({ sessionId, macro, arduinoService });
            if (didChange) userChanged = true;
        }
        if (userChanged) {
            store.users[sessionId] = {
                macros,
                updatedAt: Date.now()
            };
            changed = true;
        }
    }

    if (changed) {
        writeMacroStore(store);
    }
}

async function executeMacroRuntimeForOne({ sessionId, macro, arduinoService }) {
    const triggerLua = String(macro?.triggerLua || macro?.condition || '').trim();
    const thenLuaScript = String(macro?.thenLuaScript || macro?.luaScript || '').trim();
    const elseLuaScript = String(macro?.elseLuaScript || '').trim();
    if (!triggerLua || !thenLuaScript) return false;

    const writeEvents = [];
    const variableCache = new Map();
    const runtimeContext = createMacroRuntimeContext({
        sessionId,
        macroId: macro.id,
        macroName: macro.name,
        arduinoService,
        writeEvents,
        variableCache
    });

    try {
        const triggerResult = Boolean(await evaluateLuaLikeExpression(triggerLua, runtimeContext));
        const branchName = triggerResult ? 'then' : 'else';
        const branchScript = triggerResult ? thenLuaScript : elseLuaScript;
        if (branchScript) {
            await executeLuaLikeScript(branchScript, runtimeContext);
        }

        const now = Date.now();
        macro.updatedAt = now;
        macro.lastStateChangeAt = now;
        if (writeEvents.length > 0) {
            macro.runtimeState = 'firing';
            macro.lastFiredAt = now;
            macro.lastRuntimeEvent = `changed variable "${writeEvents[writeEvents.length - 1]}"`;
            scheduleMacroToIdle(sessionId, macro.id);
        } else {
            macro.runtimeState = 'idling';
            macro.lastRuntimeEvent = `trigger ${branchName === 'then' ? 'true' : 'false'} (no variable change)`;
        }
        console.log(`[Macro] tick id=${macro.id} name="${macro.name}" branch=${branchName} writes=${writeEvents.length}`);
        return true;
    } catch (error) {
        macro.runtimeState = 'idling';
        macro.lastStateChangeAt = Date.now();
        macro.updatedAt = Date.now();
        macro.lastRuntimeEvent = `runtime error: ${error.message}`;
        console.error(`[Macro] runtime error id=${macro.id} name="${macro.name}" error=${error.message}`);
        return true;
    }
}

function createMacroRuntimeContext({ sessionId, macroId, macroName, arduinoService, writeEvents, variableCache }) {
    const osApi = {
        time: () => Math.floor(Date.now() / 1000),
        clock: () => process.uptime(),
        date: (fmt, ts) => {
            const baseDate = ts ? new Date(Number(ts) * 1000) : new Date();
            if (!fmt || fmt === '%c') return baseDate.toISOString();
            if (fmt === '%s') return String(Math.floor(baseDate.getTime() / 1000));
            return baseDate.toISOString();
        }
    };

    return {
        async get_all_variables() {
            const payload = await arduinoService.getAllVariables({ sessionId });
            const out = {};
            const vars = payload?.variables && typeof payload.variables === 'object' ? payload.variables : {};
            Object.entries(vars).forEach(([name, entry]) => {
                out[name] = entry?.value;
                variableCache.set(name, entry?.value);
            });
            return out;
        },
        async read_variable(name) {
            const key = String(name || '').trim();
            if (!key) return null;
            if (variableCache.has(key)) return variableCache.get(key);
            const payload = await arduinoService.readVariable({ sessionId, name: key });
            variableCache.set(key, payload?.value);
            return payload?.value;
        },
        async write_variable(name, value) {
            const key = String(name || '').trim();
            if (!key) return false;
            await arduinoService.writeVariable({
                sessionId,
                name: key,
                value,
                sourceMacroId: '',
                sourceMacroName: ''
            });
            variableCache.set(key, value);
            writeEvents.push(key);
            console.log(`[Macro] write id=${macroId} name="${macroName}" variable=${key}`);
            return true;
        },
        os: osApi,
        math: Math,
        tonumber(value) {
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        },
        tostring(value) {
            return String(value);
        },
        print(...args) {
            console.log(`[Macro Lua ${macroId}]`, ...args);
        }
    };
}

function transformLuaOperatorsToJs(input) {
    let out = String(input || '');
    out = out.replace(/\r/g, '');
    out = out.replace(/--.*$/gm, '');
    out = out.replace(/\bnil\b/g, 'null');
    out = out.replace(/\btrue\b/g, 'true');
    out = out.replace(/\bfalse\b/g, 'false');
    out = out.replace(/\band\b/g, '&&');
    out = out.replace(/\bor\b/g, '||');
    out = out.replace(/\bnot\b/g, '!');
    out = out.replace(/~=/g, '!=');
    out = out.replace(/\.\./g, '+');
    out = out.replace(/\b(read_variable|write_variable|get_all_variables)\s*\(/g, 'await $1(');
    return out;
}

function transformLuaScriptToJs(script) {
    const lines = String(script || '').replace(/\r/g, '').split('\n');
    const outLines = [];
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('--')) continue;

        const ifMatch = line.match(/^if\s+(.+)\s+then$/);
        if (ifMatch) {
            outLines.push(`if (${transformLuaOperatorsToJs(ifMatch[1])}) {`);
            continue;
        }
        const elseifMatch = line.match(/^elseif\s+(.+)\s+then$/);
        if (elseifMatch) {
            outLines.push(`} else if (${transformLuaOperatorsToJs(elseifMatch[1])}) {`);
            continue;
        }
        if (line === 'else') {
            outLines.push('} else {');
            continue;
        }
        if (line === 'end') {
            outLines.push('}');
            continue;
        }

        const localAssignMatch = line.match(/^local\s+([A-Za-z_]\w*)\s*=\s*(.+)$/);
        if (localAssignMatch) {
            outLines.push(`let ${localAssignMatch[1]} = ${transformLuaOperatorsToJs(localAssignMatch[2])};`);
            continue;
        }

        const assignMatch = line.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/);
        if (assignMatch) {
            outLines.push(`${assignMatch[1]} = ${transformLuaOperatorsToJs(assignMatch[2])};`);
            continue;
        }

        outLines.push(`${transformLuaOperatorsToJs(line)};`);
    }
    return outLines.join('\n');
}

async function evaluateLuaLikeExpression(expression, runtimeContext) {
    const jsExpr = transformLuaOperatorsToJs(expression);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runner = new AsyncFunction(
        'read_variable',
        'write_variable',
        'get_all_variables',
        'os',
        'math',
        'tonumber',
        'tostring',
        'print',
        `return (${jsExpr});`
    );
    return runner(
        runtimeContext.read_variable,
        runtimeContext.write_variable,
        runtimeContext.get_all_variables,
        runtimeContext.os,
        runtimeContext.math,
        runtimeContext.tonumber,
        runtimeContext.tostring,
        runtimeContext.print
    );
}

async function executeLuaLikeScript(script, runtimeContext) {
    const jsScript = transformLuaScriptToJs(script);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runner = new AsyncFunction(
        'read_variable',
        'write_variable',
        'get_all_variables',
        'os',
        'math',
        'tonumber',
        'tostring',
        'print',
        jsScript
    );
    return runner(
        runtimeContext.read_variable,
        runtimeContext.write_variable,
        runtimeContext.get_all_variables,
        runtimeContext.os,
        runtimeContext.math,
        runtimeContext.tonumber,
        runtimeContext.tostring,
        runtimeContext.print
    );
}

function getRequestOrigin(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = forwardedProto || (req.secure ? 'https' : 'http');
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const host = forwardedHost || req.headers.host || 'localhost';
    return `${proto}://${host}`;
}

function pruneQuickSigninTokens() {
    const now = Date.now();
    for (const [token, entry] of quickSigninTokens.entries()) {
        if (!entry || entry.used || entry.expiresAt <= now) {
            quickSigninTokens.delete(token);
        }
    }
}

function mintQuickSigninToken(sessionOwner) {
    pruneQuickSigninTokens();
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    quickSigninTokens.set(token, {
        token,
        ownerSessionId: String(sessionOwner || ''),
        createdAt: now,
        expiresAt: now + QUICK_SIGNIN_TTL_MS,
        used: false
    });
    return token;
}

function consumeQuickSigninToken(token) {
    pruneQuickSigninTokens();
    const entry = quickSigninTokens.get(token);
    if (!entry || entry.used || entry.expiresAt <= Date.now()) return null;
    entry.used = true;
    quickSigninTokens.set(token, entry);
    return entry;
}

function sanitizeThreads(rawThreads) {
    if (!Array.isArray(rawThreads)) return [];
    return rawThreads.map((thread) => ({
        id: typeof thread?.id === 'string' ? thread.id : `chat-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        createdAt: Number.isFinite(Number(thread?.createdAt)) ? Number(thread.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(thread?.updatedAt)) ? Number(thread.updatedAt) : Date.now(),
        history: Array.isArray(thread?.history) ? thread.history : [],
    }));
}

function getChatsHandler(req, res) {
    const store = readChatStore();
    const userKey = getSessionUserKey(req);
    const userState = store.users[userKey] || { threads: [], activeThreadId: null };
    return res.json({
        threads: sanitizeThreads(userState.threads),
        activeThreadId: typeof userState.activeThreadId === 'string' ? userState.activeThreadId : null,
    });
}

function putChatsHandler(req, res) {
    const threads = sanitizeThreads(req.body?.threads);
    const activeThreadId = typeof req.body?.activeThreadId === 'string' ? req.body.activeThreadId : null;

    const store = readChatStore();
    const userKey = getSessionUserKey(req);
    store.users[userKey] = {
        threads,
        activeThreadId,
        updatedAt: Date.now(),
    };
    writeChatStore(store);

    return res.json({ ok: true });
}

// Register both prefixed and unprefixed routes to support different mount styles.
['/api/chats', '/chats'].forEach((route) => {
    app.get(route, requireWhitelistedIp, getChatsHandler);
    app.put(route, requireWhitelistedIp, putChatsHandler);
});

// --- protect everything except login page before serving static files ---
const publicPath = path.join(__dirname, '../public');

// serve the login page with the sitekey inserted
app.get('/', (req, res) => {
    const file = path.join(publicPath, 'index.html');
    fs.readFile(file, 'utf8', (err, data) => {
        if (err) return res.status(500).send('error');
        res.send(data);
    });
});

// custom middleware - run before express.static
app.use((req, res, next) => {
    const openPaths = new Set([
        '/',
        '/login',
        '/logout',
        '/index_style.css',
        '/index_script.js',
        '/LOGO.svg',
        '/favicon.ico',
    ]);
    if (openPaths.has(req.path)) {
        return next();
    }

    // now only whitelist and authentication remain
    requireWhitelistedIp(req, res, () => {
        requireAuth(req, res, next);
    });
});

app.use(express.static(publicPath));

// --- 3. LOCAL SERVER STARTER (async for cert generation) ---
async function ensureCerts() {
    if (!fs.existsSync(sslDir)) {
        fs.mkdirSync(sslDir);
    }
    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
        console.log('Generating self-signed certificate for HTTPS...');
        const attrs = [{ name: 'commonName', value: 'localhost' }];
        const pems = await selfsigned.generate(attrs, { days: 365 });
        fs.writeFileSync(certFile, pems.cert);
        fs.writeFileSync(keyFile, pems.private);
    }
    sslOptions = {
        key: fs.readFileSync(keyFile),
        cert: fs.readFileSync(certFile),
    };
}

if (require.main === module && !IS_VERCEL) {
    (async () => {
        await ensureCerts();
        const PORT = process.env.PORT || 3000;

        // create https server using generated self-signed certificate
        https.createServer(sslOptions, app).listen(PORT, () => {
            console.log(`HTTPS server running locally at https://localhost:${PORT}`);
            console.log(`API Endpoint: https://localhost:${PORT}/api`);
        });
    })();
}

// Export for Vercel (ignored when running locally)
module.exports = app;
