# QRcode-main — Organização em MVC

Este projeto foi reorganizado seguindo o padrão **MVC (Model-View-Controller)**.

## Camadas

### Model (`/models`)
Único ponto de acesso ao MongoDB. Cada arquivo representa uma coleção do
banco e expõe apenas funções (find, insert, update, delete) — nenhuma regra
de negócio, nenhuma lógica de request/response.

- `Product.js` — coleção `products`
- `Purchase.js` — coleção `purchases`
- `MergeRule.js` — coleção `merge_rules`
- `User.js` — coleção `users`
- `db.js` — conexão com o MongoDB (usada só pelos Models)

### View (`/src`)
Frontend em React (Vite). Consome a API via `src/lib/api.js` e renderiza os
dados em componentes e abas (`TabLeitor`, `TabBuscar`, `TabHistorico`, etc.).
Não foi alterado nesta reorganização — já era a camada de View do sistema.

### Controller (`/controllers`)
Recebe a requisição HTTP, valida entrada, orquestra chamadas aos Models e
Services, e devolve a resposta. É aqui que mora a lógica que antes ficava
espalhada dentro de cada arquivo de `/api`.

### Rotas (`/api`)
Como o deploy é feito na Vercel (roteamento por arquivo), os arquivos de
`/api` continuam existindo, mas agora são apenas uma linha cada, redirecionando
para o Controller correspondente:

```js
export { default } from '../controllers/produtosController.js';
```

### Services (`/services`)
Regras de negócio reutilizáveis, sem acesso a banco e sem req/res:

- `normalize.js` — normalização de texto (base de toda a mesclagem)
- `parseNota.js` — scraping da página da SEFAZ com Cheerio
- `fuzzyMerge.js` — mesclagem automática com Fuse.js (upsert + clusterização)
- `auth.js` — JWT (HMAC-SHA256) e hashing de senha

## Bônus: fim da duplicação em `server.js`

Antes, `server.js` (usado só em desenvolvimento local) reimplementava toda a
lógica de negócio em paralelo aos arquivos de `/api` — cerca de 700 linhas
duplicadas. Agora ele apenas importa os mesmos Controllers e os monta como
rotas Express, então local e produção (Vercel) rodam exatamente o mesmo
código.

## Fluxo de uma requisição

```
Requisição HTTP
   → /api/*.js         (rota fina, Vercel)
      → /controllers/*  (valida, orquestra)
         → /services/*  (regra de negócio pura)
         → /models/*    (acesso ao MongoDB)
      ← resposta JSON
   ← resposta HTTP
→ /src (View em React) renderiza o resultado
```
