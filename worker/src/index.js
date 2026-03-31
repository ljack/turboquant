export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || 'https://ljack.github.io';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(origin, allowed),
      });
    }

    // Origin check
    if (!origin || (origin !== allowed && !origin.startsWith('http://localhost'))) {
      return json({ error: 'Forbidden' }, 403);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin, allowed);
    }

    // Rate limiting by IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateKey = `rate:${ip}`;
    const maxReq = parseInt(env.RATE_LIMIT_MAX) || 20;
    const windowSec = parseInt(env.RATE_LIMIT_WINDOW_SECONDS) || 3600;

    let count = parseInt(await env.RATE_LIMIT.get(rateKey)) || 0;
    if (count >= maxReq) {
      return json(
        { error: `Rate limited. Max ${maxReq} requests per hour.` },
        429, origin, allowed
      );
    }
    await env.RATE_LIMIT.put(rateKey, String(count + 1), { expirationTtl: windowSec });

    // Parse and validate request
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400, origin, allowed);
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: 'messages array required' }, 400, origin, allowed);
    }

    const wantStream = body.stream === true;
    const requestedModel = body.model || 'auto';

    // Cap message count
    const trimmed = messages.slice(-12);

    // Allowed free models (whitelist for safety)
    const allowedModels = [
      'qwen/qwen3.6-plus-preview:free',
      'arcee-ai/trinity-large-preview:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'google/gemma-3-27b-it:free',
      'mistralai/mistral-small-3.2-24b-instruct:free',
      'deepseek/deepseek-r1-0528:free',
      'openrouter/free',
    ];

    // If user picked a specific model, use just that; otherwise fallback chain
    let models;
    if (requestedModel !== 'auto' && allowedModels.includes(requestedModel)) {
      models = [requestedModel];
    } else {
      models = [
        'qwen/qwen3.6-plus-preview:free',
        'arcee-ai/trinity-large-preview:free',
        'meta-llama/llama-3.3-70b-instruct:free',
        'openrouter/free',
      ];
    }

    if (wantStream) {
      return handleStreaming(trimmed, models, env, origin, allowed);
    } else {
      return handleNonStreaming(trimmed, models, env, origin, allowed);
    }
  },
};

async function handleStreaming(messages, models, env, origin, allowed) {
  // Try each model until one streams successfully
  for (const model of models) {
    try {
      const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://ljack.github.io/turboquant/',
          'X-Title': 'TurboQuant Explainer',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 800,
          temperature: 0.7,
          stream: true,
          reasoning: { effort: 'none' },
        }),
      });

      // If rate limited or no endpoints, try next model
      if (orRes.status === 429 || orRes.status === 404) continue;

      if (!orRes.ok) {
        // Try to read error
        try {
          const errData = await orRes.json();
          continue; // try next model
        } catch {
          continue;
        }
      }

      // Pipe the SSE stream through to the client
      const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...corsHeaders(origin, allowed),
      };

      // TransformStream to pass through SSE data
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Pipe upstream SSE to client in background
      const pipePromise = (async () => {
        const reader = orRes.body.getReader();
        const decoder = new TextDecoder();
        let hasContent = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            // Check if we got actual content (not just thinking tokens)
            if (chunk.includes('"content"') && chunk.includes(':')) {
              hasContent = true;
            }
            await writer.write(encoder.encode(chunk));
          }
        } catch (e) {
          // Stream error, close gracefully
        } finally {
          await writer.close();
        }
      })();

      // Don't await — let it stream
      return new Response(readable, { status: 200, headers });
    } catch (e) {
      continue;
    }
  }

  // All models failed — return error as SSE
  const errorSSE = `data: ${JSON.stringify({ error: 'All models unavailable' })}\n\ndata: [DONE]\n\n`;
  return new Response(errorSSE, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      ...corsHeaders(origin, allowed),
    },
  });
}

async function handleNonStreaming(messages, models, env, origin, allowed) {
  for (const model of models) {
    try {
      const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://ljack.github.io/turboquant/',
          'X-Title': 'TurboQuant Explainer',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 800,
          temperature: 0.7,
          reasoning: { effort: 'none' },
        }),
      });

      const data = await orRes.json();

      if (orRes.status === 429 || orRes.status === 404) continue;

      const content = data.choices?.[0]?.message?.content;
      if (orRes.ok && (!content || content.length < 2)) continue;

      if (!orRes.ok) {
        return json(
          { error: data.error?.message || 'OpenRouter API error' },
          orRes.status, origin, allowed
        );
      }

      return json(data, 200, origin, allowed);
    } catch (e) {
      continue;
    }
  }

  return json({ error: 'All models unavailable. Try again shortly.' }, 503, origin, allowed);
}

function corsHeaders(origin, allowed) {
  const effectiveOrigin = origin.startsWith('http://localhost') ? origin : allowed;
  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status, origin, allowed) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin || '', allowed || ''),
    },
  });
}
