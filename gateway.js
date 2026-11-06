"use strict";

const crypto = require("crypto");

module.exports = function mountGateway(app, pool, requireDatabase) {
  async function authenticate(req, res, next) {
    const header = req.get("authorization") || "";
    const match = /^Bearer (nx_live_[a-f0-9]{64})$/.exec(header);
    if (!match) return res.status(401).json({ error: { code: "invalid_api_key", message: "A valid Nexora bearer API key is required." } });
    try {
      const hash = crypto.createHash("sha256").update(match[1]).digest("hex");
      const result = await pool.query(
        "SELECT k.id AS api_key_id, k.user_id, k.project_id FROM api_keys k JOIN projects p ON p.id=k.project_id AND p.user_id=k.user_id WHERE k.key_hash=$1 AND k.revoked_at IS NULL",
        [hash]
      );
      if (!result.rowCount) return res.status(401).json({ error: { code: "invalid_api_key", message: "The API key is invalid, revoked, or no longer linked to a project." } });
      req.nexora = result.rows[0];
      pool.query("UPDATE api_keys SET last_used_at=NOW() WHERE id=$1", [req.nexora.api_key_id]).catch(() => {});
      next();
    } catch (error) {
      console.error("Gateway authentication failed:", error.message);
      res.status(503).json({ error: { code: "gateway_unavailable", message: "The gateway is temporarily unavailable." } });
    }
  }

  async function record(req, capability, endpoint, model, status, provider, started) {
    try {
      await pool.query(
        "INSERT INTO api_usage(user_id,project_id,api_key_id,capability,endpoint,model,status_code,provider,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [req.nexora.user_id, req.nexora.project_id, req.nexora.api_key_id, capability, endpoint, model || null, status, provider || null, Date.now() - started]
      );
    } catch (error) { console.error("Usage recording failed:", error.message); }
  }

  const geminiModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  // Multiple server-side keys allow fallback when one key is rate-limited or unavailable.
  const geminiKeys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean);
  // Independent Groq fallback (credential stays on the server).
  const groqApiKey = process.env.GROQ_API_KEY;
  const groqModel = process.env.GROQ_TEXT_MODEL || "llama-3.3-70b-versatile";

  app.get("/v1/models", requireDatabase, authenticate, async (_req, res) => {
    const textConfigured = geminiKeys.length > 0 || Boolean(groqApiKey);
    const data = textConfigured
      ? [{ id: "nexora-text", object: "model", owned_by: "nexora", capabilities: ["text"] }]
      : [];
    res.json({ object: "list", data, note: textConfigured ? "Text provider configured; availability depends on upstream service and quota." : "No text provider is configured yet." });
  });

  app.post("/v1/chat/completions", requireDatabase, authenticate, async (req, res) => {
    const started = Date.now();
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const validMessages = messages.filter(m => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.trim());
    if (!validMessages.length && !(typeof body.prompt === "string" && body.prompt.trim())) {
      await record(req, "text", "/v1/chat/completions", body.model, 400, null, started);
      return res.status(400).json({ error: { code: "invalid_request", message: "Provide a non-empty prompt or valid messages array." } });
    }
    if (!geminiKeys.length && !(cfAccountId && cfApiToken)) {
      await record(req, "text", "/v1/chat/completions", body.model, 503, null, started);
      return res.status(503).json({ error: { code: "provider_not_configured", message: "Nexora's text provider is not configured yet." } });
    }

    const systemText = validMessages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const conversational = validMessages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
    if (!conversational.length && typeof body.prompt === "string" && body.prompt.trim()) {
      conversational.push({ role: "user", parts: [{ text: body.prompt.trim() }] });
    }
    const payload = { contents: conversational, generationConfig: {} };
    if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };
    if (Number.isFinite(body.temperature)) payload.generationConfig.temperature = Math.max(0, Math.min(2, body.temperature));
    if (Number.isInteger(body.max_tokens)) payload.generationConfig.maxOutputTokens = Math.max(1, Math.min(8192, body.max_tokens));

    let lastFailure = null;
    for (let i = 0; i < geminiKeys.length; i++) {
      try {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(geminiModel) + ":generateContent", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKeys[i] },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(25000)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          lastFailure = { kind: response.status === 429 ? "rate_limit" : "http", status: response.status };
          console.error("Gemini provider attempt failed:", response.status, result && result.error && result.error.message ? result.error.message : "Unknown provider error");
          if (response.status === 429 || response.status >= 500) continue;
          break;
        }
        const answer = (result.candidates || []).flatMap(c => c.content && c.content.parts || []).map(p => p.text || "").join("").trim();
        if (!answer) { lastFailure = { kind: "empty", status: 502 }; continue; }
        await record(req, "text", "/v1/chat/completions", geminiModel, 200, "google", started);
        return res.json({
          id: "nexora-" + crypto.randomUUID(), object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: typeof body.model === "string" ? body.model : "nexora-text",
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
          usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }
        });
      } catch (error) {
        const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
        lastFailure = { kind: timedOut ? "timeout" : "network", status: timedOut ? 504 : 503 };
        console.error("Gemini provider attempt failed:", timedOut ? "timeout after 25 seconds" : error.name + " " + error.message);
      }
    }
    // Try an independent Groq provider after Gemini keys fail.
    if (groqApiKey) {
      try {
        const groqMessages = validMessages.map(m => ({ role: m.role, content: m.content }));
        if (!groqMessages.length && typeof body.prompt === "string" && body.prompt.trim()) {
          groqMessages.push({ role: "user", content: body.prompt.trim() });
        }
        const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqApiKey },
          body: JSON.stringify({
            model: groqModel,
            messages: groqMessages,
            ...(Number.isFinite(body.temperature) ? { temperature: Math.max(0, Math.min(2, body.temperature)) } : {}),
            ...(Number.isInteger(body.max_tokens) ? { max_tokens: Math.max(1, Math.min(8192, body.max_tokens)) } : {})
          }),
          signal: AbortSignal.timeout(25000)
        });
        const groqResult = await groqResponse.json().catch(() => ({}));
        const groqAnswer = groqResult && groqResult.choices && groqResult.choices[0] &&
          groqResult.choices[0].message && typeof groqResult.choices[0].message.content === "string"
          ? groqResult.choices[0].message.content.trim() : "";
        if (groqResponse.ok && groqAnswer) {
          await record(req, "text", "/v1/chat/completions", groqModel, 200, "groq", started);
          return res.json({
            id: "nexora-" + crypto.randomUUID(), object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: typeof body.model === "string" ? body.model : "nexora-text",
            choices: [{ index: 0, message: { role: "assistant", content: groqAnswer }, finish_reason: "stop" }],
            usage: groqResult.usage || { prompt_tokens: null, completion_tokens: null, total_tokens: null }
          });
        }
        console.error("Groq fallback failed:", groqResponse.status,
          groqResult && groqResult.error ? JSON.stringify(groqResult.error) : "Empty response");
        lastFailure = { kind: groqResponse.status === 429 ? "rate_limit" : "http", status: groqResponse.status || 502 };
      } catch (error) {
        const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
        console.error("Groq fallback failed:", timedOut ? "timeout after 25 seconds" : error.name + " " + error.message);
        lastFailure = { kind: timedOut ? "timeout" : "network", status: timedOut ? 504 : 503 };
      }
    }

    const kind = lastFailure && lastFailure.kind;
    const status = kind === "rate_limit" ? 429 : kind === "timeout" ? 504 : kind === "network" ? 503 : 502;
    const code = kind === "rate_limit" ? "provider_rate_limited" : kind === "timeout" ? "provider_timeout" : kind === "network" ? "provider_unavailable" : "provider_error";
    const message = kind === "rate_limit" ? "All configured text provider keys are rate-limited. Try again later." :
      kind === "timeout" ? "All configured text provider attempts timed out. The upstream provider may be overloaded or unreachable." :
      kind === "network" ? "Nexora could not reach the text provider. Check provider connectivity and try again." :
      "The text provider rejected the request. Check the configured model and API key.";
    await record(req, "text", "/v1/chat/completions", geminiModel, status, "google", started);
    return res.status(status).json({ error: { code, message } });
  });

  const mediaRoutes = [
    { path: "/v1/images/generations", capability: "image" },
    { path: "/v1/videos/generations", capability: "video" }
  ];
  for (const route of mediaRoutes) {
    app.post(route.path, requireDatabase, authenticate, async (req, res) => {
      const started = Date.now();
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        await record(req, route.capability, route.path, body.model, 400, null, started);
        return res.status(400).json({ error: { code: "invalid_request", message: "Provide a non-empty prompt." } });
      }
      await record(req, route.capability, route.path, body.model, 503, null, started);
      return res.status(503).json({ error: { code: "provider_not_configured", message: "No genuinely free provider is connected for this capability yet." } });
    });
  }
};
