import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SALT_ROUNDS = 10;
const JWT_EXPIRES_IN = '7d';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-troque-isso-em-producao';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (!process.env.JWT_SECRET) {
  console.warn(
    '[auth] JWT_SECRET não definido no .env — usando segredo de desenvolvimento. ' +
      'Defina JWT_SECRET antes de ir para produção.'
  );
}

/**
 * Gera o hash da senha em texto puro usando bcrypt.
 * Nunca armazene a senha original no banco — apenas o hash.
 */
export async function hashPassword(senha) {
  return bcrypt.hash(senha, SALT_ROUNDS);
}

/**
 * Compara a senha digitada no login com o hash salvo no banco.
 */
export async function comparePassword(senha, hash) {
  return bcrypt.compare(senha, hash);
}

/**
 * Gera um token JWT contendo o id e o e-mail do usuário.
 * O front-end deve guardar esse token (ex: localStorage) e enviá-lo
 * em requisições futuras que exijam autenticação.
 */
export function gerarToken(usuario) {
  return jwt.sign(
    { sub: usuario._id.toString(), email: usuario.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Verifica e decodifica um token JWT. Retorna o payload se válido,
 * ou null se o token for inválido/expirado.
 */
export function verificarToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Remove campos sensíveis (como o hash da senha) antes de enviar
 * o usuário de volta para o front-end.
 */
export function sanitizeUsuario(usuario) {
  return {
    id: usuario._id.toString(),
    nome: usuario.nome,
    email: usuario.email,
  };
}

/**
 * Validações básicas dos dados de cadastro. Retorna um array de
 * mensagens de erro (vazio se tudo estiver correto).
 */
export function validarCadastro({ nome, email, senha }) {
  const erros = [];

  if (!nome || nome.trim().length < 2) {
    erros.push('O nome deve ter ao menos 2 caracteres.');
  }
  if (!email || !EMAIL_REGEX.test(email.trim())) {
    erros.push('Informe um e-mail válido.');
  }
  if (!senha || senha.length < 6) {
    erros.push('A senha deve ter ao menos 6 caracteres.');
  }

  return erros;
}

/**
 * Garante que a coleção "users" tenha um índice único pelo e-mail,
 * evitando contas duplicadas no banco. Roda apenas uma vez por
 * instância do servidor (cold start, no caso da Vercel).
 */
let indiceGarantido = false;
export async function garantirIndiceUsuarios(db) {
  if (indiceGarantido) return;
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  indiceGarantido = true;
}
