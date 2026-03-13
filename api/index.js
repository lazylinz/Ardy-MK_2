const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const cors = require('cors');
const session = require('express-session');
const https = require('https');
const crypto = require('crypto');
const jpeg = require('jpeg-js');
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
const faceProfileStoreFile = path.join(dataDir, 'face-profiles.json');

// application secrets -------------------------------------------------------
const PASSWORD = process.env.PASSWORD || 'changeme';
const IP_WHITELIST = (process.env.IP_WHITELIST || '').split(',').filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || 'keyboard cat';
const IFLOW_API_KEY = process.env.IFLOW_API_KEY || '';
const IFLOW_API_URL = 'https://apis.iflow.cn/v1/chat/completions';
const AUTH_COOKIE_NAME = 'ardy_auth';
const AUTH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_COOKIE_DOMAIN = String(process.env.AUTH_COOKIE_DOMAIN || '').trim() || undefined;
const AUTH_COOKIE_SAMESITE = String(process.env.AUTH_COOKIE_SAMESITE || 'lax').trim().toLowerCase() === 'none'
    ? 'none'
    : 'lax';
const CORS_ALLOWLIST = String(process.env.CORS_ALLOWLIST || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const QUICK_SIGNIN_TTL_MS = 5 * 60 * 1000;
const PASSWORD_GATE_TTL_MS = 10 * 60 * 1000;
const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.47);
const FACE_MATCH_MARGIN = Number(process.env.FACE_MATCH_MARGIN || 0.035);
const FACE_PROFILE_MIN_SAMPLES = Math.max(3, Number(process.env.FACE_PROFILE_MIN_SAMPLES || 6));
const FACE_PROFILE_MAX_SAMPLES = Math.max(FACE_PROFILE_MIN_SAMPLES, Number(process.env.FACE_PROFILE_MAX_SAMPLES || 24));
const FACE_PROFILE_DEDUP_DISTANCE = Number(process.env.FACE_PROFILE_DEDUP_DISTANCE || 0.12);
const HOSTED_IMAGE_TTL_MS = 15 * 60 * 1000;
const HOSTED_IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const HOSTED_IMAGE_MAX_ITEMS = 300;
const CAM_INGEST_KEY = String(process.env.CAM_INGEST_KEY || '').trim();
const CAM_FRAME_TTL_MS = Math.max(1000, Number(process.env.CAM_FRAME_TTL_MS || 15000));
const CAM_MAX_FRAME_BYTES = Math.max(64 * 1024, Number(process.env.CAM_MAX_FRAME_BYTES || 512 * 1024));
const CAM_DETECT_ENABLED = String(process.env.CAM_DETECT_ENABLED || 'true').trim().toLowerCase() !== 'false';
const CAM_DETECT_INTERVAL_MS = Math.max(800, Number(process.env.CAM_DETECT_INTERVAL_MS || 2500));
const CAM_DETECT_BACKEND = String(process.env.CAM_DETECT_BACKEND || 'opencv-js').trim().toLowerCase();
const OPENCV_JS_HAAR_CASCADE = String(process.env.OPENCV_JS_HAAR_CASCADE || process.env.OPENCV_HAAR_CASCADE || '').trim();
const OPENCV_CASCADE_FILENAME = 'haarcascade_frontalface_default.xml';
const OPENCV_CASCADE_BUNDLED_PATH = path.join(__dirname, OPENCV_CASCADE_FILENAME);
const OPENCV_CASCADE_TMP_PATH = path.join('/tmp', OPENCV_CASCADE_FILENAME);
const OPENCV_CASCADE_DOWNLOAD_URL = String(
    process.env.OPENCV_CASCADE_DOWNLOAD_URL
    || 'https://raw.githubusercontent.com/opencv/opencv/master/data/haarcascades/haarcascade_frontalface_default.xml'
).trim();
const FACE_OPENCV_MAX_IMAGES = Math.max(1, Number(process.env.FACE_OPENCV_MAX_IMAGES || 6));
const FACE_OPENCV_MATCH_THRESHOLD = Number(process.env.FACE_OPENCV_MATCH_THRESHOLD || 0.62);
const FACE_OPENCV_MARGIN = Number(process.env.FACE_OPENCV_MARGIN || 0.045);
const quickSigninTokens = new Map();
const hostedImages = new Map();
const camMjpegClients = new Set();
let latestCamFrame = null;
let arduinoService = null;
let lastCamDetectionAtMs = 0;
let lastPublishedDetectedPeople = null;
let opencvJsReady = false;
let opencvJsReadyChecked = false;
let opencvJsCascadePath = '/haarcascade_frontalface_default.xml';
let opencvJsCascadeHostPath = '';
let cvInstance = null;
let cvLoadPromise = null;
let opencvJsLastInitAttemptAt = 0;
let opencvJsLastInitError = '';
const MACRO_FIRING_WINDOW_MS = 5000;
const MACRO_TICK_INTERVAL_MS = 1000;
const GLOBAL_MACRO_RUNTIME_SESSION_ID = 'global-macro-runtime';
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
app.use(cors({
    credentials: true,
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (CORS_ALLOWLIST.length === 0) return callback(null, true);
        if (CORS_ALLOWLIST.includes(origin)) return callback(null, true);
        return callback(null, false);
    }
}));
app.use(express.json({ limit: '20mb' })); // Parse JSON bodies
app.use(express.urlencoded({ extended: true, limit: '20mb' })); // Parse form bodies (for login)
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
    const sameSite = AUTH_COOKIE_SAMESITE === 'none' && !shouldUseSecure ? 'lax' : AUTH_COOKIE_SAMESITE;
    res.cookie(AUTH_COOKIE_NAME, createAuthToken(sessionId), {
        httpOnly: true,
        sameSite,
        secure: shouldUseSecure,
        domain: AUTH_COOKIE_DOMAIN,
        path: '/',
        maxAge: AUTH_COOKIE_MAX_AGE_MS
    });
}

function clearAuthCookie(req, res) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const shouldUseSecure = IS_VERCEL || forwardedProto === 'https' || req.secure;
    const sameSite = AUTH_COOKIE_SAMESITE === 'none' && !shouldUseSecure ? 'lax' : AUTH_COOKIE_SAMESITE;
    res.clearCookie(AUTH_COOKIE_NAME, {
        httpOnly: true,
        sameSite,
        secure: shouldUseSecure,
        domain: AUTH_COOKIE_DOMAIN,
        path: '/'
    });
}

function getSessionUserKey(req) {
    const fromAuth = String(req.authSessionId || '').trim();
    if (fromAuth) return fromAuth;
    const fromSignedCookie = String(getSignedAuth(req)?.sid || '').trim();
    if (fromSignedCookie) return fromSignedCookie;
    const fromStoredSession = String(req.session?.userKey || '').trim();
    if (fromStoredSession) return fromStoredSession;
    const fromExpressSession = String(req.sessionID || '').trim();
    if (fromExpressSession) return fromExpressSession;
    return `anon-${crypto.randomBytes(12).toString('hex')}`;
}

