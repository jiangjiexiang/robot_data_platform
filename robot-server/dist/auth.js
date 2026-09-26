"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeRobotAuth = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function authSecret(dataRoot) {
    const secretFile = path_1.default.join(dataRoot, ".lerobot-web", "auth-secret");
    const configured = process.env.BETTER_AUTH_SECRET;
    if (configured)
        return configured;
    try {
        const secret = fs_1.default.readFileSync(secretFile, "utf-8").trim();
        if (secret.length >= 32)
            return secret;
    }
    catch {
        // Generate the persistent secret below on first startup.
    }
    fs_1.default.mkdirSync(path_1.default.dirname(secretFile), { recursive: true, mode: 0o700 });
    const secret = crypto_1.default.randomBytes(32).toString("base64url");
    fs_1.default.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
    return secret;
}
function ensureSchema(database) {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" text NOT NULL PRIMARY KEY,
      "name" text NOT NULL,
      "email" text NOT NULL UNIQUE,
      "emailVerified" integer NOT NULL,
      "image" text,
      "createdAt" date NOT NULL,
      "updatedAt" date NOT NULL,
      "role" text
    );
    CREATE TABLE IF NOT EXISTS "session" (
      "id" text NOT NULL PRIMARY KEY,
      "expiresAt" date NOT NULL,
      "token" text NOT NULL UNIQUE,
      "createdAt" date NOT NULL,
      "updatedAt" date NOT NULL,
      "ipAddress" text,
      "userAgent" text,
      "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "account" (
      "id" text NOT NULL PRIMARY KEY,
      "accountId" text NOT NULL,
      "providerId" text NOT NULL,
      "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" date,
      "refreshTokenExpiresAt" date,
      "scope" text,
      "password" text,
      "createdAt" date NOT NULL,
      "updatedAt" date NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "verification" (
      "id" text NOT NULL PRIMARY KEY,
      "identifier" text NOT NULL,
      "value" text NOT NULL,
      "expiresAt" date NOT NULL,
      "createdAt" date NOT NULL,
      "updatedAt" date NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
    CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
    CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
  `);
}
async function initializeRobotAuth(dataRoot, port) {
    const databasePath = process.env.AUTH_DATABASE_PATH || path_1.default.join(dataRoot, ".lerobot-web", "auth.db");
    fs_1.default.mkdirSync(path_1.default.dirname(databasePath), { recursive: true, mode: 0o700 });
    const [betterAuthModule, nodeModule, sqliteModule] = await Promise.all([
        Promise.resolve().then(() => __importStar(require("better-auth"))),
        Promise.resolve().then(() => __importStar(require("better-auth/node"))),
        Promise.resolve().then(() => __importStar(require("better-sqlite3"))),
    ]);
    const Database = sqliteModule.default;
    const database = new Database(databasePath);
    ensureSchema(database);
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        try {
            fs_1.default.chmodSync(file, 0o600);
        }
        catch { /* The WAL files may not exist yet. */ }
    }
    const baseURL = process.env.AUTH_BASE_URL || `http://localhost:${port}`;
    const trustedOrigins = (process.env.AUTH_TRUSTED_ORIGINS || [
        baseURL,
        `http://127.0.0.1:${port}`,
        `http://192.168.5.2:${port}`,
        "https://116.62.235.182:5173",
    ].join(",")).split(",").map((origin) => origin.trim()).filter(Boolean);
    const auth = betterAuthModule.betterAuth({
        database,
        baseURL,
        secret: authSecret(dataRoot),
        trustedOrigins,
        emailAndPassword: { enabled: true, minPasswordLength: 5 },
        user: {
            additionalFields: {
                role: { type: "string", required: false, defaultValue: "viewer", input: false },
            },
        },
        // This deployment is intentionally reachable through changing LAN/IP/FRP
        // origins. Disable Better Auth's origin and CSRF checks so those origins do
        // not fail with "Invalid origin". Authentication and role checks remain
        // enabled by the API middleware in robot-server/src/index.ts.
        advanced: {
            useSecureCookies: false,
            disableOriginCheck: true,
            disableCSRFCheck: true,
        },
    });
    // This project compiles CommonJS while Better Auth publishes ESM declaration
    // files; require keeps the runtime on Better Auth's Node password implementation.
    const { hashPassword } = require("@better-auth/utils/password");
    // This project has one fixed initial administrator.  The email is only an
    // internal Better Auth identifier; the login screen accepts the account name.
    if (Number(database.prepare('SELECT COUNT(*) AS count FROM "user"').get()?.count || 0) === 0) {
        const result = await auth.api.signUpEmail({
            body: { name: "管理员", email: "admin@robot.local", password: "admin" },
        });
        database.prepare('UPDATE "user" SET "role" = ? WHERE "id" = ?').run("admin", result.user.id);
    }
    database.prepare('UPDATE "user" SET "role" = ? WHERE "email" = ?').run("admin", "admin@robot.local");
    return {
        handle: nodeModule.toNodeHandler(auth),
        getSession: (headers) => auth.api.getSession({ headers: nodeModule.fromNodeHeaders(headers) }),
        revokeOtherSessions: (userId, currentSessionId) => database.prepare('DELETE FROM "session" WHERE "userId" = ? AND "id" <> ?').run(userId, currentSessionId).changes,
        userCount: () => Number(database.prepare('SELECT COUNT(*) AS count FROM "user"').get()?.count || 0),
        promoteFirstUser: (userId) => {
            if (Number(database.prepare('SELECT COUNT(*) AS count FROM "user"').get()?.count || 0) !== 1)
                return false;
            return database.prepare('UPDATE "user" SET "role" = ? WHERE "id" = ?').run("admin", userId).changes === 1;
        },
        listUsers: () => {
            const rows = database.prepare('SELECT "id", "name", "email", COALESCE("role", ?) AS "role", "createdAt" FROM "user" ORDER BY "createdAt"').all?.("viewer") || [];
            return rows.map((row) => ({ id: String(row.id), name: String(row.name), email: String(row.email), role: (["viewer", "operator", "admin"].includes(String(row.role)) ? String(row.role) : "viewer"), createdAt: String(row.createdAt) }));
        },
        createUser: async (name, account, password, role) => {
            const email = `${account}@robot.local`;
            const result = await auth.api.signUpEmail({ body: { name, email, password } });
            database.prepare('UPDATE "user" SET "role" = ? WHERE "id" = ?').run(role, result.user.id);
            return result.user;
        },
        updateUserRole: (id, role) => database.prepare('UPDATE "user" SET "role" = ?, "updatedAt" = ? WHERE "id" = ?').run(role, new Date().toISOString(), id).changes === 1,
        resetUserPassword: async (id, password) => {
            const hash = await hashPassword(password);
            const changed = database.prepare('UPDATE "account" SET "password" = ?, "updatedAt" = ? WHERE "userId" = ? AND "providerId" = ?').run(hash, new Date().toISOString(), id, "credential").changes === 1;
            if (changed)
                database.prepare('DELETE FROM "session" WHERE "userId" = ?').run(id);
            return changed;
        },
        deleteUser: (id) => database.prepare('DELETE FROM "user" WHERE "id" = ?').run(id).changes === 1,
    };
}
exports.initializeRobotAuth = initializeRobotAuth;
