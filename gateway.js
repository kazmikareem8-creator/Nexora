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
  const geminiKey = process.env.GEMINI_API_KEY;

  app.get("/v1/models", requireDatabase, authenticate, async (_req, res) => {
    const data = geminiKey
      ? [{ id: "nexora-text", object: "model", owned_by: "google", capabilities: ["text"] }]
      : [];
    res.json({ object: "list", data, note: geminiKey ? "Text generation is available through Nexora." : "No text provider is configured yet." });
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
    if (!geminiKey) {
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

    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(geminiModel) + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify(payload),
        // Allow slower free-tier responses more time before aborting.
        signal: AbortSignal.timeout(90000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = response.status === 429 ? 429 : response.status >= 500 ? 503 : 502;
        await record(req, "text", "/v1/chat/completions", geminiModel, status, "google", started);
        console.error("Gemini provider error:", response.status, result && result.error && result.error.message ? result.error.message : "Unknown provider error");
        return res.status(status).json({ error: { code: response.status === 429 ? "provider_rate_limited" : "provider_error", message: response.status === 429 ? "The text provider quota or rate limit was reached. Try again later." : "The text provider returned an error. Check provider configuration and try again." } });
      }
      const answer = (result.candidates || []).flatMap(c => c.content && c.content.parts || []).map(p => p.text || "").join("").trim();
      if (!answer) {
        await record(req, "text", "/v1/chat/completions", geminiModel, 502, "google", started);
        return res.status(502).json({ error: { code: "empty_provider_response", message: "The text provider returned no text. Try a different prompt." } });
      }
      await record(req, "text", "/v1/chat/completions", geminiModel, 200, "google", started);
      return res.json({
        id: "nexora-" + crypto.randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: typeof body.model === "string" ? body.model : "nexora-text",
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }
      });
    } catch (error) {
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      const status = timedOut ? 504 : 503;
      await record(req, "text", "/v1/chat/completions", geminiModel, status, "google", started);
      console.error("Gemini request failed:", timedOut ? "provider request timed out after 90 seconds" : error.name + " " + error.message);
      return res.status(status).json({ error: { code: timedOut ? "provider_timeout" : "provider_unavailable", message: timedOut ? "The text provider did not respond within 90 seconds. Try again shortly; the provider may be slow or overloaded." : "Nexora could not reach the text provider. Please try again shortly." } });
    }
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
