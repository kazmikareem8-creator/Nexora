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
        "SELECT k.id AS api_key_id, k.user_id, k.project_id, k.capability FROM api_keys k JOIN projects p ON p.id=k.project_id AND p.user_id=k.user_id WHERE k.key_hash=$1 AND k.revoked_at IS NULL",
        [hash]
      );
      if (!result.rowCount) return res.status(401).json({ error: { code: "invalid_api_key", message: "The API key is invalid, revoked, or no longer linked to a project." } });
      const expectedCapability = req.path.startsWith("/v1/images/") ? "image" : req.path.startsWith("/v1/videos/") ? "video" : "text";
      if (result.rows[0].capability !== expectedCapability) {
        return res.status(403).json({ error: { code: "key_capability_mismatch", message: "This API key is not enabled for the requested capability." } });
      }
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
  const geminiKeys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean);
  const groqApiKey = process.env.GROQ_API_KEY;
  // Use a currently supported Groq model by default; override only with a model enabled for this key.
  const groqModel = process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-20b";

  app.get("/v1/models", requireDatabase, authenticate, async (_req, res) => {
    const textConfigured = geminiKeys.length > 0 || Boolean(groqApiKey);
    const data = textConfigured ? [{ id: "nexora-text", object: "model", owned_by: "nexora", capabilities: ["text"] }] : [];
    res.json({ object: "list", data, note: textConfigured ? "Text provider configured; availability depends on upstream service and quota." : "No text provider is configured yet." });
  });

  app.post("/v1/chat/completions", requireDatabase, authenticate, async (req, res) => {
    const started = Date.now();
    const requestId = "nxreq-" + crypto.randomUUID();
    res.setHeader("X-Nexora-Request-Id", requestId);
    console.log("Nexora text request started:", requestId);
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const validMessages = messages.filter(m => m && ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.trim());
    if (!validMessages.length && !(typeof body.prompt === "string" && body.prompt.trim())) {
      await record(req, "text", "/v1/chat/completions", body.model, 400, null, started);
      return res.status(400).json({ error: { code: "invalid_request", message: "Provide a non-empty prompt or valid messages array." } });
    }
    if (!geminiKeys.length && !groqApiKey) {
      await record(req, "text", "/v1/chat/completions", body.model, 503, null, started);
      return res.status(503).json({ error: { code: "provider_not_configured", message: "Nexora's text provider is not configured yet." } });
    }

    const systemText = validMessages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const conversational = validMessages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
    if (!conversational.length && typeof body.prompt === "string" && body.prompt.trim()) conversational.push({ role: "user", parts: [{ text: body.prompt.trim() }] });
    const payload = { contents: conversational, generationConfig: {} };
    if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };
    if (Number.isFinite(body.temperature)) payload.generationConfig.temperature = Math.max(0, Math.min(2, body.temperature));
    if (Number.isInteger(body.max_tokens)) payload.generationConfig.maxOutputTokens = Math.max(1, Math.min(8192, body.max_tokens));

    let lastFailure = null;
    for (const key of geminiKeys) {
      try {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(geminiModel) + ":generateContent", {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(20000)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          lastFailure = { kind: response.status === 429 ? "rate_limit" : "http", status: response.status };
          console.error("Gemini provider attempt failed:", requestId, response.status, result?.error?.message || "Unknown provider error");
          if (response.status === 429 || response.status >= 500) continue;
          break;
        }
        const answer = (result.candidates || []).flatMap(c => c.content?.parts || []).map(p => p.text || "").join("").trim();
        if (!answer) { lastFailure = { kind: "empty", status: 502 }; continue; }
        await record(req, "text", "/v1/chat/completions", geminiModel, 200, "google", started);
        return res.json({ id: "nexora-" + crypto.randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model: typeof body.model === "string" ? body.model : "nexora-text", choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } });
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        lastFailure = { kind: timedOut ? "timeout" : "network", status: timedOut ? 504 : 503 };
        console.error("Gemini provider attempt failed:", requestId, timedOut ? "timeout after 20 seconds" : error.name + " " + error.message);
      }
    }

    if (groqApiKey) {
      console.log("Nexora trying Groq fallback:", requestId);
      try {
        const groqMessages = validMessages.map(m => ({ role: m.role, content: m.content }));
        if (!groqMessages.length && typeof body.prompt === "string" && body.prompt.trim()) groqMessages.push({ role: "user", content: body.prompt.trim() });
        const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqApiKey },
          body: JSON.stringify({ model: groqModel, messages: groqMessages, ...(Number.isFinite(body.temperature) ? { temperature: Math.max(0, Math.min(2, body.temperature)) } : {}), ...(Number.isInteger(body.max_tokens) ? { max_tokens: Math.max(1, Math.min(8192, body.max_tokens)) } : {}) }),
          signal: AbortSignal.timeout(20000)
        });
        const groqResult = await groqResponse.json().catch(() => ({}));
        const groqAnswer = groqResult?.choices?.[0]?.message?.content;
        if (groqResponse.ok && typeof groqAnswer === "string" && groqAnswer.trim()) {
          await record(req, "text", "/v1/chat/completions", groqModel, 200, "groq", started);
          console.log("Nexora text request succeeded:", requestId, "provider=groq");
          return res.json({ id: "nexora-" + crypto.randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model: typeof body.model === "string" ? body.model : "nexora-text", choices: [{ index: 0, message: { role: "assistant", content: groqAnswer.trim() }, finish_reason: "stop" }], usage: groqResult.usage || { prompt_tokens: null, completion_tokens: null, total_tokens: null } });
        }
        console.error("Groq fallback failed:", requestId, groqResponse.status, groqResult?.error ? JSON.stringify(groqResult.error) : "Empty response");
        lastFailure = { kind: groqResponse.status === 429 ? "rate_limit" : "http", status: groqResponse.status || 502 };
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        console.error("Groq fallback failed:", requestId, timedOut ? "timeout after 20 seconds" : error.name + " " + error.message);
        lastFailure = { kind: timedOut ? "timeout" : "network", status: timedOut ? 504 : 503 };
      }
    }

    const kind = lastFailure?.kind;
    const status = kind === "rate_limit" ? 429 : kind === "timeout" ? 504 : kind === "network" ? 503 : 502;
    const code = kind === "rate_limit" ? "provider_rate_limited" : kind === "timeout" ? "provider_timeout" : kind === "network" ? "provider_unavailable" : "provider_error";
    const message = kind === "rate_limit" ? "All configured text provider keys are rate-limited. Try again later." :
      kind === "timeout" ? "All configured text provider attempts timed out. The upstream provider may be overloaded or unreachable." :
      kind === "network" ? "Nexora could not reach the text provider. Check provider connectivity and try again." :
      "The text provider rejected the request. Check the configured model and API key.";
    await record(req, "text", "/v1/chat/completions", "nexora-text", status, "gateway", started);
    console.error("Nexora text request failed:", requestId, code);
    return res.status(status).json({ error: { code, message, request_id: requestId } });
  });

  // Image generation uses an OpenAI-compatible upstream provider.
  // Configure IMAGE_API_BASE_URL, IMAGE_API_KEY and IMAGE_MODEL on the server.
  const imageBaseUrl = (process.env.IMAGE_API_BASE_URL || "").replace(/\/+$/, "");
  const imageApiKey = process.env.IMAGE_API_KEY || "";
  const imageModel = process.env.IMAGE_MODEL || "";
  const imageConfigured = Boolean(imageBaseUrl && imageApiKey && imageModel);

  app.post("/v1/images/generations", requireDatabase, authenticate, async (req, res) => {
    const started = Date.now();
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const count = body.n === undefined ? 1 : Number(body.n);
    const size = body.size === undefined ? "1024x1024" : body.size;
    if (!prompt || prompt.length > 4000 || !Number.isInteger(count) || count < 1 || count > 4 ||
        typeof size !== "string" || !/^\d{2,4}x\d{2,4}$/.test(size)) {
      await record(req, "image", "/v1/images/generations", body.model, 400, null, started);
      return res.status(400).json({ error: { code: "invalid_request", message: "Provide a prompt (up to 4,000 characters), n between 1 and 4, and a size such as 1024x1024." } });
    }
    if (!imageConfigured) {
      await record(req, "image", "/v1/images/generations", body.model, 503, null, started);
      return res.status(503).json({ error: { code: "provider_not_configured", message: "Image generation is not configured. Set IMAGE_API_BASE_URL, IMAGE_API_KEY and IMAGE_MODEL on the Nexora server." } });
    }
    try {
      const upstream = await fetch(imageBaseUrl + "/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + imageApiKey },
        body: JSON.stringify({
          model: imageModel,
          prompt,
          n: count,
          size,
          ...(body.response_format === "b64_json" ? { response_format: "b64_json" } : { response_format: "url" })
        }),
        signal: AbortSignal.timeout(90000)
      });
      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 400;
        await record(req, "image", "/v1/images/generations", imageModel, status, "openai-compatible", started);
        console.error("Nexora image provider rejected request:", upstream.status, result?.error?.message || "Unknown provider error");
        return res.status(status).json({ error: { code: upstream.status === 429 ? "provider_rate_limited" : "provider_error", message: "The configured image provider could not complete this request. Check its model access, quota and configuration." } });
      }
      if (!Array.isArray(result.data) || !result.data.length ||
          result.data.some(item => !item || (typeof item.url !== "string" && typeof item.b64_json !== "string"))) {
        await record(req, "image", "/v1/images/generations", imageModel, 502, "openai-compatible", started);
        return res.status(502).json({ error: { code: "invalid_provider_response", message: "The image provider returned an unsupported response. It must return data items containing url or b64_json." } });
      }
      await record(req, "image", "/v1/images/generations", imageModel, 200, "openai-compatible", started);
      return res.json({
        created: Number.isInteger(result.created) ? result.created : Math.floor(Date.now() / 1000),
        data: result.data.slice(0, count).map(item => ({
          ...(typeof item.url === "string" ? { url: item.url } : {}),
          ...(typeof item.b64_json === "string" ? { b64_json: item.b64_json } : {})
        }))
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      const status = timedOut ? 504 : 503;
      await record(req, "image", "/v1/images/generations", imageModel, status, "openai-compatible", started);
      console.error("Nexora image provider request failed:", timedOut ? "timeout after 90 seconds" : error.name + " " + error.message);
      return res.status(status).json({ error: { code: timedOut ? "provider_timeout" : "provider_unavailable", message: timedOut ? "The image provider took too long to respond." : "Nexora could not reach the configured image provider." } });
    }
  });

  // Video generation uses fal.ai's asynchronous queue API.
  const videoProviderKey = process.env.VIDEO_API_KEY || "";
  const videoEndpoint = process.env.VIDEO_MODEL || "minimax/h3-max-turbo/text-to-video";
  const videoConfigured = Boolean(videoProviderKey);
  const videoQueueBase = "https://queue.fal.run/";

  app.post("/v1/videos/generations", requireDatabase, authenticate, async (req, res) => {
    const started = Date.now();
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const duration = body.duration === undefined ? 5 : Number(body.duration);
    const resolution = body.resolution === undefined ? "768P" : body.resolution;
    const aspectRatio = body.aspect_ratio === undefined ? "16:9" : body.aspect_ratio;
    const expansion = body.prompt_expansion_mode === undefined ? "balanced" : body.prompt_expansion_mode;
    if (!prompt || prompt.length > 50000 || !Number.isFinite(duration) || duration < 0.92 || duration > 15 ||
        !["480P","768P","1080P"].includes(resolution) ||
        !["21:9","16:9","4:3","1:1","3:4","9:16"].includes(aspectRatio) ||
        !["disabled","balanced","quality"].includes(expansion)) {
      await record(req, "video", "/v1/videos/generations", videoEndpoint, 400, null, started);
      return res.status(400).json({ error: { code: "invalid_request", message: "Provide a prompt (up to 50,000 characters), duration 0.92–15 seconds, resolution 480P/768P/1080P, a supported aspect_ratio, and prompt_expansion_mode disabled/balanced/quality." } });
    }
    if (!videoConfigured) {
      await record(req, "video", "/v1/videos/generations", videoEndpoint, 503, null, started);
      return res.status(503).json({ error: { code: "provider_not_configured", message: "Video generation is not configured. Set VIDEO_API_KEY in the Nexora server environment." } });
    }
    try {
      const upstream = await fetch(videoQueueBase + videoEndpoint, {
        method: "POST",
        headers: { "Authorization": "Key " + videoProviderKey, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, duration, resolution, aspect_ratio: aspectRatio, prompt_expansion_mode: expansion, enable_safety_checker: true }),
        signal: AbortSignal.timeout(30000)
      });
      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok || typeof result.request_id !== "string") {
        const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 502;
        await record(req, "video", "/v1/videos/generations", videoEndpoint, status, "fal.ai", started);
        console.error("Nexora video provider rejected request:", upstream.status, result?.detail || result?.message || "Unknown provider error");
        return res.status(status).json({ error: { code: upstream.status === 429 ? "provider_rate_limited" : "provider_error", message: "The video provider could not accept this job. Check provider access, credits and configuration." } });
      }
      const job = await pool.query(
        "INSERT INTO video_jobs(user_id,project_id,api_key_id,provider,model,provider_request_id,status,created_at,updated_at) VALUES($1,$2,$3,'fal.ai',$4,$5,'IN_QUEUE',NOW(),NOW()) RETURNING id,status,created_at",
        [req.nexora.user_id, req.nexora.project_id, req.nexora.api_key_id, videoEndpoint, result.request_id]
      );
      await record(req, "video", "/v1/videos/generations", videoEndpoint, 202, "fal.ai", started);
      return res.status(202).json({ id: String(job.rows[0].id), object: "video.job", status: "IN_QUEUE", model: videoEndpoint, status_url: "/v1/videos/" + job.rows[0].id, created_at: job.rows[0].created_at });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      await record(req, "video", "/v1/videos/generations", videoEndpoint, timedOut ? 504 : 503, "fal.ai", started);
      console.error("Nexora video submission failed:", timedOut ? "timeout" : error.name + " " + error.message);
      return res.status(timedOut ? 504 : 503).json({ error: { code: timedOut ? "provider_timeout" : "provider_unavailable", message: "Nexora could not submit the video job to fal.ai." } });
    }
  });

  app.get("/v1/videos/:id", requireDatabase, authenticate, async (req, res) => {
    if (!/^[1-9][0-9]*$/.test(req.params.id) || req.params.id.length > 18) {
      return res.status(400).json({ error: { code: "invalid_request", message: "A valid video job ID is required." } });
    }
    const started = Date.now();
    try {
      const found = await pool.query("SELECT id,provider_request_id,model,status,video_url,error_message,created_at,updated_at FROM video_jobs WHERE id=$1 AND user_id=$2 AND project_id=$3 AND api_key_id=$4", [req.params.id,req.nexora.user_id,req.nexora.project_id,req.nexora.api_key_id]);
      if (!found.rowCount) return res.status(404).json({ error: { code: "video_job_not_found", message: "This video job was not found for this API key and project." } });
      const job = found.rows[0];
      if (job.status === "COMPLETED" || job.status === "FAILED") {
        return res.json({ id:String(job.id),object:"video.job",status:job.status,model:job.model,video_url:job.video_url,error:job.error_message,created_at:job.created_at,updated_at:job.updated_at });
      }
      const statusResponse = await fetch(videoQueueBase + videoEndpoint + "/requests/" + encodeURIComponent(job.provider_request_id) + "/status", {
        headers: { "Authorization": "Key " + videoProviderKey },
        signal: AbortSignal.timeout(15000)
      });
      const statusData = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error("fal.ai status lookup failed with HTTP " + statusResponse.status);
      let status = statusData.status || job.status;
      let videoUrl = null;
      let errorMessage = null;
      if (status === "COMPLETED") {
        const resultResponse = await fetch(videoQueueBase + videoEndpoint + "/requests/" + encodeURIComponent(job.provider_request_id), {
          headers: { "Authorization": "Key " + videoProviderKey },
          signal: AbortSignal.timeout(20000)
        });
        const output = await resultResponse.json().catch(() => ({}));
        if (!resultResponse.ok) throw new Error("fal.ai result lookup failed with HTTP " + resultResponse.status);
        videoUrl = output.video?.url || output.video_url || null;
        if (!videoUrl) { status = "FAILED"; errorMessage = "The provider completed the job but returned no video URL."; }
      } else if (status === "FAILED") {
        errorMessage = "The video provider reported that generation failed.";
      }
      await pool.query("UPDATE video_jobs SET status=$1,video_url=$2,error_message=$3,updated_at=NOW() WHERE id=$4", [status,videoUrl,errorMessage,job.id]);
      if (status === "COMPLETED" || status === "FAILED") {
        await record(req, "video", "/v1/videos/" + req.params.id, job.model, status === "COMPLETED" ? 200 : 502, "fal.ai", started);
      }
      return res.json({ id:String(job.id),object:"video.job",status,model:job.model,video_url:videoUrl,error:errorMessage,created_at:job.created_at,updated_at:new Date().toISOString() });
    } catch (error) {
      console.error("Nexora video status lookup failed:", error.message);
      return res.status(503).json({ error: { code: "provider_unavailable", message: "Could not retrieve the video job status. Try again shortly." } });
    }
  });
};
