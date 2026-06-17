import 'dotenv/config';
import { getDb, closeDb } from './db.js';

// ── helpers ────────────────────────────────────────────────────────────────

function parseValorNum(valor) {
  if (!valor) return null;
  const limpo = String(valor)
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3},)/g, '')
    .replace(',', '.');
  const n = parseFloat(limpo);
  return isNaN(n) ? null : n;
}

function calcPrecoUnitario(valor_total, quantidade) {
  const vt = parseValorNum(valor_total);
  const qt = parseValorNum(String(quantidade ?? '').replace(',', '.'));
  if (!vt || !qt || qt === 0) return null;
  return Math.round((vt / qt) * 100) / 100;
}

function normalizeProductName(text = '') {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ── migração ───────────────────────────────────────────────────────────────

async function migrate() {
  const db = await getDb();
  const purchases = db.collection('purchases');
  const products  = db.collection('products');

  const total = await purchases.countDocuments();
  console.log(`\n🔍 Encontradas ${total} compras no banco.\n`);

  const cursor = purchases.find({});

  let notasProcessadas  = 0;
  let itensProcessados  = 0;
  let produtosCriados   = 0;
  let produtosExistentes = 0;
  let itensAtualizados  = 0;

  while (await cursor.hasNext()) {
    const compra = await cursor.next();
    notasProcessadas++;

    const itensAtualizadosNota = [];

    for (const item of compra.itens ?? []) {
      itensProcessados++;

      // calcula preco_unitario se ainda não existe
      const preco_unitario =
        item.preco_unitario ?? calcPrecoUnitario(item.valor_total, item.quantidade);

      const nomeNormalizado = normalizeProductName(item.descricao);
      const filter = item.codigo
        ? { codigo: item.codigo }
        : { nome_normalizado: nomeNormalizado };

      const update = {
        $setOnInsert: {
          createdAt:        new Date(),
          codigo:           item.codigo || null,
          nome_original:    item.descricao,
          nome_normalizado: nomeNormalizado,
        },
        $set: { updatedAt: new Date() },
      };

      const result = await products.findOneAndUpdate(filter, update, {
        upsert: true,
        returnDocument: 'after',
      });

      if (result.createdAt?.getTime() === result.updatedAt?.getTime()) {
        produtosCriados++;
      } else {
        produtosExistentes++;
      }

      itensAtualizadosNota.push({
        ...item,
        descricao_normalizada: nomeNormalizado,
        product_id:            result._id,
        preco_unitario:        preco_unitario,
      });
    }

    // Atualiza a compra com itens enriquecidos (preco_unitario + product_id)
    await purchases.updateOne(
      { _id: compra._id },
      { $set: { itens: itensAtualizadosNota } }
    );
    itensAtualizados += itensAtualizadosNota.length;

    process.stdout.write(`\r  Notas: ${notasProcessadas}/${total}  Itens: ${itensProcessados}`);
  }

  console.log('\n\n✅ Migração concluída!');
  console.log(`   Notas processadas : ${notasProcessadas}`);
  console.log(`   Itens processados : ${itensProcessados}`);
  console.log(`   Produtos criados  : ${produtosCriados}`);
  console.log(`   Produtos já existentes (sem duplicata): ${produtosExistentes}`);
  console.log(`   Itens atualizados no purchases: ${itensAtualizados}\n`);

  await closeDb();
}

migrate().catch((err) => {
  console.error('\n❌ Erro durante a migração:', err.message);
  process.exit(1);
});
