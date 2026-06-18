import { getDb } from '../db.js';
import { createHash, timingSafeEqual } from 'crypto';
import { createHmac } from 'crypto';

// ── Utilitários JWT minimalista (sem dependência externa) ────────────────────
// Usa HMAC-SHA256. Compatível com Vercel Edge/Node sem instalar jsonwebtoken.

const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-em-producao';
const TOKEN_TTL  = 7 * 24 * 60 * 60; // 7 dias em segundos

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}
function b64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function signJwt(payload) {
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL }));
  const sig     = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    // Comparação segura contra timing attacks
    const sigBuf = Buffer.from(sig,      'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(b64urlDecode(body));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expirado
    return payload;
  } catch {
    return null;
  }
}

// ── Hash de senha com SHA-256 + salt (sem bcrypt para evitar deps nativas) ───
// Para produção com bcrypt instalado, substitua estas funções.
function hashPassword(password, salt) {
  return createHash('sha256').update(salt + password + JWT_SECRET).digest('hex');
}
function generateSalt() {
  return createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 32);
}

// ── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    const db    = await getDb();
    const users = db.collection('users');

    // ── GET /api/auth?action=me ── verifica token atual ──────────────────────
    if (req.method === 'GET' && action === 'me') {
      const token   = extractToken(req);
      const payload = token ? verifyJwt(token) : null;
      if (!payload) return res.status(401).json({ loggedIn: false });
      const user = await users.findOne({ _id: payload.userId }, { projection: { password_hash: 0, salt: 0 } });
      if (!user) return res.status(401).json({ loggedIn: false });
      return res.json({ loggedIn: true, user: { username: user.username } });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido.' });
    }

    // ── POST /api/auth?action=register ───────────────────────────────────────
    if (action === 'register') {
      const { username, password } = req.body || {};
      if (!username?.trim() || !password) {
        return res.status(400).json({ error: 'Informe usuário e senha.' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });
      }

      const usernameLower = username.trim().toLowerCase();
      const existing = await users.findOne({ username: usernameLower });
      if (existing) {
        return res.status(409).json({ error: 'Usuário já existe.' });
      }

      const salt          = generateSalt();
      const password_hash = hashPassword(password, salt);

      const result = await users.insertOne({
        username:      usernameLower,
        password_hash,
        salt,
        createdAt:     new Date(),
      });

      const token = signJwt({ userId: result.insertedId });
      return res.status(201).json({ ok: true, token, username: usernameLower });
    }

    // ── POST /api/auth?action=login ───────────────────────────────────────────
    if (action === 'login') {
      const { username, password } = req.body || {};
      if (!username?.trim() || !password) {
        return res.status(400).json({ error: 'Informe usuário e senha.' });
      }

      const usernameLower = username.trim().toLowerCase();
      const user = await users.findOne({ username: usernameLower });

      // Resposta genérica para não revelar se usuário existe
      if (!user) {
        return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
      }

      const hash = hashPassword(password, user.salt);
      const hashBuf     = Buffer.from(hash,            'hex');
      const storedBuf   = Buffer.from(user.password_hash, 'hex');
      const match = hashBuf.length === storedBuf.length && timingSafeEqual(hashBuf, storedBuf);

      if (!match) {
        return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
      }

      const token = signJwt({ userId: user._id });
      return res.json({ ok: true, token, username: user.username });
    }

    return res.status(400).json({ error: 'Ação inválida. Use register ou login.' });

  } catch (err) {
    console.error('[/api/auth] Erro:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro interno.' });
  }
}

// ── Extrai token do header Authorization: Bearer <token> ─────────────────────
function extractToken(req) {
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
