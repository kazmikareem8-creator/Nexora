const express = require("express");
const path = require("path");
const session = require("express-session");
const pg = require("pg");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const { rateLimit } = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isProduction ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

let databaseReady = false;
let databaseError = null;

async function initializeDatabase() {
  if (!pool) {
    databaseError = "DATABASE_URL is not configured";
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        email VARCHAR(254) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name VARCHAR(40) NOT NULL DEFAULT 'Creator',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(80) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
        name VARCHAR(80) NOT NULL,
        key_prefix VARCHAR(24) NOT NULL,
        key_hash CHAR(64) NOT NULL UNIQUE,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      )
    `);
    await pool.query(`CREATE TABLE IF NOT EXISTS api_usage (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, api_key_id BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE, capability VARCHAR(16) NOT NULL, endpoint VARCHAR(120) NOT NULL, model VARCHAR(120), status_code INTEGER NOT NULL, provider VARCHAR(80), duration_ms INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query("CREATE INDEX IF NOT EXISTS api_usage_user_created_idx ON api_usage(user_id, created_at DESC)");
    databaseReady = true;
    databaseError = null;
    console.log("Nexora database initialized");
  } catch (error) {
    databaseReady = false;
    databaseError = error.message;
    console.error("Database initialization failed:", error.message);
  }
}

if (pool) {
  app.use(session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true,
      pruneSessionInterval: 15 * 60
    }),
    name: "nexora.sid",
    secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  }));
} else {
  app.use((req, _res, next) => { req.session = null; next(); });
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait 15 minutes and try again." }
});

function requireDatabase(_req, res, next) {
  if (!pool || !databaseReady) {
    return res.status(503).json({
      error: "Nexora account services are temporarily unavailable. Please try again shortly."
    });
  }
  next();
}

function validEmail(value) {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    createdAt: user.created_at
  };
}

app.get("/api/health", (_req, res) => {
  const textProviderConfigured = Boolean(
    process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2 ||
    process.env.GEMINI_API_KEY_3 || process.env.GROQ_API_KEY
  );
  res.json({
    status: "online",
    name: "Nexora",
    stage: "day-five-text-gateway",
    database: databaseReady ? "connected" : "unavailable",
    aiGatewayReady: true,
    capabilities: {
      text: textProviderConfigured ? "configured" : "not_configured",
      image: "not_configured",
      video: "not_configured"
    }
  });
});

app.post("/api/auth/register", authLimiter, requireDatabase, async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = req.body.password;
  const displayName = typeof req.body.displayName === "string"
    ? req.body.displayName.trim().slice(0, 40) : "Creator";

  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (typeof password !== "string" || password.length < 10 || password.length > 72) {
    return res.status(400).json({ error: "Use a password between 10 and 72 characters." });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at",
      [email, passwordHash, displayName || "Creator"]
    );
    req.session.userId = result.rows[0].id;
    req.session.save(error => {
      if (error) return res.status(500).json({ error: "Account created, but sign-in could not be saved. Please sign in." });
      res.status(201).json({ user: publicUser(result.rows[0]) });
    });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "An account with this email already exists." });
    console.error("Registration failed:", error.message);
    res.status(500).json({ error: "Could not create your account. Please try again." });
  }
});

app.post("/api/auth/login", authLimiter, requireDatabase, async (req, res) => {
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = req.body.password;
  if (!validEmail(email) || typeof password !== "string") {
    return res.status(400).json({ error: "Enter your email and password." });
  }
  try {
    const result = await pool.query(
      "SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1",
      [email]
    );
    const user = result.rows[0];
    const matches = user && await bcrypt.compare(password, user.password_hash);
    if (!matches) return res.status(401).json({ error: "Email or password is incorrect." });

    req.session.regenerate(error => {
      if (error) return res.status(500).json({ error: "Could not start your session. Please try again." });
      req.session.userId = user.id;
      req.session.save(saveError => {
        if (saveError) return res.status(500).json({ error: "Could not save your session. Please try again." });
        res.json({ user: publicUser(user) });
      });
    });
  } catch (error) {
    console.error("Login failed:", error.message);
    res.status(500).json({ error: "Sign-in failed. Please try again." });
  }
});

