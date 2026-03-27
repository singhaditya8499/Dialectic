const state = {
  providerDefaults: null,
  latestResult: null,
  savedDebates: []
};

const form = document.getElementById('debate-form');
const debateTypeInput = document.getElementById('debate-type');
const choiceOptions = document.getElementById('choice-options');
const forCardTitle = document.getElementById('for-card-title');
const againstCardTitle = document.getElementById('against-card-title');
const skipSummaryInput = document.getElementById('skip-summary');
const separateSummaryInput = document.getElementById('separate-summary-model');
const saveDebateInput = document.getElementById('save-debate');
const summaryModelArea = document.getElementById('summary-model-area');
const runButton = document.getElementById('run-button');
const statusEl = document.getElementById('status');
const metaEl = document.getElementById('meta');
const transcriptEl = document.getElementById('transcript');
const summaryEl = document.getElementById('summary');
const liveStatusEl = document.getElementById('live-status');
const refreshSavedButton = document.getElementById('refresh-saved');
const savedListEl = document.getElementById('saved-list');
const tabs = Array.from(document.querySelectorAll('.tab'));
const tabContents = {
  transcript: transcriptEl,
  summary: summaryEl
};

const providerSelectIds = ['for-provider', 'against-provider', 'summary-provider'];

async function init() {
  attachListeners();
  await loadProviderDefaults();
  await loadSavedDebates();
  applyModeVisibility();
  applySummaryVisibility();
  setStatus('Ready.', 'idle');
  renderEmptyState();
}

function attachListeners() {
  form.addEventListener('submit', onSubmit);
  debateTypeInput.addEventListener('change', applyModeVisibility);
  skipSummaryInput.addEventListener('change', applySummaryVisibility);
  separateSummaryInput.addEventListener('change', applySummaryVisibility);
  refreshSavedButton.addEventListener('click', () => {
    loadSavedDebates().catch((error) => {
      setStatus(error.message || 'Failed to load saved debates.', 'error');
    });
  });

  for (const id of providerSelectIds) {
    const select = document.getElementById(id);
    select.addEventListener('change', () => {
      const prefix = id.replace('-provider', '');
      applyProviderDefaults(prefix);
    });
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => setActiveTab(tab.dataset.tab));
  }
}

async function loadProviderDefaults() {
  try {
    const response = await fetch('/api/providers');
    if (!response.ok) {
      throw new Error(`Failed to load provider metadata: ${response.status}`);
    }

    state.providerDefaults = await response.json();
  } catch {
    state.providerDefaults = {
      openai: { baseUrl: 'https://api.openai.com/v1', modelPlaceholder: 'gpt-5-nano' },
      anthropic: { baseUrl: 'https://api.anthropic.com', modelPlaceholder: 'claude-3-5-sonnet-latest' },
      ollama: { baseUrl: 'http://localhost:11434', modelPlaceholder: 'llama3.1:8b' }
    };
  }

  applyProviderDefaults('for');
  applyProviderDefaults('against');
  applyProviderDefaults('summary');
}

function applyProviderDefaults(prefix) {
  if (!state.providerDefaults) {
    return;
  }

  const providerEl = document.getElementById(`${prefix}-provider`);
  const modelEl = document.getElementById(`${prefix}-model`);
  const baseUrlEl = document.getElementById(`${prefix}-base-url`);
  const provider = providerEl.value;
  const defaults = state.providerDefaults[provider];

  if (!defaults) {
    return;
  }

  const knownModelPlaceholders = new Set(
    Object.values(state.providerDefaults).map((entry) => entry.modelPlaceholder)
  );
  const knownBaseUrls = new Set(Object.values(state.providerDefaults).map((entry) => entry.baseUrl));

  modelEl.placeholder = defaults.modelPlaceholder;
  if (!modelEl.value.trim() || knownModelPlaceholders.has(modelEl.value.trim())) {
    modelEl.value = defaults.modelPlaceholder;
  }

  if (!baseUrlEl.value.trim() || knownBaseUrls.has(baseUrlEl.value.trim())) {
    baseUrlEl.value = defaults.baseUrl;
  }
}

function applyModeVisibility() {
  const choiceMode = debateTypeInput.value === 'choice';
  choiceOptions.classList.toggle('hidden', !choiceMode);

  if (choiceMode) {
    forCardTitle.textContent = 'Advocate for Option A';
    againstCardTitle.textContent = 'Advocate for Option B';
  } else {
    forCardTitle.textContent = 'For the Motion / Option A';
    againstCardTitle.textContent = 'Against the Motion / Option B';
  }
}

