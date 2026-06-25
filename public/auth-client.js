/* eslint-disable no-unused-vars -- este arquivo é carregado como <script> global em
   login.html, cadastro.html e index.html; as funções abaixo são usadas nos scripts
   inline dessas páginas, então o ESLint (que analisa este .js isoladamente) não
   consegue ver esse uso. */

/* ---------------------------------------------------------------
   Utilitários de autenticação usados em login.html, cadastro.html
   e (para o "guard" de rota) no index.html.
   ----------------------------------------------------------------*/

const API_BASE = '/api';
const CHAVE_TOKEN = 'qr_auth_token';
const CHAVE_USUARIO = 'qr_auth_usuario';

/**
 * POST genérico para a API, seguindo o mesmo padrão usado no
 * restante do front-end (index.html).
 */
async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Resposta inválida do servidor (status ${res.status}).`);
  }

  if (!res.ok) throw new Error(data.error || 'Erro na requisição.');
  return data;
}

/** Monta o HTML de uma mensagem de erro, no mesmo estilo usado no resto do app. */
function alertHtml(texto) {
  return `<div class="alert"><i class="ti ti-alert-circle" aria-hidden="true"></i> ${texto}</div>`;
}

/** Salva o token e os dados do usuário logado no localStorage. */
function salvarSessao(token, usuario) {
  localStorage.setItem(CHAVE_TOKEN, token);
  localStorage.setItem(CHAVE_USUARIO, JSON.stringify(usuario));
}

/** Remove a sessão do localStorage (logout). */
function limparSessao() {
  localStorage.removeItem(CHAVE_TOKEN);
  localStorage.removeItem(CHAVE_USUARIO);
}

function getToken() {
  return localStorage.getItem(CHAVE_TOKEN);
}

function getUsuario() {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_USUARIO));
  } catch {
    return null;
  }
}

/**
 * Liga o botão de "olho" que alterna a visibilidade de um campo de senha.
 */
function setupPasswordToggle(botaoId, inputId) {
  const botao = document.getElementById(botaoId);
  const input = document.getElementById(inputId);
  if (!botao || !input) return;

  botao.addEventListener('click', () => {
    const oculto = input.type === 'password';
    input.type = oculto ? 'text' : 'password';
    botao.innerHTML = oculto
      ? '<i class="ti ti-eye-off" aria-hidden="true"></i>'
      : '<i class="ti ti-eye" aria-hidden="true"></i>';
    botao.setAttribute('aria-label', oculto ? 'Ocultar senha' : 'Mostrar senha');
  });
}

/**
 * "Guard" de rota: chame no topo de páginas que exigem login.
 * Se não houver token salvo, redireciona para a tela de login.
 */
function exigirLogin() {
  if (!getToken()) {
    window.location.href = '/login.html';
  }
}
