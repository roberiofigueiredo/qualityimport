const crypto = require('crypto');
const { nowIso } = require('./dates');

const SESSION_COOKIE = 'qi_sessao';
const SESSION_DAYS = 7;
const TOKEN_HOURS = { convite: 72, redefinicao: 2 };

function sha256(v) {
  return crypto.createHash('sha256').update(v).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

/** Regras mínimas de senha. Retorna mensagem de erro ou null. */
function passwordProblem(pw) {
  if (!pw || pw.length < 8) return 'A senha deve ter pelo menos 8 caracteres.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'A senha deve conter letras e números.';
  return null;
}

function createSession(db, userId, userAgent) {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    randomToken(18),
    now.toISOString(),
    expires.toISOString(),
    (userAgent || '').slice(0, 200)
  );
  return token;
}

/** Busca sessão válida + usuário ATIVO. Conta desativada = sessão inválida na hora. */
function loadSession(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.id sid, s.csrf, s.expires_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`
    )
    .get(sha256(token));
  if (!row) return null;
  if (row.expires_at < nowIso() || row.status !== 'ativo') {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.sid);
    return null;
  }
  const { sid, csrf, expires_at, password_hash, ...user } = row;
  return { sid, csrf, user };
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

function destroyUserSessions(db, userId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

function createPasswordToken(db, userId, kind) {
  const token = randomToken();
  const now = new Date();
  // invalida tokens anteriores do mesmo tipo
  db.prepare('UPDATE password_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL').run(now.toISOString(), userId, kind);
  db.prepare('INSERT INTO password_tokens (id, user_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    kind,
    new Date(now.getTime() + TOKEN_HOURS[kind] * 3600000).toISOString(),
    now.toISOString()
  );
  return token;
}

function findPasswordToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT t.*, u.name, u.email, u.status FROM password_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?`
    )
    .get(sha256(token));
  if (!row || row.used_at || row.expires_at < nowIso() || row.status === 'desativado') return null;
  return row;
}

// Limite simples de tentativas de login (memória do processo)
const attempts = new Map();
function tooManyAttempts(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60000) {
    attempts.delete(key);
    return false;
  }
  return a.count >= 10;
}
function registerFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > 15 * 60000) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}
function clearFailures(key) {
  attempts.delete(key);
}

module.exports = {
  SESSION_COOKIE,
  SESSION_DAYS,
  sha256,
  randomToken,
  hashPassword,
  verifyPassword,
  passwordProblem,
  createSession,
  loadSession,
  destroySession,
  destroyUserSessions,
  createPasswordToken,
  findPasswordToken,
  tooManyAttempts,
  registerFailure,
  clearFailures,
};