app.get("/api/auth/me", requireDatabase, async (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ user: null });
  try {
    const result = await pool.query(
      "SELECT id, email, display_name, created_at FROM users WHERE id = $1",
      [req.session.userId]
    );
    if (!result.rows[0]) {
      req.session.destroy(() => {});
      return res.json({ user: null });
    }
    res.json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    console.error("Session lookup failed:", error.message);
    res.status(500).json({ error: "Could not load your account." });
  }
});

app.post("/api/auth/logout", requireDatabase, (req, res) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy(error => {
    if (error) return res.status(500).json({ error: "Could not sign out. Please try again." });
    res.clearCookie("nexora.sid", {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax"
    });
    res.json({ ok: true });
  });
});


function validId(value){return typeof value==="string" && /^[1-9][0-9]*$/.test(value) && value.length<=18;}

function requireUser(req,res,next){
  if(!req.session || !req.session.userId) return res.status(401).json({error:"Please sign in to continue."});
  next();
}
app.get("/api/projects", requireDatabase, requireUser, async (req,res)=>{
  try { const r=await pool.query("SELECT p.id,p.name,p.description,p.created_at,COUNT(k.id)::int AS key_count FROM projects p LEFT JOIN api_keys k ON k.project_id=p.id AND k.user_id=p.user_id WHERE p.user_id=$1 GROUP BY p.id ORDER BY p.created_at DESC",[req.session.userId]); res.json({projects:r.rows}); }
  catch(e){ console.error("Projects load failed:",e.message); res.status(500).json({error:"Could not load projects."});}
});
app.post("/api/projects", requireDatabase, requireUser, async (req,res)=>{
  const name=typeof req.body.name==="string"?req.body.name.trim().slice(0,80):"";
  const description=typeof req.body.description==="string"?req.body.description.trim().slice(0,500):"";
  if(!name) return res.status(400).json({error:"Enter a project name."});
  try {const r=await pool.query("INSERT INTO projects(user_id,name,description) VALUES($1,$2,$3) RETURNING id,name,description,created_at",[req.session.userId,name,description]);res.status(201).json({project:r.rows[0]});}
  catch(e){console.error("Project create failed:",e.message);res.status(500).json({error:"Could not create project."});}
});
app.get("/api/projects/:id", requireDatabase, requireUser, async (req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({error:"Invalid project ID."});
  try {const r=await pool.query("SELECT p.id,p.name,p.description,p.created_at,COUNT(k.id)::int AS key_count FROM projects p LEFT JOIN api_keys k ON k.project_id=p.id AND k.user_id=p.user_id WHERE p.id=$1 AND p.user_id=$2 GROUP BY p.id",[req.params.id,req.session.userId]);if(!r.rowCount)return res.status(404).json({error:"Project not found."});res.json({project:r.rows[0]});}
  catch(e){console.error("Project detail failed:",e.message);res.status(500).json({error:"Could not load project."});}
});
app.patch("/api/projects/:id", requireDatabase, requireUser, async (req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({error:"Invalid project ID."});
  const hasName=Object.prototype.hasOwnProperty.call(req.body,"name"),hasDescription=Object.prototype.hasOwnProperty.call(req.body,"description");
  if(!hasName&&!hasDescription)return res.status(400).json({error:"No project changes were supplied."});
  const name=hasName&&typeof req.body.name==="string"?req.body.name.trim().slice(0,80):null;
  const description=hasDescription&&typeof req.body.description==="string"?req.body.description.trim().slice(0,500):null;
  if(hasName&&!name)return res.status(400).json({error:"Project name cannot be empty."});
  if((hasName&&typeof req.body.name!=="string")||(hasDescription&&typeof req.body.description!=="string"))return res.status(400).json({error:"Invalid project details."});
  try {const r=await pool.query("UPDATE projects SET name=COALESCE($1,name),description=COALESCE($2,description) WHERE id=$3 AND user_id=$4 RETURNING id,name,description,created_at",[name,description,req.params.id,req.session.userId]);if(!r.rowCount)return res.status(404).json({error:"Project not found."});res.json({project:r.rows[0]});}
  catch(e){console.error("Project update failed:",e.message);res.status(500).json({error:"Could not update project."});}
});
app.delete("/api/projects/:id", requireDatabase, requireUser, async (req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({error:"Invalid project ID."});
  try {const r=await pool.query("DELETE FROM projects WHERE id=$1 AND user_id=$2",[req.params.id,req.session.userId]);if(!r.rowCount)return res.status(404).json({error:"Project not found."});res.json({ok:true});}
  catch(e){console.error("Project delete failed:",e.message);res.status(500).json({error:"Could not delete project."});}
});
app.get("/api/keys", requireDatabase, requireUser, async (req,res)=>{
  try {const r=await pool.query("SELECT k.id,k.name,k.key_prefix,k.project_id,p.name AS project_name,k.created_at,k.last_used_at,k.revoked_at FROM api_keys k LEFT JOIN projects p ON p.id=k.project_id WHERE k.user_id=$1 ORDER BY k.created_at DESC",[req.session.userId]);res.json({keys:r.rows});}
  catch(e){console.error("API keys load failed:",e.message);res.status(500).json({error:"Could not load API keys."});}
});
app.post("/api/keys", requireDatabase, requireUser, async (req,res)=>{
  const name=typeof req.body.name==="string"?req.body.name.trim().slice(0,80):"";
  const projectId=typeof req.body.projectId==="string"?req.body.projectId:"";
  if(!name)return res.status(400).json({error:"Enter a name for this API key."});
  if(!validId(projectId))return res.status(400).json({error:"Choose a valid project for this API key."});
  try {
    const project=await pool.query("SELECT id FROM projects WHERE id=$1 AND user_id=$2",[projectId,req.session.userId]);
    if(!project.rowCount)return res.status(404).json({error:"Project not found in your account."});
    const crypto=require("crypto");
    const raw="nx_live_"+crypto.randomBytes(32).toString("hex");
    const hash=crypto.createHash("sha256").update(raw).digest("hex");
    const prefix=raw.slice(0,16);
    const r=await pool.query("INSERT INTO api_keys(user_id,project_id,name,key_prefix,key_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,name,project_id,key_prefix,created_at",[req.session.userId,projectId,name,prefix,hash]);
    res.status(201).json({key:r.rows[0],secret:raw});
  } catch(e){console.error("API key create failed:",e.message);res.status(500).json({error:"Could not create API key."});}
});
app.post("/api/keys/:id/revoke", requireDatabase, requireUser, async (req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({error:"Invalid API key ID."});
  try {const r=await pool.query("UPDATE api_keys SET revoked_at=NOW() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id",[req.params.id,req.session.userId]);if(!r.rowCount)return res.status(404).json({error:"Active API key not found."});res.json({ok:true});}
  catch(e){console.error("API key revoke failed:",e.message);res.status(500).json({error:"Could not revoke API key."});}
});

