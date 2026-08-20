/**
 * Diagnóstico do painel, rodado NO servidor.
 *
 *   node --env-file=/opt/whatsapp-monitor/.env deploy/diagnostico.mjs
 *
 * Existe porque o caminho do Dashboard passa por autenticação, e testar de fora
 * exige senha — que eu não devo manipular. Aqui as mesmas consultas do
 * `montarDossie()` rodam com a credencial que o serviço já tem, e só os
 * resultados agregados são impressos. Nenhum segredo vai para a saída.
 */

import pg from 'pg';

const db = new pg.Pool({ connectionString: process.env.PGURL, max: 2 });
const ok = (s) => console.log('  ✓ ' + s);
const ruim = (s) => console.log('  ✗ ' + s);

async function main() {
  console.log('\n=== 1. GRUPOS E VOLUME ===');
  const { rows: grupos } = await db.query(
    `select g.id::int as id, g.nome,
            (select count(*) from mensagens m where m.grupo_id = g.id)::int as msgs,
            (select count(*) from blocos b where b.grupo_id = g.id)::int as blocos,
            (select max(enviada_em) from mensagens m where m.grupo_id = g.id) as ultima
       from grupos g order by g.id`);
  if (!grupos.length) ruim('nenhum grupo cadastrado');
  for (const g of grupos) {
    const idade = g.ultima ? Math.round((Date.now() - new Date(g.ultima)) / 86400000) : null;
    console.log(`  [${g.id}] ${g.nome} — ${g.msgs} msgs, ${g.blocos} blocos` +
      (idade === null ? ', SEM MENSAGENS' : `, última há ${idade}d`));
  }

  console.log('\n=== 2. DOSSIÊ (o que o Dashboard consome) ===');
  for (const g of grupos) {
    const dias = 30;
    const fim = new Date(), inicio = new Date(Date.now() - dias * 86400000);
    const p = [g.id, inicio.toISOString(), fim.toISOString()];
    try {
      const [tipos, origens, horas] = await Promise.all([
        db.query(`select tipo, count(*)::int as total from mensagens
                   where grupo_id=$1 and enviada_em>=$2 and enviada_em<$3
                   group by tipo order by 2 desc`, p),
        db.query(`select origem, count(*)::int as total from mensagens
                   where grupo_id=$1 and enviada_em>=$2 and enviada_em<$3
                   group by origem order by 2 desc`, p),
        db.query(`select count(*)::int as n from mensagens
                   where grupo_id=$1 and enviada_em>=$2 and enviada_em<$3`, p),
      ]);
      const total = horas.rows[0].n;
      if (total === 0) {
        ruim(`grupo ${g.id}: ZERO mensagens nos últimos ${dias}d ` +
             `— o Dashboard vai mostrar a Visão executiva vazia`);
      } else {
        ok(`grupo ${g.id}: ${total} msgs em ${dias}d | tipos=${tipos.rows.map(r => r.tipo + ':' + r.total).join(' ')} | ` +
           `origens=${origens.rows.map(r => r.origem + ':' + r.total).join(' ')}`);
      }
    } catch (e) {
      ruim(`grupo ${g.id}: consulta do dossiê FALHOU — ${e.message}`);
    }
  }

  console.log('\n=== 3. CARDS DE CONSULTA ===');
  const { rows: cards } = await db.query(
    `select id::int as id, grupo_id::int as grupo_id, titulo, natureza, metrica,
            parametro, execucoes::int as execucoes
       from consultas where ativa order by grupo_id nulls first, id`);
  console.log(`  ${cards.length} cards ativos`);
  for (const c of cards) {
    console.log(`  [${c.id}] ${c.grupo_id === null ? 'GLOBAL' : 'g' + c.grupo_id} · ` +
      `${c.natureza}${c.metrica ? '/' + c.metrica : ''} · "${c.titulo}" · ${c.execucoes}x`);
  }

  console.log('\n=== 4. CUSTO DE IA (o que gasta token) ===');
  for (const [rot, sql] of [
    ['blocos com embedding', `select count(*)::int as n from blocos where embedding is not null`],
    ['blocos SEM embedding', `select count(*)::int as n from blocos where embedding is null`],
    ['análises de janela',   `select count(*)::int as n from wa_analises`],
    ['análises sem nada relevante', `select count(*)::int as n from wa_analises where nada_relevante`],
    ['alertas gerados',      `select count(*)::int as n from wa_alertas`],
  ]) {
    try { console.log(`  ${rot}: ${(await db.query(sql)).rows[0].n}`); }
    catch (e) { ruim(`${rot}: ${e.message}`); }
  }

  console.log('\n=== 5. ESQUEMA ESPERADO PELO CÓDIGO NOVO ===');
  for (const [tabela, coluna] of [['grupos', 'nicho'], ['consultas', 'nicho'], ['consultas', 'ordem']]) {
    const { rows } = await db.query(
      `select 1 from information_schema.columns
        where table_name=$1 and column_name=$2`, [tabela, coluna]);
    rows.length ? ok(`${tabela}.${coluna} existe`) : ruim(`${tabela}.${coluna} NÃO existe — falta migração`);
  }

  await db.end();
  console.log('');
}

main().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