function establishAuthenticatedRequest(req, res, preferredSessionId = '') {
    const candidate = String(preferredSessionId || req.session?.userKey || '').trim();
    const sessionId = candidate || crypto.randomBytes(16).toString('hex');
    if (req.session) {
        req.session.authenticated = true;
        req.session.userKey = sessionId;
        req.session.passwordVerifiedAt = null;
    }
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
        if (req.session) {
            req.session.authenticated = true;
            req.session.userKey = signedAuth.sid;
        }
        return next();
    }
    if (req.session && req.session.authenticated) {
        req.authSessionId = String(req.session.userKey || req.sessionID || '').trim() || crypto.randomBytes(16).toString('hex');
        return next();
    }
    // APIs should return an auth error instead of HTML redirect.
    if (req.path.startsWith('/api/') || req.path === '/api' || req.path === '/chats') {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    // redirect to login page if not logged in
    return res.redirect('/');
}

function sanitizeFaceDescriptor(rawDescriptor) {
    if (!Array.isArray(rawDescriptor)) return null;
    const normalized = rawDescriptor
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.max(-10, Math.min(10, value)));
    if (normalized.length < 32) return null;
    return normalized.slice(0, 256);
}

function averageFaceDescriptors(descriptors) {
    if (!Array.isArray(descriptors) || !descriptors.length) return null;
    const first = sanitizeFaceDescriptor(descriptors[0]);
    if (!first) return null;

    const length = first.length;
    const sum = new Array(length).fill(0);
    let count = 0;
    for (const raw of descriptors) {
        const descriptor = sanitizeFaceDescriptor(raw);
        if (!descriptor || descriptor.length !== length) continue;
        for (let i = 0; i < length; i += 1) {
            sum[i] += descriptor[i];
        }
        count += 1;
    }
    if (!count) return null;
    return sum.map((value) => value / count);
}

function sanitizeNickname(rawNickname) {
    const cleaned = String(rawNickname || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';
    return cleaned.slice(0, 32);
}

function sanitizeOpenCvVector(rawVector) {
    if (!Array.isArray(rawVector)) return null;
    const normalized = rawVector
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.max(-10, Math.min(10, value)));
    if (normalized.length < 64) return null;
    return normalized.slice(0, 512);
}

function sanitizeOpenCvVectorSet(raw) {
    const source = Array.isArray(raw) ? raw : [raw];
    const vectors = [];
    for (const entry of source) {
        const vector = sanitizeOpenCvVector(entry);
        if (vector) vectors.push(vector);
    }
    return vectors.slice(0, FACE_OPENCV_MAX_IMAGES);
}

function averageOpenCvVectors(vectors) {
    if (!Array.isArray(vectors) || !vectors.length) return null;
    const first = sanitizeOpenCvVector(vectors[0]);
    if (!first) return null;
    const length = first.length;
    const sum = new Array(length).fill(0);
    let count = 0;
    for (const raw of vectors) {
        const vector = sanitizeOpenCvVector(raw);
        if (!vector || vector.length !== length) continue;
        for (let i = 0; i < length; i += 1) sum[i] += vector[i];
        count += 1;
    }
    if (!count) return null;
    return sum.map((value) => value / count);
}

function openCvVectorDistance(vectorA, vectorB) {
    if (!Array.isArray(vectorA) || !Array.isArray(vectorB)) return Number.POSITIVE_INFINITY;
    const dims = Math.min(vectorA.length, vectorB.length);
    if (dims < 64) return Number.POSITIVE_INFINITY;
    let sum = 0;
    for (let i = 0; i < dims; i += 1) {
        const delta = Number(vectorA[i]) - Number(vectorB[i]);
        sum += delta * delta;
    }
    return Math.sqrt(sum / dims);
}

function normalizeOpenCvProfile(entry) {
    const setFromProfile = sanitizeOpenCvVectorSet(entry?.opencvProfile?.samples || []);
    const setDirect = sanitizeOpenCvVectorSet(entry?.opencvVectors || []);
    const single = sanitizeOpenCvVector(entry?.opencvVector);
    const merged = [];

    for (const vector of [...setFromProfile, ...setDirect, ...(single ? [single] : [])]) {
        const duplicate = merged.some((existing) => openCvVectorDistance(existing, vector) <= 0.04);
        if (!duplicate) merged.push(vector);
        if (merged.length >= FACE_OPENCV_MAX_IMAGES) break;
    }
    if (!merged.length) return null;

    const centroid = averageOpenCvVectors(merged);
    if (!centroid) return null;
    return {
        version: 1,
        samples: merged,
        centroid
    };
}

function faceDistance(descriptorA, descriptorB) {
    if (!Array.isArray(descriptorA) || !Array.isArray(descriptorB)) return Number.POSITIVE_INFINITY;
    const dims = Math.min(descriptorA.length, descriptorB.length);
    if (dims < 32) return Number.POSITIVE_INFINITY;
    let sum = 0;
    for (let i = 0; i < dims; i += 1) {
        const delta = Number(descriptorA[i]) - Number(descriptorB[i]);
        sum += delta * delta;
    }
    return Math.sqrt(sum);
}

function sanitizeFaceDescriptorSet(raw) {
    const source = Array.isArray(raw) ? raw : [raw];
    const descriptors = [];
    for (const entry of source) {
        const descriptor = sanitizeFaceDescriptor(entry);
        if (descriptor) descriptors.push(descriptor);
    }
    if (!descriptors.length) return [];

    const deduped = [];
    for (const descriptor of descriptors) {
        const duplicate = deduped.some((existing) => faceDistance(existing, descriptor) <= FACE_PROFILE_DEDUP_DISTANCE);
        if (!duplicate) deduped.push(descriptor);
        if (deduped.length >= FACE_PROFILE_MAX_SAMPLES) break;
    }
    return deduped;
}

function normalizeFaceProfile(entry) {
    const profileSamples = sanitizeFaceDescriptorSet(entry?.faceProfile?.samples || []);
    const directSamples = sanitizeFaceDescriptorSet(entry?.faceDescriptors || []);
    const singleDescriptor = sanitizeFaceDescriptor(entry?.faceDescriptor);
    const merged = [];

    for (const descriptor of [...profileSamples, ...directSamples, ...(singleDescriptor ? [singleDescriptor] : [])]) {
        const duplicate = merged.some((existing) => faceDistance(existing, descriptor) <= FACE_PROFILE_DEDUP_DISTANCE);
        if (!duplicate) merged.push(descriptor);
        if (merged.length >= FACE_PROFILE_MAX_SAMPLES) break;
    }
    if (!merged.length) return null;

    const centroid = averageFaceDescriptors(merged);
    if (!centroid) return null;
    return {
        version: 2,
        samples: merged.slice(0, FACE_PROFILE_MAX_SAMPLES),
        centroid
    };
}

function faceProfileDistance(inputDescriptor, faceProfile) {
    const descriptor = sanitizeFaceDescriptor(inputDescriptor);
    if (!descriptor || !faceProfile) return Number.POSITIVE_INFINITY;
    const centroidDistance = faceDistance(descriptor, faceProfile.centroid);
    const sampleDistances = (faceProfile.samples || [])
        .map((sample) => faceDistance(descriptor, sample))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);
    if (!sampleDistances.length || !Number.isFinite(centroidDistance)) return Number.POSITIVE_INFINITY;

    const nearestCount = Math.min(3, sampleDistances.length);
    const nearestAverage = sampleDistances.slice(0, nearestCount).reduce((acc, value) => acc + value, 0) / nearestCount;
    const bestSample = sampleDistances[0];
    return (bestSample * 0.5) + (nearestAverage * 0.3) + (centroidDistance * 0.2);
}

