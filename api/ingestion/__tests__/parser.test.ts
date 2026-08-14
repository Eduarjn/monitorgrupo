/**
 * Testes do parser — Fase 2.
 *
 * ⚠️ Os fixtures são SINTÉTICOS, montados a partir dos formatos conhecidos
 * (iOS/Android × pt/en). Quando a Fase 0 entregar exports reais, eles entram
 * aqui como fixtures adicionais — os sintéticos ficam, os reais mandam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTexto } from '../parser.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));
const fixture = (nome: string) => readFileSync(join(AQUI, 'fixtures', nome), 'utf8');

// ---------------------------------------------------------------- android-pt

test('android-pt: classifica sistema, texto e mídia; reconstrói multilinha', async () => {
  const r = await parseTexto(fixture('android-pt.txt'));

  assert.equal(r.meta.plataforma, 'android');
  assert.equal(r.meta.formatoDataDetectado, 'DMY');       // linha 13/08 prova
  assert.equal(r.meta.porTipo.sistema, 3);                // cripto + criou + adicionou
  assert.equal(r.meta.porTipo.midia, 2);                  // <Mídia omitida> + .opus
  assert.equal(r.meta.porTipo.texto, 4);

  // multilinha vira UMA mensagem com \n preservado
  const maria = r.mensagens.find((m) => m.conteudo.startsWith('Bom dia, João!'));
  assert.ok(maria);
  assert.equal(maria.conteudo.split('\n').length, 3);

  // mídia com arquivo: nome extraído (risco 1.2)
  const audio = r.mensagens.find((m) => m.midia_arquivo);
  assert.equal(audio?.midia_arquivo, 'PTT-20260803-WA0001.opus');
  assert.equal(audio?.tipo, 'midia');

  // autor que é só número (fora da agenda) é preservado cru
  assert.ok(r.mensagens.some((m) => m.autor_raw === '+55 19 99876-5432'));

  // "Esta mensagem foi apagada" tem autor → continua texto, conta na atividade
  const apagada = r.mensagens.find((m) => m.conteudo === 'Esta mensagem foi apagada');
  assert.equal(apagada?.tipo, 'texto');

  // timestamp materializado com o offset padrão
  const pedro = r.mensagens.find((m) => m.autor_raw === 'Pedro Lima');
  assert.equal(pedro?.enviada_em, '2026-08-13T18:44:00-03:00');
});

// -------------------------------------------------------------------- ios-pt

test('ios-pt: remove marcas invisíveis; sistema com prefixo de grupo; anexo iOS', async () => {
  const r = await parseTexto(fixture('ios-pt.txt'));

  assert.equal(r.meta.plataforma, 'ios');
  assert.equal(r.meta.formatoDataDetectado, 'DMY');

  // U+200E não pode sobrar no autor
  assert.ok(r.mensagens.every((m) => !/[‎‏]/.test(m.autor_raw ?? '')));
  assert.ok(r.mensagens.some((m) => m.autor_raw === 'João Silva'));

  // aviso de criptografia vem como "NomeDoGrupo: texto" no iOS — tem ':' mas é sistema
  const cripto = r.mensagens.find((m) => m.enviada_em === '2026-08-03T09:12:45-03:00');
  assert.equal(cripto?.tipo, 'sistema');

  // "imagem ocultada" com autor → mídia sem arquivo, mantida para estatística
  const img = r.mensagens.find((m) => m.enviada_em === '2026-08-03T09:13:10-03:00');
  assert.equal(img?.tipo, 'midia');
  assert.equal(img?.midia_arquivo, null);

  // <anexado: X> extrai o arquivo
  const anexo = r.mensagens.find((m) => m.midia_arquivo);
  assert.equal(anexo?.midia_arquivo, '00000012-AUDIO-2026-08-03-09-16-00.opus');

  // multilinha no iOS também
  const maria = r.mensagens.find((m) => m.conteudo.startsWith('oi!'));
  assert.ok(maria?.conteudo.includes('\nsegunda linha'));

  // hora com segundos
  const pedro = r.mensagens.find((m) => m.autor_raw === 'Pedro Lima');
  assert.equal(pedro?.enviada_em, '2026-08-13T10:00:00-03:00');
});

// ----------------------------------------------------------------- android-en

test('android-en: detecta MDY por 8/13; converte AM/PM; dígito único', async () => {
  const r = await parseTexto(fixture('android-en.txt'));

  assert.equal(r.meta.formatoDataDetectado, 'MDY');       // 8/13 prova (13 > 12)

  // 2:05 PM → 14:05, e a data 8/3 é 3 de agosto (MDY)
  const mary = r.mensagens.find((m) => m.autor_raw === 'Mary Jane');
  assert.equal(mary?.enviada_em, '2026-08-03T14:05:00-03:00');
  assert.equal(mary?.tipo, 'midia');                       // <Media omitted>

  // 12:00 AM → 00:00 (meia-noite), multilinha junto
  const peter = r.mensagens.find((m) => m.autor_raw === 'Peter Parker');
  assert.equal(peter?.enviada_em, '2026-08-13T00:00:00-03:00');
  assert.ok(peter?.conteudo.includes('\nline two here'));

  // 12:30 PM → 12:30 (meio-dia não soma 12)
  const anexo = r.mensagens.find((m) => m.midia_arquivo === 'IMG-20260813-WA0007.jpg');
  assert.equal(anexo?.enviada_em, '2026-08-13T12:30:00-03:00');
});

// -------------------------------------------------------------------- ios-en

test('ios-en: narrow no-break space antes de AM/PM; meia-noite e meio-dia', async () => {
  const r = await parseTexto(fixture('ios-en.txt'));

  assert.equal(r.meta.plataforma, 'ios');
  assert.equal(r.meta.formatoDataDetectado, 'MDY');

  const john = r.mensagens.find((m) => m.conteudo === 'Good morning!');
  assert.equal(john?.enviada_em, '2026-08-03T09:20:00-03:00');

  // "audio omitted" com U+202F e marcas invisíveis → mídia
  const audio = r.mensagens.find((m) => m.enviada_em === '2026-08-03T14:05:10-03:00');
  assert.equal(audio?.tipo, 'midia');

  const meiaNoite = r.mensagens.find((m) => m.conteudo === 'midnight message');
  assert.equal(meiaNoite?.enviada_em, '2026-08-13T00:00:00-03:00');

  const meioDia = r.mensagens.find((m) => m.conteudo === 'noon reply');
  assert.equal(meioDia?.enviada_em, '2026-08-13T12:30:00-03:00');
});

// ------------------------------------------------------- ambiguidade de data

const AMBIGUO = [
  '03/08/2026 09:00 - Ana: primeira',
  '04/08/2026 10:00 - Bia: segunda',
].join('\n');

test('datas ambíguas: avisa e assume DMY por padrão', async () => {
  const r = await parseTexto(AMBIGUO);
  assert.equal(r.meta.formatoDataDetectado, 'ambiguo');
  assert.equal(r.meta.formatoDataUsado, 'DMY');
  assert.ok(r.meta.avisos.some((a) => a.includes('CONFIRMAR')));
  assert.equal(r.mensagens[0].enviada_em, '2026-08-03T09:00:00-03:00');
});

test('datas ambíguas: opção do usuário (MDY) muda a interpretação', async () => {
  const r = await parseTexto(AMBIGUO, { formatoData: 'MDY' });
  assert.equal(r.meta.formatoDataUsado, 'MDY');
  assert.equal(r.mensagens[0].enviada_em, '2026-03-08T09:00:00-03:00'); // 8 de março
});

test('opção que CONTRADIZ o arquivo é ignorada com aviso', async () => {
  const r = await parseTexto(fixture('android-pt.txt'), { formatoData: 'MDY' });
  assert.equal(r.meta.formatoDataUsado, 'DMY');            // 13/08 vence a opção
  assert.ok(r.meta.avisos.some((a) => a.includes('CONTRADIZ')));
});

// ------------------------------------------------------------------- dedup

test('hash é estável entre execuções e NÃO depende do formato de data', async () => {
  const a = await parseTexto(AMBIGUO);
  const b = await parseTexto(AMBIGUO, { formatoData: 'MDY' });
  // mesma linha crua → mesmo hash, mesmo com timestamps interpretados diferentes
  assert.equal(a.mensagens[0].hash_mensagem, b.mensagens[0].hash_mensagem);
  assert.notEqual(a.mensagens[0].enviada_em, b.mensagens[0].enviada_em);
  // mensagens diferentes → hashes diferentes
  assert.notEqual(a.mensagens[0].hash_mensagem, a.mensagens[1].hash_mensagem);
});

// ------------------------------------------------------------ opção de descarte

test('descartarMidiaSemArquivo remove só a mídia SEM arquivo', async () => {
  const r = await parseTexto(fixture('android-pt.txt'), { descartarMidiaSemArquivo: true });
  assert.equal(r.meta.descartadas, 1);                     // <Mídia omitida>
  assert.equal(r.meta.porTipo.midia, 1);                   // o .opus anexado fica
  assert.ok(r.mensagens.some((m) => m.midia_arquivo === 'PTT-20260803-WA0001.opus'));
});

// ------------------------------------------------------------------ robustez

test('lixo antes da primeira mensagem não derruba e gera aviso', async () => {
  const r = await parseTexto('linha estranha de cabeçalho\n' + AMBIGUO);
  assert.equal(r.meta.totalMensagens, 2);
  assert.ok(r.meta.avisos.some((a) => a.includes('antes da primeira mensagem')));
});

test('conteúdo com ":" e URLs não confunde autor', async () => {
  const r = await parseTexto('03/08/2026 09:00 - Ana: obs: o link é https://x.com/a?b=1');
  assert.equal(r.mensagens[0].autor_raw, 'Ana');
  assert.equal(r.mensagens[0].conteudo, 'obs: o link é https://x.com/a?b=1');
});

test('arquivo vazio devolve zero mensagens sem erro', async () => {
  const r = await parseTexto('');
  assert.equal(r.meta.totalMensagens, 0);
  assert.equal(r.meta.plataforma, 'desconhecida');
});
