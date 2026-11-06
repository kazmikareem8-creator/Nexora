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
  res.json({
    status: "online",
    name: "Nexora",
    stage: "day-two-authentication",
    database: databaseReady ? "connected" : "unavailable",
    aiGatewayReady: false
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