function ensureFaceProfileStoreFile() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
    }
    if (!fs.existsSync(faceProfileStoreFile)) {
        fs.writeFileSync(faceProfileStoreFile, JSON.stringify({ users: [] }, null, 2));
    }
}

function readFaceProfileStore() {
    ensureFaceProfileStoreFile();
    try {
        const parsed = JSON.parse(fs.readFileSync(faceProfileStoreFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return { users: [] };
        if (!Array.isArray(parsed.users)) parsed.users = [];
        return {
            users: parsed.users
                .map((entry) => {
                    const id = String(entry?.id || '').trim();
                    const nickname = sanitizeNickname(entry?.nickname);
                    const faceProfile = normalizeFaceProfile(entry);
                    const opencvProfile = normalizeOpenCvProfile(entry);
                    if (!id || !nickname || (!faceProfile && !opencvProfile)) return null;
                    return {
                        id,
                        nickname,
                        faceProfile,
                        opencvProfile,
                        // Compatibility alias for old code paths.
                        faceDescriptor: faceProfile?.centroid || null,
                        faceDescriptors: faceProfile?.samples || [],
                        opencvVector: opencvProfile?.centroid || null,
                        opencvVectors: opencvProfile?.samples || [],
                        createdAt: Number.isFinite(Number(entry?.createdAt)) ? Number(entry.createdAt) : Date.now(),
                        updatedAt: Number.isFinite(Number(entry?.updatedAt)) ? Number(entry.updatedAt) : Date.now(),
                        lastSeenAt: Number.isFinite(Number(entry?.lastSeenAt)) ? Number(entry.lastSeenAt) : null
                    };
                })
                .filter(Boolean)
        };
    } catch (error) {
        return { users: [] };
    }
}

function writeFaceProfileStore(store) {
    ensureFaceProfileStoreFile();
    const normalizedUsers = (Array.isArray(store?.users) ? store.users : []).map((entry) => {
        const id = String(entry?.id || '').trim();
        const nickname = sanitizeNickname(entry?.nickname);
        const faceProfile = normalizeFaceProfile(entry);
        const opencvProfile = normalizeOpenCvProfile(entry);
        if (!id || !nickname || (!faceProfile && !opencvProfile)) return null;
        return {
            id,
            nickname,
            faceProfile: faceProfile || undefined,
            faceDescriptors: faceProfile?.samples || [],
            faceDescriptor: faceProfile?.centroid || null,
            opencvProfile: opencvProfile || undefined,
            opencvVectors: opencvProfile?.samples || [],
            opencvVector: opencvProfile?.centroid || null,
            createdAt: Number.isFinite(Number(entry?.createdAt)) ? Number(entry.createdAt) : Date.now(),
            updatedAt: Number.isFinite(Number(entry?.updatedAt)) ? Number(entry.updatedAt) : Date.now(),
            lastSeenAt: Number.isFinite(Number(entry?.lastSeenAt)) ? Number(entry.lastSeenAt) : null
        };
    }).filter(Boolean);

    const tempFile = `${faceProfileStoreFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify({ users: normalizedUsers }, null, 2));
    fs.renameSync(tempFile, faceProfileStoreFile);
}

function hasRecentPasswordVerification(req) {
    const verifiedAt = Number(req.session?.passwordVerifiedAt || 0);
    return Number.isFinite(verifiedAt) && verifiedAt > 0 && Date.now() - verifiedAt <= PASSWORD_GATE_TTL_MS;
}

function isLocalOrHttpRequest(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const proto = forwardedProto || (req.secure ? 'https' : 'http');
    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const hostNoPort = hostHeader.replace(/:\d+$/, '').trim().toLowerCase();

    const isHttp = proto === 'http';
    const isLocalHost = hostNoPort === 'localhost' || hostNoPort === '127.0.0.1' || hostNoPort === '::1' || hostNoPort === '[::1]' || hostNoPort.endsWith('.local');
    const isPrivateIpv4 = /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostNoPort)
        || /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostNoPort)
        || /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostNoPort);

    return isHttp || isLocalHost || isPrivateIpv4;
}

function findBestFaceMatch(inputDescriptor) {
    const bestMatch = findBestFaceCandidate(inputDescriptor);
    if (!bestMatch) return null;
    if (bestMatch.distance > FACE_MATCH_THRESHOLD) return null;
    if (bestMatch.margin !== null && bestMatch.margin < FACE_MATCH_MARGIN) return null;
    return bestMatch;
}

function findBestFaceMatchFromSet(descriptors) {
    if (!Array.isArray(descriptors) || !descriptors.length) return null;
    const tally = new Map();
    for (const descriptor of descriptors) {
        const match = findBestFaceMatch(descriptor);
        if (!match) continue;
        const key = match.user.id;
        const current = tally.get(key) || {
            user: match.user,
            totalDistance: 0,
            count: 0
        };
        current.totalDistance += Number(match.distance || 0);
        current.count += 1;
        tally.set(key, current);
    }
    if (!tally.size) return null;

    let best = null;
    for (const item of tally.values()) {
        const avgDistance = item.totalDistance / item.count;
        if (!best) {
            best = { user: item.user, votes: item.count, distance: avgDistance };
            continue;
        }
        if (item.count > best.votes || (item.count === best.votes && avgDistance < best.distance)) {
            best = { user: item.user, votes: item.count, distance: avgDistance };
        }
    }
    if (!best) return null;
    if (best.votes < Math.max(2, Math.ceil(descriptors.length / 2))) return null;
    return best;
}

function findBestFaceCandidate(inputDescriptor) {
    const descriptor = sanitizeFaceDescriptor(inputDescriptor);
    if (!descriptor) return null;

    const store = readFaceProfileStore();
    let bestMatch = null;
    let secondBestDistance = Number.POSITIVE_INFINITY;
    for (const user of store.users) {
        const distance = faceProfileDistance(descriptor, user.faceProfile);
        if (!Number.isFinite(distance)) continue;
        if (!bestMatch || distance < bestMatch.distance) {
            if (bestMatch && Number.isFinite(bestMatch.distance)) {
                secondBestDistance = Math.min(secondBestDistance, bestMatch.distance);
            }
            bestMatch = { user, distance };
        } else {
            secondBestDistance = Math.min(secondBestDistance, distance);
        }
    }
    if (!bestMatch) return null;
    bestMatch.margin = Number.isFinite(secondBestDistance)
        ? secondBestDistance - bestMatch.distance
        : null;
    return bestMatch;
}

function findBestOpenCvCandidate(inputVector) {
    const vector = sanitizeOpenCvVector(inputVector);
    if (!vector) return null;

    const store = readFaceProfileStore();
    let bestMatch = null;
    let secondBestDistance = Number.POSITIVE_INFINITY;
    for (const user of store.users) {
        const profile = normalizeOpenCvProfile(user);
        if (!profile) continue;
        const distance = openCvVectorDistance(vector, profile.centroid);
        if (!Number.isFinite(distance)) continue;
        if (!bestMatch || distance < bestMatch.distance) {
            if (bestMatch && Number.isFinite(bestMatch.distance)) {
                secondBestDistance = Math.min(secondBestDistance, bestMatch.distance);
            }
            bestMatch = { user, distance };
        } else {
            secondBestDistance = Math.min(secondBestDistance, distance);
        }
    }
    if (!bestMatch) return null;
    bestMatch.margin = Number.isFinite(secondBestDistance)
        ? secondBestDistance - bestMatch.distance
        : null;
    return bestMatch;
}

function findBestOpenCvMatch(inputVector) {
    const candidate = findBestOpenCvCandidate(inputVector);
    if (!candidate) return null;
    if (candidate.distance > FACE_OPENCV_MATCH_THRESHOLD) return null;
    if (candidate.margin !== null && candidate.margin < FACE_OPENCV_MARGIN) return null;
    return candidate;
}

async function getOpenCvProbeFromRequestImages(body) {
    const incoming = Array.isArray(body?.images) ? body.images : (body?.image ? [body.image] : []);
    const imageStrings = incoming
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, FACE_OPENCV_MAX_IMAGES);
    if (!imageStrings.length) return null;

    const vectors = [];
    for (const imageText of imageStrings) {
        const dataPart = imageText.includes(',') ? imageText.split(',').pop() : imageText;
        if (!dataPart) continue;
        let imageBuffer = null;
        try {
            imageBuffer = Buffer.from(dataPart, 'base64');
        } catch (error) {
            imageBuffer = null;
        }
        if (!imageBuffer || imageBuffer.length < 128) continue;
        const vector = await extractFaceVectorWithOpenCvJs(imageBuffer);
        const sanitized = sanitizeOpenCvVector(vector);
        if (sanitized) vectors.push(sanitized);
    }
    if (!vectors.length) return null;
    const centroid = averageOpenCvVectors(vectors);
    if (!centroid) return null;
    return { vector: centroid, vectors };
}

function refreshFaceProfileWithDescriptor(user, descriptor) {
    const sample = sanitizeFaceDescriptor(descriptor);
    if (!user || !sample) return user;
    const profile = normalizeFaceProfile(user);
    if (!profile) return user;

    const samples = [...profile.samples];
    const isDuplicate = samples.some((existing) => faceDistance(existing, sample) <= FACE_PROFILE_DEDUP_DISTANCE);
    if (!isDuplicate) samples.push(sample);
    const trimmed = samples.slice(-FACE_PROFILE_MAX_SAMPLES);
    const centroid = averageFaceDescriptors(trimmed) || profile.centroid;
    return {
        ...user,
        faceProfile: {
            version: 2,
            samples: trimmed,
            centroid
        },
        faceDescriptors: trimmed,
        faceDescriptor: centroid
    };
}

function touchFaceProfileLastSeen(userId, descriptor) {
    const id = String(userId || '').trim();
    if (!id) return;
    const store = readFaceProfileStore();
    const now = Date.now();
    const idx = store.users.findIndex((entry) => entry.id === id);
    if (idx < 0) return;
    const refreshed = refreshFaceProfileWithDescriptor(store.users[idx], descriptor);
    store.users[idx] = {
        ...store.users[idx],
        ...refreshed,
        lastSeenAt: now,
        updatedAt: now
    };
    writeFaceProfileStore(store);
}

function getFaceProbeFromRequest(body) {
    const setFromList = sanitizeFaceDescriptorSet(body?.descriptors || []);
    const single = sanitizeFaceDescriptor(body?.descriptor);
    const descriptors = [...setFromList];
    if (single) {
        const duplicate = descriptors.some((entry) => faceDistance(entry, single) <= FACE_PROFILE_DEDUP_DISTANCE);
        if (!duplicate) descriptors.push(single);
    }
    if (!descriptors.length) return null;
    const descriptor = averageFaceDescriptors(descriptors);
    if (!descriptor) return null;
    return { descriptor, descriptors };
}

// --- authentication routes ---
app.post('/login/password', (req, res) => {
    const pwd = String(req.body?.password || '');
    if (pwd !== PASSWORD) {
        return res.status(401).json({ success: false, message: 'Invalid password' });
    }
    if (req.session) req.session.passwordVerifiedAt = Date.now();
    if (isLocalOrHttpRequest(req)) {
        establishAuthenticatedRequest(req, res, getSessionUserKey(req));
        return res.json({ success: true, requiresFaceScan: false, bypassedFaceScan: true });
    }
    return res.json({ success: true, requiresFaceScan: true });
});

app.post('/login', (req, res) => {
    const pwd = String(req.body?.password || '');
    if (pwd !== PASSWORD) {
        return res.status(401).json({ success: false, message: 'Invalid password' });
    }
    if (req.session) req.session.passwordVerifiedAt = Date.now();
    if (isLocalOrHttpRequest(req)) {
        establishAuthenticatedRequest(req, res, getSessionUserKey(req));
        return res.json({ success: true, requiresFaceScan: false, bypassedFaceScan: true });
    }
    return res.json({ success: true, requiresFaceScan: true });
});

app.post('/login/face', (req, res) => {
    const probe = getFaceProbeFromRequest(req.body);
    if (!probe?.descriptor) {
        return res.status(400).json({ success: false, message: 'Face descriptor is invalid.' });
    }

    const bestMatch = findBestFaceMatch(probe.descriptor) || findBestFaceMatchFromSet(probe.descriptors);
    if (!bestMatch) {
        return res.status(404).json({
            success: false,
            code: 'FACE_NOT_RECOGNIZED',
            message: 'Face not recognized. Please enroll as a new user.'
        });
    }

    establishAuthenticatedRequest(req, res, bestMatch.user.id);
    touchFaceProfileLastSeen(bestMatch.user.id, probe.descriptor);
    return res.json({
        success: true,
        userId: bestMatch.user.id,
        nickname: bestMatch.user.nickname
    });
});

app.post('/login/face-opencv', async (req, res) => {
    try {
        const probe = await getOpenCvProbeFromRequestImages(req.body);
        if (!probe?.vector) {
            return res.status(400).json({ success: false, message: 'No valid face image was detected.' });
        }
        const bestMatch = findBestOpenCvMatch(probe.vector);
        if (!bestMatch) {
            return res.status(404).json({
                success: false,
                code: 'FACE_NOT_RECOGNIZED',
                message: 'Face not recognized. Please enroll as a new user.'
            });
        }

        establishAuthenticatedRequest(req, res, bestMatch.user.id);
        const store = readFaceProfileStore();
        const idx = store.users.findIndex((entry) => entry.id === bestMatch.user.id);
        if (idx >= 0) {
            const now = Date.now();
            const existingProfile = normalizeOpenCvProfile(store.users[idx]) || { samples: [], centroid: probe.vector };
            const samples = [...existingProfile.samples];
            const isDuplicate = samples.some((entry) => openCvVectorDistance(entry, probe.vector) <= 0.04);
            if (!isDuplicate) samples.push(probe.vector);
            const trimmed = samples.slice(-FACE_OPENCV_MAX_IMAGES);
            store.users[idx] = {
                ...store.users[idx],
                opencvProfile: {
                    version: 1,
                    samples: trimmed,
                    centroid: averageOpenCvVectors(trimmed) || probe.vector
                },
                opencvVectors: trimmed,
                opencvVector: averageOpenCvVectors(trimmed) || probe.vector,
                lastSeenAt: now,
                updatedAt: now
            };
            writeFaceProfileStore(store);
        }

        return res.json({
            success: true,
            userId: bestMatch.user.id,
            nickname: bestMatch.user.nickname
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/login/enroll', (req, res) => {
    const probe = getFaceProbeFromRequest(req.body);
    const nickname = sanitizeNickname(req.body?.nickname);
    const password = String(req.body?.password || '');
    const isPasswordAllowed = password === PASSWORD || hasRecentPasswordVerification(req);

    if (!isPasswordAllowed) {
        return res.status(401).json({
            success: false,
            message: 'Password verification required before enrollment.'
        });
    }
    if (!probe?.descriptor) {
        return res.status(400).json({ success: false, message: 'Face descriptor is invalid.' });
    }
    if (probe.descriptors.length < FACE_PROFILE_MIN_SAMPLES) {
        return res.status(400).json({
            success: false,
            message: `Please capture at least ${FACE_PROFILE_MIN_SAMPLES} stable face samples before enrollment.`
        });
    }
    if (!nickname || !/^[A-Za-z0-9 _.-]{2,32}$/.test(nickname)) {
        return res.status(400).json({
            success: false,
            message: 'Nickname must be 2-32 chars and use letters, numbers, spaces, ., _, or -.'
        });
    }

    const existing = findBestFaceMatch(probe.descriptor);
    if (existing) {
        return res.status(409).json({
            success: false,
            message: 'This face is already enrolled.',
            userId: existing.user.id,
            nickname: existing.user.nickname
        });
    }

    const store = readFaceProfileStore();
    const now = Date.now();
    const userId = `user_${crypto.randomBytes(8).toString('hex')}`;
    store.users.push({
        id: userId,
        nickname,
        faceProfile: {
            version: 2,
            samples: probe.descriptors.slice(0, FACE_PROFILE_MAX_SAMPLES),
            centroid: probe.descriptor
        },
        faceDescriptors: probe.descriptors.slice(0, FACE_PROFILE_MAX_SAMPLES),
        faceDescriptor: probe.descriptor,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now
    });
    writeFaceProfileStore(store);

    establishAuthenticatedRequest(req, res, userId);
    return res.json({
        success: true,
        userId,
        nickname
    });
});

app.post('/login/enroll-opencv', async (req, res) => {
    try {
        const probe = await getOpenCvProbeFromRequestImages(req.body);
        const nickname = sanitizeNickname(req.body?.nickname);
        const password = String(req.body?.password || '');
        const isPasswordAllowed = password === PASSWORD || hasRecentPasswordVerification(req);

        if (!isPasswordAllowed) {
            return res.status(401).json({
                success: false,
                message: 'Password verification required before enrollment.'
            });
        }
        if (!probe?.vector || !Array.isArray(probe.vectors) || !probe.vectors.length) {
            return res.status(400).json({ success: false, message: 'No valid face image was detected for enrollment.' });
        }
        if (!nickname || !/^[A-Za-z0-9 _.-]{2,32}$/.test(nickname)) {
            return res.status(400).json({
                success: false,
                message: 'Nickname must be 2-32 chars and use letters, numbers, spaces, ., _, or -.'
            });
        }

        const existing = findBestOpenCvMatch(probe.vector);
        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'This face is already enrolled.',
                userId: existing.user.id,
                nickname: existing.user.nickname
            });
        }

        const store = readFaceProfileStore();
        const now = Date.now();
        const userId = `user_${crypto.randomBytes(8).toString('hex')}`;
        const samples = probe.vectors.slice(0, FACE_OPENCV_MAX_IMAGES);
        const centroid = averageOpenCvVectors(samples) || probe.vector;
        store.users.push({
            id: userId,
            nickname,
            opencvProfile: {
                version: 1,
                samples,
                centroid
            },
            opencvVectors: samples,
            opencvVector: centroid,
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now
        });
        writeFaceProfileStore(store);

        establishAuthenticatedRequest(req, res, userId);
        return res.json({
            success: true,
            userId,
            nickname
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
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
    establishAuthenticatedRequest(req, res, consumed.ownerSessionId);
    return res.redirect('/chat.html');
});

app.post('/api/quick-signin-token/revoke', requireWhitelistedIp, requireAuth, (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) {
        return res.status(400).json({ error: { message: 'token is required.' } });
    }
    const revoked = revokeQuickSigninToken(token, getSessionUserKey(req));
    if (!revoked) {
        return res.status(404).json({ error: { message: 'Token not found or already expired.' } });
    }
    return res.json({ success: true });
});

app.get('/api/auth/me', requireWhitelistedIp, requireAuth, (req, res) => {
    const userId = getSessionUserKey(req);
    const store = readFaceProfileStore();
    const profile = store.users.find((entry) => entry.id === userId) || null;
    return res.json({
        success: true,
        userId,
        nickname: profile?.nickname || null,
        hasFaceProfile: Boolean(profile)
    });
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
            model: req.body?.model || 'qwen3-235b-a22b-thinking-2507',
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

app.post('/api/voice/ardy', requireWhitelistedIp, requireAuth, async (req, res) => {
    return res.status(501).json({
        error: {
            message: 'Voice synthesis is temporarily disabled in this deployment.'
        }
    });
});

app.post('/api/faces/match-batch', requireWhitelistedIp, requireAuth, (req, res) => {
    const incoming = Array.isArray(req.body?.descriptors)
        ? req.body.descriptors
        : (req.body?.descriptor ? [req.body.descriptor] : []);
    const descriptors = incoming.slice(0, 6);

    if (!descriptors.length) {
        return res.status(400).json({
            error: { message: 'descriptors is required and must contain at least one descriptor.' }
        });
    }

    const matches = descriptors.map((rawDescriptor, index) => {
        const descriptor = sanitizeFaceDescriptor(rawDescriptor);
        if (!descriptor) {
            return {
                index,
                matched: false,
                invalid: true
            };
        }

        const candidate = findBestFaceCandidate(descriptor);
        const isMatch = Boolean(candidate && Number.isFinite(candidate.distance) && candidate.distance <= FACE_MATCH_THRESHOLD);
        return {
            index,
            matched: isMatch,
            distance: candidate?.distance ?? null,
            threshold: FACE_MATCH_THRESHOLD,
            userId: isMatch ? candidate.user.id : null,
            nickname: isMatch ? candidate.user.nickname : null
        };
    });

    return res.json({
        ok: true,
        count: matches.length,
        matches,
        scannedAt: new Date().toISOString()
    });
});

function pruneHostedImages() {
    const now = Date.now();
    for (const [id, item] of hostedImages.entries()) {
        if (!item || !item.expiresAt || item.expiresAt <= now) {
            hostedImages.delete(id);
        }
    }
    if (hostedImages.size <= HOSTED_IMAGE_MAX_ITEMS) return;
    const ordered = [...hostedImages.entries()].sort((a, b) => (a[1]?.createdAt || 0) - (b[1]?.createdAt || 0));
    const overflow = hostedImages.size - HOSTED_IMAGE_MAX_ITEMS;
    for (let i = 0; i < overflow; i += 1) {
        hostedImages.delete(ordered[i][0]);
    }
}

function safeCompareSecret(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8');
    const right = Buffer.from(String(b || ''), 'utf8');
    if (left.length === 0 || right.length === 0 || left.length !== right.length) return false;
    try {
        return crypto.timingSafeEqual(left, right);
    } catch (error) {
        return false;
    }
}

function hasValidCamIngestKey(req) {
    if (!CAM_INGEST_KEY) return false;
    const fromHeader = String(req.headers['x-cam-key'] || '').trim();
    const fromQuery = String(req.query?.key || '').trim();
    const provided = fromHeader || fromQuery;
    return safeCompareSecret(provided, CAM_INGEST_KEY);
}

function isCamFrameFresh() {
    if (!latestCamFrame || !latestCamFrame.receivedAt) return false;
    return Date.now() - latestCamFrame.receivedAt <= CAM_FRAME_TTL_MS;
}

function writeMjpegFrame(res, frame) {
    if (!frame?.buffer || !Buffer.isBuffer(frame.buffer)) return;
    const mimeType = String(frame.mimeType || 'image/jpeg').toLowerCase();
    res.write(`--frame\r\nContent-Type: ${mimeType}\r\nContent-Length: ${frame.buffer.length}\r\n\r\n`);
    res.write(frame.buffer);
    res.write('\r\n');
}

function broadcastCamFrame(frame) {
    for (const client of camMjpegClients) {
        try {
            writeMjpegFrame(client, frame);
        } catch (error) {
            try {
                client.end();
            } catch (innerError) {
                // no-op
            }
            camMjpegClients.delete(client);
        }
    }
}

async function loadOpenCvJs() {
    if (cvInstance) return cvInstance;
    if (!cvLoadPromise) {
        cvLoadPromise = (async () => {
            const opencvModule = await import('@techstark/opencv-js');
            let cv = opencvModule?.default || opencvModule;
            if (cv && typeof cv.then === 'function') {
                cv = await cv;
            }
            if (!cv || typeof cv.Mat !== 'function') {
                throw new Error('Failed to initialize OpenCV.js runtime.');
            }
            return cv;
        })();
    }
    try {
        cvInstance = await cvLoadPromise;
    } catch (error) {
        // Allow future retries if initial WASM/module load failed.
        cvLoadPromise = null;
        cvInstance = null;
        throw error;
    }
    return cvInstance;
}

async function ensureOpenCvJsReady() {
    const now = Date.now();
    const retryWindowMs = 10000;
    if (opencvJsReady) return true;
    if (opencvJsReadyChecked && now - opencvJsLastInitAttemptAt < retryWindowMs) {
        return false;
    }
    opencvJsReadyChecked = true;
    opencvJsLastInitAttemptAt = now;

    try {
        const resolveCascadePath = async () => {
            if (OPENCV_JS_HAAR_CASCADE) {
                if (fs.existsSync(OPENCV_JS_HAAR_CASCADE)) return OPENCV_JS_HAAR_CASCADE;
                throw new Error(`Configured OPENCV_JS_HAAR_CASCADE not found at ${OPENCV_JS_HAAR_CASCADE}`);
            }
            if (fs.existsSync(OPENCV_CASCADE_BUNDLED_PATH)) {
                return OPENCV_CASCADE_BUNDLED_PATH;
            }
            if (fs.existsSync(OPENCV_CASCADE_TMP_PATH)) {
                return OPENCV_CASCADE_TMP_PATH;
            }

            const response = await fetch(OPENCV_CASCADE_DOWNLOAD_URL, { method: 'GET' });
            if (!response.ok) {
                throw new Error(`Cascade download failed: ${response.status} ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            if (!buffer.length) {
                throw new Error('Cascade download returned empty payload.');
            }
            fs.writeFileSync(OPENCV_CASCADE_TMP_PATH, buffer);
            return OPENCV_CASCADE_TMP_PATH;
        };

        opencvJsCascadeHostPath = await resolveCascadePath();

        const cv = await loadOpenCvJs();
        const cascadeData = fs.readFileSync(opencvJsCascadeHostPath);
        if (!cv.FS.analyzePath('/').exists) {
            cv.FS.mkdir('/');
        }
        if (cv.FS.analyzePath(opencvJsCascadePath).exists) {
            cv.FS.unlink(opencvJsCascadePath);
        }
        cv.FS_createDataFile('/', path.basename(opencvJsCascadePath), cascadeData, true, false, false);
        opencvJsReady = true;
        opencvJsLastInitError = '';
        console.log(`[CAM DETECT] OpenCV.js ready (cascade=${opencvJsCascadeHostPath}).`);
    } catch (error) {
        opencvJsLastInitError = String(error?.message || 'init-failed');
        console.error(`[CAM DETECT] OpenCV.js init failed: ${opencvJsLastInitError}`);
        opencvJsReady = false;
    }
    return opencvJsReady;
}

