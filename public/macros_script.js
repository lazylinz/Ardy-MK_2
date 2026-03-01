const MACROS_API_URL = "/api/macros";

const macroForm = document.querySelector("#macro-form");
const macroNameInput = document.querySelector("#macro-name");
const macroTriggerLuaInput = document.querySelector("#macro-trigger-lua");
const macroThenScriptInput = document.querySelector("#macro-then-script");
const macroElseScriptInput = document.querySelector("#macro-else-script");
const macroList = document.querySelector("#macro-list");
const macroStatus = document.querySelector("#macro-status");
let triggerEditor = null;
let thenEditor = null;
let elseEditor = null;

const escapeText = (value) => String(value || "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

let macroItems = [];

const getRuntimeState = (macro) => {
  const raw = String(macro?.runtimeState || "").trim().toLowerCase();
  if (raw === "running" || raw === "firing" || raw === "idling") return raw;
  return macro?.enabled ? "running" : "idling";
};

const formatRuntimeState = (state) => {
  if (state === "running") return "Running";
  if (state === "firing") return "Firing";
  return "Idling";
};

const setStatus = (text) => {
  if (!macroStatus) return;
  macroStatus.textContent = text || "";
};

const createLuaEditor = (textarea, { minLines = 5 } = {}) => {
  if (!textarea || typeof window.CodeMirror === "undefined") return null;
  textarea.removeAttribute("required");
  const editor = window.CodeMirror.fromTextArea(textarea, {
    mode: "text/x-lua",
    theme: "material-darker",
    lineNumbers: true,
    lineWrapping: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    indentUnit: 2,
    tabSize: 2,
    viewportMargin: Infinity
  });
  editor.setSize("100%", `${Math.max(120, minLines * 24)}px`);
  return editor;
};

const renderMacros = () => {
  if (!macroList) return;
  macroList.innerHTML = "";

  if (!macroItems.length) {
    macroList.innerHTML = `<article class="macro-item"><p>No macros yet.</p></article>`;
    return;
  }

  macroItems.forEach((macro) => {
    const runtimeState = getRuntimeState(macro);
    const runtimeEvent = String(macro?.lastRuntimeEvent || "").trim();
    const triggerLua = String(macro?.triggerLua || macro?.condition || "").trim();
    const thenLuaScript = String(macro?.thenLuaScript || macro?.luaScript || "").trim();
    const elseLuaScript = String(macro?.elseLuaScript || "").trim();
    const item = document.createElement("article");
    item.className = "macro-item";
    item.innerHTML = `
      <h3>
        ${escapeText(macro.name || "Untitled Macro")}
        <span class="status-dot status-${runtimeState}" title="${formatRuntimeState(runtimeState)}"></span>
      </h3>
      <p><strong>Trigger (Lua):</strong> ${escapeText(triggerLua || "N/A")}</p>
      <p><strong>Status:</strong> ${macro.enabled ? "Enabled" : "Disabled"}</p>
      <p><strong>Runtime:</strong> ${formatRuntimeState(runtimeState)}${runtimeEvent ? ` - ${escapeText(runtimeEvent)}` : ""}</p>
      <p><strong>Then (Lua):</strong></p>
      <pre>${escapeText(thenLuaScript)}</pre>
      <p><strong>Else (Lua):</strong></p>
      <pre>${escapeText(elseLuaScript || "-- no-op")}</pre>
      <div class="macro-actions">
        <button type="button" data-action="toggle" data-id="${escapeText(macro.id)}">${macro.enabled ? "Disable" : "Enable"}</button>
        <button type="button" data-action="delete" data-id="${escapeText(macro.id)}">Delete</button>
      </div>
    `;
    macroList.appendChild(item);
  });
};

const loadMacros = async () => {
  try {
    const response = await fetch(MACROS_API_URL, { method: "GET" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
    }
    macroItems = Array.isArray(payload?.macros) ? payload.macros : [];
    renderMacros();
  } catch (error) {
    setStatus(`Failed to load macros: ${error.message}`);
  }
};

const createMacro = async ({ name, triggerLua, thenLuaScript, elseLuaScript = "", enabled = true }) => {
  const response = await fetch(MACROS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      triggerLua,
      thenLuaScript,
      elseLuaScript,
      enabled
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
  }
  macroItems = Array.isArray(payload?.macros) ? payload.macros : macroItems;
  renderMacros();
};

const updateMacroEnabled = async (macroId, enabled) => {
  const response = await fetch(`${MACROS_API_URL}/${encodeURIComponent(macroId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
  }
  macroItems = Array.isArray(payload?.macros) ? payload.macros : macroItems;
  renderMacros();
};

const removeMacro = async (macroId) => {
  const response = await fetch(`${MACROS_API_URL}/${encodeURIComponent(macroId)}`, {
    method: "DELETE"
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
  }
  macroItems = Array.isArray(payload?.macros) ? payload.macros : macroItems;
  renderMacros();
};

if (macroForm) {
  triggerEditor = createLuaEditor(macroTriggerLuaInput, { minLines: 4 });
  thenEditor = createLuaEditor(macroThenScriptInput, { minLines: 6 });
  elseEditor = createLuaEditor(macroElseScriptInput, { minLines: 5 });

  macroForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = macroNameInput?.value?.trim() || "";
    const triggerLua = (triggerEditor ? triggerEditor.getValue() : macroTriggerLuaInput?.value || "").trim();
    const thenLuaScript = (thenEditor ? thenEditor.getValue() : macroThenScriptInput?.value || "").trim();
    const elseLuaScript = (elseEditor ? elseEditor.getValue() : macroElseScriptInput?.value || "").trim();
    if (!name || !triggerLua || !thenLuaScript) {
      setStatus("Name, Trigger (Lua), and Then script (Lua) are required.");
      return;
    }

    try {
      setStatus("Saving macro...");
      await createMacro({ name, triggerLua, thenLuaScript, elseLuaScript, enabled: true });
      macroForm.reset();
      if (triggerEditor) triggerEditor.setValue("");
      if (thenEditor) thenEditor.setValue("");
      if (elseEditor) elseEditor.setValue("");
      setStatus("Macro saved.");
    } catch (error) {
      setStatus(`Save failed: ${error.message}`);
    }
  });
}

if (macroList) {
  macroList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;

    const macroId = btn.dataset.id;
    const action = btn.dataset.action;
    if (!macroId || !action) return;

    try {
      if (action === "delete") {
        setStatus("Deleting macro...");
        await removeMacro(macroId);
        setStatus("Macro deleted.");
        return;
      }
      if (action === "toggle") {
        const target = macroItems.find((m) => String(m.id) === String(macroId));
        if (!target) return;
        setStatus("Updating macro...");
        await updateMacroEnabled(macroId, !target.enabled);
        setStatus("Macro updated.");
      }
    } catch (error) {
      setStatus(`Update failed: ${error.message}`);
    }
  });
}

loadMacros();
setInterval(loadMacros, 2000);
