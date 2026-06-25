import 'dotenv/config';
import { getDb } from '../db.js';
import {
  hashPassword,
  gerarToken,
  sanitizeUsuario,
  validarCadastro,
  garantirIndiceUsuarios,
} from '../auth.js';

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

  const { nome, email, senha } = req.body || {};
  console.log('[POST /api/cadastro] Requisição recebida:', { email });

  const erros = validarCadastro({ nome, email, senha });
  if (erros.length > 0) {
    return res.status(400).json({ error: erros.join(' ') });
  }

  const emailNormalizado = email.trim().toLowerCase();

  try {
    const db = await getDb();
    await garantirIndiceUsuarios(db);
    const users = db.collection('users');

    const existente = await users.findOne({ email: emailNormalizado });
    if (existente) {
      return res.status(409).json({ error: 'Já existe uma conta cadastrada com este e-mail.' });
    }

    const senhaHash = await hashPassword(senha);
    const novoUsuario = {
      nome: nome.trim(),
      email: emailNormalizado,
      senhaHash,
      createdAt: new Date(),
    };

    const resultado = await users.insertOne(novoUsuario);
    novoUsuario._id = resultado.insertedId;

    const token = gerarToken(novoUsuario);
    console.log('[POST /api/cadastro] Usuário criado com sucesso:', novoUsuario._id.toString());

    return res.status(201).json({ token, usuario: sanitizeUsuario(novoUsuario) });
  } catch (error) {
    // Código 11000 = violação de índice único (e-mail já existe).
    // Pode acontecer em uma corrida entre duas requisições simultâneas.
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Já existe uma conta cadastrada com este e-mail.' });
    }
    console.error('[POST /api/cadastro] Erro:', error.message, error.stack);
    return res.status(500).json({ error: 'Erro interno no servidor.', details: error.message });
  }
}