async function decodeJpegToMat(frameBuffer) {
    const cv = await loadOpenCvJs();
    const decoded = jpeg.decode(frameBuffer, { useTArray: true });
    if (!decoded || !decoded.width || !decoded.height || !decoded.data) {
        throw new Error('Failed to decode JPEG buffer.');
    }
    const imageData = {
        data: new Uint8ClampedArray(decoded.data),
        width: decoded.width,
        height: decoded.height
    };
    return cv.matFromImageData(imageData);
}

function detectLargestFaceRect(cv, grayMat, classifier) {
    const faces = new cv.RectVector();
    const minSize = new cv.Size(40, 40);
    const maxSize = new cv.Size(0, 0);
    classifier.detectMultiScale(grayMat, faces, 1.1, 4, 0, minSize, maxSize);

    let largest = null;
    let largestArea = 0;
    for (let i = 0; i < faces.size(); i += 1) {
        const rect = faces.get(i);
        const area = rect.width * rect.height;
        if (area > largestArea) {
            largestArea = area;
            largest = {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height
            };
        }
    }

    faces.delete();
    return largest;
}

async function extractFaceVectorWithOpenCvJs(frameBuffer) {
    const ready = await ensureOpenCvJsReady();
    if (!ready) throw new Error('OpenCV.js is not ready.');

    const cv = await loadOpenCvJs();
    const mat = await decodeJpegToMat(frameBuffer);
    const gray = new cv.Mat();
    const classifier = new cv.CascadeClassifier();
    try {
        cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY, 0);
        cv.equalizeHist(gray, gray);
        if (!classifier.load(opencvJsCascadePath)) {
            throw new Error('Failed to load Haar cascade in OpenCV.js.');
        }

        const largest = detectLargestFaceRect(cv, gray, classifier);
        if (!largest) {
            throw new Error('No face detected.');
        }

        const faceRoi = gray.roi(largest);
        const resized = new cv.Mat();
        cv.resize(faceRoi, resized, new cv.Size(16, 16), 0, 0, cv.INTER_AREA);
        const pixels = Array.from(resized.data || []);
        faceRoi.delete();
        resized.delete();
        if (!pixels.length) {
            throw new Error('Face vector extraction failed.');
        }

        const mean = pixels.reduce((acc, v) => acc + Number(v || 0), 0) / pixels.length;
        const variance = pixels.reduce((acc, v) => {
            const d = Number(v || 0) - mean;
            return acc + d * d;
        }, 0) / pixels.length;
        const std = Math.sqrt(Math.max(variance, 1e-12));

        return pixels.map((v) => (Number(v || 0) - mean) / std);
    } finally {
        classifier.delete();
        gray.delete();
        mat.delete();
    }
}

