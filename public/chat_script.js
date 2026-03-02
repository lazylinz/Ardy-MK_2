const chatBody = document.querySelector(".chat-body");
const messageInput = document.querySelector(".message-input");
const sendMessage = document.querySelector("#send-message");
const fileInput = document.querySelector("#file-input");
const fileUploadWrapper = document.querySelector(".file-upload-wrapper");
const fileCancelButton = fileUploadWrapper.querySelector("#file-cancel");
const toolsBtn = document.querySelector("#tools-btn");
const toolsMenu = document.querySelector(".tools-menu");
const chatList = document.querySelector(".chat-list");
const newChatBtn = document.querySelector(".new-chat-btn");
const sidebarToggle = document.querySelector(".sidebar-toggle");
const modelSelect = document.querySelector("#model-select");
const multiAgentToggle = document.querySelector("#multi-agent-toggle");
const voiceInputButton = document.querySelector("#voice-input");
const quickSigninBtn = document.querySelector("#quick-signin-btn");
const quickSigninModal = document.querySelector("#quick-signin-modal");
const quickSigninClose = document.querySelector("#quick-signin-close");
const quickSigninQrImage = document.querySelector("#quick-signin-qr-image");
const quickSigninUrlText = document.querySelector("#quick-signin-url");
const viewerName = document.querySelector("#viewer-name");
const viewerId = document.querySelector("#viewer-id");

const CHAT_STATE_API_URL = "/api/chats";
const AUTH_ME_API_URL = "/api/auth/me";
const WEB_SEARCH_API_URL = "/api/web-search";
const VISIT_SITE_API_URL = "/api/visit-site";
const MACROS_API_URL = "/api/macros";
const ARDUINO_GET_ALL_VARIABLES_API_URL = "/api/arduino/get-all-variables";
const ARDUINO_READ_VARIABLE_API_URL = "/api/arduino/read-variable";
const ARDUINO_WRITE_VARIABLE_API_URL = "/api/arduino/write-variable";
const OS_TIME_API_URL = "/api/os/time";
const QUICK_SIGNIN_TOKEN_API_URL = "/api/quick-signin-token";
const CHAT_QUERY_PARAM = "chat";
const MODEL_STORAGE_KEY = "ardy_selected_text_model_v1";
const MULTI_AGENT_MODE_STORAGE_KEY = "ardy_multi_agent_mode_v1";

const IFLOW_PROXY_URL = "/api/iflow/chat";
const DEFAULT_MODEL = "glm-4.6";
const MODEL_VISION = "qwen3-vl-plus";
const MODEL_OPTIONS = [
    { id: "glm-4.6", label: "GLM 4.6" },
    { id: "iflow-rome-30ba3b", label: "iFlow ROME" },
    { id: "qwen3-coder-plus", label: "Qwen3 Coder Plus" },
    { id: "kimi-k2", label: "Kimi K2" },
    { id: "qwen3-vl-plus", label: "Qwen3 VL Plus (Vision)" }
];

const userData = {
    message: null,
    file: { data: null, mime_type: null, fileName: null },
    tool: null
};

let chatHistory = [];
let chatThreads = [];
let currentThreadId = null;
let saveTimeout = null;
let contextMenuThreadId = null;
let chatContextMenu = null;
let selectedTextModel = DEFAULT_MODEL;
let multiAgentMode = false;
let speechRecognition = null;
let isListeningToVoice = false;
let manualVoiceStop = false;
let finalVoiceTranscript = "";
let preferredArdyVoice = null;
let pendingVoiceReplyFromStt = false;
const initialInputHeight = messageInput.scrollHeight;

marked.setOptions({
    highlight: function (code, lang) {
        if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
    },
    breaks: true
});

const buildSystemPrompt = () => `You are Ardy,
an enthusiastic and knowledgeable AIOT agent
and creative companion for the Arduino ecosystem. Act like a helpful hands-on AIOT agent who uses tools to his use when he can.
You can create automation macros using the create_macro tool. A macro has a Lua trigger expression, a Then Lua script (trigger true), and an optional Else Lua script (trigger false).
When generating Lua macros, prefer built-in macro helpers:
- get_all_variables(): returns a table of all Arduino variables.
- read_variable(name): returns one variable value by name.
- write_variable(name, value): updates one variable.
- os.date/os.time/os.clock for time-based logic.
AI tools available for live operations: get-all-variables, read-variable, write-variable, os-time.

SPEAK ONLY THE LANGUAGE THE {{USER}} SPEAKS, NEVER BREAK CHARACTER.
You are based on ${selectedTextModel}`;

const createSystemMessage = () => ({
    role: "system",
    parts: [{ text: buildSystemPrompt() }],
    fileData: null,
    id: Date.now()
});

const createMessageElement = (content, ...classes) => {
    const div = document.createElement("div");
    div.classList.add("message", ...classes);
    div.innerHTML = content;
    return div;
};

const sanitizePreview = (text) => (text || "").replace(/\s+/g, " ").trim();

const getThreadTitle = (thread) => {
    const firstUser = (thread.history || []).find((entry) => entry.role === "user" && entry.parts?.[0]?.text);
    return firstUser ? sanitizePreview(firstUser.parts[0].text).slice(0, 36) || "New chat" : "New chat";
};

const getThreadPreview = (thread) => {
    const nonSystem = [...(thread.history || [])].reverse().find((entry) => entry.role !== "system" && entry.parts?.[0]?.text);
    return nonSystem ? sanitizePreview(nonSystem.parts[0].text).slice(0, 56) : "No messages yet";
};

const getModelById = (modelId) => MODEL_OPTIONS.find((m) => m.id === modelId);

const MALE_VOICE_HINTS = [
    "male", "man", "david", "mark", "daniel", "james", "john", "michael", "thomas",
    "matthew", "ryan", "aaron", "alex", "sam", "guy", "fred", "arthur"
];
const FEMALE_VOICE_HINTS = [
    "female", "woman", "zira", "susan", "samantha", "victoria", "allison", "jenny",
    "karen", "aria", "sonia"
];

const scoreVoiceForArdy = (voice) => {
    const name = String(voice?.name || "").toLowerCase();
    const lang = String(voice?.lang || "").toLowerCase();
    let score = 0;
    if (lang.startsWith("en")) score += 6;
    if (lang === "en-gb") score += 10;
    if (name.includes("google uk english male")) score += 100;
    if (MALE_VOICE_HINTS.some((hint) => name.includes(hint))) score += 8;
    if (FEMALE_VOICE_HINTS.some((hint) => name.includes(hint))) score -= 6;
    if (voice?.localService) score += 2;
    return score;
};

const pickPreferredArdyVoice = () => {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices?.length) return null;

    const exactGoogleUkMale = voices.find((voice) => String(voice?.name || "").toLowerCase() === "google uk english male");
    if (exactGoogleUkMale) return exactGoogleUkMale;

    let bestVoice = null;
    let bestScore = -Infinity;
    voices.forEach((voice) => {
        const score = scoreVoiceForArdy(voice);
        if (score > bestScore) {
            bestScore = score;
            bestVoice = voice;
        }
    });
    return bestVoice;
};

const stripMarkdownForSpeech = (text) => {
    if (!text) return "";
    const html = marked.parse(text);
    const container = document.createElement("div");
    container.innerHTML = html;
    return container.textContent.replace(/\s+/g, " ").trim();
};

const stopArdySpeech = () => {
    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }
};

const speakAsArdyFallback = (plainText) => {
    if (!plainText || !("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
    preferredArdyVoice = preferredArdyVoice || pickPreferredArdyVoice();
    const utterance = new SpeechSynthesisUtterance(plainText);
    if (preferredArdyVoice) {
        utterance.voice = preferredArdyVoice;
        utterance.lang = preferredArdyVoice.lang || "en-GB";
    } else {
        utterance.lang = "en-GB";
    }
    utterance.rate = 0.96;
    utterance.pitch = 0.86;
    utterance.volume = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
};

const renderVoiceReplyAfterThinking = async (incomingMessageDiv, messageElement, markdownText) => {
    const plainText = stripMarkdownForSpeech(markdownText).slice(0, 1400);
    messageElement.innerHTML = marked.parse(markdownText);
    if (plainText) {
        try {
            speakAsArdyFallback(plainText);
        } catch (error) {
            // Ignore speech engine failures and keep rendered text reply.
        }
    }
};

const submitMessageFromInput = ({ fromVoiceInput = false } = {}) => {
    const text = (messageInput.value || "").trim();
    if (!text) return;
    pendingVoiceReplyFromStt = Boolean(fromVoiceInput);
    handleOutgoingMessage({ preventDefault: () => {} });
};

const setVoiceInputUi = ({ listening, disabled, title, icon }) => {
    if (!voiceInputButton) return;
    voiceInputButton.disabled = Boolean(disabled);
    voiceInputButton.classList.toggle("listening", Boolean(listening));
    if (title) voiceInputButton.title = title;
    if (icon) voiceInputButton.textContent = icon;
};

const initializeVoiceInput = () => {
    if (!voiceInputButton) return;

    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
        setVoiceInputUi({
            listening: false,
            disabled: true,
            title: "Voice input is not supported on this browser",
            icon: "mic_off"
        });
        return;
    }

    speechRecognition = new SpeechRecognitionCtor();
    speechRecognition.lang = navigator.language || "en-US";
    speechRecognition.continuous = false;
    speechRecognition.interimResults = true;
    speechRecognition.maxAlternatives = 1;

    speechRecognition.onstart = () => {
        isListeningToVoice = true;
        finalVoiceTranscript = "";
        setVoiceInputUi({
            listening: true,
            disabled: false,
            title: "Stop voice input",
            icon: "radio_button_checked"
        });
    };

    speechRecognition.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            const transcript = result?.[0]?.transcript || "";
            if (result.isFinal) {
                finalVoiceTranscript += `${transcript} `;
            } else {
                interim += transcript;
            }
        }
        const composed = `${finalVoiceTranscript} ${interim}`.replace(/\s+/g, " ").trim();
        if (composed) {
            messageInput.value = composed;
            messageInput.dispatchEvent(new Event("input"));
        }
    };

    speechRecognition.onerror = () => {
        isListeningToVoice = false;
        setVoiceInputUi({
            listening: false,
            disabled: false,
            title: "Voice input",
            icon: "mic"
        });
    };

    speechRecognition.onend = () => {
        const transcript = finalVoiceTranscript.replace(/\s+/g, " ").trim();
        const shouldAutoSend = !manualVoiceStop && Boolean(transcript);
        manualVoiceStop = false;
        isListeningToVoice = false;
        finalVoiceTranscript = "";
        setVoiceInputUi({
            listening: false,
            disabled: false,
            title: "Voice input",
            icon: "mic"
        });

        if (shouldAutoSend) {
            messageInput.value = transcript;
            messageInput.dispatchEvent(new Event("input"));
            submitMessageFromInput({ fromVoiceInput: true });
        }
    };

    voiceInputButton.addEventListener("click", () => {
        if (!speechRecognition) return;
        if (isListeningToVoice) {
            manualVoiceStop = true;
            speechRecognition.stop();
            return;
        }
        try {
            speechRecognition.lang = navigator.language || "en-US";
            speechRecognition.start();
        } catch (error) {}
    });
};

