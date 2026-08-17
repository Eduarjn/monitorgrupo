/**
 * Testes da captura em tempo real. Tudo offline: sem rede, sem banco, sem
 * Evolution rodando. São as quatro correções da revisão que estão sob teste.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { hashCaptura, hashTexto, normalizarTexto, JANELA_RECONCILIACAO_SEG } from '../chave.ts';
import { ehGrupo, telefoneDoJid } from '../driver.ts';
import { avaliarGatilho, formatarJanela, interpretarResposta, assinaturaJanela,
         REGRAS_PADRAO } from '../../ai/analise.ts';

// ---------------------------------------------- CORREÇÃO 1: repareamento

test('hashCaptura NÃO depende da instância — repareamento não muda a chave', () => {
  // Era o bug: com o uuid da instância dentro, recriar a instância mudava o
  // hash, o ON CONFLICT de hash_mensagem não casava e o índice único de
  // wa_msg_id levantava 23505 → 500 → retry em loop na Evolution.
  const a = hashCaptura('120363041234567890@g.us', '3EB0C767D26A8A2E9C1B');
  const b = hashCaptura('120363041234567890@g.us', '3EB0C767D26A8A2E9C1B');
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('hashCaptura separa grupos e mensagens diferentes', () => {
  assert.notEqual(hashCaptura('1@g.us', 'X'), hashCaptura('2@g.us', 'X'));
  assert.notEqual(hashCaptura('1@g.us', 'X'), hashCaptura('1@g.us', 'Y'));
});

test('hash de captura nunca colide com hash de upload (prefixo namespaced)', () => {
  // O hash do upload é sha256 de [dataRaw, horaRaw, autorRaw, conteudo].
  // Nenhum dataRaw de arquivo é a string 'wa', então o espaço é disjunto.
  const captura = hashCaptura('120363@g.us', 'ABC');
  const upload = createHash('sha256')
    .update(['03/08/2026', '09:12:45', 'Joao', 'oi'].join('\x1f')).digest('hex');
  assert.notEqual(captura, upload);
});

// ------------------------------------- CORREÇÃO 2: reconciliação por tempo

test('hashTexto ignora hora e autor — só o texto normalizado importa', () => {
  // O .txt traz "Marcos Vendas", o webhook traz "Marcos". Exigir autor igual
  // destruiria a conciliação em vez de melhorá-la.
  assert.equal(hashTexto('Manda o contrato até as 18h'), hashTexto('manda o contrato ate as 18h'));
  assert.equal(hashTexto('  manda   o contrato ate as 18h  '), hashTexto('manda o contrato ate as 18h'));
});

test('hashTexto devolve null para texto curto e vazio', () => {
  // "ok" casaria com qualquer "ok" da janela e sumiria do histórico.
  assert.equal(hashTexto('ok'), null);
  assert.equal(hashTexto('kkkk'), null);
  assert.equal(hashTexto(''), null);
  assert.ok(hashTexto('bom dia pessoal, tudo certo?'));
});

test('normalizarTexto remove as marcas invisíveis que o WhatsApp injeta', () => {
  assert.equal(normalizarTexto('‎Bom dia‬'), 'bom dia');
  assert.equal(normalizarTexto('AÇÃO Ürgente'), 'acao urgente');
});

test('a janela de reconciliação tolera a virada do minuto', () => {
  // O relógio do celular (que carimba o .txt) e o do servidor (webhook) não
  // coincidem. 1 segundo atravessando a virada do minuto virava linha
  // DUPLICADA no painel — o risco frequente, não o raro.
  assert.ok(JANELA_RECONCILIACAO_SEG >= 60,
    'precisa cobrir pelo menos uma virada de minuto inteira');
  assert.ok(JANELA_RECONCILIACAO_SEG <= 180,
    'acima disso engoliria repetição legítima da conversa');
});

// ------------------------------------------------- CORREÇÃO 4: filtro LGPD

test('ehGrupo separa grupo de conversa 1:1', () => {
  assert.equal(ehGrupo('120363041234567890@g.us'), true);
  assert.equal(ehGrupo('5511977776666@s.whatsapp.net'), false);
  assert.equal(ehGrupo(null), false);
  assert.equal(ehGrupo(undefined), false);
});

test('telefoneDoJid extrai o número e recusa @lid', () => {
  assert.equal(telefoneDoJid('5519999999999@s.whatsapp.net'), '5519999999999');
  assert.equal(telefoneDoJid('5519999999999:12@s.whatsapp.net'), '5519999999999');
  // @lid é identificador opaco da migração de identidade — não é telefone.
  assert.equal(telefoneDoJid('98765432101234@lid'), null);
  assert.equal(telefoneDoJid(null), null);
});

// ------------------------------------------------------------ gatilhos e IA

test('gatilho de termo crítico respeita fronteira de palavra', () => {
  const r = avaliarGatilho('eles pediram o cancelamento do contrato', [], REGRAS_PADRAO);
  assert.equal(r?.gatilho, 'termo_critico');
  assert.equal(r?.termo, 'cancelamento');
  // "descancelar" não existe, mas o teste vale contra casamento dentro de palavra
  assert.equal(avaliarGatilho('precancelamentos', [], REGRAS_PADRAO)?.gatilho, undefined);
});

test('gatilho de menção dispara por JID mencionado', () => {
  const regras = { ...REGRAS_PADRAO, mencoes: ['5519935010887'] };
  const r = avaliarGatilho('bora?', ['5519935010887@s.whatsapp.net'], regras);
  assert.equal(r?.gatilho, 'mencao');
});

test('conversa comum não dispara gatilho nenhum', () => {
  assert.equal(avaliarGatilho('bom dia, alguem vai no almoço?', [], REGRAS_PADRAO), null);
});

test('formatarJanela põe o id na frente para o modelo poder citar', () => {
  const txt = formatarJanela('Comercial ERA', [
    { id: 84198, enviada_em: '2026-08-17T09:02', autor: 'Marcos', conteudo: 'bom dia' },
    { id: 84213, enviada_em: '2026-08-17T09:11', autor: 'Rafael', conteudo: 'pediram cancelamento' },
  ], 'termo_critico', 'cancelamento');
  assert.match(txt, /\[84198\] 09:02 Marcos: bom dia/);
  assert.match(txt, /2 mensagens · 2 participantes/);
  assert.match(txt, /Gatilho: termo_critico \("cancelamento"\)/);
});

test('interpretarResposta aceita JSON cercado de prosa do modelo', () => {
  const a = interpretarResposta('Claro! Segue:\n{"nada_relevante":false,"resumo":"x","temperatura":4}\nEspero ter ajudado.');
  assert.equal(a.resumo, 'x');
  assert.equal(a.temperatura, 4);
});

test('interpretarResposta não estoura com lixo — devolve análise vazia', () => {
  for (const lixo of ['', 'não consegui', '{quebrado', '{"a":']) {
    const a = interpretarResposta(lixo);
    assert.equal(a.nada_relevante, true);
    assert.deepEqual(a.assuntos_urgentes, []);
  }
});

test('interpretarResposta prende a temperatura em 1..5', () => {
  assert.equal(interpretarResposta('{"temperatura":99}').temperatura, 5);
  assert.equal(interpretarResposta('{"temperatura":-3}').temperatura, 1);
  assert.equal(interpretarResposta('{"temperatura":"alta"}').temperatura, 1);
});

test('assinaturaJanela independe da ordem dos ids', () => {
  assert.equal(assinaturaJanela([3, 1, 2]), assinaturaJanela([1, 2, 3]));
  assert.notEqual(assinaturaJanela([1, 2]), assinaturaJanela([1, 2, 3]));
});
