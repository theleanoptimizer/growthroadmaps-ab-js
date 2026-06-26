interface ReviewVariant {
  id: string;
  name: string;
  is_control: boolean;
  js?: string | null;
  css?: string | null;
  external_js?: string[] | null;
  external_css?: string[] | null;
}

interface ReviewNote {
  id: string;
  content: string;
  created_at: string;
  user_name: string;
  is_external: boolean;
  screenshot_url: string | null;
}

interface ReviewConfig {
  experiment_id: string;
  experiment_name: string;
  status: string;
  reviewed: boolean;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  variant: ReviewVariant | null;
  notes: ReviewNote[];
}

import { DEFAULT_API_HOST } from './constants';

function getApiHost(): string {
  return DEFAULT_API_HOST;
}

function getReviewToken(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('_ab_review');
}

async function applyReviewVariant(variant: ReviewVariant): Promise<void> {
  if (variant.is_control) return;

  if (variant.external_css && variant.external_css.length) {
    for (const href of variant.external_css) {
      if (!document.querySelector(`link[data-gr-review-css][href="${href}"]`)) {
        const lk = document.createElement('link');
        lk.rel = 'stylesheet';
        lk.href = href;
        lk.setAttribute('data-gr-review-css', '1');
        document.head.appendChild(lk);
      }
    }
  }

  if (variant.css) {
    if (!document.querySelector('style[data-gr-review-css]')) {
      const s = document.createElement('style');
      s.setAttribute('data-gr-review-css', '1');
      s.textContent = variant.css;
      document.head.appendChild(s);
    }
  }

  const runJs = () => {
    if (variant.js) {
      try {
        const sc = document.createElement('script');
        sc.textContent = `(function(){try{${variant.js}}catch(e){console.error('[GR Review]',e)}})();`;
        document.head.appendChild(sc);
      } catch {
        // ignore
      }
    }
  };

  if (variant.external_js && variant.external_js.length) {
    let chain: Promise<void> = Promise.resolve();
    for (const src of variant.external_js) {
      chain = chain.then(() => new Promise<void>(resolve => {
        if (document.querySelector(`script[data-gr-review-js][src="${src}"]`)) { resolve(); return; }
        const sc = document.createElement('script');
        sc.src = src;
        sc.setAttribute('data-gr-review-js', '1');
        sc.onload = () => resolve();
        sc.onerror = () => resolve();
        document.head.appendChild(sc);
      }));
    }
    chain.then(runJs);
  } else {
    runJs();
  }
}

type Html2CanvasFn = (el: HTMLElement, opts: Record<string, unknown>) => Promise<HTMLCanvasElement>;

