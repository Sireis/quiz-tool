(() => {
  const panel = document.getElementById('selection-chatgpt');
  const link = document.getElementById('selection-chatgpt-link');
  const project = document.getElementById('selection-chatgpt-project');
  const status = document.getElementById('selection-chatgpt-status');
  const sources = ['question-text', 'answer-input', 'result-feedback', 'expected-answer-text', 'result-verdict'];
  const storageKey = 'quiz-chatgpt-project';
  let prompt = '';

  function projectUrl(value) {
    if (!value.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (url.protocol === 'https:' && url.hostname === 'chatgpt.com' &&
          /^\/g\/[^/]+\/project\/?$/.test(url.pathname)) {
        url.search = ''; url.hash = '';
        return url.href;
      }
    } catch {}
    return null;
  }

  function updateLink() {
    const destination = projectUrl(project.value);
    project.setCustomValidity(project.value.trim() && !destination ? 'Bitte eine ChatGPT-Projekt-URL eingeben.' : '');
    link.href = destination || `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
    link.textContent = destination ? 'Im ChatGPT-Projekt öffnen ↗' : 'In ChatGPT öffnen ↗';
  }

  try { project.value = localStorage.getItem(storageKey) || ''; } catch {}
  project.addEventListener('input', () => {
    updateLink();
    if (!project.checkValidity()) { project.reportValidity(); return; }
    try {
      if (project.value.trim()) localStorage.setItem(storageKey, projectUrl(project.value));
      else localStorage.removeItem(storageKey);
    } catch { status.textContent = 'Projekt-URL kann in diesem Browser nicht gespeichert werden.'; }
  });

  function captureSelection() {
    // Keep the captured text while interacting with the toolbar.
    if (panel.contains(document.activeElement)) return;
    let text = '';
    const input = document.getElementById('answer-input');
    if (document.activeElement === input) {
      text = input.value.slice(input.selectionStart, input.selectionEnd);
    } else {
      const selection = window.getSelection();
      if (selection && selection.rangeCount && !selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        const source = sources.map(id => document.getElementById(id)).find(el =>
          el.contains(range.startContainer) && el.contains(range.endContainer));
        if (source) text = selection.toString();
      }
    }
    text = text.trim();
    panel.hidden = !text;
    if (!text) { prompt = ''; return; }
    prompt = `Tell me more regarding the following:\n\n${text}`;
    document.getElementById('selection-chatgpt-preview').textContent = text;
    status.textContent = '';
    updateLink();
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      status.textContent = 'Prompt kopiert. In ChatGPT einfügen.';
    } catch {
      // Clipboard access can be unavailable on HTTP or denied by the browser.
      const fallback = document.createElement('textarea');
      fallback.value = prompt;
      panel.appendChild(fallback);
      fallback.focus(); fallback.select();
      status.textContent = 'Bitte den markierten Prompt mit Strg+C (Mac: ⌘C) kopieren.';
      fallback.addEventListener('blur', () => fallback.remove(), { once: true });
    }
  }
  document.getElementById('selection-chatgpt-copy').addEventListener('click', copyPrompt);
  link.addEventListener('click', () => { if (projectUrl(project.value)) copyPrompt(); });
  document.getElementById('selection-chatgpt-close').addEventListener('click', () => {
    panel.hidden = true;
    window.getSelection()?.removeAllRanges();
    const input = document.getElementById('answer-input');
    input.setSelectionRange(input.selectionEnd, input.selectionEnd);
  });
  document.addEventListener('selectionchange', captureSelection);
  document.addEventListener('select', captureSelection, true);
  document.addEventListener('pointerup', event => { if (!panel.contains(event.target)) captureSelection(); });
  document.addEventListener('keyup', event => { if (!panel.contains(event.target)) captureSelection(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') panel.hidden = true;
  });
  // A new question must not retain a shortcut for the previous question.
  new MutationObserver(() => { panel.hidden = true; prompt = ''; })
    .observe(document.getElementById('question-text'), { childList: true, characterData: true, subtree: true });
})();