const extractTextFromMessageContent = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === "string" ? part : part?.text || ""))
            .filter(Boolean)
            .join("\n");
    }
    return "";
};

const callIflowCompletion = async ({ model, messages, temperature = 0.4 }) => {
    const response = await fetch(IFLOW_PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages,
            temperature,
            stream: false
        })
    });

    const payload = await response.json().catch(() => null);
    const statusErr = getApiStatusError(payload);
    if (!response.ok || statusErr) {
        throw new Error(statusErr || `${response.status} ${response.statusText}`);
    }

    const choice = payload?.choices?.[0];
    const text = extractTextFromMessageContent(choice?.message?.content);
    if (!text) throw new Error("Empty response from model.");
    return text;
};

const streamIflowCompletion = async ({ model, messages, temperature = 0.4, onToken, tools, tool_choice }) => {
    const response = await fetch(IFLOW_PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages,
            temperature,
            stream: true,
            tools,
            tool_choice
        })
    });

    if (!response.ok) {
        let errText = `${response.status} ${response.statusText}`;
        try {
            const errJson = await response.json();
            errText = errJson.error?.message || errJson.msg || errText;
        } catch (e) {}
        throw new Error(errText);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
        let payload = null;
        try {
            payload = await response.json();
        } catch (e) {}
        const statusErr = getApiStatusError(payload);
        if (statusErr) throw new Error(statusErr);
        throw new Error("Unexpected non-stream response from model API.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let done = false;
    let buffer = "";
    let fullText = "";
    let toolCalls = [];

    while (!done) {
        const { value, done: readerDone } = await reader.read();
        if (value) {
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split(/\r?\n\r?\n/);
            buffer = parts.pop();

            for (const part of parts) {
                const line = part.trim();
                if (!line) continue;
                const dataStr = line.startsWith("data:") ? line.replace(/^data:\s*/, "") : line;
                if (dataStr === "[DONE]") {
                    done = true;
                    break;
                }

                const parsed = JSON.parse(dataStr);
                const statusErr = getApiStatusError(parsed);
                if (statusErr) throw new Error(statusErr);

                const choice = parsed.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta;

                if (delta?.tool_calls) {
                    const tc = delta.tool_calls[0];
                    if (!toolCalls[tc.index]) {
                        toolCalls[tc.index] = { id: "", type: "function", function: { name: "", arguments: "" } };
                    }
                    if (tc.id) toolCalls[tc.index].id += tc.id;
                    if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                    if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
                if (delta?.content) {
                    fullText += delta.content;
                    if (typeof onToken === "function") onToken(delta.content, fullText);
                }
            }
        }
        if (readerDone) break;
    }

    if (!fullText.trim() && toolCalls.length === 0) throw new Error("Empty streamed response from model.");
    return { text: fullText, toolCalls };
};

const callModelCompletion = async ({ model, messages, temperature = 0.4 }) =>
    callIflowCompletion({ model, messages, temperature });

const escapeHtml = (text) => String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const renderMultiAgentStreaming = (messageElement, sections, synthesisText) => {
    const blocks = sections.map((section) => `
        <div class="agent-stream-block ${section.status || "pending"}">
            <div class="agent-stream-head">${escapeHtml(section.role)} - ${escapeHtml(section.model)} (${escapeHtml(section.status || "pending")})</div>
            <div class="agent-stream-body">${escapeHtml(section.text || "")}</div>
        </div>
    `).join("");

    const synthesisBlock = `
        <div class="agent-stream-final">
            <div class="agent-stream-head">Final Synthesis</div>
            <div class="agent-stream-body">${escapeHtml(synthesisText || "")}</div>
        </div>
    `;

    messageElement.innerHTML = `<div class="agent-stream-wrap">${blocks}${synthesisBlock}</div>`;
};

const getApiStatusError = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    if (payload.error?.message) return payload.error.message;
    if (payload.msg && payload.status && String(payload.status) !== "200") {
        return payload.msg;
    }
    if (payload.status && String(payload.status) !== "200") {
        return `Request failed with status ${payload.status}`;
    }
    return null;
};

const renderApiError = (messageElement, errorText) => {
    const safeText = String(errorText || "Unknown error")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    messageElement.classList.add("error-bubble");
    messageElement.innerHTML = `
        <div class="error-head">
            <span class="material-symbols-rounded">error</span>
            Response failed
        </div>
        <div class="error-detail">${safeText}</div>
        <div class="error-detail">Model: ${selectedTextModel} (vision uses ${MODEL_VISION})</div>
    `;
};

const getCurrentReasoningLine = (reasoningText) => {
    if (!reasoningText) return "";
    const lines = reasoningText.split(/\r?\n/).map((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i]) return lines[i];
    }
    return "";
};

const syncCurrentSystemPromptModel = () => {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return;
    const firstSystem = chatHistory.find((entry) => entry.role === "system");
    if (!firstSystem || !firstSystem.parts?.[0]) return;

    firstSystem.parts[0].text = buildSystemPrompt();
    persistCurrentThread();
};

const initializeModelSelector = () => {
    if (!modelSelect) return;

    modelSelect.innerHTML = "";
    MODEL_OPTIONS.forEach((model) => {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.text || model.label;
        modelSelect.appendChild(option);
    });

    const savedModel = localStorage.getItem(MODEL_STORAGE_KEY);
    selectedTextModel = getModelById(savedModel)?.id || DEFAULT_MODEL;
    modelSelect.value = selectedTextModel;

    modelSelect.addEventListener("change", () => {
        const next = modelSelect.value;
        if (!getModelById(next)) {
            modelSelect.value = selectedTextModel;
            return;
        }
        selectedTextModel = next;
        localStorage.setItem(MODEL_STORAGE_KEY, selectedTextModel);
        syncCurrentSystemPromptModel();
    });
};

const initializeMultiAgentToggle = () => {
    if (!multiAgentToggle) return;
    multiAgentMode = localStorage.getItem(MULTI_AGENT_MODE_STORAGE_KEY) === "1";
    multiAgentToggle.classList.toggle("active", multiAgentMode);

    multiAgentToggle.addEventListener("click", () => {
        multiAgentMode = !multiAgentMode;
        multiAgentToggle.classList.toggle("active", multiAgentMode);
        localStorage.setItem(MULTI_AGENT_MODE_STORAGE_KEY, multiAgentMode ? "1" : "0");
    });
};

const updateThinkingStatus = (incomingMessageDiv, text) => {
    let box = incomingMessageDiv.querySelector(".thinking-box");
    if (!box) {
        box = document.createElement("div");
        box.className = "thinking-box thinking-active open";
        box.innerHTML = `
            <div class="thinking-box-header">
                <span>Thinking Process</span>
                <span class="thinking-live-line"></span>
                <span class="material-symbols-outlined toggle-icon">expand_more</span>
            </div>
            <div class="thinking-box-content"></div>
        `;
        const messageElement = incomingMessageDiv.querySelector(".message-text");
        messageElement.parentElement.insertBefore(box, messageElement);
        box.querySelector(".thinking-box-header").addEventListener("click", () => box.classList.toggle("open"));
    }
    const live = box.querySelector(".thinking-live-line");
    const content = box.querySelector(".thinking-box-content");
    if (live) live.textContent = text;
    if (content) {
        content.textContent = content.textContent ? `${content.textContent}\n${text}` : text;
    }
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
};

const getCurrentChatIdFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get(CHAT_QUERY_PARAM);
    return id && id.trim() ? id.trim() : null;
};

const shortenUserId = (userId) => {
    const raw = String(userId || "").trim();
    if (!raw) return "unknown";
    if (raw.length <= 20) return raw;
    return `${raw.slice(0, 10)}...${raw.slice(-6)}`;
};

const renderViewerIdentity = ({ nickname = "", userId = "", hasFaceProfile = false, error = "" } = {}) => {
    if (!viewerName || !viewerId) return;

    if (error) {
        viewerName.textContent = "Unavailable";
        viewerId.textContent = error;
        return;
    }

    const resolvedUserId = String(userId || "").trim();
    const resolvedNickname = String(nickname || "").trim();
    if (resolvedNickname) {
        viewerName.textContent = resolvedNickname;
    } else if (hasFaceProfile) {
        viewerName.textContent = "Face profile";
    } else {
        viewerName.textContent = "Session user";
    }

    viewerId.textContent = resolvedUserId ? `ID: ${shortenUserId(resolvedUserId)}` : "ID unavailable";
};

