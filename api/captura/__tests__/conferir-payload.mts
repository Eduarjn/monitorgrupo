/**
 * Confere o parser contra o payload REAL da Evolution, antes de produção.
 *
 *   node --experimental-strip-types api/captura/__tests__/conferir-payload.mts capturado.json
 *
 * O `normalizarMensagem` foi escrito lendo o código-fonte da 2.3.7, não um
 * payload vivo. Um nome de campo diferente do esperado não gera erro: gera
 * "conecta e não captura nada", que é o sintoma mais caro de diagnosticar.
 * Este script transforma esse silêncio em diagnóstico.
 *
 * Aceita: um objeto, um array de objetos, ou JSONL (um por linha).
 */

import { readFileSync } from 'node:fs';
import { EvolutionDriver } from '../evolution.ts';
import { hashCaptura, hashTexto } from '../chave.ts';

const arquivo = process.argv[2];
if (!arquivo) {
  console.error('uso: conferir-payload.mts <arquivo.json>');
  process.exit(1);
}

function carregar(caminho: string): unknown[] {
  const bruto = readFileSync(caminho, 'utf8').trim();
  try {
    const j = JSON.parse(bruto);
    return Array.isArray(j) ? j : [j];
  } catch {
    // JSONL — o formato que sai de um coletor de webhook
    return bruto.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}

const driver = new EvolutionDriver('http://127.0.0.1:8080', 'nao-usado-aqui');
const eventos = carregar(arquivo);

const conta = { total: 0, mensagem: 0, grupo: 0, um_a_um: 0, qr: 0, conexao: 0, outro: 0, nulo: 0 };
const problemas: string[] = [];

console.log(`\nLendo ${eventos.length} evento(s) de ${arquivo}\n${'='.repeat(70)}`);

for (const [i, bruto] of eventos.entries()) {
  conta.total++;
  const envelope = bruto as Record<string, unknown>;
  const nomeEvento = String(envelope?.event ?? '(sem campo "event")');

  const ev = driver.normalizarEvento(bruto);

  if (!ev) {
    conta.nulo++;
    // null é CORRETO para mensagem 1:1 — é o filtro de LGPD funcionando.
    const jid = String(((envelope?.data as Record<string, unknown>)?.key as
                        Record<string, unknown>)?.remoteJid ?? '');
    if (jid.endsWith('@s.whatsapp.net')) {
      conta.um_a_um++;
      console.log(`[${i}] ${nomeEvento} → descartado (conversa 1:1) ✓ filtro OK`);
    } else {
      problemas.push(`[${i}] ${nomeEvento} devolveu null e NÃO é 1:1 — remoteJid=${jid || '(vazio)'}`);
      console.log(`[${i}] ${nomeEvento} → NULL ⚠️  investigar`);
    }
    continue;
  }

  if (ev.tipo === 'qr') { conta.qr++; console.log(`[${i}] qr → contagem ${ev.qr?.contagem}, base64 ${ev.qr?.base64 ? 'presente' : 'AUSENTE ⚠️'}`); continue; }
  if (ev.tipo === 'conexao') { conta.conexao++; console.log(`[${i}] conexao → estado "${ev.conexao?.estado}" motivo ${ev.conexao?.motivo ?? '—'}`); continue; }
  if (ev.tipo !== 'mensagem' || !ev.mensagem) { conta.outro++; console.log(`[${i}] ${ev.tipo} (${nomeEvento})`); continue; }

  const m = ev.mensagem;
  conta.mensagem++; conta.grupo++;

  // Cada campo que a ingestão depende, conferido um a um.
  const faltando: string[] = [];
  if (!m.wa_msg_id) faltando.push('wa_msg_id (key.id)');
  if (!m.autor_jid) faltando.push('autor_jid (key.participant)');
  if (!m.autor_nome) faltando.push('autor_nome (pushName)');
  if (!(m.enviada_em instanceof Date) || Number.isNaN(m.enviada_em.getTime())) faltando.push('enviada_em');
  if (m.tipo === 'texto' && !m.conteudo) faltando.push('conteudo');

  const ano = m.enviada_em.getFullYear();
  if (ano < 2020 || ano > 2100) faltando.push(`enviada_em fora de faixa (${m.enviada_em.toISOString()}) — epoch em ms em vez de s?`);

  console.log(
    `[${i}] mensagem → ${m.grupo_jid}\n` +
    `      autor: ${m.autor_nome ?? '?'} <${m.autor_jid ?? '?'}>\n` +
    `      quando: ${m.enviada_em.toISOString()}\n` +
    `      tipo: ${m.tipo}${m.midia_arquivo ? ` (${m.midia_arquivo})` : ''}` +
    `${m.propria ? ' [enviada pelo próprio número]' : ''}\n` +
    `      texto: ${JSON.stringify(m.conteudo.slice(0, 70))}\n` +
    `      menções: ${m.mencionados.length}${m.respondendo_a ? ` · responde a ${m.respondendo_a}` : ''}\n` +
    `      hash: ${hashCaptura(m.grupo_jid, m.wa_msg_id).slice(0, 16)}…` +
    ` · texto_hash: ${hashTexto(m.conteudo)?.slice(0, 16) ?? '(curto demais — não reconcilia)'}`,
  );
  if (faltando.length) {
    problemas.push(`[${i}] campos ausentes: ${faltando.join(', ')}`);
    console.log(`      ⚠️  ${faltando.join(', ')}`);
  }
}

console.log('\n' + '='.repeat(70));
console.log(`total ${conta.total} · mensagens de grupo ${conta.grupo} · 1:1 descartadas ${conta.um_a_um}` +
            ` · qr ${conta.qr} · conexão ${conta.conexao} · outros ${conta.outro} · nulos ${conta.nulo}`);

if (problemas.length) {
  console.log(`\n❌ ${problemas.length} problema(s) — NÃO vincule grupo antes de resolver:\n`);
  for (const p of problemas) console.log('  · ' + p);
  process.exit(1);
}

if (conta.grupo === 0) {
  console.log('\n⚠️  Nenhuma mensagem de GRUPO no arquivo. Ou o payload não tem, ou');
  console.log('    groupsIgnore ficou true na instância — nesse caso a Evolution');
  console.log('    descarta grupo antes do webhook e nada chega, sem erro.');
  process.exit(1);
}

console.log('\n✅ O parser leu todos os campos que a ingestão precisa. Pode vincular o primeiro grupo.');