app.get("/api/usage", requireDatabase, requireUser, async (req,res)=>{
  try {
    const [summary, recent] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int AS today,
        COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300)::int AS successful,
        COUNT(*) FILTER (WHERE status_code >= 400)::int AS failed
        FROM api_usage WHERE user_id=$1`, [req.session.userId]),
      pool.query(`SELECT u.id,u.capability,u.endpoint,u.model,u.status_code,u.provider,u.duration_ms,u.created_at,p.name AS project_name
        FROM api_usage u JOIN projects p ON p.id=u.project_id
        WHERE u.user_id=$1 ORDER BY u.created_at DESC LIMIT 10`, [req.session.userId])
    ]);
    res.json({summary:summary.rows[0],recent:recent.rows});
  } catch(e) {
    console.error("Usage load failed:",e.message);
    res.status(500).json({error:"Could not load API usage."});
  }
});

// Public API CORS: allow external apps and API clients to call Nexora.
app.use("/v1", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

require("./gateway")(app, pool, requireDatabase);

app.use("/v1", (_req,res)=>res.status(404).json({error:{code:"not_found",message:"Nexora API route not found."}}));
app.use("/api", (_req,res)=>res.status(404).json({error:"API route not found."}));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Nexora is running on port ${PORT}`);
  initializeDatabase();
});

process.on("SIGTERM", async () => {
  if (pool) await pool.end();
  process.exit(0);
});