async function detectPeopleCountWithOpenCvJs(frameBuffer) {
    const ready = await ensureOpenCvJsReady();
    if (!ready) throw new Error('OpenCV.js is not ready.');

    const cv = await loadOpenCvJs();
    const mat = await decodeJpegToMat(frameBuffer);
    const gray = new cv.Mat();
    const classifier = new cv.CascadeClassifier();
    try {
        cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY, 0);
        cv.equalizeHist(gray, gray);
        if (!classifier.load(opencvJsCascadePath)) {
            throw new Error('Failed to load Haar cascade in OpenCV.js.');
        }

        const faces = new cv.RectVector();
        const minSize = new cv.Size(40, 40);
        const maxSize = new cv.Size(0, 0);
        classifier.detectMultiScale(gray, faces, 1.1, 4, 0, minSize, maxSize);
        const count = faces.size();
        faces.delete();
        return Math.max(0, Number(count || 0));
    } finally {
        classifier.delete();
        gray.delete();
        mat.delete();
    }
}

async function detectPeopleCountFromFrame(frameBuffer) {
    if (CAM_DETECT_BACKEND === 'opencv-js') {
        return detectPeopleCountWithOpenCvJs(frameBuffer);
    }
    throw new Error(`Unsupported CAM_DETECT_BACKEND: ${CAM_DETECT_BACKEND}`);
}

