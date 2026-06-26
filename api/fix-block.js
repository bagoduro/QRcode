import 'dotenv/config';
import { getDb } from './db.js'; // ajuste o caminho se necessário

async function fixBlock() {
  try {
    const db = await getDb();
    const products = db.collection('products');
    const mergeRules = db.collection('merge_rules');

    // 1. Buscar todos os destinos (nome_final_normalizado) únicos
    const destinos = await mergeRules.distinct('nome_final_normalizado');
    console.log(`Encontrados ${destinos.length} destinos únicos.`);

    // 2. Atualizar produtos que são destinos
    const resultDestinos = await products.updateMany(
      { nome_normalizado: { $in: destinos } },
      { $set: { block_auto_merge: true, updatedAt: new Date() } }
    );
    console.log(`Produtos destino atualizados: ${resultDestinos.modifiedCount}`);

    // 3. (Opcional) Buscar todas as origens (descricao_original_normalizada) únicas
    const origens = await mergeRules.distinct('descricao_original_normalizada');
    console.log(`Encontradas ${origens.length} origens únicas.`);

    const resultOrigens = await products.updateMany(
      { nome_normalizado: { $in: origens } },
      { $set: { block_auto_merge: true, updatedAt: new Date() } }
    );
    console.log(`Produtos origem atualizados: ${resultOrigens.modifiedCount}`);

    console.log('Correção concluída.');
  } catch (err) {
    console.error('Erro:', err);
  }
}

fixBlock().then(() => process.exit(0));