// ─── ROTA (Vercel serverless): /api/auth ─────────────────────────────────────
// Camada fina: apenas delega para o Controller correspondente. Toda a lógica
// vive em controllers/authController.js (padrão MVC).
export { default, verifyJwt } from '../controllers/authController.js';
