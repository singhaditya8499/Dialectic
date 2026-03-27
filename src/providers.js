const DEFAULT_TIMEOUT_MS = 120000;

const DEFAULT_BASE_URLS = {
  openai: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  anthropic: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
};

function assertConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Missing model configuration.');
  }

  if (!config.provider) {
    throw new Error('Model configuration must include a provider.');
  }

  if (!config.model) {
    throw new Error('Model configuration must include a model.');
  }
}

async function readErrorBody(response) {
  try {
    return await response.text();
  } catch {
    return 'Unable to read error response body.';
  }
}

async function postJson(url, payload, headers, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms for ${url}`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function openAiPayload({ model, systemPrompt, userPrompt, temperature, jsonMode }) {
  const payload = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }

  if (jsonMode) {
    payload.response_format = { type: 'json_object' };
  }

  return payload;
}

function parseOpenAiText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.length > 0) {
    return data.output_text;
  }

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
}

async function callOpenAi(config, promptSpec) {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key missing. Provide it in UI or OPENAI_API_KEY env var.');
  }

  const baseUrl = config.baseUrl || DEFAULT_BASE_URLS.openai;
  const explicitTemperature = Number(config.temperature);
  const useExplicitTemperature = Number.isFinite(explicitTemperature);
  const data = await postJson(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    openAiPayload({
      model: config.model,
      systemPrompt: promptSpec.systemPrompt,
      userPrompt: promptSpec.userPrompt,
      temperature: useExplicitTemperature ? explicitTemperature : undefined,
      jsonMode: promptSpec.jsonMode
    }),
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    promptSpec.timeoutMs
  );

  return parseOpenAiText(data);
}

function anthropicPayload({ model, systemPrompt, userPrompt, temperature }) {
  const payload = {
    model,
    max_tokens: 1200,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  };

  if (typeof temperature === 'number') {
    payload.temperature = temperature;
  }

  return payload;
}

function parseAnthropicText(data) {
  const parts = data?.content;
  if (!Array.isArray(parts)) {
    throw new Error('Anthropic response did not contain a content array.');
  }

  const text = parts
    .filter((part) => part?.type === 'text' && typeof part?.text === 'string')
    .map((part) => part.text)
    .join('\n');

  if (!text) {
    throw new Error('Anthropic response did not contain readable text content.');
  }

  return text;
}

async function callAnthropic(config, promptSpec) {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Anthropic API key missing. Provide it in UI or ANTHROPIC_API_KEY env var.');
  }

  const baseUrl = config.baseUrl || DEFAULT_BASE_URLS.anthropic;
  const data = await postJson(
    `${baseUrl.replace(/\/$/, '')}/v1/messages`,
    anthropicPayload({
      model: config.model,
      systemPrompt: promptSpec.systemPrompt,
      userPrompt: promptSpec.userPrompt,
      temperature: promptSpec.temperature
    }),
    {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    promptSpec.timeoutMs
  );

  return parseAnthropicText(data);
}

function ollamaPayload({ model, systemPrompt, userPrompt, temperature, jsonMode }) {
  const payload = {
    model,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  };

  if (typeof temperature === 'number') {
    payload.options = { temperature };
  }

  if (jsonMode) {
    payload.format = 'json';
  }

  return payload;
}

function parseOllamaText(data) {
  const text = data?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Ollama response did not contain readable text content.');
  }

  return text;
}

async function callOllama(config, promptSpec) {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URLS.ollama;
  const data = await postJson(
    `${baseUrl.replace(/\/$/, '')}/api/chat`,
    ollamaPayload({
      model: config.model,
      systemPrompt: promptSpec.systemPrompt,
      userPrompt: promptSpec.userPrompt,
      temperature: promptSpec.temperature,
      jsonMode: promptSpec.jsonMode
    }),
    {
      'Content-Type': 'application/json'
    },
    promptSpec.timeoutMs
  );

  return parseOllamaText(data);
}

export async function completeWithProvider(config, promptSpec) {
  assertConfig(config);

  const provider = String(config.provider).toLowerCase();
  if (provider === 'openai') {
    return await callOpenAi(config, promptSpec);
  }

  if (provider === 'anthropic' || provider === 'claude') {
    return await callAnthropic(config, promptSpec);
  }

  if (provider === 'ollama') {
    return await callOllama(config, promptSpec);
  }

  throw new Error(`Unsupported provider: ${config.provider}`);
}

export function getProviderDefaults() {
  return {
    openai: {
      provider: 'openai',
      baseUrl: DEFAULT_BASE_URLS.openai,
      modelPlaceholder: 'gpt-5-nano'
    },
    anthropic: {
      provider: 'anthropic',
      baseUrl: DEFAULT_BASE_URLS.anthropic,
      modelPlaceholder: 'claude-3-5-sonnet-latest'
    },
    ollama: {
      provider: 'ollama',
      baseUrl: DEFAULT_BASE_URLS.ollama,
      modelPlaceholder: 'llama3.1:8b'
    }
  };
}
