import { completeWithProvider } from './providers.js';

const DEFAULT_MAX_ROUNDS = 6;
const MAX_ALLOWED_ROUNDS = 20;
const MAX_TURN_EVIDENCE_ITEMS = 6;
const MAX_SUMMARY_LEDGER_ITEMS = 28;

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

const ALLOWED_LEDGER_SIDES = new Set(['for', 'against', 'both', 'disputed']);
const ALLOWED_RELIABILITY = new Set(['high', 'medium', 'low', 'uncertain']);

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

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeStringArray(value, maxItems = 10) {
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

  const lower = argumentText.toLowerCase();
  if (/\b(no further|no more|nothing else|rest my case|i concede)\b/.test(lower)) {
    return false;
  }

  return argumentText.length > 0;
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

    if (evidence.length >= MAX_TURN_EVIDENCE_ITEMS) {
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
    audienceNote: normalizeString(parsed.audienceNote || parsed.plainLanguageNote || parsed.teachingNote)
  };
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

      if (turn.audienceNote) {
        lines.push(`Plain-language note: ${turn.audienceNote}`);
      }

      if (Array.isArray(turn.evidence) && turn.evidence.length > 0) {
        lines.push('Evidence anchors:');
        for (const item of turn.evidence.slice(0, 4)) {
          lines.push(`- ${formatEvidenceLine(item)}`);
        }
      }

      if (turn.citations.length > 0) {
        lines.push(`Citations: ${turn.citations.join('; ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function buildTurnPrompts({ descriptors, sideLabel, opponentLabel, transcript, round }) {
  const systemPrompt = [
    'You are a debate participant in a structured two-agent debate.',
    `Your side: ${sideLabel}. Opponent side: ${opponentLabel}.`,
    'Goal: be information-dense but easy to follow for a non-expert.',
    'Use concrete facts, figures, named studies/reports, historical examples, and practical implications.',
    'Return strict JSON only (no markdown, no prose outside JSON).',
    'Required JSON schema:',
    '{',
    '  "argument": "4-8 sentences, clear and substantive",',
    '  "hasMore": true or false,',
    '  "confidence": 0.0 to 1.0,',
    '  "audienceNote": "One plain-language sentence for a general reader",',
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
    'Quality bar:',
    '- Include 2-4 evidence items each turn when possible.',
    '- At least one evidence item should include a concrete number/date.',
    '- Directly rebut or strengthen at least one point from the recent transcript.',
    '- Avoid repeating previous facts unless refining or correcting them.',
    '- If source certainty is weak, keep the claim but mark reliability as "uncertain".',
    '- If you genuinely have no meaningful new argument, set "hasMore": false.'
  ].join('\n');

  const userPrompt = [
    descriptors.propositionText,
    `Current round: ${round}`,
    `Your role this round: ${sideLabel}`,
    '',
    'Recent transcript:',
    transcriptToContext(transcript),
    '',
    'Now produce your next turn in strict JSON.'
  ].join('\n');

  return { systemPrompt, userPrompt };
}

function formatTranscriptForSummary(transcript) {
  if (transcript.length === 0) {
    return 'No turns were generated.';
  }

  return transcript
    .map((turn) => {
      const lines = [`Round ${turn.round} | ${turn.sideLabel}`, turn.argument];

      if (turn.audienceNote) {
        lines.push(`Plain-language note: ${turn.audienceNote}`);
      }

      if (Array.isArray(turn.evidence) && turn.evidence.length > 0) {
        lines.push('Evidence anchors:');
        for (const item of turn.evidence) {
          lines.push(`- ${formatEvidenceLine(item)}`);
        }
      }

      if (turn.citations.length > 0) {
        lines.push(`Citations: ${turn.citations.join('; ')}`);
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

function buildSummaryPrompts(descriptors, transcript) {
  const systemPrompt = [
    'You are an impartial debate analyst.',
    'Your job is to preserve high-value details while staying readable.',
    'Do not dilute unique facts, numbers, dates, named studies, or case examples.',
    'Return strict JSON only.'
  ].join('\n');

  const userPrompt = [
    descriptors.propositionText,
    '',
    'Transcript:',
    formatTranscriptForSummary(transcript),
    '',
    'Return this exact JSON schema:',
    '{',
    '  "overview": "2-4 sentence high-level synthesis",',
    '  "bestCaseFor": ["bullet", "bullet"],',
    '  "bestCaseAgainst": ["bullet", "bullet"],',
    '  "evidenceLedger": [',
    '    {',
    '      "side": "for|against|both|disputed",',
    '      "fact": "Atomic fact from transcript",',
    '      "figureOrDate": "exact number/date/range if present",',
    '      "source": "source hint from transcript",',
    '      "importance": "why this is decision-relevant",',
    '      "reliability": "high|medium|low|uncertain"',
    '    }',
    '  ],',
    '  "convergence": ["Where both sides partly agree"],',
    '  "openQuestions": ["What evidence would resolve uncertainty"],',
    '  "decisionTakeaway": "Actionable takeaway for a practical reader"',
    '}',
    'Rules:',
    '- Keep distinct facts separate; do not merge two different findings into one.',
    '- Preserve unusual or specific details exactly where possible.',
    '- Include at least 8 ledger entries when transcript provides enough evidence.',
    '- If evidence conflicts, keep both and mark the side as "disputed" or appropriate.',
    '- Do not declare a winner unless evidence is clearly one-sided.'
  ].join('\n');

  return { systemPrompt, userPrompt };
}

function normalizeLedgerSide(value) {
  const side = normalizeString(value).toLowerCase();
  if (ALLOWED_LEDGER_SIDES.has(side)) {
    return side;
  }

  return 'disputed';
}

function normalizeSummaryLedger(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const fact = normalizeString(item.fact || item.claim || item.detail || item.statement);
    if (!fact) {
      continue;
    }

    entries.push({
      side: normalizeLedgerSide(item.side),
      fact,
      figureOrDate: normalizeString(item.figureOrDate || item.figure || item.year || item.stat),
      source: normalizeString(item.source || item.sourceHint || item.reference || item.citation),
      importance: normalizeString(item.importance || item.whyItMatters || item.relevance),
      reliability: normalizeReliability(item.reliability)
    });

    if (entries.length >= MAX_SUMMARY_LEDGER_ITEMS) {
      break;
    }
  }

  return entries;
}

function normalizeSummaryObject(parsed) {
  return {
    overview: normalizeString(parsed.overview || parsed.executiveSummary || parsed.summary),
    bestCaseFor: normalizeStringArray(parsed.bestCaseFor || parsed.strongestFor || parsed.forPoints, 12),
    bestCaseAgainst: normalizeStringArray(parsed.bestCaseAgainst || parsed.strongestAgainst || parsed.againstPoints, 12),
    evidenceLedger: normalizeSummaryLedger(parsed.evidenceLedger || parsed.keyFacts || parsed.factLedger),
    convergence: normalizeStringArray(parsed.convergence || parsed.overlap || parsed.sharedGround, 8),
    openQuestions: normalizeStringArray(parsed.openQuestions || parsed.evidenceGaps || parsed.uncertainties, 10),
    decisionTakeaway: normalizeString(parsed.decisionTakeaway || parsed.takeaway || parsed.practicalTakeaway)
  };
}

function hasStructuredSummaryContent(summaryStructured) {
  return Boolean(
    summaryStructured.overview ||
      summaryStructured.bestCaseFor.length > 0 ||
      summaryStructured.bestCaseAgainst.length > 0 ||
      summaryStructured.evidenceLedger.length > 0 ||
      summaryStructured.convergence.length > 0 ||
      summaryStructured.openQuestions.length > 0 ||
      summaryStructured.decisionTakeaway
  );
}

function formatSection(title, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const lines = [`## ${title}`];
  for (const item of items) {
    lines.push(`- ${item}`);
  }

  return lines;
}

function structuredSummaryToMarkdown(summaryStructured) {
  const lines = [];

  if (summaryStructured.overview) {
    lines.push('## Overview');
    lines.push(summaryStructured.overview);
  }

  lines.push(...formatSection('Strongest Case For', summaryStructured.bestCaseFor));
  lines.push(...formatSection('Strongest Case Against', summaryStructured.bestCaseAgainst));

  if (summaryStructured.evidenceLedger.length > 0) {
    lines.push('## Evidence Ledger (Preserved Facts & Figures)');
    for (const item of summaryStructured.evidenceLedger) {
      const details = [];
      if (item.figureOrDate) {
        details.push(`Figure/Date: ${item.figureOrDate}`);
      }
      if (item.source) {
        details.push(`Source: ${item.source}`);
      }
      if (item.importance) {
        details.push(`Why it matters: ${item.importance}`);
      }
      details.push(`Reliability: ${item.reliability}`);

      lines.push(`- [${item.side.toUpperCase()}] ${item.fact}${details.length > 0 ? ` (${details.join('; ')})` : ''}`);
    }
  }

  lines.push(...formatSection('Areas of Convergence', summaryStructured.convergence));
  lines.push(...formatSection('Open Questions', summaryStructured.openQuestions));

  if (summaryStructured.decisionTakeaway) {
    lines.push('## Decision Takeaway');
    lines.push(summaryStructured.decisionTakeaway);
  }

  return lines.join('\n\n').trim();
}

function parseSummaryOutput(rawOutput) {
  const raw = normalizeString(rawOutput);
  if (!raw) {
    return {
      summaryMarkdown: '',
      summaryStructured: null
    };
  }

  try {
    const parsed = safeJsonParse(raw);
    const summaryStructured = normalizeSummaryObject(parsed);

    if (!hasStructuredSummaryContent(summaryStructured)) {
      return {
        summaryMarkdown: raw,
        summaryStructured: null
      };
    }

    const summaryMarkdown = structuredSummaryToMarkdown(summaryStructured);
    return {
      summaryMarkdown: summaryMarkdown || raw,
      summaryStructured
    };
  } catch {
    return {
      summaryMarkdown: raw,
      summaryStructured: null
    };
  }
}

function buildMeta(config, roundsCompleted, stopReason) {
  return {
    debateType: config.debateType,
    question: config.question,
    optionA: config.optionA,
    optionB: config.optionB,
    maxRounds: config.maxRounds,
    roundsCompleted,
    stopReason
  };
}

async function emitHook(hooks, hookName, payload) {
  const hook = hooks?.[hookName];
  if (typeof hook === 'function') {
    await hook(payload);
  }
}

async function generateSingleTurn({ modelConfig, promptSpec }) {
  const rawText = await completeWithProvider(modelConfig, {
    ...promptSpec,
    jsonMode: true,
    temperature: 0.7,
    timeoutMs: 120000
  });

  return parseDebaterTurn(rawText);
}

export async function runDebate(input, hooks = {}) {
  const config = normalizeDebateRequest(input);
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

  await emitHook(hooks, 'onStart', {
    meta: buildMeta(config, 0, 'running')
  });

  for (let round = 1; round <= config.maxRounds; round += 1) {
    for (const state of states) {
      if (state.exhausted) {
        continue;
      }

      const opponent = states.find((candidate) => candidate.id !== state.id);
      const promptSpec = buildTurnPrompts({
        descriptors,
        sideLabel: state.label,
        opponentLabel: opponent ? opponent.label : 'Opponent',
        transcript,
        round
      });

      await emitHook(hooks, 'onThinking', {
        round,
        side: state.id,
        sideLabel: state.label,
        sideShort: state.shortName
      });

      try {
        const turn = await generateSingleTurn({
          modelConfig: state.modelConfig,
          promptSpec
        });

        const argument = turn.argument || 'No argument produced.';
        const nextTurn = {
          round,
          side: state.id,
          sideLabel: state.label,
          sideShort: state.shortName,
          argument,
          hasMore: turn.hasMore,
          confidence: turn.confidence,
          citations: turn.citations,
          evidence: turn.evidence,
          audienceNote: turn.audienceNote
        };

        transcript.push(nextTurn);

        await emitHook(hooks, 'onTurn', {
          turn: nextTurn,
          meta: buildMeta(config, round, 'running'),
          transcriptCount: transcript.length
        });

        if (!turn.hasMore) {
          state.exhausted = true;
        }
      } catch (error) {
        state.exhausted = true;
        const errorTurn = {
          round,
          side: state.id,
          sideLabel: state.label,
          sideShort: state.shortName,
          argument: `Model error: ${error.message}`,
          hasMore: false,
          confidence: null,
          citations: [],
          evidence: [],
          audienceNote: '',
          error: true
        };

        transcript.push(errorTurn);
        await emitHook(hooks, 'onTurn', {
          turn: errorTurn,
          meta: buildMeta(config, round, 'running'),
          transcriptCount: transcript.length
        });
      }
    }

    if (states.every((state) => state.exhausted)) {
      break;
    }
  }

  const completedRounds = transcript.reduce((maxRound, turn) => Math.max(maxRound, turn.round), 0);
  const stopReason = states.every((state) => state.exhausted)
    ? 'both_sides_exhausted'
    : completedRounds >= config.maxRounds
      ? 'max_rounds_reached'
      : 'completed';

  let summary = '';
  let summaryRaw = '';
  let summaryStructured = null;
  let summaryError = null;

  if (!config.skipSummary) {
    const promptSpec = buildSummaryPrompts(descriptors, transcript);

    await emitHook(hooks, 'onSummaryThinking', {
      usingSeparateModel: config.summaryModel !== config.forModel
    });

    try {
      summaryRaw = await completeWithProvider(config.summaryModel, {
        ...promptSpec,
        jsonMode: true,
        temperature: 0.2,
        timeoutMs: 120000
      });

      const parsedSummary = parseSummaryOutput(summaryRaw);
      summary = parsedSummary.summaryMarkdown;
      summaryStructured = parsedSummary.summaryStructured;
    } catch (error) {
      summaryError = error.message;
    }

    await emitHook(hooks, 'onSummary', {
      summary,
      summaryRaw,
      summaryStructured,
      summaryError
    });
  }

  const result = {
    meta: buildMeta(config, completedRounds, stopReason),
    transcript,
    summary,
    summaryRaw,
    summaryStructured,
    summaryError
  };

  await emitHook(hooks, 'onComplete', {
    result
  });

  return result;
}
