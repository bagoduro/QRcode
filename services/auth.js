import { createHash, createHmac, timingSafeEqual } from 'crypto';

// ─── SERVICE: Auth ───────────────────────────────────────────────────────────
// JWT artesanal (HMAC-SHA256, sem dependências externas) + hashing de senha
// com salt. Puramente lógico — não acessa o banco (isso é responsabilidade
// do controller + do model User).

const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-em-producao';
const TOKEN_TTL = 7 * 24 * 60 * 60; // 7 dias em segundos

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}
function b64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

export function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL }));
  const sig = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    const sigBuf = Buffer.from(sig, 'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(b64urlDecode(body));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function hashPassword(password, salt) {
  return createHash('sha256').update(salt + password + JWT_SECRET).digest('hex');
}

export function generateSalt() {
  return createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 32);
}

export function safeEqualHex(hashA, hashB) {
  const bufA = Buffer.from(hashA, 'hex');
  const bufB = Buffer.from(hashB, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function extractToken(req) {
  const auth = req.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}
