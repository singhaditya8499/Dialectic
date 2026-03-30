import { completeWithProvider } from './providers.js';

const DEFAULT_MAX_ROUNDS = 6;
const MAX_ALLOWED_ROUNDS = 20;
const MAX_TURN_EVIDENCE_ITEMS = 6;
const MAX_SUMMARY_LEDGER_ITEMS = 28;
const MAX_NOVELTY_REWRITE_ATTEMPTS = 3;
const MIN_NEW_FACTS_PER_CONTINUING_TURN = 2;
const MIN_NEW_CITATIONS_PER_CONTINUING_TURN = 1;

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
const NOVELTY_SIMILARITY_THRESHOLD = 0.74;
const FACT_REUSE_SIMILARITY_THRESHOLD = 0.58;
const CITATION_REUSE_SIMILARITY_THRESHOLD = 0.7;
const ANGLE_REUSE_SIMILARITY_THRESHOLD = 0.72;
const MIN_COUNTER_ALIGNMENT_SIMILARITY = 0.08;
const MIN_COUNTER_ALIGNMENT_OVERLAP_WORDS = 2;

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
    position: normalizeString(parsed.position || parsed.side || parsed.stance),
    angle: normalizeString(parsed.angle || parsed.lens || parsed.focus || parsed.debateAngle),
    audienceNote: normalizeString(parsed.audienceNote || parsed.plainLanguageNote || parsed.teachingNote),
    counterTo: normalizeString(parsed.counterTo || parsed.rebuttalTarget || parsed.opponentClaimAddressed)
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

function normalizeFactKey(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function collectUsedFactsBySide(transcript, sideId, limit = 40) {
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
      if (facts.length >= limit) {
        return facts;
      }
    }
  }

  return facts;
}

function collectUsedCitationsBySide(transcript, sideId, limit = 30) {
  const citations = [];

  for (const turn of transcript) {
    if (turn.side !== sideId || !Array.isArray(turn.citations)) {
      continue;
    }

    for (const citation of turn.citations) {
      const cleaned = normalizeString(citation);
      if (cleaned) {
        citations.push(cleaned);
      }
      if (citations.length >= limit) {
        return dedupeStrings(citations);
      }
    }
  }

  return dedupeStrings(citations);
}