function loadHtml2Canvas(): Promise<Html2CanvasFn | null> {
  const w = window as unknown as Record<string, unknown>;
  if (typeof w['html2canvas'] === 'function') {
    return Promise.resolve(w['html2canvas'] as Html2CanvasFn);
  }
  return new Promise((resolve) => {
    if (document.querySelector('script[data-gr-h2c]')) {
      // Already loading — poll until ready or timeout
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        if (typeof w['html2canvas'] === 'function') {
          clearInterval(poll);
          resolve(w['html2canvas'] as Html2CanvasFn);
        } else if (attempts > 40) {
          clearInterval(poll);
          resolve(null);
        }
      }, 100);
      return;
    }
    const script = document.createElement('script');
    script.setAttribute('data-gr-h2c', '1');
    script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    script.onload = () => resolve(typeof w['html2canvas'] === 'function' ? w['html2canvas'] as Html2CanvasFn : null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

async function withPanelHidden<T>(fn: () => Promise<T>): Promise<T> {
  const host = document.getElementById('gr-review-panel-host');
  if (host) host.style.visibility = 'hidden';
  await new Promise(r => requestAnimationFrame(r));
  try {
    return await fn();
  } finally {
    if (host) host.style.visibility = '';
  }
}

async function captureFullPageScreenshot(): Promise<string | null> {
  return withPanelHidden(async () => {
    try {
      const html2canvas = await loadHtml2Canvas();
      if (!html2canvas) return null;
      const sx = window.scrollX || 0;
      const sy = window.scrollY || 0;
      const canvas = await html2canvas(document.documentElement, {
        scale: 0.6,
        useCORS: true,
        allowTaint: true,
        logging: false,
        x: sx,
        y: sy,
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: -sx,
        scrollY: -sy,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
      });
      return canvas.toDataURL('image/jpeg', 0.7);
    } catch {
      return null;
    }
  });
}

async function captureElementScreenshot(el: HTMLElement): Promise<string | null> {
  return withPanelHidden(async () => {
    try {
      const html2canvas = await loadHtml2Canvas();
      if (!html2canvas) return null;
      const canvas = await html2canvas(el, { scale: 1, useCORS: true, allowTaint: true, logging: false });
      return canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      return null;
    }
  });
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function renderReviewPanel(initialConfig: ReviewConfig, token: string, apiHost: string): void {
  const existing = document.getElementById('gr-review-panel-host');
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = 'gr-review-panel-host';
  host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const LS_NAME_KEY = 'gr_reviewer_name';

  // Panel state
  let config = initialConfig;
  let collapsed = false;
  let tab: 'feedback' | 'notes' = 'feedback';
  let submitting = false;
  let submitted = false;
  let name = (() => { try { return localStorage.getItem(LS_NAME_KEY) || ''; } catch { return ''; } })();
  let noteText = '';
  let screenshotMode: 'none' | 'page' | 'element' = 'none';
  let captureStatus = '';
  let pendingDataUrl: string | null = null;
  let pickingElement = false;

  // Poll notes every 10 seconds
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  async function pollNotes() {
    try {
      const res = await fetch(`${apiHost}/api/ab/review/${token}`, { cache: 'no-store' });
      if (!res.ok) return;
      const fresh: ReviewConfig = await res.json();
      config = fresh;
      render();
    } catch {
      // ignore poll errors
    }
  }

  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(pollNotes, 10000);
  }

  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  // Element picker overlay
  function startElementPicker() {
    if (pickingElement) return;
    pickingElement = true;
    const overlay = document.createElement('div');
    overlay.id = 'gr-element-picker-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;cursor:crosshair;';

    let highlighted: HTMLElement | null = null;
    const origOutline = new WeakMap<HTMLElement, string>();

    const highlight = (el: HTMLElement) => {
      if (highlighted && highlighted !== el) {
        highlighted.style.outline = origOutline.get(highlighted) || '';
      }
      if (!origOutline.has(el)) origOutline.set(el, el.style.outline);
      el.style.outline = '2px solid #8b5cf6';
      highlighted = el;
    };

    overlay.addEventListener('mousemove', (e: MouseEvent) => {
      overlay.style.pointerEvents = 'none';
      const elUnder = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      overlay.style.pointerEvents = '';
      if (elUnder && elUnder !== overlay && elUnder !== host) highlight(elUnder);
    });

    overlay.addEventListener('click', async (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      overlay.style.pointerEvents = 'none';
      const elUnder = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      overlay.remove();
      pickingElement = false;

      if (highlighted) {
        highlighted.style.outline = origOutline.get(highlighted) || '';
        highlighted = null;
      }

      if (elUnder && elUnder !== host) {
        captureStatus = 'Capturing element…';
        render();
        pendingDataUrl = await captureElementScreenshot(elUnder as HTMLElement);
        captureStatus = pendingDataUrl ? 'Element captured.' : 'Capture failed.';
        render();
        setTimeout(() => { captureStatus = ''; render(); }, 2000);
      } else {
        screenshotMode = 'none';
        render();
      }
    });

    document.body.appendChild(overlay);
  }

  function render() {
    shadow.innerHTML = '';

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .panel-toggle {
        width: 44px; height: 44px; border-radius: 50%; border: none;
        background: #8b5cf6; color: #fff; cursor: pointer; display: flex;
        align-items: center; justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25); transition: transform 0.15s;
      }
      .panel-toggle:hover { transform: scale(1.1); }
      .panel { width: 340px; background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.18); overflow: hidden; display: flex; flex-direction: column; max-height: 80vh; }
      .panel-header { padding: 12px 16px; background: #8b5cf6; color: #fff; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
      .panel-title { font-size: 13px; font-weight: 600; }
      .panel-subtitle { font-size: 10px; opacity: 0.8; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
      .header-btn { background: none; border: none; color: #fff; cursor: pointer; opacity: 0.8; padding: 2px; }
      .header-btn:hover { opacity: 1; }
      .tabs { display: flex; border-bottom: 1px solid #e5e7eb; flex-shrink: 0; background: #fff; }
      .tab { flex: 1; padding: 8px; font-size: 12px; font-weight: 500; border: none; background: none; cursor: pointer; color: #6b7280; border-bottom: 2px solid transparent; transition: color 0.15s; }
      .tab.active { color: #8b5cf6; border-bottom-color: #8b5cf6; }
      .tab:hover:not(.active) { color: #374151; }
      .panel-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1; }
      label { font-size: 12px; font-weight: 500; color: #374151; display: block; margin-bottom: 3px; }
      input[type="text"], textarea { width: 100%; padding: 7px 10px; font-size: 12px; border: 1px solid #e5e7eb; border-radius: 6px; outline: none; resize: none; font-family: inherit; transition: border-color 0.15s; }
      input[type="text"]:focus, textarea:focus { border-color: #8b5cf6; }
      .screenshot-row { display: flex; flex-direction: column; gap: 4px; }
      .screenshot-btns { display: flex; gap: 6px; }
      .screenshot-btn { flex: 1; padding: 5px 8px; font-size: 11px; font-weight: 500; border: 1px solid #e5e7eb; border-radius: 5px; background: #fff; cursor: pointer; color: #374151; transition: all 0.15s; }
      .screenshot-btn.active { border-color: #8b5cf6; background: #f5f3ff; color: #8b5cf6; }
      .screenshot-btn:hover:not(.active) { border-color: #d1d5db; background: #f9fafb; }
      .capture-status { font-size: 11px; color: #6b7280; }
      .preview-img { max-height: 80px; max-width: 100%; border-radius: 4px; border: 1px solid #e5e7eb; object-fit: cover; }
      .clear-btn { font-size: 11px; color: #ef4444; background: none; border: none; cursor: pointer; padding: 0; }
      .submit-btn { width: 100%; padding: 8px; background: #8b5cf6; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
      .submit-btn:hover { background: #7c3aed; }
      .submit-btn:disabled { background: #c4b5fd; cursor: not-allowed; }
      .success-msg { text-align: center; padding: 20px; font-size: 13px; color: #059669; }
      .reviewed-badge { font-size: 11px; color: #059669; display: flex; align-items: center; gap: 4px; padding: 4px 0; font-weight: 500; }
      .reviewed-meta { font-size: 10px; color: #6b7280; font-weight: 400; }
      .notes-list { display: flex; flex-direction: column; gap: 10px; }
      .note-item { padding: 8px 10px; background: #f9fafb; border-radius: 6px; border: 1px solid #f3f4f6; }
      .note-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
      .note-author { font-size: 11px; font-weight: 600; color: #374151; }
      .note-ext-badge { font-size: 9px; background: #ede9fe; color: #7c3aed; border-radius: 3px; padding: 1px 4px; font-weight: 500; }
      .note-time { font-size: 10px; color: #9ca3af; }
      .note-content { font-size: 12px; color: #374151; white-space: pre-wrap; word-break: break-word; }
      .note-screenshot { margin-top: 6px; max-height: 80px; max-width: 100%; border-radius: 4px; border: 1px solid #e5e7eb; object-fit: cover; display: block; cursor: pointer; }
      .empty-notes { text-align: center; padding: 24px 0; font-size: 12px; color: #9ca3af; }
    `;
    shadow.appendChild(style);

    if (collapsed) {
      const btn = document.createElement('button');
      btn.className = 'panel-toggle';
      btn.title = 'Open Review Panel';
      btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      btn.onclick = () => { collapsed = false; render(); };
      shadow.appendChild(btn);
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'panel';

    // Header
    const header = document.createElement('div');
    header.className = 'panel-header';
    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'min-width:0;flex:1;';
    const titleEl = document.createElement('div');
    titleEl.className = 'panel-title';
    titleEl.textContent = 'Review Feedback';
    const subtitle = document.createElement('div');
    subtitle.className = 'panel-subtitle';
    subtitle.textContent = config.experiment_name;
    headerLeft.appendChild(titleEl);
    headerLeft.appendChild(subtitle);
    header.appendChild(headerLeft);
    const minBtn = document.createElement('button');
    minBtn.className = 'header-btn';
    minBtn.title = 'Minimize';
    minBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
    minBtn.onclick = () => { collapsed = true; render(); };
    header.appendChild(minBtn);
    panel.appendChild(header);

    // Tabs
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    const feedbackTab = document.createElement('button');
    feedbackTab.className = `tab${tab === 'feedback' ? ' active' : ''}`;
    feedbackTab.textContent = 'Leave Feedback';
    feedbackTab.onclick = () => { tab = 'feedback'; render(); };
    const notesTab = document.createElement('button');
    notesTab.className = `tab${tab === 'notes' ? ' active' : ''}`;
    const noteCount = config.notes.length;
    notesTab.textContent = `Notes${noteCount > 0 ? ` (${noteCount})` : ''}`;
    notesTab.onclick = () => { tab = 'notes'; render(); };
    tabs.appendChild(feedbackTab);
    tabs.appendChild(notesTab);
    panel.appendChild(tabs);

    const body = document.createElement('div');
    body.className = 'panel-body';

    if (config.reviewed) {
      const badge = document.createElement('div');
      badge.className = 'reviewed-badge';
      let reviewedText = '✓ Marked as reviewed';
      if (config.reviewed_by_name) reviewedText += ` by ${config.reviewed_by_name}`;
      badge.innerHTML = reviewedText;
      if (config.reviewed_at) {
        const meta = document.createElement('div');
        meta.className = 'reviewed-meta';
        meta.textContent = formatTimeAgo(config.reviewed_at);
        badge.appendChild(meta);
      }
      body.appendChild(badge);
    }

    if (tab === 'feedback') {
      if (submitted) {
        const msg = document.createElement('div');
        msg.className = 'success-msg';
        msg.innerHTML = '✓ Your feedback has been submitted.<br><small style="color:#6b7280">Thank you for reviewing!</small>';
        body.appendChild(msg);
        const backBtn = document.createElement('button');
        backBtn.className = 'submit-btn';
        backBtn.style.marginTop = '8px';
        backBtn.textContent = 'View notes thread';
        backBtn.onclick = () => { tab = 'notes'; submitted = false; render(); };
        body.appendChild(backBtn);
      } else {
        // Name field
        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Your name (optional)';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Reviewer name';
        nameInput.value = name;
        nameInput.oninput = (e) => {
          name = (e.target as HTMLInputElement).value;
          if (name) { try { localStorage.setItem(LS_NAME_KEY, name); } catch { /* ignore */ } }
        };
        body.appendChild(nameLabel);
        body.appendChild(nameInput);

        // Feedback textarea
        const noteLabel = document.createElement('label');
        noteLabel.textContent = 'Feedback *';
        const noteArea = document.createElement('textarea');
        noteArea.rows = 4;
        noteArea.placeholder = 'Share your thoughts about this design…';
        noteArea.value = noteText;
        noteArea.oninput = (e) => { noteText = (e.target as HTMLTextAreaElement).value; };
        body.appendChild(noteLabel);
        body.appendChild(noteArea);

        // Screenshot capture section
        const ssSection = document.createElement('div');
        ssSection.className = 'screenshot-row';
        const ssLabel = document.createElement('label');
        ssLabel.textContent = 'Screenshot (optional)';
        ssSection.appendChild(ssLabel);

        const ssBtns = document.createElement('div');
        ssBtns.className = 'screenshot-btns';

        const noneBtn = document.createElement('button');
        noneBtn.className = `screenshot-btn${screenshotMode === 'none' ? ' active' : ''}`;
        noneBtn.textContent = 'None';
        noneBtn.onclick = () => {
          screenshotMode = 'none';
          pendingDataUrl = null;
          render();
        };

        const pageBtn = document.createElement('button');
        pageBtn.className = `screenshot-btn${screenshotMode === 'page' ? ' active' : ''}`;
        pageBtn.textContent = 'Visible area';
        pageBtn.onclick = async () => {
          screenshotMode = 'page';
          pendingDataUrl = null;
          captureStatus = 'Capturing page…';
          render();
          pendingDataUrl = await captureFullPageScreenshot();
          captureStatus = pendingDataUrl ? '' : 'Capture failed. Try again.';
          render();
        };

        const elemBtn = document.createElement('button');
        elemBtn.className = `screenshot-btn${screenshotMode === 'element' ? ' active' : ''}`;
        elemBtn.textContent = 'Pick element';
        elemBtn.onclick = () => {
          screenshotMode = 'element';
          pendingDataUrl = null;
          captureStatus = 'Click an element on the page…';
          render();
          startElementPicker();
        };

        ssBtns.appendChild(noneBtn);
        ssBtns.appendChild(pageBtn);
        ssBtns.appendChild(elemBtn);
        ssSection.appendChild(ssBtns);

        if (captureStatus) {
          const statusEl = document.createElement('div');
          statusEl.className = 'capture-status';
          statusEl.textContent = captureStatus;
          ssSection.appendChild(statusEl);
        }

        if (pendingDataUrl) {
          const previewRow = document.createElement('div');
          previewRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
          const img = document.createElement('img');
          img.className = 'preview-img';
          img.src = pendingDataUrl;
          img.alt = 'Screenshot preview';
          const clearBtn = document.createElement('button');
          clearBtn.className = 'clear-btn';
          clearBtn.textContent = 'Remove';
          clearBtn.onclick = () => { pendingDataUrl = null; screenshotMode = 'none'; render(); };
          previewRow.appendChild(img);
          previewRow.appendChild(clearBtn);
          ssSection.appendChild(previewRow);
        }

        body.appendChild(ssSection);

        const submitBtn = document.createElement('button');
        submitBtn.className = 'submit-btn';
        submitBtn.textContent = submitting ? 'Submitting…' : 'Submit feedback';
        submitBtn.disabled = submitting;
        submitBtn.onclick = async () => {
          const trimmedNote = noteText.trim();
          if (!trimmedNote) { noteArea.focus(); return; }
          submitting = true;
          render();

          try {
            type NotePayload = { content: string; externalName?: string; screenshotUrl?: string };
            const payload: NotePayload = { content: trimmedNote };
            if (name.trim()) payload.externalName = name.trim();

            if (pendingDataUrl) {
              captureStatus = 'Uploading screenshot…';
              render();
              try {
                const upRes = await fetch(`${apiHost}/api/ab/review/${token}/upload`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ data_url: pendingDataUrl }),
                });
                if (upRes.ok) {
                  const upJson = await upRes.json() as { screenshotUrl: string };
                  payload.screenshotUrl = upJson.screenshotUrl;
                }
              } catch {
                // Screenshot upload failed; submit note without screenshot
              }
              captureStatus = '';
              render();
            }

            const res = await fetch(`${apiHost}/api/ab/review/${token}/notes`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (res.ok) {
              const newNote: ReviewNote = await res.json();
              config.notes.push(newNote);
              submitted = true;
              noteText = '';
              pendingDataUrl = null;
              screenshotMode = 'none';
            } else {
              captureStatus = 'Failed to submit. Please try again.';
            }
          } catch {
            captureStatus = 'Network error. Please try again.';
          }
          submitting = false;
          render();
        };
        body.appendChild(submitBtn);
      }
    } else {
      // Notes thread tab
      if (config.notes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-notes';
        empty.textContent = 'No notes yet. Be the first to leave feedback!';
        body.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.className = 'notes-list';
        for (const note of [...config.notes].reverse()) {
          const item = document.createElement('div');
          item.className = 'note-item';

          const meta = document.createElement('div');
          meta.className = 'note-meta';
          const authorRow = document.createElement('div');
          authorRow.style.cssText = 'display:flex;align-items:center;gap:4px;';
          const author = document.createElement('span');
          author.className = 'note-author';
          author.textContent = note.user_name;
          authorRow.appendChild(author);
          if (note.is_external) {
            const badge = document.createElement('span');
            badge.className = 'note-ext-badge';
            badge.textContent = 'External';
            authorRow.appendChild(badge);
          }
          const timeEl = document.createElement('span');
          timeEl.className = 'note-time';
          timeEl.textContent = formatTimeAgo(note.created_at);
          meta.appendChild(authorRow);
          meta.appendChild(timeEl);
          item.appendChild(meta);

          const content = document.createElement('div');
          content.className = 'note-content';
          content.textContent = note.content;
          item.appendChild(content);

          if (note.screenshot_url) {
            const img = document.createElement('img');
            img.className = 'note-screenshot';
            img.src = `${apiHost}${note.screenshot_url}`;
            img.alt = 'Screenshot';
            img.onclick = () => { window.open(`${apiHost}${note.screenshot_url}`, '_blank'); };
            item.appendChild(img);
          }

          list.appendChild(item);
        }
        body.appendChild(list);
      }
    }

    panel.appendChild(body);
    shadow.appendChild(panel);
  }

  render();
  startPolling();

  // Clean up poll on page unload
  window.addEventListener('unload', stopPolling, { once: true });
}

export async function initReviewMode(apiHost: string = ''): Promise<void> {
  if (typeof window === 'undefined') return;
  const token = getReviewToken();
  if (!token) return;

  try {
    const host = apiHost || getApiHost();
    const res = await fetch(`${host}/api/ab/review/${token}`, { cache: 'no-store' });
    if (!res.ok) return;
    const config: ReviewConfig = await res.json();

    if (config.variant) {
      await applyReviewVariant(config.variant);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => renderReviewPanel(config, token, host));
    } else {
      renderReviewPanel(config, token, host);
    }
  } catch {
    // Silently fail — don't break the host page
  }
}
