const LOCAL_DEBATES_KEY = 'dialectic_saved_debates_v1';
const DEFAULT_MAX_ROUNDS = 6;
const MAX_ALLOWED_ROUNDS = 20;
const MAX_EVIDENCE_ITEMS = 6;
const MAX_NOVELTY_REWRITE_ATTEMPTS = 2;
const TURN_TIMEOUT_MS = 120000;
const ARGUMENT_SIMILARITY_THRESHOLD = 0.74;

const ALLOWED_EVIDENCE_TYPES = new Set([
  'statistic',
  'study',
  'historical_case',
  'policy_result',
  'mechanism',
  'expert_view',
  'anecdote',
  'other'
]);

const ALLOWED_RELIABILITY = new Set(['high', 'medium', 'low', 'uncertain']);

const TOKEN_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'this',
  'from',
  'into',
  'about',
  'have',
  'has',
  'had',
  'will',
  'would',
  'could',
  'should',
  'their',
  'they',
  'them',
  'your',
  'ours',
  'ourselves',
  'against',
  'motion',
  'because',
  'while',
  'where',
  'when',
  'which',
  'there',
  'these',
  'those',
  'being',
  'been',
  'were',
  'was',
  'than',
  'then',
  'also',
  'only',
  'very',
  'such',
  'more',
  'most',
  'much',
  'many',
  'just',
  'over',
  'under',
  'after',
  'before',
  'across',
  'each',
  'other',
  'some',
  'same'
]);

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeStringArray(value, maxItems = 12) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }

  return result;
}

function clampRoundCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_MAX_ROUNDS;
  }

  return Math.max(1, Math.min(MAX_ALLOWED_ROUNDS, Math.floor(numeric)));
}

function clampConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.max(0, Math.min(1, numeric));
}

function normalizeEvidenceType(value) {
  const raw = normalizeString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (ALLOWED_EVIDENCE_TYPES.has(raw)) {
    return raw;
  }

  return 'other';
}