function applySummaryVisibility() {
  const summaryDisabled = skipSummaryInput.checked;
  const useSeparate = separateSummaryInput.checked;

  separateSummaryInput.disabled = summaryDisabled;
  summaryModelArea.classList.toggle('hidden', summaryDisabled || !useSeparate);
}

function setActiveTab(tabName) {
  for (const tab of tabs) {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  }

  for (const [name, section] of Object.entries(tabContents)) {
    section.classList.toggle('hidden', name !== tabName);
  }
}

function setStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`;
}

function showLiveStatus(text) {
  liveStatusEl.innerHTML = `<span class="spinner"></span><span>${escapeHtml(text)}</span>`;
  liveStatusEl.classList.remove('hidden');
}

function hideLiveStatus() {
  liveStatusEl.classList.add('hidden');
  liveStatusEl.innerHTML = '';
}

function readModelConfig(prefix) {
  const provider = document.getElementById(`${prefix}-provider`).value;
  const model = document.getElementById(`${prefix}-model`).value.trim();
  const apiKey = document.getElementById(`${prefix}-api-key`).value.trim();
  const baseUrl = document.getElementById(`${prefix}-base-url`).value.trim();

  const config = {
    provider,
    model
  };

  if (apiKey) {
    config.apiKey = apiKey;
  }

  if (baseUrl) {
    config.baseUrl = baseUrl;
  }

  return config;
}

function buildPayload() {
  const debateType = debateTypeInput.value;
  const payload = {
    debateType,
    question: document.getElementById('question').value.trim(),
    maxRounds: Number(document.getElementById('max-rounds').value),
    forModel: readModelConfig('for'),
    againstModel: readModelConfig('against'),
    skipSummary: skipSummaryInput.checked,
    useSeparateSummaryModel: !skipSummaryInput.checked && separateSummaryInput.checked,
    saveDebate: saveDebateInput.checked
  };

  if (debateType === 'choice') {
    payload.optionA = document.getElementById('option-a').value.trim();
    payload.optionB = document.getElementById('option-b').value.trim();
  }

  if (payload.useSeparateSummaryModel) {
    payload.summaryModel = readModelConfig('summary');
  }

  return payload;
}

async function onSubmit(event) {
  event.preventDefault();

  const payload = buildPayload();
  const liveResult = {
    meta: {
      question: payload.question,
      debateType: payload.debateType,
      optionA: payload.optionA || null,
      optionB: payload.optionB || null,
      maxRounds: payload.maxRounds,
      roundsCompleted: 0,
      stopReason: 'running'
    },
    transcript: [],
    summary: '',
    summaryError: null
  };

  runButton.disabled = true;
  setStatus('Running debate. Live turns will appear below...', 'running');
  renderResult(liveResult);
  showLiveStatus('Preparing debate...');
  setActiveTab('transcript');
  let sawCompleteEvent = false;

  try {
    await streamDebate(payload, async (eventName, data) => {
      if (eventName === 'start' && data?.meta) {
        liveResult.meta = {
          ...liveResult.meta,
          ...data.meta
        };
        renderMeta(liveResult.meta);
        return;
      }

      if (eventName === 'thinking') {
        showLiveStatus(`${data.sideLabel || 'Model'} is thinking...`);
        return;
      }

      if (eventName === 'turn') {
        if (data?.turn) {
          liveResult.transcript.push(data.turn);
        }

        if (data?.meta) {
          liveResult.meta = {
            ...liveResult.meta,
            ...data.meta
          };
        } else if (data?.turn?.round) {
          liveResult.meta.roundsCompleted = Math.max(
            liveResult.meta.roundsCompleted || 0,
            Number(data.turn.round) || 0
          );
        }

        renderMeta(liveResult.meta);
        renderTranscript(liveResult.transcript);
        scrollTranscriptToBottom();
        return;
      }

      if (eventName === 'summary_thinking') {
        showLiveStatus('Generating summary...');
        if (!liveResult.summary) {
          renderSummary('', null, true);
        }
        return;
      }

      if (eventName === 'summary') {
        liveResult.summary = typeof data?.summary === 'string' ? data.summary : '';
        liveResult.summaryError = data?.summaryError || null;
        renderSummary(liveResult.summary, liveResult.summaryError, false);
        return;
      }

      if (eventName === 'complete') {
        sawCompleteEvent = true;
        hideLiveStatus();

        if (data?.result) {
          state.latestResult = data.result;
          renderResult(data.result);
        } else {
          state.latestResult = liveResult;
          renderResult(liveResult);
        }

        if (data?.savedDebate?.id) {
          setStatus(`Debate complete. Saved as ${data.savedDebate.id}.`, 'idle');
        } else {
          setStatus('Debate complete.', 'idle');
        }
        return;
      }

      if (eventName === 'error') {
        throw new Error(data?.error || 'Streamed debate failed.');
      }
    });

    if (!sawCompleteEvent) {
      throw new Error('Debate stream ended unexpectedly before completion.');
    }
  } catch (error) {
    hideLiveStatus();
    setStatus(error.message || 'Failed to run debate.', 'error');
  } finally {
    runButton.disabled = false;
    try {
      await loadSavedDebates();
    } catch {
      // Preserve current status; saved list can still be manually refreshed later.
    }
  }
}

async function streamDebate(payload, onEvent) {
  const response = await fetch('/api/debate/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    let parsedError = '';

    try {
      parsedError = JSON.parse(text)?.error || '';
    } catch {
      parsedError = '';
    }

    throw new Error(parsedError || `Request failed with status ${response.status}`);
  }

  if (!response.body) {
    throw new Error('Streaming is not available in this browser.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const boundaryIndex = buffer.indexOf('\n\n');
      if (boundaryIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      const parsedEvent = parseSseEvent(rawEvent);
      if (parsedEvent) {
        await onEvent(parsedEvent.event, parsedEvent.data);
      }
    }
  }

  if (buffer.trim()) {
    const parsedEvent = parseSseEvent(buffer);
    if (parsedEvent) {
      await onEvent(parsedEvent.event, parsedEvent.data);
    }
  }
}

function parseSseEvent(rawBlock) {
  const lines = rawBlock.replace(/\r/g, '').split('\n');
  let eventName = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const rawData = dataLines.join('\n');

  try {
    return {
      event: eventName,
      data: JSON.parse(rawData)
    };
  } catch {
    return {
      event: eventName,
      data: rawData
    };
  }
}

async function loadSavedDebates() {
  const response = await fetch('/api/debates');
  if (!response.ok) {
    throw new Error('Could not load saved debates.');
  }

  const payload = await response.json();
  state.savedDebates = Array.isArray(payload.debates) ? payload.debates : [];
  renderSavedDebates(state.savedDebates);
}

function renderSavedDebates(debates) {
  savedListEl.innerHTML = '';

  if (!Array.isArray(debates) || debates.length === 0) {
    savedListEl.innerHTML = '<div class="summary-card">No saved debates yet.</div>';
    return;
  }

  for (const debate of debates) {
    const card = document.createElement('article');
    card.className = 'saved-item';

    const title = document.createElement('div');
    title.className = 'saved-title';
    title.textContent = debate.question || 'Untitled debate';

    const meta = document.createElement('div');
    meta.className = 'saved-meta';
    meta.textContent =
      `${formatDate(debate.createdAt)} | ${debate.debateType || 'motion'} | rounds ${debate.roundsCompleted || 0}` +
      ` | turns ${debate.turnCount || 0}`;

    const excerpt = document.createElement('div');
    excerpt.className = 'saved-excerpt';
    excerpt.textContent = debate.summaryExcerpt || 'No summary available for this debate.';

    const actions = document.createElement('div');
    actions.className = 'saved-actions';

    const loadButton = document.createElement('button');
    loadButton.type = 'button';
    loadButton.className = 'ghost-button';
    loadButton.textContent = 'Load Debate';
    loadButton.addEventListener('click', () => {
      loadSavedDebate(debate.id).catch((error) => {
        setStatus(error.message || 'Failed to load saved debate.', 'error');
      });
    });

    actions.appendChild(loadButton);
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(excerpt);
    card.appendChild(actions);
    savedListEl.appendChild(card);
  }
}

async function loadSavedDebate(debateId) {
  setStatus('Loading saved debate...', 'running');

  const response = await fetch(`/api/debates/${encodeURIComponent(debateId)}`);
  if (!response.ok) {
    const text = await response.text();
    let parsedError = '';

    try {
      parsedError = JSON.parse(text)?.error || '';
    } catch {
      parsedError = '';
    }

    throw new Error(parsedError || `Failed to load debate: ${response.status}`);
  }

  const record = await response.json();
  const storedResult = getStoredResult(record);

  if (!storedResult) {
    throw new Error('Saved debate format is invalid.');
  }

  hideLiveStatus();
  state.latestResult = storedResult;
  renderResult(storedResult);
  setActiveTab('summary');
  setStatus(`Loaded saved debate from ${formatDate(record.createdAt)}.`, 'idle');
}

function renderResult(result) {
  renderMeta(result.meta);
  renderTranscript(result.transcript);
  renderSummary(result.summary, result.summaryError, false);
}

function renderMeta(meta) {
  if (!meta) {
    metaEl.textContent = 'No metadata available.';
    return;
  }

  const lines = [
    `<strong>Question:</strong> ${escapeHtml(meta.question || '')}`,
    `<strong>Type:</strong> ${escapeHtml(meta.debateType || 'motion')}`,
    `<strong>Rounds:</strong> ${escapeHtml(String(meta.roundsCompleted || 0))} / ${escapeHtml(String(meta.maxRounds || 0))}`,
    `<strong>Stop reason:</strong> ${escapeHtml(meta.stopReason || 'running')}`
  ];

  if (meta.debateType === 'choice') {
    lines.push(`<strong>Option A:</strong> ${escapeHtml(meta.optionA || 'Option A')}`);
    lines.push(`<strong>Option B:</strong> ${escapeHtml(meta.optionB || 'Option B')}`);
  }

  metaEl.innerHTML = lines.join('<br/>');
}

function renderTranscript(turns) {
  transcriptEl.innerHTML = '';

  if (!Array.isArray(turns) || turns.length === 0) {
    transcriptEl.innerHTML = '<div class="summary-card">Transcript will appear here as turns complete.</div>';
    return;
  }

  for (const turn of turns) {
    const article = document.createElement('article');
    article.className = `turn ${turn.side === 'for' ? 'for' : 'against'}${turn.error ? ' error' : ''}`;

    const header = document.createElement('div');
    header.className = 'turn-head';
    header.innerHTML = `<span>Round ${escapeHtml(String(turn.round))}</span><span>${escapeHtml(turn.sideLabel || turn.side)}</span>`;

    const body = document.createElement('div');
    body.className = 'turn-body';
    body.textContent = turn.argument || '';

    let audienceNote = null;
    if (typeof turn.audienceNote === 'string' && turn.audienceNote.trim()) {
      audienceNote = document.createElement('div');
      audienceNote.className = 'turn-note';
      audienceNote.textContent = `Plain-language note: ${turn.audienceNote.trim()}`;
    }

    let evidenceBlock = null;
    if (Array.isArray(turn.evidence) && turn.evidence.length > 0) {
      evidenceBlock = document.createElement('div');
      evidenceBlock.className = 'turn-evidence';

      const heading = document.createElement('div');
      heading.className = 'turn-evidence-title';
      heading.textContent = 'Evidence anchors';

      const list = document.createElement('ul');
      for (const entry of turn.evidence.slice(0, 6)) {
        const item = document.createElement('li');
        item.textContent = formatEvidenceEntry(entry);
        list.appendChild(item);
      }

      evidenceBlock.appendChild(heading);
      evidenceBlock.appendChild(list);
    }

    const badges = document.createElement('div');
    badges.className = 'badges';

    if (typeof turn.confidence === 'number') {
      badges.appendChild(makeBadge(`confidence: ${Math.round(turn.confidence * 100)}%`));
    }

    if (turn.hasMore === false) {
      badges.appendChild(makeBadge('no more arguments'));
    }

    if (Array.isArray(turn.citations) && turn.citations.length > 0) {
      badges.appendChild(makeBadge(`citations: ${turn.citations.join('; ')}`));
    }

    article.appendChild(header);
    article.appendChild(body);
    if (audienceNote) {
      article.appendChild(audienceNote);
    }
    if (evidenceBlock) {
      article.appendChild(evidenceBlock);
    }

    if (badges.childNodes.length > 0) {
      article.appendChild(badges);
    }

    transcriptEl.appendChild(article);
  }
}

function renderSummary(summary, summaryError, isThinking) {
  summaryEl.innerHTML = '';

  if (summaryError) {
    const errorCard = document.createElement('div');
    errorCard.className = 'summary-card';
    errorCard.textContent = `Summary unavailable: ${summaryError}`;
    summaryEl.appendChild(errorCard);
    return;
  }

  const card = document.createElement('div');
  card.className = 'summary-card markdown';

  if (summary && summary.trim()) {
    card.innerHTML = markdownToHtml(summary);
  } else if (isThinking) {
    card.classList.remove('markdown');
    card.textContent = 'Summary is being generated...';
  } else {
    card.classList.remove('markdown');
    card.textContent = 'Summary will appear here.';
  }

  summaryEl.appendChild(card);
}

function makeBadge(text) {
  const span = document.createElement('span');
  span.className = 'badge';
  span.textContent = text;
  return span;
}

function formatEvidenceEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }

  const parts = [];
  const fact = typeof entry.fact === 'string' ? entry.fact.trim() : '';
  const type = typeof entry.type === 'string' ? entry.type.trim() : '';
  const figureOrDate = typeof entry.figureOrDate === 'string' ? entry.figureOrDate.trim() : '';
  const source = typeof entry.source === 'string' ? entry.source.trim() : '';
  const reliability = typeof entry.reliability === 'string' ? entry.reliability.trim() : '';

  if (type) {
    parts.push(`[${type}]`);
  }

  if (fact) {
    parts.push(fact);
  }

  if (figureOrDate) {
    parts.push(`Figure/Date: ${figureOrDate}`);
  }

  if (source) {
    parts.push(`Source: ${source}`);
  }

  if (reliability) {
    parts.push(`Reliability: ${reliability}`);
  }

  return parts.join(' | ');
}

function renderEmptyState() {
  metaEl.innerHTML = '<strong>No debate run yet.</strong> Configure the models and press Run Debate.';
  transcriptEl.innerHTML = '<div class="summary-card">Transcript will appear here.</div>';
  summaryEl.innerHTML = '<div class="summary-card">Summary will appear here.</div>';
}

function scrollTranscriptToBottom() {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function formatDate(value) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) {
    return 'Unknown time';
  }

  return new Date(parsed).toLocaleString();
}

function getStoredResult(record) {
  if (record?.result && typeof record.result === 'object') {
    return record.result;
  }

  if (record?.debate && typeof record.debate === 'object') {
    return record.debate;
  }

  return null;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const html = [];
  let inCodeBlock = false;
  let codeLines = [];
  let codeLang = '';
  let inUnorderedList = false;
  let inOrderedList = false;
  let paragraphLines = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }
    html.push(`<p>${formatInlineMarkdown(paragraphLines.join(' ').trim())}</p>`);
    paragraphLines = [];
  };

  const flushLists = () => {
    if (inUnorderedList) {
      html.push('</ul>');
      inUnorderedList = false;
    }
    if (inOrderedList) {
      html.push('</ol>');
      inOrderedList = false;
    }
  };

  const flushCodeBlock = () => {
    if (!inCodeBlock) {
      return;
    }
    const languageClass = codeLang ? ` class="language-${escapeHtmlAttribute(codeLang)}"` : '';
    html.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    inCodeBlock = false;
    codeLang = '';
    codeLines = [];
  };

  for (const line of lines) {
    const codeFenceMatch = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (codeFenceMatch) {
      flushParagraph();
      flushLists();
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        inCodeBlock = true;
        codeLang = codeFenceMatch[1] || '';
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushLists();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushLists();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${formatInlineMarkdown(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (inOrderedList) {
        html.push('</ol>');
        inOrderedList = false;
      }
      if (!inUnorderedList) {
        html.push('<ul>');
        inUnorderedList = true;
      }
      html.push(`<li>${formatInlineMarkdown(unorderedMatch[1].trim())}</li>`);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      if (inUnorderedList) {
        html.push('</ul>');
        inUnorderedList = false;
      }
      if (!inOrderedList) {
        html.push('<ol>');
        inOrderedList = true;
      }
      html.push(`<li>${formatInlineMarkdown(orderedMatch[1].trim())}</li>`);
      continue;
    }

    const quoteMatch = trimmed.match(/^>\s?(.+)$/);
    if (quoteMatch) {
      flushParagraph();
      flushLists();
      html.push(`<blockquote>${formatInlineMarkdown(quoteMatch[1].trim())}</blockquote>`);
      continue;
    }

    const ruleMatch = trimmed.match(/^([-*_]){3,}$/);
    if (ruleMatch) {
      flushParagraph();
      flushLists();
      html.push('<hr/>');
      continue;
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushLists();
  flushCodeBlock();

  return html.join('');
}

function formatInlineMarkdown(text) {
  let output = escapeHtml(text || '');

  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safeUrl = sanitizeUrl(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return output;
}

function sanitizeUrl(url) {
  const normalized = String(url || '').trim().replace(/^<|>$/g, '');
  if (!/^(https?:\/\/|mailto:)/i.test(normalized)) {
    return '#';
  }

  return escapeHtmlAttribute(normalized);
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

init();
