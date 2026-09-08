export async function streamLLM(prompt, config, onChunk) {
  const { provider, model, apiKey, endpoint } = config;

  if (provider === 'anthropic') {
    return await streamAnthropic(prompt, model, apiKey, onChunk);
  } else if (provider === 'openai' || provider === 'openrouter' || provider === 'custom') {
    let url = endpoint;
    if (provider === 'openai') url = 'https://api.openai.com/v1/chat/completions';
    if (provider === 'openrouter') url = 'https://openrouter.ai/api/v1/chat/completions';
    return await streamOpenAICompatible(prompt, model, apiKey, url, onChunk, provider);
  } else if (provider === 'gemini') {
    return await streamGemini(prompt, model, apiKey, onChunk);
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }
}

async function streamAnthropic(prompt, model, apiKey, onChunk) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
      stream: true
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Anthropic error: ${res.status} ${err.error?.message || res.statusText}`);
  }
  await parseSSE(res.body, (data) => {
    if (data.type === 'content_block_delta' && data.delta?.text) {
      onChunk(data.delta.text);
    }
  });
}

async function streamOpenAICompatible(prompt, model, apiKey, url, onChunk, provider) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/RobertoReale/YT-Transcript-Summarizer';
    headers['X-Title'] = 'YT Transcript Summarizer';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      stream: true
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`${provider} error: ${res.status} ${err.error?.message || res.statusText}`);
  }
  await parseSSE(res.body, (data) => {
    if (data === '[DONE]') return;
    const content = data.choices?.[0]?.delta?.content;
    if (content) onChunk(content);
  });
}

async function streamGemini(prompt, model, apiKey, onChunk) {
  const m = model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini error: ${res.status} ${err.error?.message || res.statusText}`);
  }
  await parseSSE(res.body, (data) => {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) onChunk(text);
  });
}

async function parseSSE(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6).trim();
        if (!dataStr) continue;
        if (dataStr === '[DONE]') {
          onData('[DONE]');
          continue;
        }
        try {
          const data = JSON.parse(dataStr);
          onData(data);
        } catch (e) {
          // ignore incomplete json or other malformed data
        }
      }
    }
  }
}
