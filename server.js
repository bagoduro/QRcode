import 'dotenv/config';
import express from 'express';

import authController, { verifyJwt } from './controllers/authController.js';
import consultaQrcodeController from './controllers/consultaQrcodeController.js';
import produtosController from './controllers/produtosController.js';
import mesclarProdutosController from './controllers/mesclarProdutosController.js';
import historicoComprasController from './controllers/historicoComprasController.js';
import criarProdutosController from './controllers/criarProdutosController.js';
import migrateController from './controllers/migrateController.js';
import restaurarNomesController from './controllers/restaurarNomesController.js';
import toggleBlockController from './controllers/toggleBlockController.js';
import desbloquearTodosController from './controllers/desbloquearTodosController.js';
import fixBlockController from './controllers/fixBlockController.js';
import healthController from './controllers/healthController.js';
import blacklistController from './controllers/blacklistController.js';

// ─── server.js ────────────────────────────────────────────────────────────
// Servidor Express para desenvolvimento local. Não reimplementa nenhuma
// lógica: apenas monta as mesmas rotas/Controllers usados pelas funções
// serverless em /api. Isso elimina a duplicação que existia antes (a mesma
// lógica de negócio vivia, ao mesmo tempo, aqui e em cada arquivo de /api).

function requireAuth(req, res, next) {
  const auth = req.headers?.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Não autenticado.' });
  const payload = verifyJwt(token);
  if (!payload) return res.status(401).json({ error: 'Token inválido ou expirado.' });
  req.user = payload;
  next();
}

const app = express();
const port = process.env.PORT || 3333;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});

// ── Rotas públicas (espelham as funções serverless de /api) ────────────────
app.all('/consulta-qrcode', consultaQrcodeController);
app.all('/api/consulta-qrcode', consultaQrcodeController);
app.get('/health', healthController);
app.get('/api/health', healthController);
app.get('/historico-compras', historicoComprasController);
app.get('/api/historico-compras', historicoComprasController);
app.get('/produtos', produtosController);
app.get('/api/produtos', produtosController);
app.all('/api/auth', authController);

// ── Rotas protegidas (exigem Bearer token) ──────────────────────────────────
app.delete('/historico-compras', requireAuth, historicoComprasController);
app.delete('/api/historico-compras', requireAuth, historicoComprasController);
app.post('/api/migrate', requireAuth, migrateController);
app.get('/api/auto-merge-blacklist', requireAuth, blacklistController);
app.post('/api/toggle-block', requireAuth, toggleBlockController);
app.post('/mesclar-produtos', requireAuth, mesclarProdutosController);
app.post('/api/mesclar-produtos', requireAuth, mesclarProdutosController);
app.get('/api/mesclar-produtos', requireAuth, mesclarProdutosController);
app.post('/api/criar-produtos', requireAuth, criarProdutosController);
app.post('/api/restaurar-nomes', requireAuth, restaurarNomesController);
app.post('/api/desbloquear-todos', requireAuth, desbloquearTodosController);
app.post('/api/fix-block', requireAuth, fixBlockController);

app.listen(port, () => {
  console.log(`Servidor local rodando em http://localhost:${port}`);
});
