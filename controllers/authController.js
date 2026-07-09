import * as UserModel from '../models/User.js';
import { signJwt, verifyJwt, hashPassword, generateSalt, safeEqualHex, extractToken } from '../services/auth.js';

// ─── CONTROLLER: Auth ────────────────────────────────────────────────────────
// Recebe a requisição HTTP, valida entrada, delega a lógica de senha/JWT ao
// service de Auth e a persistência ao model User, e devolve a resposta.

export { verifyJwt };

export default async function authController(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (req.method === 'GET' && action === 'me') {
      const token = extractToken(req);
      const payload = token ? verifyJwt(token) : null;
      if (!payload) return res.status(401).json({ loggedIn: false });
      const user = await UserModel.findByIdSafe(payload.userId);
      if (!user) return res.status(401).json({ loggedIn: false });
      return res.json({ loggedIn: true, user: { username: user.username } });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido.' });
    }

    if (action === 'register') {
      const { username, password } = req.body || {};
      if (!username?.trim() || !password) {
        return res.status(400).json({ error: 'Informe usuário e senha.' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres.' });
      }

      const usernameLower = username.trim().toLowerCase();
      const existing = await UserModel.findByUsername(usernameLower);
      if (existing) {
        return res.status(409).json({ error: 'Usuário já existe.' });
      }

      const salt = generateSalt();
      const password_hash = hashPassword(password, salt);
      const result = await UserModel.createUser({ username: usernameLower, password_hash, salt });

      const token = signJwt({ userId: result.insertedId });
      return res.status(201).json({ ok: true, token, username: usernameLower });
    }

    if (action === 'login') {
      const { username, password } = req.body || {};
      if (!username?.trim() || !password) {
        return res.status(400).json({ error: 'Informe usuário e senha.' });
      }

      const usernameLower = username.trim().toLowerCase();
      const user = await UserModel.findByUsername(usernameLower);

      if (!user) {
        return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
      }

      const hash = hashPassword(password, user.salt);
      const match = safeEqualHex(hash, user.password_hash);

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
