interface BuilderResolveConfig {
  experiment_id: string;
  experiment_name: string;
  variant_id: string;
  variant_name: string;
  is_control: boolean;
  mode: string;
  js?: string | null;
  css?: string | null;
  external_js?: string[] | null;
  external_css?: string[] | null;
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
};

function getApiHost(fallback: string): string {
  if (fallback) return fallback.replace(/\/$/, "");
  if (typeof window === "undefined") return "";
  return ((window as unknown as Record<string, unknown>)["__GR_API_HOST__"] as string || "").replace(/\/$/, "");
}

function getBuilderToken(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("_ab_builder");
}

function builderUrl(apiHost: string, token: string, path: string): string {
  return `${getApiHost(apiHost)}/api/ab/builder/${encodeURIComponent(token)}/${path}`;
}

async function applyBuilderVariant(variant: BuilderResolveConfig): Promise<void> {
  if (variant.is_control) return;

  if (variant.external_css?.length) {
    for (const href of variant.external_css) {
      if (!document.querySelector(`link[data-gr-builder-css][href="${href}"]`)) {
        const lk = document.createElement("link");
        lk.rel = "stylesheet";
        lk.href = href;
        lk.setAttribute("data-gr-builder-css", "1");
        document.head.appendChild(lk);
      }
    }
  }

  if (variant.css) {
    const existing = document.querySelector("style[data-gr-builder-css]");
    if (existing) existing.remove();
    const s = document.createElement("style");
    s.setAttribute("data-gr-builder-css", "1");
    s.textContent = variant.css;
    document.head.appendChild(s);
  }

  const runJs = () => {
    if (!variant.js) return;
    const prev = document.querySelector("script[data-gr-builder-js]");
    if (prev) prev.remove();
    try {
      const sc = document.createElement("script");
      sc.setAttribute("data-gr-builder-js", "1");
      sc.textContent = `(function(){try{${variant.js}}catch(e){console.error('[GR Builder]',e)}})();`;
      document.head.appendChild(sc);
    } catch {
      // ignore
    }
  };

  if (variant.external_js?.length) {
    for (const src of variant.external_js) {
      const existing = document.querySelector(`script[data-gr-builder-ext-js][src="${src}"]`);
      if (existing) continue;
      await new Promise<void>((resolve) => {
        const sc = document.createElement("script");
        sc.src = src;
        sc.setAttribute("data-gr-builder-ext-js", "1");
        sc.onload = () => resolve();
        sc.onerror = () => resolve();
        document.head.appendChild(sc);
      });
    }
  }
  runJs();
}

async function postLivePageContext(apiHost: string, token: string): Promise<void> {
  try {
    const html = document.documentElement?.outerHTML || "";
    if (!html) return;
    await fetch(builderUrl(apiHost, token, "page-context"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: window.location.href, html }),
    });
  } catch {
    // non-fatal
  }
}

