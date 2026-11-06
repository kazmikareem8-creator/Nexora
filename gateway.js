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

  app.get("/v1/models", requireDatabase, authenticate, async (req, res) => {
    res.json({ object: "list", data: [], note: "No AI providers are configured yet. Models will appear when a real provider is connected." });
  });

  const routes = [
    { path: "/v1/chat/completions", capability: "text" },
    { path: "/v1/images/generations", capability: "image" },
    { path: "/v1/videos/generations", capability: "video" }
  ];
  for (const route of routes) {
    app.post(route.path, requireDatabase, authenticate, async (req, res) => {
      const started = Date.now();
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      const model = typeof body.model === "string" ? body.model.slice(0, 120) : null;
      const prompt = route.capability === "text"
        ? (Array.isArray(body.messages) && body.messages.some(m => m && typeof m.content === "string" && m.content.trim()) || typeof body.prompt === "string" && body.prompt.trim())
        : typeof body.prompt === "string" && body.prompt.trim();
      if (!prompt) {
        await record(req, route.capability, route.path, model, 400, null, started);
        return res.status(400).json({ error: { code: "invalid_request", message: "Provide a non-empty prompt or valid messages array." } });
      }
      await record(req, route.capability, route.path, model, 503, null, started);
      return res.status(503).json({ error: { code: "provider_not_configured", message: "No provider is currently configured for this capability. Nexora will not return a simulated result." } });
    });
  }
};