async function detectAndPublishPeopleCount(frameBuffer) {
    if (!CAM_DETECT_ENABLED) return { attempted: false, skipped: 'disabled' };
    if (!arduinoService) return { attempted: false, skipped: 'arduino-service-unavailable' };

    const now = Date.now();
    if (now - lastCamDetectionAtMs < CAM_DETECT_INTERVAL_MS) {
        return { attempted: false, skipped: 'interval' };
    }
    lastCamDetectionAtMs = now;

    const detectedPeople = await detectPeopleCountFromFrame(frameBuffer);
    const changed = detectedPeople !== lastPublishedDetectedPeople;
    if (changed) {
        await arduinoService.writeVariable({
            sessionId: GLOBAL_MACRO_RUNTIME_SESSION_ID,
            name: 'detectedPeople',
            value: detectedPeople,
            sourceMacroId: 'cam-opencv-js',
            sourceMacroName: 'cam-opencv-js'
        });
        lastPublishedDetectedPeople = detectedPeople;
    }
    return { attempted: true, detectedPeople, changed };
}

app.post('/api/cam/push-frame', express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: `${CAM_MAX_FRAME_BYTES}b` }), async (req, res) => {
    if (!hasValidCamIngestKey(req)) {
        return res.status(401).json({ error: { message: 'Invalid camera ingest key.' } });
    }

    const body = req.body;
    const frameBuffer = Buffer.isBuffer(body) ? body : null;
    if (!frameBuffer || frameBuffer.length === 0) {
        return res.status(400).json({ error: { message: 'Request body must contain raw JPEG bytes.' } });
    }
    if (frameBuffer.length > CAM_MAX_FRAME_BYTES) {
        return res.status(413).json({ error: { message: `Frame too large. Max ${CAM_MAX_FRAME_BYTES} bytes.` } });
    }

    const contentType = String(req.headers['content-type'] || 'image/jpeg').toLowerCase();
    const mimeType = contentType.startsWith('image/') ? contentType : 'image/jpeg';
    latestCamFrame = {
        buffer: frameBuffer,
        mimeType,
        receivedAt: Date.now()
    };
    broadcastCamFrame(latestCamFrame);

    let detection = { attempted: false, skipped: 'disabled' };
    try {
        detection = await detectAndPublishPeopleCount(frameBuffer);
    } catch (error) {
        detection = { attempted: true, error: error.message };
        console.error(`[CAM DETECT] ${error.message}`);
    }

    return res.json({
        ok: true,
        bytes: frameBuffer.length,
        receivedAt: new Date(latestCamFrame.receivedAt).toISOString(),
        detection
    });
});

