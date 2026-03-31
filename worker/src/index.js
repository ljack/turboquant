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

    // Cap message count and token usage
    const trimmed = messages.slice(-12);

    // Proxy to OpenRouter
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
          model: 'openrouter/free',
          messages: trimmed,
          max_tokens: 512,
          temperature: 0.7,
        }),
      });

      const data = await orRes.json();

      if (!orRes.ok) {
        return json(
          { error: data.error?.message || 'OpenRouter API error' },
          orRes.status, origin, allowed
        );
      }

      return json(data, 200, origin, allowed);
    } catch (e) {
      return json({ error: 'Upstream error' }, 502, origin, allowed);
    }
  },
};

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