function normalizeReliability(value, fallback = 'uncertain') {
  const raw = normalizeString(value).toLowerCase();
  if (ALLOWED_RELIABILITY.has(raw)) {
    return raw;
  }

  return fallback;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const withoutCodeFence = String(raw)
      .replace(/```json/gi, '```')
      .replace(/```/g, '')
      .trim();

    try {
      return JSON.parse(withoutCodeFence);
    } catch {
      const start = withoutCodeFence.indexOf('{');
      const end = withoutCodeFence.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const maybeJson = withoutCodeFence.slice(start, end + 1);
        return JSON.parse(maybeJson);
      }

      throw new Error('Could not parse JSON response from model.');
    }
  }
}

function inferHasMore(parsed, argumentText) {
  if (typeof parsed?.hasMore === 'boolean') {
    return parsed.hasMore;
  }

  const lower = String(argumentText || '').toLowerCase();
  if (/\b(no further|no more|nothing else|rest my case|i concede|no new points)\b/.test(lower)) {
    return false;
  }

  return String(argumentText || '').trim().length > 0;
}

function normalizeTurnEvidence(parsed) {
  const candidate = Array.isArray(parsed?.evidence)
    ? parsed.evidence
    : Array.isArray(parsed?.facts)
      ? parsed.facts
      : [];

  const evidence = [];
  for (const entry of candidate) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const fact = normalizeString(entry.fact || entry.claim || entry.detail || entry.statement);
    if (!fact) {
      continue;
    }

    evidence.push({
      type: normalizeEvidenceType(entry.type),
      fact,
      figureOrDate: normalizeString(entry.figureOrDate || entry.figure || entry.year || entry.stat),
      source: normalizeString(entry.source || entry.sourceHint || entry.reference || entry.citation),
      whyItMatters: normalizeString(entry.whyItMatters || entry.relevance || entry.impact),
      reliability: normalizeReliability(entry.reliability || entry.strength || entry.confidenceLabel)
    });

    if (evidence.length >= MAX_EVIDENCE_ITEMS) {
      break;
    }
  }

  return evidence;
}

function parseDebaterTurn(rawOutput) {
  const parsed = safeJsonParse(rawOutput);
  const argument = normalizeString(parsed.argument || parsed.claim || parsed.response);
  const evidence = normalizeTurnEvidence(parsed);
  const citations = dedupeStrings([
    ...normalizeStringArray(parsed.citations, 10),
    ...evidence.map((item) => item.source)
  ]);

  return {
    argument,
    hasMore: inferHasMore(parsed, argument),
    confidence: clampConfidence(parsed.confidence),
    citations,
    evidence,
    position: normalizeString(parsed.position || parsed.side || parsed.stance),
    angle: normalizeString(parsed.angle || parsed.lens || parsed.focus || parsed.debateAngle),
    audienceNote: normalizeString(parsed.audienceNote || parsed.plainLanguageNote || parsed.teachingNote),
    counterTo: normalizeString(parsed.counterTo || parsed.rebuttalTarget || parsed.opponentClaimAddressed)
  };
}

function normalizeDebateRequest(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body must be a JSON object.');
  }

  const debateType = payload.debateType === 'choice' ? 'choice' : 'motion';
  const question = normalizeString(payload.question);
  if (!question) {
    throw new Error('Question is required.');
  }

  const optionA = debateType === 'choice' ? normalizeString(payload.optionA) || 'Option A' : null;
  const optionB = debateType === 'choice' ? normalizeString(payload.optionB) || 'Option B' : null;

  const forModel = payload.forModel;
  const againstModel = payload.againstModel;
  if (!forModel || !againstModel) {
    throw new Error('Both debater model configs are required.');
  }

  const summaryModel = payload.useSeparateSummaryModel ? payload.summaryModel : forModel;

  return {
    debateType,
    question,
    optionA,
    optionB,
    maxRounds: clampRoundCount(payload.maxRounds),
    forModel,
    againstModel,
    summaryModel,
    skipSummary: Boolean(payload.skipSummary)
  };
}

function ensureOpenAiModel(config, label) {
  if (!config || typeof config !== 'object') {
    throw new Error(`${label} config is missing.`);
  }

  const provider = normalizeString(config.provider).toLowerCase();
  if (provider !== 'openai') {
    throw new Error('GitHub Pages mode currently supports OpenAI models only.');
  }

  if (!normalizeString(config.model)) {
    throw new Error(`${label} model is required.`);
  }

  if (!normalizeString(config.apiKey)) {
    throw new Error(`${label} API key is required in browser mode.`);
  }
}

function sideDescriptors(config) {
  if (config.debateType === 'choice') {
    return {
      forSide: {
        roleLabel: config.optionA,
        sideName: 'A'
      },
      againstSide: {
        roleLabel: config.optionB,
        sideName: 'B'
      },
      propositionText: `Question: ${config.question}\nOption A: ${config.optionA}\nOption B: ${config.optionB}`
    };
  }

  return {
    forSide: {
      roleLabel: 'For the motion',
      sideName: 'FOR'
    },
    againstSide: {
      roleLabel: 'Against the motion',
      sideName: 'AGAINST'
    },
    propositionText: `Motion: ${config.question}`
  };
}

function formatEvidenceLine(item) {
  const parts = [`[${item.type}] ${item.fact}`];
  if (item.figureOrDate) {
    parts.push(`figure/date: ${item.figureOrDate}`);
  }
  if (item.source) {
    parts.push(`source: ${item.source}`);
  }
  if (item.reliability) {
    parts.push(`reliability: ${item.reliability}`);
  }

  return parts.join(' | ');
}

function transcriptToContext(transcript, maxTurns = 10) {
  const recent = transcript.slice(-maxTurns);
  if (recent.length === 0) {
    return 'No previous turns.';
  }

  return recent
    .map((turn) => {
      const lines = [`Round ${turn.round} | ${turn.sideLabel}: ${turn.argument}`];
      if (turn.angle) {
        lines.push(`Angle: ${turn.angle}`);
      }
      if (turn.counterTo) {
        lines.push(`Countered point: ${turn.counterTo}`);
      }
      if (Array.isArray(turn.evidence) && turn.evidence.length > 0) {
        lines.push('Evidence anchors:');
        for (const item of turn.evidence.slice(0, 4)) {
          lines.push(`- ${formatEvidenceLine(item)}`);
        }
      }
      if (Array.isArray(turn.citations) && turn.citations.length > 0) {
        lines.push(`Citations: ${turn.citations.join('; ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function normalizeFactKey(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenizeForSimilarity(text) {
  return normalizeString(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !TOKEN_STOPWORDS.has(token));
}

function argumentSimilarity(left, right) {
  const leftTokens = new Set(tokenizeForSimilarity(left));
  const rightTokens = new Set(tokenizeForSimilarity(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = leftTokens.size + rightTokens.size - intersection;
  if (union === 0) {
    return 0;
  }

  return intersection / union;
}

function collectUsedFactsBySide(transcript, sideId) {
  const facts = [];
  for (const turn of transcript) {
    if (turn.side !== sideId || !Array.isArray(turn.evidence)) {
      continue;
    }

    for (const entry of turn.evidence) {
      const fact = normalizeString(entry?.fact);
      if (fact) {
        facts.push(fact);
      }
    }
  }

  return facts;
}

function collectUsedCitationsBySide(transcript, sideId) {
  const citations = [];
  for (const turn of transcript) {
    if (turn.side !== sideId || !Array.isArray(turn.citations)) {
      continue;
    }
    citations.push(...turn.citations.map((entry) => normalizeString(entry)).filter(Boolean));
  }

  return dedupeStrings(citations);
}

function collectUsedAnglesBySide(transcript, sideId) {
  const angles = [];
  for (const turn of transcript) {
    if (turn.side !== sideId) {
      continue;
    }
    const angle = normalizeString(turn.angle);
    if (angle) {
      angles.push(angle);
    }
  }

  return dedupeStrings(angles);
}

function getLatestOpponentTurn(transcript, sideId) {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i].side !== sideId) {
      return transcript[i];
    }
  }
  return null;
}

function summarizeTurnForRebuttal(turn) {
  if (!turn) {
    return 'No opponent turn yet.';
  }

  const lines = [`Opponent last argument: ${turn.argument}`];
  if (Array.isArray(turn.evidence) && turn.evidence.length > 0) {
    lines.push('Opponent evidence anchors:');
    for (const item of turn.evidence.slice(0, 3)) {
      lines.push(`- ${formatEvidenceLine(item)}`);
    }
  }

  return lines.join('\n');
}

function evidenceHasConcreteFigure(evidence) {
  if (!Array.isArray(evidence)) {
    return false;
  }

  return evidence.some((entry) => {
    const figureOrDate = normalizeString(entry?.figureOrDate);
    const fact = normalizeString(entry?.fact);
    return /\d/.test(figureOrDate) || /\d/.test(fact);
  });
}

function argumentStartsWithPosition(argument, sideLabel) {
  return normalizeFactKey(argument).startsWith(`position defended ${normalizeFactKey(sideLabel)}`);
}

function collectSourceHintsFromTurn(turn) {
  const sourceHints = [];
  if (Array.isArray(turn?.citations)) {
    sourceHints.push(...turn.citations);
  }
  if (Array.isArray(turn?.evidence)) {
    for (const entry of turn.evidence) {
      sourceHints.push(entry?.source);
    }
  }

  return dedupeStrings(sourceHints).filter((item) => {
    const key = normalizeFactKey(item);
    return Boolean(key) && key !== 'unknown' && key !== 'none' && key !== 'n a';
  });
}

function argumentMentionsSourceHints(argument, sourceHints) {
  const argumentRaw = normalizeString(argument);
  if (!argumentRaw) {
    return false;
  }

  const normalizedArgument = argumentRaw.toLowerCase();
  const argumentTokens = new Set(tokenizeForSimilarity(argumentRaw));

  for (const hint of sourceHints) {
    const cleanedHint = normalizeString(hint);
    if (!cleanedHint) {
      continue;
    }

    if (normalizedArgument.includes(cleanedHint.toLowerCase())) {
      return true;
    }

    const hintTokens = [...new Set(tokenizeForSimilarity(cleanedHint))];
    if (hintTokens.length === 0) {
      continue;
    }

    let matches = 0;
    for (const token of hintTokens) {
      if (argumentTokens.has(token)) {
        matches += 1;
      }
    }

    if (matches >= (hintTokens.length >= 3 ? 2 : 1)) {
      return true;
    }
  }

  return false;
}

function assessTurnNovelty(turn, sideId, sideLabel, round, transcript) {
  const reasons = [];
  const isContinuing = turn.hasMore !== false;

  if (!turn.argument) {
    reasons.push('Argument is empty.');
  }

  if (isContinuing && normalizeFactKey(turn.position) !== normalizeFactKey(sideLabel)) {
    reasons.push(`"position" must be exactly "${sideLabel}".`);
  }

  if (isContinuing && !argumentStartsWithPosition(turn.argument, sideLabel)) {
    reasons.push(`Argument must begin with "Position defended: ${sideLabel}."`);
  }

  if (round > 1 && !turn.counterTo) {
    reasons.push('Missing explicit counter to the latest opponent point.');
  }

  if (isContinuing && !turn.angle) {
    reasons.push('Missing debate angle.');
  }

  if (isContinuing && (!Array.isArray(turn.evidence) || turn.evidence.length === 0)) {
    reasons.push('No evidence anchors were provided.');
  }

  if (isContinuing && Array.isArray(turn.evidence) && turn.evidence.length > 0 && !evidenceHasConcreteFigure(turn.evidence)) {
    reasons.push('Include at least one concrete number/date in evidence.');
  }

  const sourceHints = collectSourceHintsFromTurn(turn);
  if (isContinuing && sourceHints.length > 0 && !argumentMentionsSourceHints(turn.argument, sourceHints)) {
    reasons.push('Argument must mention at least one cited source in prose.');
  }

  const sameSideTurns = transcript.filter((entry) => entry.side === sideId);
  let maxSimilarity = 0;
  for (const previousTurn of sameSideTurns) {
    maxSimilarity = Math.max(maxSimilarity, argumentSimilarity(turn.argument, previousTurn.argument));
  }

  if (maxSimilarity >= ARGUMENT_SIMILARITY_THRESHOLD) {
    reasons.push(`Argument overlaps too much with prior points (similarity ${maxSimilarity.toFixed(2)}).`);
  }

  const usedFactKeys = new Set(collectUsedFactsBySide(transcript, sideId).map((fact) => normalizeFactKey(fact)));
  const providedFacts = Array.isArray(turn.evidence)
    ? turn.evidence.map((entry) => normalizeFactKey(entry.fact)).filter(Boolean)
    : [];
  const newFacts = providedFacts.filter((fact) => !usedFactKeys.has(fact));
  if (round > 1 && isContinuing && providedFacts.length > 0 && newFacts.length === 0) {
    reasons.push('All evidence facts repeat prior rounds.');
  }

  const usedAngles = new Set(collectUsedAnglesBySide(transcript, sideId).map((value) => normalizeFactKey(value)));
  if (round > 1 && isContinuing && usedAngles.has(normalizeFactKey(turn.angle))) {
    reasons.push('Angle repeats a previous round.');
  }

  return {
    isValid: reasons.length === 0,
    reasons
  };
}

function buildTurnPrompts({ descriptors, sideId, sideLabel, opponentLabel, transcript, round }) {
  const latestOpponentTurn = getLatestOpponentTurn(transcript, sideId);
  const usedFacts = collectUsedFactsBySide(transcript, sideId).slice(-20);
  const usedCitations = collectUsedCitationsBySide(transcript, sideId).slice(-14);
  const usedAngles = collectUsedAnglesBySide(transcript, sideId).slice(-10);

  const systemPrompt = [
    'You are a debate participant in a structured two-person debate.',
    `Your side is: ${sideLabel}.`,
    `Opponent side is: ${opponentLabel}.`,
    'Return strict JSON only (no markdown, no extra text).',
    'Required JSON schema:',
    '{',
    '  "argument": "single paragraph",',
    '  "hasMore": true or false,',
    '  "confidence": 0.0 to 1.0,',
    `  "position": "exactly ${sideLabel}",`,
    '  "angle": "4-10 words naming the fresh lens for this turn",',
    '  "counterTo": "Exact opponent point being rebutted now",',
    '  "audienceNote": "One plain-language sentence",',
    '  "evidence": [',
    '    {',
    '      "type": "statistic|study|historical_case|policy_result|mechanism|expert_view|anecdote|other",',
    '      "fact": "Atomic factual claim",',
    '      "figureOrDate": "number/date/range when available",',
    '      "source": "publication/institution/person and year",',
    '      "whyItMatters": "short impact statement",',
    '      "reliability": "high|medium|low|uncertain"',
    '    }',
    '  ],',
    '  "citations": ["short source hints"]',
    '}',
    'Rules:',
    `- Set "position" to exactly "${sideLabel}".`,
    `- Start "argument" with exactly: "Position defended: ${sideLabel}."`,
    `- Defend ${sideLabel}, not ${opponentLabel}.`,
    '- Keep claims objective and evidence-backed whenever possible.',
    '- Include 2-4 evidence items when continuing.',
    '- Include at least one concrete number/date in evidence when continuing.',
    '- Mention at least one cited source directly in argument prose.',
    '- Use a new angle; do not repeat prior angles/facts/citations.',
    '- If you have no meaningful new rebuttal, set "hasMore": false.'
  ].join('\n');

  const userPrompt = [
    descriptors.propositionText,
    `Current round: ${round}`,
    `Your role this round: ${sideLabel}`,
    '',
    'Recent transcript:',
    transcriptToContext(transcript),
    '',
    'Latest opponent turn to counter:',
    summarizeTurnForRebuttal(latestOpponentTurn),
    '',
    'Facts already used by your side (avoid repeating):',
    usedFacts.length > 0 ? usedFacts.map((value) => `- ${value}`).join('\n') : '- none yet',
    '',
    'Angles already used by your side (must choose a different angle):',
    usedAngles.length > 0 ? usedAngles.map((value) => `- ${value}`).join('\n') : '- none yet',
    '',
    'Citation/source lines already used by your side (avoid repeating):',
    usedCitations.length > 0 ? usedCitations.map((value) => `- ${value}`).join('\n') : '- none yet',
    '',
    'Return strict JSON now.'
  ].join('\n');

  return { systemPrompt, userPrompt };
}

function buildRevisionPrompts({ descriptors, sideId, sideLabel, opponentLabel, transcript, round, previousTurn, reasons }) {
  const latestOpponentTurn = getLatestOpponentTurn(transcript, sideId);

  const systemPrompt = [
    'Revise your previous turn because it failed quality constraints.',
    `Your side is: ${sideLabel}. Opponent side is: ${opponentLabel}.`,
    'Return strict JSON only with the same schema.',
    `Set "position" to exactly "${sideLabel}".`,
    `Start "argument" with exactly: "Position defended: ${sideLabel}."`,
    'Keep claims objective and evidence-backed.',
    'Mention at least one cited source by name in argument prose.',
    'Do not repeat your own prior facts/angles/citations.',
    'If no new rebuttal exists, set "hasMore": false.'
  ].join('\n');

  const userPrompt = [
    descriptors.propositionText,
    `Current round: ${round}`,
    '',
    'Recent transcript:',
    transcriptToContext(transcript),
    '',
    'Latest opponent turn to counter:',
    summarizeTurnForRebuttal(latestOpponentTurn),
    '',
    'Why previous draft was rejected:',
    reasons.map((reason) => `- ${reason}`).join('\n'),
    '',
    'Previous draft JSON:',
    JSON.stringify(previousTurn, null, 2),
    '',
    'Return revised strict JSON now.'
  ].join('\n');

  return { systemPrompt, userPrompt };
}

function openAiPayload({ model, systemPrompt, userPrompt, jsonMode }) {
  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  if (jsonMode) {
    payload.response_format = { type: 'json_object' };
  }

  return payload;
}

async function readErrorBody(response) {
  try {
    return await response.text();
  } catch {
    return 'Unable to read error response body.';
  }
}

async function completeOpenAi(modelConfig, promptSpec) {
  const apiKey = normalizeString(modelConfig.apiKey);
  if (!apiKey) {
    throw new Error('OpenAI API key is required in browser mode.');
  }

  const baseUrl = normalizeString(modelConfig.baseUrl) || 'https://api.openai.com/v1';
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), promptSpec.timeoutMs || TURN_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(
        openAiPayload({
          model: modelConfig.model,
          systemPrompt: promptSpec.systemPrompt,
          userPrompt: promptSpec.userPrompt,
          jsonMode: Boolean(promptSpec.jsonMode)
        })
      ),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      const textPart = content.find((part) => typeof part?.text === 'string');
      if (textPart?.text) {
        return textPart.text;
      }
    }
    throw new Error('OpenAI response did not contain readable text content.');
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${promptSpec.timeoutMs || TURN_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generateSingleTurn({ modelConfig, promptSpec }) {
  const rawText = await completeOpenAi(modelConfig, {
    ...promptSpec,
    jsonMode: true,
    timeoutMs: TURN_TIMEOUT_MS
  });
  return parseDebaterTurn(rawText);
}

async function generateTurnWithGuard({ modelConfig, descriptors, sideId, sideLabel, opponentLabel, transcript, round }) {
  let promptSpec = buildTurnPrompts({
    descriptors,
    sideId,
    sideLabel,
    opponentLabel,
    transcript,
    round
  });

  let latestTurn = null;
  let latestAssessment = {
    isValid: false,
    reasons: ['No turn generated yet.']
  };

  for (let attempt = 1; attempt <= MAX_NOVELTY_REWRITE_ATTEMPTS; attempt += 1) {
    latestTurn = await generateSingleTurn({
      modelConfig,
      promptSpec
    });

    latestAssessment = assessTurnNovelty(latestTurn, sideId, sideLabel, round, transcript);
    if (latestAssessment.isValid || latestTurn.hasMore === false) {
      return {
        ...latestTurn,
        noveltyWarnings: latestAssessment.isValid ? [] : latestAssessment.reasons
      };
    }

    promptSpec = buildRevisionPrompts({
      descriptors,
      sideId,
      sideLabel,
      opponentLabel,
      transcript,
      round,
      previousTurn: latestTurn,
      reasons: latestAssessment.reasons
    });
  }

  return {
    argument: 'No new rebuttal or evidence-backed point available; stopping to avoid repetition.',
    hasMore: false,
    confidence: null,
    citations: [],
    evidence: [],
    position: sideLabel,
    angle: latestTurn?.angle || '',
    audienceNote: '',
    counterTo: latestTurn?.counterTo || '',
    noveltyWarnings: latestAssessment.reasons,
    forcedStop: true
  };
}

function buildMeta(config, roundsCompleted, stopReason, stopSide = null) {
  const stopReasonDisplay = stopSide ? `${stopReason} (${stopSide})` : stopReason;
  return {
    debateType: config.debateType,
    question: config.question,
    optionA: config.optionA,
    optionB: config.optionB,
    maxRounds: config.maxRounds,
    roundsCompleted,
    stopReason,
    stopSide,
    stopReasonDisplay
  };
}

function buildSummaryStopContext(stopReason, stopSideLabel, stopRound, forcedStop) {
  if (
    stopReason !== 'side_reported_no_more_arguments' &&
    stopReason !== 'no_new_points_or_rebuttal'
  ) {
    return null;
  }

  if (!stopSideLabel) {
    return null;
  }

  return {
    reason: stopReason,
    sideLabel: normalizeString(stopSideLabel),
    round: Number.isFinite(Number(stopRound)) ? Number(stopRound) : null,
    forcedStop: Boolean(forcedStop)
  };
}

function summaryStopSentence(stopContext) {
  if (!stopContext || !stopContext.sideLabel) {
    return '';
  }

  const roundText =
    Number.isFinite(stopContext.round) && stopContext.round > 0
      ? ` in round ${stopContext.round}`
      : '';
  const reasonText =
    stopContext.reason === 'no_new_points_or_rebuttal'
      ? 'because it had no new rebuttal or evidence-backed points'
      : 'because it reported no more arguments';

  return `${stopContext.sideLabel} stopped${roundText} ${reasonText}.`;
}

function summaryMentionsStopContext(summaryMarkdown, stopContext) {
  if (!stopContext || !stopContext.sideLabel) {
    return true;
  }

  const text = normalizeString(summaryMarkdown).toLowerCase();
  if (!text) {
    return false;
  }

  const sideMentioned = text.includes(stopContext.sideLabel.toLowerCase());
  const stopMentioned =
    text.includes('stopped') ||
    text.includes('no more arguments') ||
    text.includes('ran out of arguments') ||
    text.includes('no new rebuttal');

  return sideMentioned && stopMentioned;
}

function ensureSummaryStopNote(summaryMarkdown, stopContext) {
  if (!stopContext || !stopContext.sideLabel) {
    return summaryMarkdown;
  }

  if (summaryMentionsStopContext(summaryMarkdown, stopContext)) {
    return summaryMarkdown;
  }

  const note = summaryStopSentence(stopContext);
  if (!note) {
    return summaryMarkdown;
  }

  const base = normalizeString(summaryMarkdown);
  if (!base) {
    return `## Debate Halt Note\n\n- ${note}`;
  }

  return `${base}\n\n## Debate Halt Note\n\n- ${note}`;
}

function formatTranscriptForSummary(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return 'No turns were generated.';
  }

  return transcript
    .map((turn) => {
      const lines = [`Round ${turn.round} | ${turn.sideLabel}`, turn.argument];
      if (turn.angle) {
        lines.push(`Angle: ${turn.angle}`);
      }
      if (turn.counterTo) {
        lines.push(`Countered point: ${turn.counterTo}`);
      }
      if (turn.audienceNote) {
        lines.push(`Plain-language note: ${turn.audienceNote}`);
      }
      if (Array.isArray(turn.evidence) && turn.evidence.length > 0) {
        lines.push('Evidence anchors:');
        for (const item of turn.evidence) {
          lines.push(`- ${formatEvidenceLine(item)}`);
        }
      }
      if (Array.isArray(turn.citations) && turn.citations.length > 0) {
        lines.push(`Citations: ${turn.citations.join('; ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function buildSummaryPrompts(descriptors, transcript, stopContext) {
  const stopSentence = summaryStopSentence(stopContext);
  const systemPrompt = [
    'You are an impartial debate analyst.',
    'Write markdown only.',
    'Preserve high-value details and do not dilute unique facts, numbers, dates, and source names.'
  ].join('\n');

  const userPrompt = [
    descriptors.propositionText,
    '',
    ...(stopSentence ? ['Debate halt context:', `- ${stopSentence}`, ''] : []),
    'Transcript:',
    formatTranscriptForSummary(transcript),
    '',
    'Return markdown with these sections:',
    '## Overview',
    '## Strongest Case For',
    '## Strongest Case Against',
    '## Evidence Ledger (Preserved Facts & Figures)',
    '## Areas of Convergence',
    '## Open Questions',
    '## Decision Takeaway',
    '',
    'Rules:',
    '- Keep distinct facts separate.',
    '- Preserve unusual/specific details.',
    '- Mention if one side stopped due to no more arguments/new rebuttal.',
    '- Do not declare a winner unless evidence is clearly one-sided.'
  ].join('\n');

  return { systemPrompt, userPrompt };
}

async function emitHook(hooks, hookName, payload) {
  const hook = hooks?.[hookName];
  if (typeof hook === 'function') {
    await hook(payload);
  }
}

export async function runDebateInBrowser(input, hooks = {}) {
  const config = normalizeDebateRequest(input);
  ensureOpenAiModel(config.forModel, 'For model');
  ensureOpenAiModel(config.againstModel, 'Against model');
  if (!config.skipSummary) {
    ensureOpenAiModel(config.summaryModel, 'Summary model');
  }

  const descriptors = sideDescriptors(config);
  const states = [
    {
      id: 'for',
      label: descriptors.forSide.roleLabel,
      shortName: descriptors.forSide.sideName,
      modelConfig: config.forModel,
      exhausted: false
    },
    {
      id: 'against',
      label: descriptors.againstSide.roleLabel,
      shortName: descriptors.againstSide.sideName,
      modelConfig: config.againstModel,
      exhausted: false
    }
  ];

  const transcript = [];
  let stopReasonOverride = null;
  let stopSideLabel = null;
  let stopRound = null;
  let stopWasForced = false;

  await emitHook(hooks, 'onStart', {
    meta: buildMeta(config, 0, 'running')
  });

  for (let round = 1; round <= config.maxRounds; round += 1) {
    for (const state of states) {
      if (state.exhausted) {
        continue;
      }

      const opponent = states.find((candidate) => candidate.id !== state.id);
      await emitHook(hooks, 'onThinking', {
        round,
        side: state.id,
        sideLabel: state.label,
        sideShort: state.shortName
      });

      const turn = await generateTurnWithGuard({
        modelConfig: state.modelConfig,
        descriptors,
        sideId: state.id,
        sideLabel: state.label,
        opponentLabel: opponent ? opponent.label : 'Opponent',
        transcript,
        round
      });

      if (!turn.hasMore) {
        state.exhausted = true;
        stopReasonOverride = turn.forcedStop
          ? 'no_new_points_or_rebuttal'
          : 'side_reported_no_more_arguments';
        stopSideLabel = state.label;
        stopRound = transcript.length > 0 ? transcript[transcript.length - 1].round : Math.max(0, round - 1);
        stopWasForced = Boolean(turn.forcedStop);
        break;
      }

      const nextTurn = {
        round,
        side: state.id,
        sideLabel: state.label,
        sideShort: state.shortName,
        argument: turn.argument || 'No argument produced.',
        hasMore: turn.hasMore,
        confidence: turn.confidence,
        citations: turn.citations || [],
        evidence: turn.evidence || [],
        position: turn.position || state.label,
        angle: turn.angle || '',
        audienceNote: turn.audienceNote || '',
        counterTo: turn.counterTo || '',
        noveltyWarnings: Array.isArray(turn.noveltyWarnings) ? turn.noveltyWarnings : [],
        forcedStop: Boolean(turn.forcedStop)
      };

      transcript.push(nextTurn);

      await emitHook(hooks, 'onTurn', {
        turn: nextTurn,
        meta: buildMeta(config, round, 'running'),
        transcriptCount: transcript.length
      });
    }

    if (stopReasonOverride) {
      break;
    }

    if (states.every((state) => state.exhausted)) {
      break;
    }
  }

  const completedRounds = transcript.reduce((maxRound, turn) => Math.max(maxRound, turn.round), 0);
  const stopReason = stopReasonOverride
    ? stopReasonOverride
    : states.every((state) => state.exhausted)
      ? 'both_sides_exhausted'
      : completedRounds >= config.maxRounds
        ? 'max_rounds_reached'
        : 'completed';
  const finalMeta = buildMeta(config, completedRounds, stopReason, stopSideLabel);
  const stopContext = buildSummaryStopContext(stopReason, stopSideLabel, stopRound, stopWasForced);

  let summary = '';
  let summaryRaw = '';
  let summaryError = null;

  if (!config.skipSummary) {
    const promptSpec = buildSummaryPrompts(descriptors, transcript, stopContext);
    await emitHook(hooks, 'onSummaryThinking', {
      usingSeparateModel: config.summaryModel !== config.forModel
    });

    try {
      summaryRaw = await completeOpenAi(config.summaryModel, {
        ...promptSpec,
        jsonMode: false,
        timeoutMs: TURN_TIMEOUT_MS
      });
      summary = ensureSummaryStopNote(summaryRaw, stopContext);
    } catch (error) {
      summaryError = error.message;
    }

    await emitHook(hooks, 'onSummary', {
      summary,
      summaryRaw,
      summaryStructured: null,
      summaryError
    });
  }

  const result = {
    meta: finalMeta,
    transcript,
    summary,
    summaryRaw,
    summaryStructured: null,
    summaryError
  };

  await emitHook(hooks, 'onComplete', {
    result
  });

  return result;
}

function sanitizeModelConfig(modelConfig) {
  if (!modelConfig || typeof modelConfig !== 'object') {
    return null;
  }

  return {
    provider: normalizeString(modelConfig.provider),
    model: normalizeString(modelConfig.model),
    baseUrl: normalizeString(modelConfig.baseUrl)
  };
}

function sanitizeRequestForStorage(requestBody) {
  if (!requestBody || typeof requestBody !== 'object') {
    return {};
  }

  return {
    debateType: requestBody.debateType === 'choice' ? 'choice' : 'motion',
    question: normalizeString(requestBody.question),
    optionA: normalizeString(requestBody.optionA),
    optionB: normalizeString(requestBody.optionB),
    maxRounds: clampRoundCount(requestBody.maxRounds),
    skipSummary: Boolean(requestBody.skipSummary),
    useSeparateSummaryModel: Boolean(requestBody.useSeparateSummaryModel),
    forModel: sanitizeModelConfig(requestBody.forModel),
    againstModel: sanitizeModelConfig(requestBody.againstModel),
    summaryModel: requestBody.useSeparateSummaryModel ? sanitizeModelConfig(requestBody.summaryModel) : null
  };
}

function extractDebatePayload(result) {
  return {
    meta: result?.meta || null,
    transcript: Array.isArray(result?.transcript) ? result.transcript : [],
    summary: normalizeString(result?.summary),
    summaryRaw: normalizeString(result?.summaryRaw),
    summaryStructured: result?.summaryStructured || null,
    summaryError: normalizeString(result?.summaryError)
  };
}

function slugify(value) {
  const cleaned = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'debate';
}

function buildDebateId(question) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 8);
  const slug = slugify(question).slice(0, 48);
  return `${timestamp}-${slug}-${random}`;
}

function readLocalDebateRecords() {
  try {
    const raw = window.localStorage.getItem(LOCAL_DEBATES_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalDebateRecords(records) {
  try {
    window.localStorage.setItem(LOCAL_DEBATES_KEY, JSON.stringify(records));
  } catch {
    // Ignore quota/privacy mode failures silently for UX continuity.
  }
}

function toDebateMetadata(record) {
  const result = record?.result || record?.debate || {};
  const meta = result?.meta || {};
  const transcript = Array.isArray(result?.transcript) ? result.transcript : [];
  const summary = normalizeString(result?.summary || record?.debate?.summary || '');

  return {
    id: record?.id || '',
    createdAt: record?.createdAt || '',
    question: meta.question || record?.request?.question || 'Untitled debate',
    debateType: meta.debateType || record?.request?.debateType || 'motion',
    roundsCompleted: Number(meta.roundsCompleted) || 0,
    turnCount: transcript.length,
    summaryExcerpt: summary ? summary.replace(/\s+/g, ' ').slice(0, 220) : ''
  };
}

export function listLocalDebates() {
  const records = readLocalDebateRecords();
  const metadata = records.map((record) => toDebateMetadata(record));
  metadata.sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0));
  return metadata;
}

export function loadLocalDebateRecord(debateId) {
  const id = normalizeString(debateId);
  if (!id) {
    return null;
  }

  const records = readLocalDebateRecords();
  return records.find((record) => record?.id === id) || null;
}

export function saveLocalDebateRecord(requestBody, result) {
  const records = readLocalDebateRecords();
  const question = result?.meta?.question || requestBody?.question || 'debate';
  const id = buildDebateId(question);
  const createdAt = new Date().toISOString();

  const record = {
    id,
    createdAt,
    request: sanitizeRequestForStorage(requestBody),
    result,
    debate: extractDebatePayload(result)
  };

  records.unshift(record);
  const capped = records.slice(0, 120);
  writeLocalDebateRecords(capped);

  return {
    id,
    createdAt
  };
}