const loadViewerIdentity = async () => {
    if (viewerName) viewerName.textContent = "Loading...";
    if (viewerId) viewerId.textContent = "Fetching profile";

    try {
        const response = await fetch(AUTH_ME_API_URL, { method: "GET" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(payload?.message || `${response.status} ${response.statusText}`);
        }

        renderViewerIdentity({
            nickname: payload?.nickname,
            userId: payload?.userId,
            hasFaceProfile: Boolean(payload?.hasFaceProfile)
        });
    } catch (error) {
        renderViewerIdentity({ error: "Could not load profile" });
    }
};

const setChatUrl = (threadId, replace = false) => {
    const url = new URL(window.location.href);
    url.searchParams.set(CHAT_QUERY_PARAM, threadId);
    const next = url.pathname + url.search + url.hash;
    if (replace) {
        window.history.replaceState({}, "", next);
        return;
    }
    window.history.pushState({}, "", next);
};

const closeQuickSigninModal = () => {
    if (!quickSigninModal) return;
    quickSigninModal.classList.remove("show");
    quickSigninModal.setAttribute("aria-hidden", "true");
};

const openQuickSigninModal = async () => {
    if (!quickSigninModal || !quickSigninQrImage || !quickSigninUrlText) return;
    quickSigninModal.classList.add("show");
    quickSigninModal.setAttribute("aria-hidden", "false");
    quickSigninUrlText.textContent = "Generating one-time sign-in QR...";
    quickSigninQrImage.removeAttribute("src");

    try {
        const response = await fetch(QUICK_SIGNIN_TOKEN_API_URL, { method: "POST" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
        }

        const url = String(payload?.url || "").trim();
        if (!url) throw new Error("Invalid quick sign-in URL.");

        quickSigninQrImage.src = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(url)}`;
        quickSigninUrlText.textContent = url;
    } catch (error) {
        quickSigninUrlText.textContent = `Failed to generate quick sign-in URL: ${error.message}`;
    }
};

const escapeText = (value) => String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const saveMacro = async ({ name, triggerLua, thenLuaScript, elseLuaScript = "", enabled = true }) => {
    const response = await fetch(MACROS_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, triggerLua, thenLuaScript, elseLuaScript, enabled })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
    }
    return payload?.macro || null;
};

const executeCreateMacro = async (args, incomingMessageDiv) => {
    const macroName = String(args?.name || "").trim();
    const triggerLua = String(args?.triggerLua || args?.condition || "").trim();
    const thenLuaScript = String(args?.thenLuaScript || args?.luaScript || "").trim();
    const elseLuaScript = String(args?.elseLuaScript || "").trim();
    const enabled = args?.enabled !== false;
    if (!macroName || !triggerLua || !thenLuaScript) {
        return "Macro creation failed: name, triggerLua, and thenLuaScript are required.";
    }

    const messageElement = incomingMessageDiv.querySelector(".message-text");
    const macroBox = document.createElement("div");
    macroBox.className = "thinking-box";
    macroBox.innerHTML = `
        <div class="thinking-box-header">
            <span class="material-symbols-outlined" style="font-size:16px;">code</span>
            <span class="search-status">Creating macro "${escapeText(macroName)}"...</span>
            <span class="material-symbols-outlined toggle-icon">expand_more</span>
        </div>
        <div class="thinking-box-content" style="font-size: 0.85em; white-space: pre-wrap;"></div>
    `;
    messageElement.parentElement.insertBefore(macroBox, messageElement);
    const contentDiv = macroBox.querySelector(".thinking-box-content");
    const statusSpan = macroBox.querySelector(".search-status");
    macroBox.querySelector(".thinking-box-header").addEventListener("click", () => macroBox.classList.toggle("open"));

    try {
        const created = await saveMacro({ name: macroName, triggerLua, thenLuaScript, elseLuaScript, enabled });
        statusSpan.textContent = `Macro "${macroName}" created`;
        contentDiv.textContent = `ID: ${created?.id || "unknown"}\nTrigger (Lua): ${triggerLua}\nEnabled: ${enabled ? "yes" : "no"}`;
        return `Macro created successfully.\nName: ${macroName}\nTrigger (Lua): ${triggerLua}\nEnabled: ${enabled ? "true" : "false"}`;
    } catch (error) {
        statusSpan.textContent = `Error creating macro "${macroName}"`;
        contentDiv.textContent = error.message;
        return `Error creating macro: ${error.message}`;
    }
};

const saveThreadsToServer = async () => {
    try {
        await fetch(CHAT_STATE_API_URL, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threads: chatThreads,
                activeThreadId: currentThreadId
            })
        });
    } catch (error) {
        console.error("Failed to save chats:", error);
    }
};

const queueSaveThreads = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        saveThreadsToServer();
    }, 250);
};

const ensureChatContextMenu = () => {
    if (chatContextMenu) return;
    chatContextMenu = document.createElement("div");
    chatContextMenu.className = "chat-context-menu";
    chatContextMenu.innerHTML = `<button type="button" class="chat-context-menu-item danger">Delete chat</button>`;
    document.body.appendChild(chatContextMenu);

    chatContextMenu.querySelector(".chat-context-menu-item.danger").addEventListener("click", () => {
        if (!contextMenuThreadId) return;
        const confirmed = window.confirm("Delete this chat permanently?");
        if (!confirmed) {
            hideChatContextMenu();
            return;
        }
        deleteThreadById(contextMenuThreadId);
        hideChatContextMenu();
    });
};

const hideChatContextMenu = () => {
    if (!chatContextMenu) return;
    chatContextMenu.classList.remove("show");
    contextMenuThreadId = null;
};

const showChatContextMenu = (x, y, threadId) => {
    ensureChatContextMenu();
    contextMenuThreadId = threadId;

    chatContextMenu.style.left = `${x}px`;
    chatContextMenu.style.top = `${y}px`;
    chatContextMenu.classList.add("show");

    const menuRect = chatContextMenu.getBoundingClientRect();
    let nextX = x;
    let nextY = y;

    if (menuRect.right > window.innerWidth - 8) {
        nextX = window.innerWidth - menuRect.width - 8;
    }
    if (menuRect.bottom > window.innerHeight - 8) {
        nextY = window.innerHeight - menuRect.height - 8;
    }

    chatContextMenu.style.left = `${Math.max(8, nextX)}px`;
    chatContextMenu.style.top = `${Math.max(8, nextY)}px`;
};

const deleteThreadById = (threadId) => {
    const idx = chatThreads.findIndex((thread) => thread.id === threadId);
    if (idx === -1) return;

    const deletedActive = chatThreads[idx].id === currentThreadId;
    chatThreads.splice(idx, 1);

    if (chatThreads.length === 0) {
        startNewThread(true);
        return;
    }

    if (deletedActive) {
        const fallbackThreadId = chatThreads[0].id;
        currentThreadId = fallbackThreadId;
        chatHistory = chatThreads[0].history;
        setChatUrl(fallbackThreadId, true);
        renderChatList();
        renderMessages();
        closeSidebarOnMobile();
    } else {
        renderChatList();
    }

    queueSaveThreads();
};

const persistCurrentThread = () => {
    const idx = chatThreads.findIndex((thread) => thread.id === currentThreadId);
    if (idx === -1) return;
    chatThreads[idx].history = chatHistory;
    chatThreads[idx].updatedAt = Date.now();
    queueSaveThreads();
    renderChatList();
};

const ensureAssistantHistoryEntry = (msgDiv) => {
    const id = parseInt(msgDiv.dataset.id, 10);
    let idx = chatHistory.findIndex((h) => h.id === id);
    if (idx !== -1) return idx;

    chatHistory.push({
        role: "assistant",
        parts: [{ text: "" }],
        id,
        branches: [],
        currentBranch: 0
    });
    persistCurrentThread();
    idx = chatHistory.findIndex((h) => h.id === id);
    return idx;
};

const renderChatList = () => {
    chatList.innerHTML = "";
    const ordered = [...chatThreads].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    ordered.forEach((thread) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `chat-list-item${thread.id === currentThreadId ? " active" : ""}`;
        button.innerHTML = `<span class="title">${getThreadTitle(thread)}</span><span class="preview">${getThreadPreview(thread)}</span>`;
        button.addEventListener("click", () => {
            const url = new URL(window.location.href);
            url.searchParams.set(CHAT_QUERY_PARAM, thread.id);
            window.location.assign(url.toString());
        });
        button.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showChatContextMenu(e.clientX, e.clientY, thread.id);
        });
        chatList.appendChild(button);
    });
};

const createThread = () => {
    const now = Date.now();
    return {
        id: `chat-${now}-${Math.floor(Math.random() * 1000)}`,
        createdAt: now,
        updatedAt: now,
        history: [createSystemMessage()]
    };
};

const closeSidebarOnMobile = () => {
    if (window.innerWidth <= 980) {
        document.body.classList.remove("sidebar-open");
    }
};

const renderMessages = () => {
    chatBody.innerHTML = "";
    let hasVisibleMessages = false;
    chatHistory.forEach((entry) => {
        if (entry.role === "system") return;
        hasVisibleMessages = true;

        let attachmentHtml = "";
        if (entry.fileData?.data) {
            if (entry.fileData.mime_type?.startsWith("image")) {
                attachmentHtml = `<img src="data:${entry.fileData.mime_type};base64,${entry.fileData.data}" class="attachment" />`;
            } else {
                const name = entry.fileData.fileName || "Attached file";
                attachmentHtml = `<div class="file-attachment"><span class="material-symbols-outlined icon">draft</span><span class="name">${name}</span></div>`;
            }
        }

        if (entry.role === "user") {
            const msg = createMessageElement(`<div class="message-text"></div>${attachmentHtml}`, "user-message");
            msg.querySelector(".message-text").innerText = entry.parts?.[0]?.text || "";
            msg.dataset.id = entry.id;
            chatBody.appendChild(msg);
            addMessageActions(msg, "user");
            return;
        }

        if (entry.role === "assistant") {
            const text = entry.parts?.[0]?.text || "";
            const msg = createMessageElement(`<div class="message-text"></div>`, "bot-message");
            msg.querySelector(".message-text").innerHTML = marked.parse(text);
            msg.dataset.id = entry.id;
            chatBody.appendChild(msg);
            addMessageActions(msg, "assistant");
        }
    });

    if (!hasVisibleMessages) {
        const welcome = createMessageElement(`<div class="message-text"> Hey there <br /> How can I help you today? </div>`, "bot-message");
        chatBody.appendChild(welcome);
    }

    chatBody.scrollTo({ top: chatBody.scrollHeight });
};

const selectThread = (threadId) => {
    const target = chatThreads.find((thread) => thread.id === threadId);
    if (!target) return;
    currentThreadId = target.id;
    chatHistory = target.history;
    queueSaveThreads();
    renderChatList();
    renderMessages();
    closeSidebarOnMobile();
};

const startNewThread = (replaceUrl = false) => {
    const thread = createThread();
    chatThreads.unshift(thread);
    currentThreadId = thread.id;
    chatHistory = thread.history;
    setChatUrl(thread.id, replaceUrl);
    queueSaveThreads();
    renderChatList();
    renderMessages();
    closeSidebarOnMobile();
};

const initializeThreads = async () => {
    try {
        const response = await fetch(CHAT_STATE_API_URL, { method: "GET" });
        if (!response.ok) throw new Error("Unable to load chats from server");
        const payload = await response.json();
        chatThreads = Array.isArray(payload?.threads) ? payload.threads : [];
        const chatIdFromUrl = getCurrentChatIdFromUrl();

        if (!Array.isArray(chatThreads)) chatThreads = [];
        if (chatThreads.length === 0 && !chatIdFromUrl) {
            startNewThread(true);
            return;
        }

        if (chatIdFromUrl) {
            const exists = chatThreads.some((thread) => thread.id === chatIdFromUrl);
            if (exists) {
                selectThread(chatIdFromUrl);
                return;
            }
        }

        // Standard behavior: opening chat.html directly starts a new conversation.
        startNewThread(true);
    } catch (e) {
        console.error("Failed to load chats from server:", e);
        chatThreads = [];
        startNewThread(true);
    }
};

async function executeWebSearch(query, incomingMessageDiv) {
    const messageElement = incomingMessageDiv.querySelector(".message-text");
    const runtime = getUserRuntimeContext();

    const searchBox = document.createElement("div");
    searchBox.className = "thinking-box";
    searchBox.innerHTML = `
        <div class="thinking-box-header">
            <span class="material-symbols-outlined" style="font-size:16px;">travel_explore</span>
            <span class="search-status">Searching the web for "${query}"...</span>
            <span class="material-symbols-outlined toggle-icon">expand_more</span>
        </div>
        <div class="thinking-box-content" style="font-size: 0.85em; white-space: pre-wrap;"></div>
    `;

    messageElement.parentElement.insertBefore(searchBox, messageElement);
    const contentDiv = searchBox.querySelector(".thinking-box-content");
    const statusSpan = searchBox.querySelector(".search-status");
    searchBox.querySelector(".thinking-box-header").addEventListener("click", () => searchBox.classList.toggle("open"));

    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });

    try {
        const response = await fetch(WEB_SEARCH_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query,
                locale: runtime.locale,
                timezone: runtime.timezone
            })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            const errorText = payload?.error?.message || `${response.status} ${response.statusText}`;
            throw new Error(errorText);
        }

        const results = Array.isArray(payload?.results) ? payload.results : [];
        if (!results.length) {
            statusSpan.innerText = `No substantial results found for "${query}"`;
            return `Search completed for "${query}", but no substantial content was found.`;
        }

        const formatted = results
            .map((item, i) => {
                const title = item.title || "Untitled";
                const snippet = item.snippet || "No snippet available.";
                const url = item.url || "";
                return `${i + 1}. ${title}\nURL: ${url}\nSnippet: ${snippet}`;
            })
            .join("\n\n");
        contentDiv.innerText = formatted;
        statusSpan.innerText = `Results found for "${query}"`;
        return `Web search results for "${query}":\n${formatted}`;
    } catch (error) {
        statusSpan.innerText = `Error searching for "${query}"`;
        contentDiv.innerText = error.message;
        return `Error performing live web search: ${error.message}.`;
    }
}

async function executeVisitSite(url, incomingMessageDiv) {
    const messageElement = incomingMessageDiv.querySelector(".message-text");
    const runtime = getUserRuntimeContext();

    const visitBox = document.createElement("div");
    visitBox.className = "thinking-box";
    visitBox.innerHTML = `
        <div class="thinking-box-header">
            <span class="material-symbols-outlined" style="font-size:16px;">language</span>
            <span class="search-status">Visiting ${url}...</span>
            <span class="material-symbols-outlined toggle-icon">expand_more</span>
        </div>
        <div class="thinking-box-content" style="font-size: 0.85em; white-space: pre-wrap;"></div>
    `;

    messageElement.parentElement.insertBefore(visitBox, messageElement);
    const contentDiv = visitBox.querySelector(".thinking-box-content");
    const statusSpan = visitBox.querySelector(".search-status");
    visitBox.querySelector(".thinking-box-header").addEventListener("click", () => visitBox.classList.toggle("open"));

    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });

    try {
        const response = await fetch(VISIT_SITE_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url,
                locale: runtime.locale,
                timezone: runtime.timezone
            })
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            const errorText = payload?.error?.message || `${response.status} ${response.statusText}`;
            throw new Error(errorText);
        }

        const text = payload?.result?.text || "";
        const contentType = payload?.result?.contentType || "unknown";
        const resolvedUrl = payload?.result?.url || url;
        if (!text) {
            statusSpan.innerText = "Visited, but no readable text extracted.";
            contentDiv.innerText = resolvedUrl;
            return `Visited ${resolvedUrl} but no readable text was extracted.`;
        }
        contentDiv.innerText = `URL: ${resolvedUrl}\nType: ${contentType}\n\n${text}`;
        statusSpan.innerText = `Visited ${resolvedUrl}`;
        return `Visited page content from ${resolvedUrl}:\n${text}`;
    } catch (error) {
        statusSpan.innerText = `Error visiting ${url}`;
        contentDiv.innerText = error.message;
        return `Error visiting site ${url}: ${error.message}`;
    }
}

async function executeGetAllVariables(incomingMessageDiv) {
    const messageElement = incomingMessageDiv.querySelector(".message-text");
    const variablesBox = document.createElement("div");
    variablesBox.className = "thinking-box";
    variablesBox.innerHTML = `
        <div class="thinking-box-header">
            <span class="material-symbols-outlined" style="font-size:16px;">database</span>
            <span class="search-status">Reading all Arduino variables...</span>
            <span class="material-symbols-outlined toggle-icon">expand_more</span>
        </div>
        <div class="thinking-box-content" style="font-size: 0.85em; white-space: pre-wrap;"></div>
    `;

    messageElement.parentElement.insertBefore(variablesBox, messageElement);
    const contentDiv = variablesBox.querySelector(".thinking-box-content");
    const statusSpan = variablesBox.querySelector(".search-status");
    variablesBox.querySelector(".thinking-box-header").addEventListener("click", () => variablesBox.classList.toggle("open"));

    try {
        const response = await fetch(ARDUINO_GET_ALL_VARIABLES_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
        }

        const variables = payload?.variables && typeof payload.variables === "object" ? payload.variables : {};
        const names = Object.keys(variables);
        if (!names.length) {
            statusSpan.innerText = "No Arduino variables found.";
            contentDiv.innerText = "No variables are currently stored.";
            return "No Arduino variables found.";
        }

        const lines = names.slice(0, 80).map((name) => {
            const entry = variables[name] || {};
            return `${name}: ${JSON.stringify(entry.value)}`;
        });
        const bodyText = lines.join("\n");
        statusSpan.innerText = `Loaded ${names.length} Arduino variable(s).`;
        contentDiv.innerText = bodyText;
        return `Arduino variables (${names.length}):\n${bodyText}`;
    } catch (error) {
        statusSpan.innerText = "Error reading Arduino variables";
        contentDiv.innerText = error.message;
        return `Error reading all variables: ${error.message}`;
    }
}

async function executeReadVariable(name, incomingMessageDiv) {
    const variableName = String(name || "").trim();
    if (!variableName) return "Read variable failed: name is required.";

    const messageElement = incomingMessageDiv.querySelector(".message-text");
    const readBox = document.createElement("div");
    readBox.className = "thinking-box";
    readBox.innerHTML = `
        <div class="thinking-box-header">
            <span class="material-symbols-outlined" style="font-size:16px;">visibility</span>
            <span class="search-status">Reading variable "${escapeText(variableName)}"...</span>
            <span class="material-symbols-outlined toggle-icon">expand_more</span>
        </div>
        <div class="thinking-box-content" style="font-size: 0.85em; white-space: pre-wrap;"></div>
    `;

    messageElement.parentElement.insertBefore(readBox, messageElement);
    const contentDiv = readBox.querySelector(".thinking-box-content");
    const statusSpan = readBox.querySelector(".search-status");
    readBox.querySelector(".thinking-box-header").addEventListener("click", () => readBox.classList.toggle("open"));

    try {
        const response = await fetch(ARDUINO_READ_VARIABLE_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: variableName })
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
        }

        const value = payload?.value;
        statusSpan.innerText = `Read variable "${variableName}"`;
        contentDiv.innerText = JSON.stringify(value, null, 2);
        return `Variable "${variableName}" value: ${JSON.stringify(value)}`;
    } catch (error) {
        statusSpan.innerText = `Error reading "${variableName}"`;
        contentDiv.innerText = error.message;
        return `Error reading variable "${variableName}": ${error.message}`;
    }
}

async function executeWriteVariable(name, value, incomingMessageDiv, meta = {}) {
    const variableName = String(name || "").trim();
    if (!variableName) return "Write variable failed: name is required.";

    const messageElement = incomingMessageDiv.querySelector(".message-text");
    const writeBox = document.createElement("div");
    writeBox.className = "thinking-box";
    writeBox.innerHTML = `
        <div class="thinking-box-header">
            <span class="material-symbols-outlined" style="font-size:16px;">edit_note</span>
            <span class="search-status">Writing variable "${escapeText(variableName)}"...</span>
            <span class="material-symbols-outlined toggle-icon">expand_more</span>
        </div>
        <div class="thinking-box-content" style="font-size: 0.85em; white-space: pre-wrap;"></div>
    `;

    messageElement.parentElement.insertBefore(writeBox, messageElement);
    const contentDiv = writeBox.querySelector(".thinking-box-content");
    const statusSpan = writeBox.querySelector(".search-status");
    writeBox.querySelector(".thinking-box-header").addEventListener("click", () => writeBox.classList.toggle("open"));

    try {
        const response = await fetch(ARDUINO_WRITE_VARIABLE_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: variableName,
                value,
                sourceMacroId: meta?.sourceMacroId || "",
                sourceMacroName: meta?.sourceMacroName || ""
            })
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
        }

        statusSpan.innerText = `Wrote variable "${variableName}"`;
        contentDiv.innerText = JSON.stringify(payload?.value, null, 2);
        return `Variable "${variableName}" updated to: ${JSON.stringify(payload?.value)}`;
    } catch (error) {
        statusSpan.innerText = `Error writing "${variableName}"`;
        contentDiv.innerText = error.message;
        return `Error writing variable "${variableName}": ${error.message}`;
    }
}

async function executeOsTime(args, incomingMessageDiv) {
    const runtime = getUserRuntimeContext();
    const timezone = String(args?.timezone || runtime.timezone || "UTC").trim();
    const locale = String(args?.locale || runtime.locale || "en-US").trim();

    const messageElement = incomingMessageDiv.querySelector(".message-text");
    const timeBox = document.createElement("div");
    timeBox.className = "thinking-box";
    timeBox.innerHTML = `
        <div class="thinking-box-header">
            <span class="material-symbols-outlined" style="font-size:16px;">schedule</span>
            <span class="search-status">Getting OS time (${escapeText(timezone)})...</span>
            <span class="material-symbols-outlined toggle-icon">expand_more</span>
        </div>
        <div class="thinking-box-content" style="font-size: 0.85em; white-space: pre-wrap;"></div>
    `;

    messageElement.parentElement.insertBefore(timeBox, messageElement);
    const contentDiv = timeBox.querySelector(".thinking-box-content");
    const statusSpan = timeBox.querySelector(".search-status");
    timeBox.querySelector(".thinking-box-header").addEventListener("click", () => timeBox.classList.toggle("open"));

    try {
        const response = await fetch(OS_TIME_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ timezone, locale })
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
        }

        const summary = `ISO: ${payload?.nowIso}\nFormatted: ${payload?.formatted}\nTimezone: ${payload?.timezone}\nEpoch: ${payload?.epochSec}`;
        statusSpan.innerText = "OS time fetched";
        contentDiv.innerText = summary;
        return `OS time info:\n${summary}`;
    } catch (error) {
        statusSpan.innerText = "Error fetching OS time";
        contentDiv.innerText = error.message;
        return `Error fetching OS time: ${error.message}`;
    }
}

const findHistoryIndexByElement = (msgDiv) => {
    const id = parseInt(msgDiv.dataset.id, 10);
    return chatHistory.findIndex((h) => h.id === id);
};

const getUserRuntimeContext = () => {
    const locale = navigator.language || "en-US";
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const nowIso = new Date().toISOString();
    return { locale, timezone, nowIso };
};

const parseToolArgs = (argText) => {
    if (!argText || typeof argText !== "string") return {};
    try {
        return JSON.parse(argText);
    } catch (error) {
        return {};
    }
};

const formatAgentToolResult = (name, payload) => {
    if (name === "web_search") return payload;
    if (name === "create_macro") return payload;
    if (name === "get-all-variables") return payload;
    if (name === "read-variable") return payload;
    if (name === "write-variable") return payload;
    if (name === "os-time") return payload;
    if (typeof payload === "string") return payload;
    return JSON.stringify(payload);
};

const finalizeIncomingMessageUi = (incomingMessageDiv) => {
    const finalThinkBox = incomingMessageDiv.querySelector(".thinking-box");
    if (finalThinkBox) finalThinkBox.classList.remove("thinking-active");
    const finalLiveLine = incomingMessageDiv.querySelector(".thinking-live-line");
    if (finalLiveLine) finalLiveLine.textContent = "";
    incomingMessageDiv.classList.remove("thinking");
    addMessageActions(incomingMessageDiv, "assistant");
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
};

const generateBotResponse = async (incomingMessageDiv, historyContext, options = {}) => {
    const shouldVoiceReply = Boolean(options?.voiceReply);
    const messageElement = incomingMessageDiv.querySelector(".message-text");
    const messages = [];
    let skipDefaultFinalize = false;

    historyContext.forEach((entry) => {
        if (entry.role === "user" && entry.fileData) {
            if (entry.fileData.mime_type?.startsWith("image")) {
                messages.push({
                    role: "user",
                    content: [
                        { type: "text", text: entry.parts[0].text },
                        { type: "image_url", image_url: { url: `data:${entry.fileData.mime_type};base64,${entry.fileData.data}` } }
                    ]
                });
            } else {
                let fileContent = "";
                if (entry.fileData.mime_type?.startsWith("text") || entry.fileData.mime_type === "text/plain") {
                    fileContent = `\n\n[Attached File: ${entry.fileData.fileName}]\n${entry.fileData.data}`;
                } else {
                    fileContent = `\n\n[User attached a non-image file: ${entry.fileData.fileName}]`;
                }
                messages.push({ role: "user", content: entry.parts[0].text + fileContent });
            }
            return;
        }

        const content = (entry.parts || []).map((p) => p.text).join("\n");
        if (content) messages.push({ role: entry.role, content });
    });

    const latestUserEntry = [...historyContext].reverse().find((entry) => entry.role === "user") || null;
    const hasImage = Boolean(
        latestUserEntry?.fileData?.mime_type?.startsWith("image") &&
        latestUserEntry?.fileData?.data
    );
    const latestUserText = latestUserEntry?.parts?.[0]?.text || "";
    const selectedModel = multiAgentMode ? selectedTextModel : (hasImage ? MODEL_VISION : selectedTextModel);
    const runtimeContext = getUserRuntimeContext();
    messages.unshift({
        role: "system",
        content: `User runtime context: locale=${runtimeContext.locale}, timezone=${runtimeContext.timezone}, now=${runtimeContext.nowIso}. Use this context for time/date and region-sensitive requests.`
    });

    const tools = [
        {
            type: "function",
            function: {
                name: "web_search",
                description: "Search the web for up-to-date information",
                parameters: {
                    type: "object",
                    properties: { query: { type: "string", description: "The search query" } },
                    required: ["query"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "visit_site",
                description: "Visit a specific URL and extract readable page text",
                parameters: {
                    type: "object",
                    properties: { url: { type: "string", description: "A full http/https URL to visit" } },
                    required: ["url"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "get-all-variables",
                description: "Get all available Arduino variables and their current values.",
                parameters: {
                    type: "object",
                    properties: {}
                }
            }
        },
        {
            type: "function",
            function: {
                name: "read-variable",
                description: "Read one Arduino variable by name.",
                parameters: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Variable name to read" }
                    },
                    required: ["name"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "write-variable",
                description: "Write/update one Arduino variable by name.",
                parameters: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Variable name to update" },
                        value: { description: "New variable value (number/string/boolean/object)" },
                        sourceMacroId: { type: "string", description: "Optional macro id responsible for this write" },
                        sourceMacroName: { type: "string", description: "Optional macro name responsible for this write" }
                    },
                    required: ["name", "value"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "os-time",
                description: "Return server OS time details (ISO, formatted time, epoch) with optional timezone and locale.",
                parameters: {
                    type: "object",
                    properties: {
                        timezone: { type: "string", description: "IANA timezone like Asia/Manila or America/New_York" },
                        locale: { type: "string", description: "Locale like en-US" }
                    }
                }
            }
        },
        {
            type: "function",
            function: {
                name: "create_macro",
                description: "Create an automation macro with Lua trigger/then/else sections. triggerLua is a Lua expression. thenLuaScript runs when true; elseLuaScript runs when false.",
                parameters: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Macro display name" },
                        triggerLua: { type: "string", description: "Lua expression for trigger condition (must evaluate to true/false)" },
                        thenLuaScript: { type: "string", description: "Lua script executed when trigger is true" },
                        elseLuaScript: { type: "string", description: "Lua script executed when trigger is false (optional)" },
                        enabled: { type: "boolean", description: "Whether macro should start enabled" }
                    },
                    required: ["name", "triggerLua", "thenLuaScript"]
                }
            }
        }
    ];

    const toolChoice = userData.tool === "web"
        ? { type: "function", function: { name: "web_search" } }
        : (userData.tool === "macro" ? { type: "function", function: { name: "create_macro" } } : "auto");

    const openAiRequestOptions = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: selectedModel,
            messages,
            tools,
            tool_choice: toolChoice,
            temperature: 0.2,
            stream: true
        })
    };

    try {
        if (multiAgentMode) {
            const textModelPool = ["glm-4.6", "iflow-rome-30ba3b", "qwen3-coder-plus", "kimi-k2"];
            const secondaryIflowModel = selectedTextModel === "iflow-rome-30ba3b" ? "glm-4.6" : "iflow-rome-30ba3b";
            const reviewerModel = selectedTextModel === "qwen3-coder-plus" ? "kimi-k2" : "qwen3-coder-plus";
            const rolePlan = [
                {
                    role: "Lead Agent",
                    name: "Ardy",
                    candidates: [selectedTextModel, ...textModelPool],
                    systemPrompt: "You are Ardy, lead of an internal team debate. Speak to Bella, Charlie, and Daisy only. Never respond directly to the end user. Coordinate, ask for evidence, and decide when debate is complete. Keep every message concise: max 3 sentences and under 80 words."
                },
                {
                    role: "Counterpoint Agent",
                    name: "Bella",
                    candidates: [secondaryIflowModel, ...textModelPool],
                    systemPrompt: "You are Bella, the counterpoint specialist in an internal team debate. Speak only to Ardy, Charlie, and Daisy. Never answer the user directly. Challenge assumptions and propose alternatives. Keep every message concise: max 3 sentences and under 80 words."
                },
                {
                    role: "Reviewer Agent",
                    name: "Charlie",
                    candidates: [reviewerModel, ...textModelPool],
                    systemPrompt: "You are Charlie, the reviewer in an internal team debate. Speak only to Ardy, Bella, and Daisy. Never answer the user directly. Validate logic, identify risks, and request missing details. Keep every message concise: max 3 sentences and under 80 words."
                }
            ];
            if (hasImage) {
                rolePlan.push({
                    role: "Vision Agent",
                    name: "Daisy",
                    candidates: [MODEL_VISION],
                    systemPrompt: "You are Daisy, the vision analyst in an internal team debate. You must inspect the provided image and report observations to Ardy, Bella, and Charlie. Never answer the user directly. Keep every message concise: max 3 sentences and under 80 words."
                });
                updateThinkingStatus(incomingMessageDiv, "Image detected. Daisy joined the team debate.");
            }

            const latestImagePayload = hasImage
                ? {
                    type: "image_url",
                    image_url: {
                        url: `data:${latestUserEntry.fileData.mime_type};base64,${latestUserEntry.fileData.data}`
                    }
                }
                : null;
            const memberNames = rolePlan.map((r) => r.name);
            const agentOutputs = [];
            const failedAttempts = [];
            const streamSections = [];
            const debateTranscript = [];
            const priorityQueue = [];
            let synthesisStream = "";
            let ardyEndedTeamChat = false;
            let turnCount = 0;
            const maxTurns = hasImage ? 12 : 9;

            const baseDebateTools = [
                {
                    type: "function",
                    function: {
                        name: "web_search",
                        description: "Search reliable web results for facts or standards before claiming them.",
                        parameters: {
                            type: "object",
                            properties: {
                                query: { type: "string", description: "Search query" }
                            },
                            required: ["query"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "visit_site",
                        description: "Open one result URL and extract page text to verify details.",
                        parameters: {
                            type: "object",
                            properties: {
                                url: { type: "string", description: "A full http/https URL to inspect" }
                            },
                            required: ["url"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "get-all-variables",
                        description: "List all Arduino variables and current values before making automation decisions.",
                        parameters: {
                            type: "object",
                            properties: {}
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "read-variable",
                        description: "Read one Arduino variable by name.",
                        parameters: {
                            type: "object",
                            properties: {
                                name: { type: "string", description: "Variable name to read" }
                            },
                            required: ["name"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "write-variable",
                        description: "Write one Arduino variable by name.",
                        parameters: {
                            type: "object",
                            properties: {
                                name: { type: "string", description: "Variable name to write" },
                                value: { description: "New value" },
                                sourceMacroId: { type: "string", description: "Optional macro id responsible for this write" },
                                sourceMacroName: { type: "string", description: "Optional macro name responsible for this write" }
                            },
                            required: ["name", "value"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "os-time",
                        description: "Get OS time details for time-sensitive macro logic.",
                        parameters: {
                            type: "object",
                            properties: {
                                timezone: { type: "string" },
                                locale: { type: "string" }
                            }
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "talk_to_agent",
                        description: "Direct a follow-up message to one teammate and request a reply.",
                        parameters: {
                            type: "object",
                            properties: {
                                to: { type: "string", description: "Target teammate name" },
                                message: { type: "string", description: "What you want that teammate to address" }
                            },
                            required: ["to", "message"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "raise_objection",
                        description: "Interrupt with an objection and force the target teammate to respond next.",
                        parameters: {
                            type: "object",
                            properties: {
                                target: { type: "string", description: "Teammate to challenge" },
                                reason: { type: "string", description: "Why you object" }
                            },
                            required: ["target", "reason"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "log_risk",
                        description: "Record a concrete risk and mitigation item for the team.",
                        parameters: {
                            type: "object",
                            properties: {
                                risk: { type: "string" },
                                impact: { type: "string" },
                                mitigation: { type: "string" }
                            },
                            required: ["risk", "impact", "mitigation"]
                        }
                    }
                },
                {
                    type: "function",
                    function: {
                        name: "create_macro",
                        description: "Create a Lua macro with triggerLua/thenLuaScript/elseLuaScript. Then runs on true, else runs on false.",
                        parameters: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                triggerLua: { type: "string" },
                                thenLuaScript: { type: "string" },
                                elseLuaScript: { type: "string" },
                                enabled: { type: "boolean" }
                            },
                            required: ["name", "triggerLua", "thenLuaScript"]
                        }
                    }
                }
            ];
            const ardyTools = [
                ...baseDebateTools,
                {
                    type: "function",
                    function: {
                        name: "end_team_debate",
                        description: "End the current team debate and proceed to final synthesis.",
                        parameters: {
                            type: "object",
                            properties: {
                                reason: { type: "string", description: "Why the team is ready to synthesize" }
                            },
                            required: ["reason"]
                        }
                    }
                }
            ];

            const queueAgentByName = (name) => {
                const idx = rolePlan.findIndex((r) => r.name.toLowerCase() === String(name || "").toLowerCase());
                if (idx === -1) return;
                if (!priorityQueue.includes(idx)) priorityQueue.unshift(idx);
            };

            const nextAgentIndex = () => {
                if (priorityQueue.length > 0) return priorityQueue.shift();
                return turnCount % rolePlan.length;
            };

            while (!ardyEndedTeamChat && turnCount < maxTurns) {
                const plan = rolePlan[nextAgentIndex()];
                turnCount += 1;
                const teamPrompt = debateTranscript.length
                    ? `Team transcript so far:\n${debateTranscript.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
                    : "No prior team messages yet.";
                let completed = false;

                for (const modelCandidate of [...new Set(plan.candidates)]) {
                    const section = { role: `${plan.role} (${plan.name})`, model: modelCandidate, status: "streaming", text: "" };
                    streamSections.push(section);
                    renderMultiAgentStreaming(messageElement, streamSections, synthesisStream);

                    try {
                        updateThinkingStatus(incomingMessageDiv, `${plan.name} turn ${turnCount}: debating with ${modelCandidate}...`);
                        const userPromptText = `User request to solve:\n${latestUserText}\n${hasImage ? "\n[Current user turn includes an image attachment. Daisy receives the raw image payload.]" : ""}\n\n${teamPrompt}\n\nDebate rules:
- You are speaking only to teammates, never to the user.
- Keep your response short and actionable.
- Hard limit: maximum 3 sentences and under 80 words per turn.
- If you need input from one teammate, call talk_to_agent.
- If you disagree strongly, call raise_objection.
- If uncertain facts are involved, call web_search then visit_site for source verification.
- Charlie should call log_risk for major implementation risks.`;
                        const baseMessages = [
                            { role: "system", content: plan.systemPrompt },
                            { role: "user", content: userPromptText }
                        ];
                        const agentMessages = (plan.name === "Daisy" && latestImagePayload)
                            ? [
                                { role: "system", content: plan.systemPrompt },
                                {
                                    role: "user",
                                    content: [
                                        { type: "text", text: latestUserText || "Analyze the attached image for the team." },
                                        latestImagePayload,
                                        { type: "text", text: `\n\n${teamPrompt}\n\nAnalyze the image and speak only to teammates.` }
                                    ]
                                }
                            ]
                            : baseMessages;

                        const liveMessages = [...agentMessages];
                        let aggregateText = "";
                        let toolRound = 0;
                        let requestedEndDebate = false;

                        while (toolRound < 5) {
                            toolRound += 1;
                            const streamResult = await streamIflowCompletion({
                                model: modelCandidate,
                                messages: liveMessages,
                                temperature: 0.45,
                                tools: plan.name === "Ardy" ? ardyTools : baseDebateTools,
                                tool_choice: "auto",
                                onToken: (_, full) => {
                                    section.text = `${aggregateText}${full}`;
                                    renderMultiAgentStreaming(messageElement, streamSections, synthesisStream);
                                    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
                                }
                            });

                            const turnText = (streamResult.text || "").trim();
                            if (turnText) {
                                aggregateText += turnText;
                            }

                            const toolCalls = Array.isArray(streamResult.toolCalls) ? streamResult.toolCalls : [];
                            if (!toolCalls.length) {
                                break;
                            }
                            const toolNames = toolCalls
                                .map((tc) => tc?.function?.name || "unknown_tool")
                                .join(", ");
                            const assistantToolIntro = `\n[${plan.name}] Calling tool(s): ${toolNames}\n`;
                            aggregateText += assistantToolIntro;
                            section.text = aggregateText;
                            renderMultiAgentStreaming(messageElement, streamSections, synthesisStream);
                            debateTranscript.push(`${plan.name} (assistant): ${assistantToolIntro.trim()}`);

                            liveMessages.push({
                                role: "assistant",
                                content: (turnText || "").trim() || `Calling tool(s): ${toolNames}`,
                                tool_calls: toolCalls.map((tc) => ({
                                    id: tc.id || `tool_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                                    type: "function",
                                    function: {
                                        name: tc?.function?.name || "",
                                        arguments: tc?.function?.arguments || "{}"
                                    }
                                }))
                            });

                            for (const toolCall of toolCalls) {
                                const toolName = toolCall?.function?.name || "";
                                const args = parseToolArgs(toolCall?.function?.arguments || "{}");
                                if (!toolName) continue;

                                let toolResultText = "";
                                if (toolName === "web_search") {
                                    const query = String(args.query || "").trim();
                                    if (query) {
                                        updateThinkingStatus(incomingMessageDiv, `${plan.name} requested web search: "${query}"`);
                                        const result = await executeWebSearch(query, incomingMessageDiv);
                                        toolResultText = formatAgentToolResult(toolName, result);
                                    } else {
                                        toolResultText = "No query was provided.";
                                    }
                                } else if (toolName === "visit_site") {
                                    const url = String(args.url || "").trim();
                                    if (url) {
                                        updateThinkingStatus(incomingMessageDiv, `${plan.name} requested site visit: ${url}`);
                                        const result = await executeVisitSite(url, incomingMessageDiv);
                                        toolResultText = formatAgentToolResult(toolName, result);
                                    } else {
                                        toolResultText = "No URL was provided.";
                                    }
                                } else if (toolName === "get-all-variables") {
                                    updateThinkingStatus(incomingMessageDiv, `${plan.name} requested all Arduino variables.`);
                                    const result = await executeGetAllVariables(incomingMessageDiv);
                                    toolResultText = formatAgentToolResult(toolName, result);
                                } else if (toolName === "read-variable") {
                                    const variableName = String(args.name || "").trim();
                                    if (variableName) {
                                        updateThinkingStatus(incomingMessageDiv, `${plan.name} requested variable read: ${variableName}`);
                                        const result = await executeReadVariable(variableName, incomingMessageDiv);
                                        toolResultText = formatAgentToolResult(toolName, result);
                                    } else {
                                        toolResultText = "No variable name was provided.";
                                    }
                                } else if (toolName === "write-variable") {
                                    const variableName = String(args.name || "").trim();
                                    if (variableName) {
                                        updateThinkingStatus(incomingMessageDiv, `${plan.name} requested variable write: ${variableName}`);
                                        const result = await executeWriteVariable(variableName, args.value, incomingMessageDiv, {
                                            sourceMacroId: args.sourceMacroId,
                                            sourceMacroName: args.sourceMacroName
                                        });
                                        toolResultText = formatAgentToolResult(toolName, result);
                                    } else {
                                        toolResultText = "No variable name was provided.";
                                    }
                                } else if (toolName === "os-time") {
                                    updateThinkingStatus(incomingMessageDiv, `${plan.name} requested OS time details.`);
                                    const result = await executeOsTime(args, incomingMessageDiv);
                                    toolResultText = formatAgentToolResult(toolName, result);
                                } else if (toolName === "talk_to_agent") {
                                    const to = String(args.to || "").trim();
                                    const msg = String(args.message || "").trim();
                                    queueAgentByName(to);
                                    toolResultText = `Message routed to ${to || "team"}: ${msg || "No message provided."}`;
                                } else if (toolName === "raise_objection") {
                                    const target = String(args.target || "").trim();
                                    const reason = String(args.reason || "").trim();
                                    queueAgentByName(target);
                                    toolResultText = `Objection raised against ${target || "team"}: ${reason || "No reason provided."}`;
                                } else if (toolName === "log_risk") {
                                    const risk = String(args.risk || "").trim();
                                    const impact = String(args.impact || "").trim();
                                    const mitigation = String(args.mitigation || "").trim();
                                    toolResultText = `Risk logged. Risk="${risk}", Impact="${impact}", Mitigation="${mitigation}"`;
                                } else if (toolName === "create_macro") {
                                    updateThinkingStatus(incomingMessageDiv, `${plan.name} requested macro creation.`);
                                    const result = await executeCreateMacro(args, incomingMessageDiv);
                                    toolResultText = formatAgentToolResult(toolName, result);
                                } else if (toolName === "end_team_debate" && plan.name === "Ardy") {
                                    const reason = String(args.reason || "Team has enough consensus.").trim();
                                    requestedEndDebate = true;
                                    toolResultText = `Debate end requested by Ardy: ${reason}`;
                                } else {
                                    toolResultText = `Tool ${toolName} executed.`;
                                }

                                const compactToolResult = String(toolResultText || "").slice(0, 700);
                                const assistantToolResultLine = `[${plan.name}] ${toolName} result: ${compactToolResult}`;
                                aggregateText += `\n${assistantToolResultLine}\n`;
                                section.text = aggregateText;
                                renderMultiAgentStreaming(messageElement, streamSections, synthesisStream);
                                debateTranscript.push(`${plan.name} (assistant): ${assistantToolResultLine}`);
                                debateTranscript.push(`Tool(${toolName}) by ${plan.name}: ${toolResultText}`);
                                liveMessages.push({
                                    role: "tool",
                                    tool_call_id: toolCall.id || "",
                                    name: toolName,
                                    content: toolResultText
                                });
                            }
                        }

                        section.status = "completed";
                        section.text = aggregateText || "(No direct text output)";
                        renderMultiAgentStreaming(messageElement, streamSections, synthesisStream);
                        debateTranscript.push(`${plan.name}: ${section.text}`);
                        agentOutputs.push({ model: modelCandidate, role: plan.role, name: plan.name, text: section.text });
                        updateThinkingStatus(incomingMessageDiv, `${plan.name} completed.`);

                        if (requestedEndDebate) {
                            ardyEndedTeamChat = true;
                            updateThinkingStatus(incomingMessageDiv, "Ardy ended the debate by tool call.");
                        }
                        completed = true;
                        break;
                    } catch (err) {
                        section.status = "failed";
                        section.text = err.message;
                        renderMultiAgentStreaming(messageElement, streamSections, synthesisStream);
                        failedAttempts.push(`${plan.name}/${modelCandidate}: ${err.message}`);
                        updateThinkingStatus(incomingMessageDiv, `${plan.name}: ${modelCandidate} failed, trying fallback...`);
                    }
                }

                if (!completed) {
                    updateThinkingStatus(incomingMessageDiv, `${plan.name} could not complete a turn.`);
                }
            }

            if (!agentOutputs.length) {
                throw new Error(`Multi-agent mode could not run any model.\n${failedAttempts.slice(0, 6).join("\n")}`);
            }

            if (!ardyEndedTeamChat) {
                debateTranscript.push("System: Max team turns reached. Proceeding to synthesis.");
            }

            const synthesisCandidates = [...new Set([selectedTextModel, ...agentOutputs.map((a) => a.model), ...textModelPool])];
            let synthesisText = "";
            let synthesisModelUsed = "";
            let synthesisError = null;
            updateThinkingStatus(incomingMessageDiv, "Ardy is invoking synthesis tool...");
            for (const synthesisModel of synthesisCandidates) {
                try {
                    const synthesisResult = await streamIflowCompletion({
                        model: synthesisModel,
                        messages: [
                            {
                                role: "system",
                                content: `You are Ardy doing final synthesis after an internal team debate with ${memberNames.filter((n) => n !== "Ardy").join(", ")}.
Convert internal discussion into a direct user-facing answer.
Start with one short paragraph acknowledging teammate contributions by name.
Then output markdown sections: Team Notes, Final Answer.`
                            },
                            {
                                role: "user",
                                content: `Original conversation context:\n${JSON.stringify(messages, null, 2)}\n\nTeam transcript:\n${debateTranscript.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nAgent outputs:\n${agentOutputs.map((a, i) => `Agent ${i + 1} (${a.name}, ${a.role}, ${a.model}):\n${a.text}`).join("\n\n")}`
                            }
                        ],
                        temperature: 0.3,
                        onToken: (_, full) => {
                            synthesisStream = full;
                            renderMultiAgentStreaming(messageElement, streamSections, synthesisStream);
                            chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
                        }
                    });
                    synthesisText = synthesisResult.text || "";
                    synthesisModelUsed = synthesisModel;
                    updateThinkingStatus(incomingMessageDiv, `Synthesis completed with ${synthesisModelUsed}.`);
                    break;
                } catch (err) {
                    synthesisError = err;
                    updateThinkingStatus(incomingMessageDiv, `${synthesisModel} failed for synthesis, trying fallback...`);
                }
            }

            if (!synthesisText) {
                throw new Error(`Multi-agent synthesis failed. ${synthesisError?.message || "No synthesis model available."}`);
            }

            messageElement.innerHTML = marked.parse(synthesisText);
            const historyIndex = ensureAssistantHistoryEntry(incomingMessageDiv);
            if (historyIndex !== -1) {
                chatHistory[historyIndex].parts = [{ text: synthesisText }];
                chatHistory[historyIndex].branches = [synthesisText];
                chatHistory[historyIndex].currentBranch = 0;
            }
            persistCurrentThread();
            if (shouldVoiceReply) {
                skipDefaultFinalize = true;
                await renderVoiceReplyAfterThinking(incomingMessageDiv, messageElement, synthesisText);
                finalizeIncomingMessageUi(incomingMessageDiv);
            }
            return;
        }

        const response = await fetch(IFLOW_PROXY_URL, openAiRequestOptions);
        if (!response.ok) {
            let errText = `${response.status} ${response.statusText}`;
            try {
                const errJson = await response.json();
                errText = errJson.error?.message || errText;
            } catch (e) {}
            throw new Error(errText);
        }

        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/event-stream")) {
            let payload = null;
            try {
                payload = await response.json();
            } catch (e) {}
            const statusErr = getApiStatusError(payload);
            if (statusErr) throw new Error(statusErr);
            throw new Error("Unexpected non-stream response from model API.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let done = false;
        let buffer = "";

        let fullText = "";
        let reasoningText = "";
        let toolCalls = [];
        let finishReason = null;
        let thinkingDivCreated = false;
        let thinkingBoxDiv = null;
        let thinkingContentDiv = null;
        let thinkingLiveLineDiv = null;

        while (!done) {
            const { value, done: readerDone } = await reader.read();
            if (value) {
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split(/\r?\n\r?\n/);
                buffer = parts.pop();

                for (const part of parts) {
                    const line = part.trim();
                    if (!line) continue;
                    const dataStr = line.startsWith("data:") ? line.replace(/^data:\s*/, "") : line;
                    if (dataStr === "[DONE]") {
                        done = true;
                        break;
                    }

                    try {
                        const parsed = JSON.parse(dataStr);
                        const statusErr = getApiStatusError(parsed);
                        if (statusErr) {
                            throw new Error(statusErr);
                        }
                        const choice = parsed.choices?.[0];
                        if (!choice) continue;

                        finishReason = choice.finish_reason;
                        const delta = choice.delta;

                        if (delta?.tool_calls) {
                            const tc = delta.tool_calls[0];
                            if (!toolCalls[tc.index]) {
                                toolCalls[tc.index] = { id: "", type: "function", function: { name: "", arguments: "" } };
                            }
                            if (tc.id) toolCalls[tc.index].id += tc.id;
                            if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                        }

                        if (delta?.reasoning_content) {
                            reasoningText += delta.reasoning_content;
                            if (!thinkingDivCreated) {
                                const thinkBox = document.createElement("div");
                                thinkBox.className = "thinking-box thinking-active";
                                thinkBox.innerHTML = `
                                    <div class="thinking-box-header">
                                        <span>Thinking Process</span>
                                        <span class="thinking-live-line"></span>
                                        <span class="material-symbols-outlined toggle-icon">expand_more</span>
                                    </div>
                                    <div class="thinking-box-content"></div>
                                `;
                                messageElement.parentElement.insertBefore(thinkBox, messageElement);
                                thinkingBoxDiv = thinkBox;
                                thinkingContentDiv = thinkBox.querySelector(".thinking-box-content");
                                thinkingLiveLineDiv = thinkBox.querySelector(".thinking-live-line");
                                thinkBox.querySelector(".thinking-box-header").addEventListener("click", () => thinkBox.classList.toggle("open"));
                                thinkingDivCreated = true;
                            }
                            if (thinkingContentDiv) thinkingContentDiv.innerText = reasoningText;
                            if (thinkingLiveLineDiv) {
                                const currentLine = getCurrentReasoningLine(reasoningText);
                                thinkingLiveLineDiv.textContent = currentLine || "Thinking...";
                            }
                            chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
                        }

                        if (delta?.content) {
                            fullText += delta.content;
                            if (!shouldVoiceReply) {
                                messageElement.innerHTML = marked.parse(fullText);
                                chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
                            }
                        }
                    } catch (err) {
                        throw err;
                    }
                }
            }
            if (readerDone) break;
        }

        if (finishReason === "tool_calls" && toolCalls.length > 0) {
            const toolCall = toolCalls[0];
            if (toolCall.function.name === "web_search") {
                const args = parseToolArgs(toolCall.function.arguments || "{}");
                const toolResponseContent = await executeWebSearch(args.query, incomingMessageDiv);

                historyContext.push({ role: "assistant", parts: [{ text: "" }], tool_calls: toolCalls });
                historyContext.push({ role: "tool", tool_call_id: toolCall.id, name: "web_search", parts: [{ text: toolResponseContent }] });

                userData.tool = null;
                await generateBotResponse(incomingMessageDiv, historyContext, options);
                return;
            }
            if (toolCall.function.name === "visit_site") {
                const args = parseToolArgs(toolCall.function.arguments || "{}");
                const toolResponseContent = await executeVisitSite(args.url, incomingMessageDiv);

                historyContext.push({ role: "assistant", parts: [{ text: "" }], tool_calls: toolCalls });
                historyContext.push({ role: "tool", tool_call_id: toolCall.id, name: "visit_site", parts: [{ text: toolResponseContent }] });

                userData.tool = null;
                await generateBotResponse(incomingMessageDiv, historyContext, options);
                return;
            }
            if (toolCall.function.name === "create_macro") {
                const args = parseToolArgs(toolCall.function.arguments || "{}");
                const toolResponseContent = await executeCreateMacro(args, incomingMessageDiv);

                historyContext.push({ role: "assistant", parts: [{ text: "" }], tool_calls: toolCalls });
                historyContext.push({ role: "tool", tool_call_id: toolCall.id, name: "create_macro", parts: [{ text: toolResponseContent }] });

                userData.tool = null;
                await generateBotResponse(incomingMessageDiv, historyContext, options);
                return;
            }
            if (toolCall.function.name === "get-all-variables") {
                const toolResponseContent = await executeGetAllVariables(incomingMessageDiv);

                historyContext.push({ role: "assistant", parts: [{ text: "" }], tool_calls: toolCalls });
                historyContext.push({ role: "tool", tool_call_id: toolCall.id, name: "get-all-variables", parts: [{ text: toolResponseContent }] });

                userData.tool = null;
                await generateBotResponse(incomingMessageDiv, historyContext, options);
                return;
            }
            if (toolCall.function.name === "read-variable") {
                const args = parseToolArgs(toolCall.function.arguments || "{}");
                const toolResponseContent = await executeReadVariable(args.name, incomingMessageDiv);

                historyContext.push({ role: "assistant", parts: [{ text: "" }], tool_calls: toolCalls });
                historyContext.push({ role: "tool", tool_call_id: toolCall.id, name: "read-variable", parts: [{ text: toolResponseContent }] });

                userData.tool = null;
                await generateBotResponse(incomingMessageDiv, historyContext, options);
                return;
            }
            if (toolCall.function.name === "write-variable") {
                const args = parseToolArgs(toolCall.function.arguments || "{}");
                const toolResponseContent = await executeWriteVariable(args.name, args.value, incomingMessageDiv, {
                    sourceMacroId: args.sourceMacroId,
                    sourceMacroName: args.sourceMacroName
                });

                historyContext.push({ role: "assistant", parts: [{ text: "" }], tool_calls: toolCalls });
                historyContext.push({ role: "tool", tool_call_id: toolCall.id, name: "write-variable", parts: [{ text: toolResponseContent }] });

                userData.tool = null;
                await generateBotResponse(incomingMessageDiv, historyContext, options);
                return;
            }
            if (toolCall.function.name === "os-time") {
                const args = parseToolArgs(toolCall.function.arguments || "{}");
                const toolResponseContent = await executeOsTime(args, incomingMessageDiv);

                historyContext.push({ role: "assistant", parts: [{ text: "" }], tool_calls: toolCalls });
                historyContext.push({ role: "tool", tool_call_id: toolCall.id, name: "os-time", parts: [{ text: toolResponseContent }] });

                userData.tool = null;
                await generateBotResponse(incomingMessageDiv, historyContext, options);
                return;
            }
        }

        if (fullText) {
            const historyIndex = ensureAssistantHistoryEntry(incomingMessageDiv);
            if (historyIndex !== -1) {
                chatHistory[historyIndex].parts = [{ text: fullText }];
                chatHistory[historyIndex].branches = [fullText];
                chatHistory[historyIndex].currentBranch = 0;
            }
            persistCurrentThread();
            if (shouldVoiceReply) {
                skipDefaultFinalize = true;
                await renderVoiceReplyAfterThinking(incomingMessageDiv, messageElement, fullText);
                finalizeIncomingMessageUi(incomingMessageDiv);
                return;
            }
        }
    } catch (error) {
        renderApiError(messageElement, error.message);
        const historyIndex = ensureAssistantHistoryEntry(incomingMessageDiv);
        if (historyIndex !== -1) {
            const errorText = `Error: ${error.message}`;
            chatHistory[historyIndex].parts = [{ text: errorText }];
            chatHistory[historyIndex].branches = [errorText];
            chatHistory[historyIndex].currentBranch = 0;
            persistCurrentThread();
        }
    } finally {
        if (!skipDefaultFinalize) {
            finalizeIncomingMessageUi(incomingMessageDiv);
        }
    }
};

const handleOutgoingMessage = async (e) => {
    e.preventDefault();
    stopArdySpeech();
    const shouldVoiceReply = pendingVoiceReplyFromStt;
    pendingVoiceReplyFromStt = false;
    userData.message = messageInput.value.trim();
    if (!userData.message) return;

    const userMessageData = {
        role: "user",
        parts: [{ text: userData.message }],
        fileData: userData.file.data ? { ...userData.file } : null,
        id: Date.now()
    };

    let attachmentHtml = "";
    if (userData.file.data) {
        if (userData.file.mime_type.startsWith("image")) {
            attachmentHtml = `<img src="data:${userData.file.mime_type};base64,${userData.file.data}" class="attachment" />`;
        } else {
            attachmentHtml = `<div class="file-attachment"><span class="material-symbols-outlined icon">draft</span><span class="name">${userData.file.fileName}</span></div>`;
        }
    }

    const outgoingMessageDiv = createMessageElement(`<div class="message-text"></div>${attachmentHtml}`, "user-message");
    outgoingMessageDiv.querySelector(".message-text").innerText = userData.message;
    outgoingMessageDiv.dataset.id = userMessageData.id;
    chatBody.appendChild(outgoingMessageDiv);
    addMessageActions(outgoingMessageDiv, "user");
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });

    messageInput.value = "";
    messageInput.dispatchEvent(new Event("input"));
    fileUploadWrapper.classList.remove("file-uploaded");

    chatHistory.push(userMessageData);
    persistCurrentThread();

    const currentTool = userData.tool;
    userData.file = {};
    userData.tool = null;

    setTimeout(async () => {
        const botId = Date.now();
        const incomingMessageDiv = createMessageElement(
            `<div class="message-text"><div class="thinking-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`,
            "bot-message",
            "thinking"
        );
        incomingMessageDiv.dataset.id = botId;
        ensureAssistantHistoryEntry(incomingMessageDiv);
        chatBody.appendChild(incomingMessageDiv);
        chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });

        userData.tool = currentTool;
        await generateBotResponse(incomingMessageDiv, chatHistory, { voiceReply: shouldVoiceReply });
        userData.tool = null;
    }, 600);
};

const switchBranch = (botMsgDiv, historyIndex, direction) => {
    const historyItem = chatHistory[historyIndex];
    let newIndex = historyItem.currentBranch + direction;
    if (newIndex < 0) newIndex = 0;
    if (newIndex >= historyItem.branches.length) newIndex = historyItem.branches.length - 1;
    if (newIndex === historyItem.currentBranch) return;

    historyItem.currentBranch = newIndex;
    const text = historyItem.branches[newIndex];
    const textDiv = botMsgDiv.querySelector(".message-text");
    textDiv.innerHTML = marked.parse(text);
    historyItem.parts[0].text = text;
    addMessageActions(botMsgDiv, "assistant");
    persistCurrentThread();
};

const regenerateMessage = async (botMsgDiv) => {
    const historyIndex = ensureAssistantHistoryEntry(botMsgDiv);
    if (historyIndex === -1) return;

    const contextHistory = chatHistory.slice(0, historyIndex);
    const textDiv = botMsgDiv.querySelector(".message-text");
    textDiv.classList.remove("error-bubble");
    textDiv.innerHTML = `<div class="thinking-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;

    const oldThinkBox = botMsgDiv.querySelector(".thinking-box");
    if (oldThinkBox) oldThinkBox.remove();
    botMsgDiv.classList.add("thinking");

    chatHistory[historyIndex].branches = [];
    chatHistory[historyIndex].currentBranch = 0;
    persistCurrentThread();

    await generateBotResponse(botMsgDiv, contextHistory);
};

const cancelEdit = (messageDiv, originalText) => {
    const textarea = messageDiv.querySelector(".edit-textarea");
    const msgTextDiv = document.createElement("div");
    msgTextDiv.className = "message-text";
    msgTextDiv.innerText = originalText;
    textarea.replaceWith(msgTextDiv);
    addMessageActions(messageDiv, "user");
};

const saveEdit = (messageDiv, newText) => {
    if (!newText.trim()) return;

    const textarea = messageDiv.querySelector(".edit-textarea");
    const msgTextDiv = document.createElement("div");
    msgTextDiv.className = "message-text";
    msgTextDiv.innerText = newText;
    textarea.replaceWith(msgTextDiv);

    const historyIndex = findHistoryIndexByElement(messageDiv);
    chatHistory[historyIndex].parts[0].text = newText;

    let nextElement = messageDiv.nextElementSibling;
    while (nextElement) {
        const toRemove = nextElement;
        nextElement = nextElement.nextElementSibling;
        toRemove.remove();
    }
    chatHistory.splice(historyIndex + 1);
    addMessageActions(messageDiv, "user");
    persistCurrentThread();

    const botId = Date.now();
    const botMsgDiv = createMessageElement(
        `<div class="message-text"><div class="thinking-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`,
        "bot-message",
        "thinking"
    );
    botMsgDiv.dataset.id = botId;
    chatBody.appendChild(botMsgDiv);
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });

    chatHistory.push({
        role: "assistant",
        parts: [{ text: "" }],
        id: botId,
        branches: [],
        currentBranch: 0
    });
    persistCurrentThread();

    setTimeout(async () => {
        await generateBotResponse(botMsgDiv, chatHistory);
    }, 600);
};

const startEditing = (messageDiv) => {
    const msgTextDiv = messageDiv.querySelector(".message-text");
    const currentText = msgTextDiv.innerText;

    const textarea = document.createElement("textarea");
    textarea.className = "edit-textarea";
    textarea.value = currentText;
    msgTextDiv.replaceWith(textarea);
    textarea.focus();
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";

    const actionsDiv = messageDiv.querySelector(".message-actions");
    actionsDiv.innerHTML = `
        <div class="edit-actions">
            <button class="edit-cancel">Cancel</button>
            <button class="edit-save">Save & Submit</button>
        </div>
    `;

    actionsDiv.querySelector(".edit-cancel").addEventListener("click", () => cancelEdit(messageDiv, currentText));
    actionsDiv.querySelector(".edit-save").addEventListener("click", () => saveEdit(messageDiv, textarea.value));
};

const addMessageActions = (messageDiv, role) => {
    const existingActions = messageDiv.querySelector(".message-actions");
    if (existingActions) existingActions.remove();

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "message-actions";

    if (role === "user") {
        actionsDiv.innerHTML = `<button class="edit-btn"><span class="material-symbols-outlined" style="font-size:14px;">edit</span> Edit</button>`;
        actionsDiv.querySelector(".edit-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            startEditing(messageDiv);
        });
    } else if (role === "assistant") {
        const historyIndex = findHistoryIndexByElement(messageDiv);
        let branchNav = "";
        if (historyIndex !== -1 && chatHistory[historyIndex].branches?.length > 1) {
            branchNav = `<div class="branch-nav">
                  <button class="prev-branch">&lt;</button>
                  <span>${chatHistory[historyIndex].currentBranch + 1} / ${chatHistory[historyIndex].branches.length}</span>
                  <button class="next-branch">&gt;</button>
              </div>`;
        }

        actionsDiv.innerHTML = `
            <button class="regen-btn"><span class="material-symbols-outlined" style="font-size:14px;">refresh</span> Regenerate</button>
            <button class="copy-btn"><span class="material-symbols-outlined" style="font-size:14px;">content_copy</span></button>
            ${branchNav}
        `;

        actionsDiv.querySelector(".regen-btn").addEventListener("click", () => regenerateMessage(messageDiv));
        actionsDiv.querySelector(".copy-btn").addEventListener("click", () => {
            const text = messageDiv.querySelector(".message-text").innerText;
            navigator.clipboard.writeText(text);
            const btn = actionsDiv.querySelector(".copy-btn");
            btn.innerText = "Copied!";
            setTimeout(() => {
                btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:14px;">content_copy</span>`;
            }, 1500);
        });

        if (historyIndex !== -1 && chatHistory[historyIndex].branches?.length > 1) {
            actionsDiv.querySelector(".prev-branch").addEventListener("click", () => switchBranch(messageDiv, historyIndex, -1));
            actionsDiv.querySelector(".next-branch").addEventListener("click", () => switchBranch(messageDiv, historyIndex, 1));
        }
    }

    messageDiv.appendChild(actionsDiv);
};

messageInput.addEventListener("input", () => {
    messageInput.style.height = `${initialInputHeight}px`;
    messageInput.style.height = `${messageInput.scrollHeight}px`;
    document.querySelector(".chat-form").style.borderRadius = messageInput.scrollHeight > initialInputHeight ? "15px" : "32px";
});

messageInput.addEventListener("keydown", (e) => {
    const userMessage = e.target.value.trim();
    if (e.key === "Enter" && !e.shiftKey && userMessage && window.innerWidth > 768) {
        handleOutgoingMessage(e);
    }
});

fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;

    const isTextFile = file.type.startsWith("text/") ||
        file.name.match(/\.(js|jsx|ts|tsx|py|java|c|cpp|h|css|html|json|md|txt|log|sh|bat|xml|yaml|yml)$/i);

    const reader = new FileReader();
    reader.onload = (e) => {
        fileInput.value = "";
        userData.file.mime_type = file.type;
        userData.file.fileName = file.name;

        const previewImg = fileUploadWrapper.querySelector("img");
        const previewIcon = fileUploadWrapper.querySelector(".file-icon-preview");

        if (file.type.startsWith("image/")) {
            userData.file.data = e.target.result.split(",")[1];
            previewImg.src = e.target.result;
            previewImg.style.display = "block";
            previewIcon.style.display = "none";
        } else {
            if (isTextFile) {
                userData.file.data = e.target.result;
                userData.file.mime_type = "text/plain";
            } else {
                userData.file.data = e.target.result.split(",")[1];
            }
            previewImg.style.display = "none";
            previewIcon.innerHTML = `<span class="material-symbols-outlined" style="font-size:20px;">${isTextFile ? "draft" : "attach_file"}</span>`;
            previewIcon.style.display = "flex";
        }
        fileUploadWrapper.classList.add("file-uploaded");
    };

    if (isTextFile) {
        reader.readAsText(file);
    } else {
        reader.readAsDataURL(file);
    }
});

fileCancelButton.addEventListener("click", () => {
    userData.file = {};
    fileUploadWrapper.classList.remove("file-uploaded");
});

toolsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toolsMenu.classList.toggle("show");
});

