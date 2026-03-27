# Dialectic: Two-LLM Debate Studio

A starter app for running structured debates between two LLMs:

- One model argues **for** a motion (or **Option A**)
- One model argues **against** a motion (or **Option B**)
- They alternate turns until they run out of new arguments (or max rounds)
- Turns stream live in the UI with a per-side thinking indicator
- You get both:
  - Full **transcript**
  - Single **summary** that synthesizes both sides
- Debate turns now include structured evidence anchors (facts, figures/dates, source hints, reliability)
- Summaries preserve high-value detail via an evidence ledger instead of flattening unique facts
- Debates can be saved to local JSON files and reopened later

It supports cloud and local providers out of the box:

- OpenAI
- Anthropic (Claude)
- Ollama (local)

## Quick Start

1. Create env file:

```bash
cp .env.example .env
```

2. Add keys as needed (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) and/or keep them blank if you provide keys in the UI.

3. Start the app:

```bash
npm start
```

4. Open [http://localhost:3000](http://localhost:3000)

## Debate Modes

- `Motion`: classic for-vs-against
  - Example: `Is homeopathy an actual science?`
- `A vs B`: each model defends one option
  - Example question: `Nature vs Nurture`
  - Option A: `Nature`
  - Option B: `Nurture`

## How Stopping Works

Each turn asks the model to return structured JSON including `hasMore`.

- If a model sets `hasMore: false`, that side is marked exhausted.
- Debate stops when both sides are exhausted, or when `maxRounds` is reached.

## Project Structure

- `/src/server.js`: HTTP server + static file serving + API routes
- `/src/debateEngine.js`: debate loop, stop logic, summary generation
- `/src/providers.js`: provider adapters (OpenAI/Anthropic/Ollama)
- `/public/index.html`: UI markup
- `/public/styles.css`: UI styling
- `/public/app.js`: browser logic and rendering

## API

### `POST /api/debate`

Request body:

```json
{
  "debateType": "motion",
  "question": "Is homeopathy an actual science?",
  "maxRounds": 6,
  "forModel": {
    "provider": "openai",
    "model": "gpt-5-nano"
  },
  "againstModel": {
    "provider": "anthropic",
    "model": "claude-3-5-sonnet-latest"
  },
  "skipSummary": false,
  "useSeparateSummaryModel": false
}
```

Response body includes:

- `meta`: debate metadata and stop reason
- `transcript`: all turns
- `summary`: synthesized view
- `summaryError`: error text if summary failed
- `savedDebate`: metadata when `saveDebate: true`

### `POST /api/debate/stream`

Streams debate lifecycle events as `text/event-stream`:

- `start`
- `thinking`
- `turn`
- `summary_thinking`
- `summary`
- `complete`
- `error`

### `GET /api/debates`

Returns saved debate metadata for the archive view in the UI.

### `GET /api/debates/:id`

Returns one stored debate record, including transcript + summary.

## Storage

- Saved debates are written to `/storage/debates/*.json`.
- Each saved file contains the full debate transcript and summary.
- Saved transcript entries include evidence anchors and plain-language notes for each turn.
- API keys are not persisted to stored debate files.

## Notes

- OpenAI + Anthropic API keys can be supplied either in env vars or directly in the UI.
- Ollama defaults to `http://localhost:11434`.
- This is a starter architecture; you can extend with:
  - citations verification
  - judge/scoring model