app.get('/api/cam/latest.jpg', (req, res) => {
    if (!isCamFrameFresh()) {
        return res.status(404).json({ error: { message: 'No recent camera frame available.' } });
    }
    res.setHeader('Content-Type', latestCamFrame.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.send(latestCamFrame.buffer);
});

app.get('/api/cam/stream.mjpeg', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    camMjpegClients.add(res);
    if (isCamFrameFresh()) {
        writeMjpegFrame(res, latestCamFrame);
    }

    req.on('close', () => {
        camMjpegClients.delete(res);
    });
});

app.post('/api/image-upload', requireWhitelistedIp, requireAuth, (req, res) => {
    pruneHostedImages();
    const mimeType = String(req.body?.mimeType || '').trim().toLowerCase();
    const base64Data = String(req.body?.base64Data || '').trim();
    if (!mimeType.startsWith('image/')) {
        return res.status(400).json({ error: { message: 'mimeType must be an image/* type.' } });
    }
    if (!base64Data) {
        return res.status(400).json({ error: { message: 'base64Data is required.' } });
    }

    let buffer = null;
    try {
        buffer = Buffer.from(base64Data, 'base64');
    } catch (error) {
        return res.status(400).json({ error: { message: 'Invalid base64 image payload.' } });
    }
    if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: { message: 'Decoded image payload is empty.' } });
    }
    if (buffer.length > HOSTED_IMAGE_MAX_BYTES) {
        return res.status(413).json({ error: { message: `Image too large. Max ${HOSTED_IMAGE_MAX_BYTES} bytes.` } });
    }

    const now = Date.now();
    const id = `img_${crypto.randomBytes(18).toString('hex')}`;
    hostedImages.set(id, {
        createdAt: now,
        expiresAt: now + HOSTED_IMAGE_TTL_MS,
        mimeType,
        buffer
    });

    const origin = getRequestOrigin(req);
    return res.json({
        ok: true,
        id,
        url: `${origin}/public-image/${id}`,
        expiresAt: new Date(now + HOSTED_IMAGE_TTL_MS).toISOString()
    });
});

