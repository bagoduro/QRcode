import 'dotenv/config';
import { getDb } from '../db.js';
import { comparePassword, gerarToken, sanitizeUsuario } from '../auth.js';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const { email, senha } = req.body || {};
  console.log('[POST /api/login] Requisição recebida:', { email });

  if (!email || !senha) {
    return res.status(400).json({ error: 'Informe e-mail e senha.' });
  }

  const emailNormalizado = email.trim().toLowerCase();

  try {
    const db = await getDb();
    const users = db.collection('users');
    const usuario = await users.findOne({ email: emailNormalizado });

    // Mensagem genérica propositalmente: não revelamos se o erro foi
    // o e-mail não cadastrado ou a senha errada (evita enumeração de contas).
    if (!usuario) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    const senhaCorreta = await comparePassword(senha, usuario.senhaHash);
    if (!senhaCorreta) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    const token = gerarToken(usuario);
    console.log('[POST /api/login] Login bem-sucedido:', usuario._id.toString());

    return res.json({ token, usuario: sanitizeUsuario(usuario) });
  } catch (error) {
    console.error('[POST /api/login] Erro:', error.message, error.stack);
    return res.status(500).json({ error: 'Erro interno no servidor.', details: error.message });
  }
}