function collectUsedAnglesBySide(transcript, sideId, limit = 24) {
  const angles = [];

  for (const turn of transcript) {
    if (turn.side !== sideId) {
      continue;
    }

    const cleaned = normalizeString(turn.angle);
    if (cleaned) {
      angles.push(cleaned);
    }

    if (angles.length >= limit) {
      return dedupeStrings(angles);
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

function tokenOverlapCount(left, right) {
  const leftTokens = new Set(tokenizeForSimilarity(left));
  const rightTokens = new Set(tokenizeForSimilarity(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap;
}

function isNearDuplicateText(left, right, minSimilarity) {
  const leftKey = normalizeFactKey(left);
  const rightKey = normalizeFactKey(right);
  if (!leftKey || !rightKey) {
    return false;
  }

  if (leftKey === rightKey) {
    return true;
  }

  const shorter = leftKey.length <= rightKey.length ? leftKey : rightKey;
  const longer = leftKey.length <= rightKey.length ? rightKey : leftKey;
  if (shorter.length >= 18 && longer.includes(shorter) && shorter.length / longer.length >= 0.72) {
    return true;
  }

  return argumentSimilarity(leftKey, rightKey) >= minSimilarity;
}

function countNovelItems(candidates, history, minSimilarity) {
  const cleanedCandidates = candidates.map((entry) => normalizeString(entry)).filter(Boolean);
  const cleanedHistory = history.map((entry) => normalizeString(entry)).filter(Boolean);

  let newCount = 0;
  let repeatedCount = 0;
  let maxSeenSimilarity = 0;

  for (const candidate of cleanedCandidates) {
    let bestSimilarity = 0;
    let repeated = false;

    for (const previous of cleanedHistory) {
      const similarity = argumentSimilarity(candidate, previous);
      bestSimilarity = Math.max(bestSimilarity, similarity);
      if (isNearDuplicateText(candidate, previous, minSimilarity)) {
        repeated = true;
      }
    }

    maxSeenSimilarity = Math.max(maxSeenSimilarity, bestSimilarity);
    if (repeated) {
      repeatedCount += 1;
    } else {
      newCount += 1;
    }
  }

  return {
    total: cleanedCandidates.length,
    newCount,
    repeatedCount,
    maxSeenSimilarity
  };
}

function argumentStartsWithPosition(argument, sideLabel) {
  const normalizedArgument = normalizeFactKey(argument);
  const normalizedSide = normalizeFactKey(sideLabel);
  if (!normalizedArgument || !normalizedSide) {
    return false;
  }

  return normalizedArgument.startsWith(`position defended ${normalizedSide}`);
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
    return Boolean(key) && key !== 'unknown' && key !== 'n a' && key !== 'none';
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

    let matchedTokens = 0;
    for (const token of hintTokens) {
      if (argumentTokens.has(token)) {
        matchedTokens += 1;
      }
    }

    const requiredMatches = hintTokens.length >= 3 ? 2 : 1;
    if (matchedTokens >= requiredMatches) {
      return true;
    }
  }

  return false;
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

function assessTurnNovelty(turn, sideId, sideLabel, round, transcript) {
  const reasons = [];
  const isContinuing = turn.hasMore !== false;
  const latestOpponentTurn = getLatestOpponentTurn(transcript, sideId);
  const expectedPosition = normalizeFactKey(sideLabel);
  const providedPosition = normalizeFactKey(turn.position);

  if (!turn.argument) {
    reasons.push('Argument is empty.');
  }

  if (isContinuing && !providedPosition) {
    reasons.push('Missing "position" field; it must match your side exactly.');
  }

  if (isContinuing && providedPosition && expectedPosition && providedPosition !== expectedPosition) {
    reasons.push(`"position" must be exactly "${sideLabel}".`);
  }

  if (isContinuing && !argumentStartsWithPosition(turn.argument, sideLabel)) {
    reasons.push(`Argument must begin with "Position defended: ${sideLabel}."`);
  }

  if (round > 1 && !turn.counterTo) {
    reasons.push('Missing explicit counter to the latest opponent point.');
  }

  if (round > 1 && turn.counterTo && latestOpponentTurn?.argument) {
    const counterSimilarity = argumentSimilarity(turn.counterTo, latestOpponentTurn.argument);
    const overlap = tokenOverlapCount(turn.counterTo, latestOpponentTurn.argument);
    if (
      counterSimilarity < MIN_COUNTER_ALIGNMENT_SIMILARITY &&
      overlap < MIN_COUNTER_ALIGNMENT_OVERLAP_WORDS
    ) {
      reasons.push('counterTo does not clearly match the latest opponent point.');
    }
  }

  if (isContinuing && (!Array.isArray(turn.evidence) || turn.evidence.length === 0)) {
    reasons.push('No evidence anchors were provided.');
  }

  if (isContinuing && Array.isArray(turn.evidence) && turn.evidence.length > 0 && !evidenceHasConcreteFigure(turn.evidence)) {
    reasons.push('Include at least one concrete number/date in evidence for objective grounding.');
  }

  if (isContinuing && !turn.angle) {
    reasons.push('Missing debate angle; include a short new angle for this round.');
  }

  const sameSideTurns = transcript.filter((entry) => entry.side === sideId);
  let maxSimilarity = 0;

  for (const previousTurn of sameSideTurns) {
    const similarity = argumentSimilarity(turn.argument, previousTurn.argument);
    maxSimilarity = Math.max(maxSimilarity, similarity);
  }

  if (maxSimilarity >= NOVELTY_SIMILARITY_THRESHOLD) {
    reasons.push(`Argument overlaps too much with prior points (similarity ${maxSimilarity.toFixed(2)}).`);
  }

  const usedAngles = collectUsedAnglesBySide(transcript, sideId, 40);
  if (isContinuing && turn.angle) {
    const angleNovelty = countNovelItems([turn.angle], usedAngles, ANGLE_REUSE_SIMILARITY_THRESHOLD);
    if (round > 1 && angleNovelty.newCount === 0 && usedAngles.length > 0) {
      reasons.push('Angle repeats your own earlier rounds; choose a clearly new angle.');
    }
  }

  const usedFacts = collectUsedFactsBySide(transcript, sideId, 200);
  const providedFacts = Array.isArray(turn.evidence)
    ? turn.evidence.map((item) => normalizeString(item.fact)).filter(Boolean)
    : [];
  const factNovelty = countNovelItems(providedFacts, usedFacts, FACT_REUSE_SIMILARITY_THRESHOLD);

  if (round > 1 && isContinuing && providedFacts.length < MIN_NEW_FACTS_PER_CONTINUING_TURN) {
    reasons.push(
      `Provide at least ${MIN_NEW_FACTS_PER_CONTINUING_TURN} evidence facts for a continuing turn.`
    );
  }

  if (
    round > 1 &&
    isContinuing &&
    factNovelty.total > 0 &&
    factNovelty.newCount < Math.min(MIN_NEW_FACTS_PER_CONTINUING_TURN, factNovelty.total)
  ) {
    reasons.push(
      `Need at least ${MIN_NEW_FACTS_PER_CONTINUING_TURN} genuinely new evidence facts; found ${factNovelty.newCount}.`
    );
  }

  if (round > 1 && isContinuing && factNovelty.total > 0 && factNovelty.newCount === 0) {
    reasons.push('All evidence facts repeat your own prior rounds; add new material or stop.');
  }

  const usedCitations = collectUsedCitationsBySide(transcript, sideId, 200);
  const providedCitations = Array.isArray(turn.citations)
    ? turn.citations.map((citation) => normalizeString(citation)).filter(Boolean)
    : [];
  const citationNovelty = countNovelItems(providedCitations, usedCitations, CITATION_REUSE_SIMILARITY_THRESHOLD);

  if (round > 1 && isContinuing && providedCitations.length < MIN_NEW_CITATIONS_PER_CONTINUING_TURN) {
    reasons.push('Include at least one citation/source hint in continuing turns.');
  }

  if (
    round > 1 &&
    isContinuing &&
    citationNovelty.total > 0 &&
    citationNovelty.newCount < Math.min(MIN_NEW_CITATIONS_PER_CONTINUING_TURN, citationNovelty.total)
  ) {
    reasons.push('Citations are fully repeated or near-duplicate; include at least one fresh source hint.');
  }

  const sourceHints = collectSourceHintsFromTurn(turn);
  if (isContinuing && sourceHints.length > 0 && !argumentMentionsSourceHints(turn.argument, sourceHints)) {
    reasons.push('Argument must explicitly mention at least one cited study/report/source by name.');
  }

  return {
    isValid: reasons.length === 0,
    reasons,
    maxSimilarity,
    factNovelty,
    citationNovelty
  };
}

function buildTurnPrompts({ descriptors, sideId, sideLabel, opponentLabel, transcript, round }) {
  const usedFacts = collectUsedFactsBySide(transcript, sideId, 24);
  const usedCitations = collectUsedCitationsBySide(transcript, sideId, 18);
  const usedAngles = collectUsedAnglesBySide(transcript, sideId, 12);
  const latestOpponentTurn = getLatestOpponentTurn(transcript, sideId);

  const systemPrompt = [
    'You are a debate participant in a structured two-person debate.',
    `Your side is: ${sideLabel}.`,
    `Opponent side is: ${opponentLabel}.`,
    'Goal: To convince the other side that your side is correct and be information-dense but easy to follow for a non-expert.',
    'Use concrete facts, figures, named studies/reports, historical examples, and practical implications.',
    'Return strict JSON only (no markdown, no prose outside JSON).',
    'Required JSON schema:',
    '{',
    '  "argument": "a paragraph",',
    '  "hasMore": true or false,',
    '  "confidence": 0.0 to 1.0,',
    `  "position": "exactly ${sideLabel}",`,
    '  "angle": "4-10 words naming the fresh lens used this round",',
    '  "counterTo": "Short quote/paraphrase of the exact opponent point you are rebutting now",',
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
    `- Set "position" to exactly "${sideLabel}".`,
    `- Start "argument" with exactly: "Position defended: ${sideLabel}."`,
    `- The argument must defend ${sideLabel} and not advocate for ${opponentLabel}.`,
    '- Include 2-4 evidence items each turn when possible.',
    '- At least one evidence item should include a concrete number/date.',
    '- Keep claims objective and testable; avoid purely subjective judgments unless clearly marked as interpretation.',
    '- Use a distinct "angle" each round (for example: safety, lifecycle cost, equity, infrastructure reliability).',
    '- You must directly rebut the latest opponent turn and fill "counterTo".',
    '- Avoid repeating previous facts unless refining or correcting them.',
    '- Do not reuse your own prior evidence facts or citation lines, even if lightly rephrased.',
    '- In rounds after round 1, include at least two genuinely new evidence facts.',
    '- In argument prose, explicitly name at least one cited source/study (for example "A 2015 Lancet review...").',
    '- If source certainty is weak, keep the claim but mark reliability as "uncertain".',
    '- If you genuinely have no meaningful new argument, set "hasMore": false and explain briefly in "argument".'
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
    usedFacts.length > 0 ? usedFacts.map((fact) => `- ${fact}`).join('\n') : '- none yet',
    '',
    'Angles already used by your side (must choose a different angle now):',
    usedAngles.length > 0 ? usedAngles.map((angle) => `- ${angle}`).join('\n') : '- none yet',
    '',
    'Citation/source lines already used by your side (avoid repeating verbatim):',
    usedCitations.length > 0 ? usedCitations.map((citation) => `- ${citation}`).join('\n') : '- none yet',
    '',
    'Now produce your next turn in strict JSON.'
  ].join('\n');

  return { systemPrompt, userPrompt };
}

function buildNoveltyRevisionPrompt({
  descriptors,
  sideId,
  sideLabel,
  opponentLabel,
  transcript,
  round,
  previousTurn,
  noveltyReasons
}) {
  const usedFacts = collectUsedFactsBySide(transcript, sideId, 30);
  const usedCitations = collectUsedCitationsBySide(transcript, sideId, 20);
  const usedAngles = collectUsedAnglesBySide(transcript, sideId, 14);
  const latestOpponentTurn = getLatestOpponentTurn(transcript, sideId);

  const systemPrompt = [
    'You are revising your previous debate turn because it repeated prior points.',
    `Your side is: ${sideLabel}. Opponent side is: ${opponentLabel}.`,
    'Return strict JSON only, using the same schema as the normal turn.',
    'Hard constraints:',
    `- Set "position" to exactly "${sideLabel}".`,
    `- Start "argument" with exactly: "Position defended: ${sideLabel}."`,
    `- Defend ${sideLabel}; do not advocate for ${opponentLabel}.`,
    '- Set "angle" to a fresh lens not used by your side before.',
    '- Include a clear rebuttal to the latest opponent point in "counterTo".',
    `- Include at least ${MIN_NEW_FACTS_PER_CONTINUING_TURN} evidence facts that are NEW relative to your previous rounds.`,
    '- Include at least one NEW citation/source hint relative to your previous rounds.',
    '- Mention at least one cited source/study explicitly in the argument text.',
    '- Keep the argument objective and evidence-led; minimize subjective language.',
    '- Do not reuse your own prior evidence facts or citation lines, even if lightly rephrased.',
    '- Keep the argument information-dense and easy to follow.'
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
    'Why your previous draft was rejected:',
    noveltyReasons.map((reason) => `- ${reason}`).join('\n'),
    '',
    'Your previous draft:',
    JSON.stringify(previousTurn, null, 2),
    '',
    'Facts already used by your side (must avoid repeating):',
    usedFacts.length > 0 ? usedFacts.map((fact) => `- ${fact}`).join('\n') : '- none yet',
    '',
    'Angles already used by your side (must avoid repeating):',
    usedAngles.length > 0 ? usedAngles.map((angle) => `- ${angle}`).join('\n') : '- none yet',
    '',
    'Citation/source lines already used by your side (must avoid repeating):',
    usedCitations.length > 0 ? usedCitations.map((citation) => `- ${citation}`).join('\n') : '- none yet',
    '',
    'Generate a revised turn in strict JSON now.'
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

      if (turn.citations.length > 0) {
        lines.push(`Citations: ${turn.citations.join('; ')}`);
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

function buildSummaryStopContext(stopReason, transcript, stopInfo = null) {
  if (
    stopReason !== 'side_reported_no_more_arguments' &&
    stopReason !== 'no_new_points_or_rebuttal'
  ) {
    return null;
  }

  if (stopInfo?.sideLabel) {
    return {
      reason: stopReason,
      sideLabel: normalizeString(stopInfo.sideLabel),
      round: Number.isFinite(Number(stopInfo.round)) ? Number(stopInfo.round) : null,
      forcedStop: Boolean(stopInfo.forcedStop)
    };
  }

  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const turn = transcript[i];
    if (turn?.hasMore === false) {
      return {
        reason: stopReason,
        sideLabel: normalizeString(turn.sideLabel || turn.side),
        round: Number.isFinite(Number(turn.round)) ? Number(turn.round) : null,
        forcedStop: Boolean(turn.forcedStop)
      };
    }
  }

  return null;
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

function buildSummaryPrompts(descriptors, transcript, stopContext = null) {
  const stopSentence = summaryStopSentence(stopContext);
  const systemPrompt = [
    'You are an impartial debate analyst.',
    'Your job is to preserve high-value details while staying readable.',
    'Do not dilute unique facts, numbers, dates, named studies, or case examples.',
    'Return strict JSON only.'
  ].join('\n');

  const userPrompt = [
    descriptors.propositionText,
    '',
    ...(stopSentence
      ? ['Debate halt context:', `- ${stopSentence}`, '']
      : []),
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
    '- If a side stopped due to no more arguments/new rebuttal, mention that explicitly in overview and decision takeaway.',
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

async function generateTurnWithNoveltyGuard({
  modelConfig,
  descriptors,
  sideId,
  sideLabel,
  opponentLabel,
  transcript,
  round
}) {
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

    promptSpec = buildNoveltyRevisionPrompt({
      descriptors,
      sideId,
      sideLabel,
      opponentLabel,
      transcript,
      round,
      previousTurn: latestTurn,
      noveltyReasons: latestAssessment.reasons
    });
  }

  return {
    argument: 'No new rebuttal or evidence-backed point available; stopping to avoid repetition.',
    hasMore: false,
    confidence: null,
    citations: [],
    evidence: [],
    position: latestTurn?.position || sideLabel,
    angle: latestTurn?.angle || '',
    audienceNote: '',
    counterTo: latestTurn?.counterTo || '',
    noveltyWarnings: latestAssessment.reasons,
    forcedStop: true
  };
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

      try {
        const turn = await generateTurnWithNoveltyGuard({
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
          position: turn.position,
          angle: turn.angle,
          audienceNote: turn.audienceNote,
          counterTo: turn.counterTo,
          noveltyWarnings: Array.isArray(turn.noveltyWarnings) ? turn.noveltyWarnings : [],
          forcedStop: Boolean(turn.forcedStop)
        };

        transcript.push(nextTurn);

        await emitHook(hooks, 'onTurn', {
          turn: nextTurn,
          meta: buildMeta(config, round, 'running'),
          transcriptCount: transcript.length
        });
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
          position: state.label,
          angle: '',
          audienceNote: '',
          counterTo: '',
          noveltyWarnings: [],
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
  const stopContext = buildSummaryStopContext(stopReason, transcript, {
    sideLabel: stopSideLabel,
    round: stopRound,
    forcedStop: stopWasForced
  });
  const finalMeta = buildMeta(config, completedRounds, stopReason, stopSideLabel);

  let summary = '';
  let summaryRaw = '';
  let summaryStructured = null;
  let summaryError = null;

  if (!config.skipSummary) {
    const promptSpec = buildSummaryPrompts(descriptors, transcript, stopContext);

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
      summary = ensureSummaryStopNote(parsedSummary.summaryMarkdown, stopContext);
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
    meta: finalMeta,
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