function renderBuilderPanel(
  config: BuilderResolveConfig,
  token: string,
  apiHost: string,
  initialMessages: ChatMessage[],
): void {
  const existing = document.getElementById("gr-builder-panel-host");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "gr-builder-panel-host";
  host.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  let collapsed = false;
  let messages = [...initialMessages];
  let input = "";
  let sending = false;
  let currentJs = config.js ?? null;
  let currentCss = config.css ?? null;

  const styles = document.createElement("style");
  styles.textContent = `
    * { box-sizing: border-box; }
    .panel {
      width: 360px;
      max-height: min(560px, calc(100vh - 32px));
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      color: #111827;
      font-size: 13px;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid #e5e7eb;
      background: #f9fafb;
    }
    .header-title { font-weight: 600; font-size: 13px; line-height: 1.3; }
    .header-sub { font-size: 11px; color: #6b7280; margin-top: 2px; }
    .header-actions { display: flex; gap: 4px; }
    .icon-btn {
      border: none;
      background: transparent;
      cursor: pointer;
      color: #6b7280;
      padding: 4px;
      border-radius: 6px;
      font-size: 14px;
      line-height: 1;
    }
    .icon-btn:hover { background: #eef2ff; color: #111827; }
    .body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 180px;
      max-height: 360px;
    }
    .msg {
      border-radius: 10px;
      padding: 8px 10px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg-user { background: #4f46e5; color: #fff; align-self: flex-end; max-width: 88%; }
    .msg-assistant { background: #f3f4f6; color: #111827; align-self: flex-start; max-width: 92%; }
    .empty { color: #9ca3af; font-style: italic; font-size: 12px; line-height: 1.45; }
    .footer { border-top: 1px solid #e5e7eb; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    textarea {
      width: 100%;
      min-height: 56px;
      max-height: 120px;
      resize: vertical;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 8px 10px;
      font: inherit;
    }
    .send-row { display: flex; justify-content: flex-end; }
    .send-btn {
      background: #4f46e5;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
    }
    .send-btn:disabled { opacity: .55; cursor: not-allowed; }
    .status { font-size: 11px; color: #6b7280; padding: 0 12px 8px; }
    .collapsed-bar {
      background: #4f46e5;
      color: #fff;
      border-radius: 999px;
      padding: 10px 14px;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(79,70,229,.35);
      font-size: 13px;
      font-weight: 600;
    }
  `;

  function render(): void {
    shadow.innerHTML = "";
    shadow.appendChild(styles);

    if (collapsed) {
      const bar = document.createElement("button");
      bar.type = "button";
      bar.className = "collapsed-bar";
      bar.textContent = "AI Builder";
      bar.onclick = () => {
        collapsed = false;
        render();
      };
      shadow.appendChild(bar);
      return;
    }

    const panel = document.createElement("div");
    panel.className = "panel";

    const header = document.createElement("div");
    header.className = "header";
    const titleWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "header-title";
    title.textContent = "AI Builder";
    const sub = document.createElement("div");
    sub.className = "header-sub";
    sub.textContent = `${config.variant_name} · ${config.experiment_name}`;
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "header-actions";
    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "icon-btn";
    collapseBtn.title = "Collapse";
    collapseBtn.textContent = "—";
    collapseBtn.onclick = () => {
      collapsed = true;
      render();
    };
    actions.appendChild(collapseBtn);
    header.appendChild(titleWrap);
    header.appendChild(actions);

    const body = document.createElement("div");
    body.className = "body";

    const status = document.createElement("div");
    status.className = "status";
    status.textContent = sending ? "Generating…" : "Changes reload the page automatically";

    const messagesEl = document.createElement("div");
    messagesEl.className = "messages";
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent =
        'Describe the change you want — for example, "Make the hero button green." The AI will update the variant and refresh this page.';
      messagesEl.appendChild(empty);
    } else {
      for (const m of messages) {
        const bubble = document.createElement("div");
        bubble.className = `msg ${m.role === "user" ? "msg-user" : "msg-assistant"}`;
        bubble.textContent =
          m.role === "assistant"
            ? m.content.replace(/```[a-zA-Z]*\n[\s\S]*?```/g, "").trim() || m.content
            : m.content;
        messagesEl.appendChild(bubble);
      }
    }

    const footer = document.createElement("div");
    footer.className = "footer";
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Describe the change you want…";
    textarea.value = input;
    textarea.disabled = sending;
    textarea.oninput = (e) => {
      input = (e.target as HTMLTextAreaElement).value;
    };
    textarea.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    };

    const sendRow = document.createElement("div");
    sendRow.className = "send-row";
    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "send-btn";
    sendBtn.textContent = sending ? "Sending…" : "Send";
    sendBtn.disabled = sending || !input.trim();
    sendBtn.onclick = () => void sendMessage();
    sendRow.appendChild(sendBtn);

    footer.appendChild(textarea);
    footer.appendChild(sendRow);

    body.appendChild(status);
    body.appendChild(messagesEl);
    body.appendChild(footer);
    panel.appendChild(header);
    panel.appendChild(body);
    shadow.appendChild(panel);

    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function sendMessage(): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    sending = true;
    messages.push({ role: "user", content: trimmed, timestamp: new Date().toISOString() });
    input = "";
    render();

    try {
      const res = await fetch(builderUrl(apiHost, token, "ai-chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, js: currentJs, css: currentCss }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message || `Request failed (${res.status})`);
      }
      const data = (await res.json()) as {
        reply: string;
        applied_versions?: Array<{ js: string | null; css: string | null }>;
      };
      messages.push({ role: "assistant", content: data.reply, timestamp: new Date().toISOString() });
      if (data.applied_versions && data.applied_versions.length > 0) {
        const latest = data.applied_versions[data.applied_versions.length - 1];
        currentJs = latest.js;
        currentCss = latest.css;
        sending = false;
        window.location.reload();
        return;
      }
    } catch (e) {
      messages.push({
        role: "assistant",
        content: `Sorry, something went wrong: ${e instanceof Error ? e.message : "unknown error"}`,
        timestamp: new Date().toISOString(),
      });
    }
    sending = false;
    render();
  }

  render();
}

export async function initBuilderMode(apiHost: string = ""): Promise<void> {
  if (typeof window === "undefined") return;
  const token = getBuilderToken();
  if (!token) return;

  const host = getApiHost(apiHost);
  try {
    const resolveRes = await fetch(builderUrl(host, token, "resolve"), { cache: "no-store" });
    if (!resolveRes.ok) {
      console.warn("[GR Builder] Failed to resolve session:", resolveRes.status);
      return;
    }
    const config = (await resolveRes.json()) as BuilderResolveConfig;

    if (!config.is_control) {
      await applyBuilderVariant(config);
    }

    await postLivePageContext(host, token);

    let initialMessages: ChatMessage[] = [];
    try {
      const histRes = await fetch(builderUrl(host, token, "ai-chat"), { cache: "no-store" });
      if (histRes.ok) {
        const hist = (await histRes.json()) as { messages?: ChatMessage[] };
        initialMessages = hist.messages || [];
      }
    } catch {
      // ignore
    }

    const boot = () => renderBuilderPanel(config, token, host, initialMessages);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
  } catch (e) {
    console.warn("[GR Builder] init failed", e);
  }
}