app.get('/public-image/:id', (req, res) => {
    pruneHostedImages();
    const id = String(req.params?.id || '').trim();
    const entry = hostedImages.get(id);
    if (!entry) {
        return res.status(404).send('Image not found or expired.');
    }
    res.setHeader('Content-Type', entry.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(entry.buffer);
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

arduinoService = createArduinoService({
    dataDir,
    onVariableWrite: handleMacroVariableWriteEvent
});

registerArduinoRestRoutes(app, {
    requireWhitelistedIp,
    requireAuth,
    dataDir,
    service: arduinoService,
    resolveSessionId: getSessionUserKey
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

app.get('/api/opencv-js/health', requireWhitelistedIp, requireAuth, async (req, res) => {
    const ready = await ensureOpenCvJsReady();
    return res.json({
        ready,
        backend: CAM_DETECT_BACKEND,
        cascadePathConfigured: OPENCV_JS_HAAR_CASCADE || null,
        cascadePathResolved: opencvJsCascadeHostPath || null,
        cascadeExists: Boolean(opencvJsCascadeHostPath && fs.existsSync(opencvJsCascadeHostPath)),
        cascadeDownloadUrl: OPENCV_CASCADE_DOWNLOAD_URL,
        lastInitAttemptAt: opencvJsLastInitAttemptAt ? new Date(opencvJsLastInitAttemptAt).toISOString() : null,
        lastInitError: opencvJsLastInitError || null
    });
});

app.get('/api/macros', requireWhitelistedIp, requireAuth, (req, res) => {
    const store = readMacroStore();
    return res.json({
        macros: getGlobalMacros(store)
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
    const existing = getGlobalMacros(store);
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
    setGlobalMacros(store, macros, now);
    writeMacroStore(store);
    console.log(`[Macro] create id=${macro.id} name="${macro.name}" enabled=${macro.enabled} state=${macro.runtimeState}`);
    return res.json({ ok: true, macro, macros });
});

app.put('/api/macros/:id', requireWhitelistedIp, requireAuth, (req, res) => {
    const macroId = String(req.params?.id || '').trim();
    if (!macroId) return res.status(400).json({ error: { message: 'macro id is required' } });

    const store = readMacroStore();
    const macros = getGlobalMacros(store);
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
    setGlobalMacros(store, sanitized, Date.now());
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
    const macros = getGlobalMacros(store);
    const filtered = macros.filter((macro) => macro.id !== macroId);
    setGlobalMacros(store, filtered, Date.now());
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
        fs.writeFileSync(macroStoreFile, JSON.stringify({ macros: [], updatedAt: null }, null, 2));
    }
}

function readMacroStore() {
    ensureMacroStoreFile();
    try {
        const parsed = JSON.parse(fs.readFileSync(macroStoreFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return { macros: [], updatedAt: null };
        parsed.macros = collectGlobalMacros(parsed);
        if (!Number.isFinite(Number(parsed.updatedAt))) parsed.updatedAt = null;
        return parsed;
    } catch (error) {
        return { macros: [], updatedAt: null };
    }
}

function writeMacroStore(store) {
    ensureMacroStoreFile();
    fs.writeFileSync(macroStoreFile, JSON.stringify(store, null, 2));
}

function collectGlobalMacros(store) {
    if (!store || typeof store !== 'object') return [];
    if (Array.isArray(store.macros)) {
        return sanitizeMacros(store.macros);
    }
    if (!store.users || typeof store.users !== 'object') {
        return [];
    }
    const merged = [];
    for (const userState of Object.values(store.users)) {
        merged.push(...sanitizeMacros(userState?.macros || []));
    }
    return sanitizeMacros(merged);
}

function getGlobalMacros(store) {
    return collectGlobalMacros(store);
}

function setGlobalMacros(store, macros, updatedAt = Date.now()) {
    store.macros = sanitizeMacros(macros);
    store.updatedAt = Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : Date.now();
    if (store.users && typeof store.users === 'object') {
        delete store.users;
    }
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

function getMacroTimerKey(macroId) {
    return String(macroId || '');
}

function scheduleMacroToIdle(macroId) {
    const key = getMacroTimerKey(macroId);
    const existing = macroIdleTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
        try {
            const store = readMacroStore();
            const macros = getGlobalMacros(store);
            const idx = macros.findIndex((macro) => macro.id === macroId);
            if (idx === -1) return;
            if (macros[idx].enabled === false) return;
            macros[idx].runtimeState = 'idling';
            macros[idx].lastStateChangeAt = Date.now();
            macros[idx].lastRuntimeEvent = 'macro idling (no recent variable write)';
            macros[idx].updatedAt = Date.now();
            setGlobalMacros(store, macros, Date.now());
            writeMacroStore(store);
            console.log(`[Macro] idling id=${macroId}`);
        } catch (error) {
            console.error(`[Macro] failed to set idling id=${macroId}: ${error.message}`);
        } finally {
            macroIdleTimers.delete(key);
        }
    }, MACRO_FIRING_WINDOW_MS);

    macroIdleTimers.set(key, timer);
}

function handleMacroVariableWriteEvent(event) {
    const sourceMacroId = String(event?.sourceMacroId || '').trim();
    const sourceMacroName = String(event?.sourceMacroName || '').trim();
    const variableName = String(event?.variableName || '').trim();
    if (!sourceMacroId && !sourceMacroName) return;

    const store = readMacroStore();
    const macros = getGlobalMacros(store);
    const idx = sourceMacroId
        ? macros.findIndex((macro) => macro.id === sourceMacroId)
        : (sourceMacroName ? macros.findIndex((macro) => macro.name === sourceMacroName) : -1);

    if (idx === -1) {
        console.log(`[Macro] variable write has no macro match variable=${variableName}`);
        return;
    }

    const now = Date.now();
    const macro = macros[idx];
    macro.runtimeState = 'firing';
    macro.lastFiredAt = now;
    macro.lastStateChangeAt = now;
    macro.lastRuntimeEvent = `changed variable "${variableName}"`;
    macro.updatedAt = now;

    setGlobalMacros(store, macros, now);
    writeMacroStore(store);
    console.log(`[Macro] firing id=${macro.id} name="${macro.name}" variable=${variableName}`);

    scheduleMacroToIdle(macro.id);
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
    const macros = getGlobalMacros(store);
    let changed = false;

    for (const macro of macros) {
        if (!macro.enabled) continue;
        const didChange = await executeMacroRuntimeForOne({
            sessionId: GLOBAL_MACRO_RUNTIME_SESSION_ID,
            macro,
            arduinoService
        });
        if (didChange) changed = true;
    }

    if (changed) {
        setGlobalMacros(store, macros, Date.now());
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
            scheduleMacroToIdle(macro.id);
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
        if (!entry || entry.expiresAt <= now) {
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
        expiresAt: now + QUICK_SIGNIN_TTL_MS
    });
    return token;
}

function consumeQuickSigninToken(token) {
    pruneQuickSigninTokens();
    const entry = quickSigninTokens.get(token);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    return entry;
}

function revokeQuickSigninToken(token, requestSessionOwner) {
    pruneQuickSigninTokens();
    const entry = quickSigninTokens.get(token);
    if (!entry || entry.expiresAt <= Date.now()) return false;
    if (entry.ownerSessionId !== String(requestSessionOwner || '')) return false;
    quickSigninTokens.delete(token);
    return true;
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

function mergeThreads(existingThreads, incomingThreads) {
    const existing = sanitizeThreads(existingThreads);
    const incoming = sanitizeThreads(incomingThreads);
    const byId = new Map();

    existing.forEach((thread) => {
        byId.set(thread.id, thread);
    });

    incoming.forEach((thread) => {
        const prior = byId.get(thread.id);
        if (!prior) {
            byId.set(thread.id, thread);
            return;
        }
        const incomingUpdated = Number(thread.updatedAt || 0);
        const priorUpdated = Number(prior.updatedAt || 0);
        if (incomingUpdated >= priorUpdated) {
            byId.set(thread.id, thread);
        }
    });

    return [...byId.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
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
    const incomingThreads = sanitizeThreads(req.body?.threads);
    const requestedActiveThreadId = typeof req.body?.activeThreadId === 'string' ? req.body.activeThreadId : null;

    const store = readChatStore();
    const userKey = getSessionUserKey(req);
    const currentState = store.users[userKey] || { threads: [], activeThreadId: null };
    const threads = mergeThreads(currentState.threads, incomingThreads);
    const threadIds = new Set(threads.map((thread) => thread.id));
    const activeThreadId = threadIds.has(requestedActiveThreadId)
        ? requestedActiveThreadId
        : (threadIds.has(currentState.activeThreadId) ? currentState.activeThreadId : null);
    store.users[userKey] = {
        threads,
        activeThreadId,
        updatedAt: Date.now(),
    };
    writeChatStore(store);

    return res.json({ ok: true, threads, activeThreadId });
}

// Register both prefixed and unprefixed routes to support different mount styles.
['/api/chats', '/chats'].forEach((route) => {
    app.get(route, requireWhitelistedIp, requireAuth, getChatsHandler);
    app.put(route, requireWhitelistedIp, requireAuth, putChatsHandler);
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