document.querySelectorAll(".tools-menu-item").forEach((item) => {
    item.addEventListener("click", () => {
        const tool = item.dataset.tool;
        userData.tool = tool;
        toolsMenu.classList.remove("show");

        let prefix = "";
        if (tool === "web") prefix = "[Web Search] ";
        if (tool === "macro") prefix = "[Create Macro] ";
        if (!messageInput.value.startsWith("[")) {
            messageInput.value = prefix + messageInput.value;
        }
        messageInput.focus();
    });
});

document.addEventListener("click", (e) => {
    toolsMenu.classList.remove("show");
    hideChatContextMenu();
    if (quickSigninModal && e.target === quickSigninModal) {
        closeQuickSigninModal();
    }

    if (window.innerWidth <= 980 && document.body.classList.contains("sidebar-open")) {
        const clickedInsideSidebar = e.target.closest(".chat-sidebar") || e.target.closest(".sidebar-toggle");
        if (!clickedInsideSidebar) {
            document.body.classList.remove("sidebar-open");
        }
    }
});

window.addEventListener("resize", hideChatContextMenu);
window.addEventListener("scroll", hideChatContextMenu, true);

const picker = new EmojiMart.Picker({
    theme: "light",
    skinTonePosition: "none",
    previewPosition: "none",
    onEmojiSelect: (emoji) => {
        const { selectionStart: start, selectionEnd: end } = messageInput;
        messageInput.setRangeText(emoji.native, start, end, "end");
        messageInput.focus();
    },
    onClickOutside: (e) => {
        if (e.target.id === "emoji-picker") {
            document.body.classList.toggle("show-emoji-picker");
        } else {
            document.body.classList.remove("show-emoji-picker");
        }
    }
});
document.querySelector(".chat-form").appendChild(picker);

sendMessage.addEventListener("click", (e) => handleOutgoingMessage(e));
document.querySelector("#file-upload").addEventListener("click", () => fileInput.click());

newChatBtn.addEventListener("click", () => {
    startNewThread();
});
sidebarToggle.addEventListener("click", () => {
    document.body.classList.toggle("sidebar-open");
});
if (quickSigninBtn) {
    quickSigninBtn.addEventListener("click", openQuickSigninModal);
}
if (quickSigninClose) {
    quickSigninClose.addEventListener("click", closeQuickSigninModal);
}
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        closeQuickSigninModal();
    }
});

if ("speechSynthesis" in window) {
    preferredArdyVoice = pickPreferredArdyVoice();
    window.speechSynthesis.onvoiceschanged = () => {
        preferredArdyVoice = pickPreferredArdyVoice();
    };
}

initializeVoiceInput();
initializeModelSelector();
initializeMultiAgentToggle();
loadViewerIdentity();
initializeThreads();
