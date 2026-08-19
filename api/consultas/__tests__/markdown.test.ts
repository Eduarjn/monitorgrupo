import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { montarMarkdown, type Narrativa } from '../markdown.ts';
import { interpretarNarrativa } from '../relatorio.ts';
import type { Dossie } from '../relatorio.ts';

const dossie = (over: Partial<Dossie> = {}): Dossie => ({
  grupo: 'Suporte N1', nicho: 'provedor de internet',
  periodo: { inicio: '2026-07-20', fim: '2026-08-19', dias: 30 },
  totais: { mensagens: 120, participantes: 3, dias_com_atividade: 12, media_por_dia: 10 },
  por_tipo: [{ tipo: 'texto', total: 100 }, { tipo: 'imagem', total: 20 }],
  por_origem: [{ origem: 'captura', total: 90 }, { origem: 'upload', total: 30 }],
  por_participante: [
    { nome: 'Ana', mensagens: 70, participacao_pct: 58.3 },
    { nome: 'Bruno', mensagens: 50, participacao_pct: 41.7 },
  ],
  por_hora: [{ hora: '09h', mensagens: 40 }, { hora: '15h', mensagens: 80 }],
  por_dia: [{ dia: '2026-08-18', mensagens: 55 }, { dia: '2026-08-19', mensagens: 65 }],
  alertas: [], temas_ia: [], tempo_sem_atividade_h: 2,
  ...over,
});

const narrativa = (over: Partial<Narrativa> = {}): Narrativa => ({
  resumo: 'Volume concentrado à tarde.',
  alertas: [{ titulo: 'Fila às 15h', explicacao: 'Pico de demanda.', severidade: 'alta' }],
  recomendacoes: ['Reforçar escala no turno da tarde.'],
  ...over,
});

describe('montarMarkdown — estrutura padronizada', () => {
  it('emite sempre as mesmas sete seções, na mesma ordem', () => {
    const md = montarMarkdown(dossie(), narrativa());
    const secoes = [...md.matchAll(/^## (\d)\. (.+)$/gm)].map((m) => m[0]);
    assert.deepEqual(secoes, [
      '## 1. Indicadores',
      '## 2. Leitura executiva',
      '## 3. Composição das interações',
      '## 4. Desempenho por participante',
      '## 5. Distribuição no tempo',
      '## 6. Alertas',
      '## 7. Recomendações',
    ]);
  });

  it('mantém a numeração das seções mesmo sem narrativa da IA', () => {
    // O modelo pode falhar ou devolver lixo; o esqueleto não pode encolher,
    // senão o relatório da semana não bate com o da semana passada.
    const md = montarMarkdown(dossie(), { resumo: '', alertas: [], recomendacoes: [] });
    assert.equal([...md.matchAll(/^## \d\./gm)].length, 7);
    assert.match(md, /_Sem leitura disponível\._/);
    assert.match(md, /_Nenhum alerta identificado no período\._/);
  });

  it('não inventa número: todo inteiro dos gráficos vem do dossiê', () => {
    const d = dossie();
    const md = montarMarkdown(d, narrativa());
    const legitimos = new Set([
      ...d.por_tipo.map((x) => x.total), ...d.por_origem.map((x) => x.total),
      ...d.por_participante.map((x) => x.mensagens),
      ...d.por_hora.map((x) => x.mensagens), ...d.por_dia.map((x) => x.mensagens),
    ]);
    for (const bloco of md.match(/```mermaid[\s\S]*?```/g) ?? []) {
      for (const m of bloco.matchAll(/:\s*(\d+)\s*$/gm)) {
        assert.ok(legitimos.has(Number(m[1])), `valor ${m[1]} não existe no dossiê`);
      }
    }
  });

  it('omite gráfico de uma fatia só — pizza com 100% não informa nada', () => {
    const md = montarMarkdown(
      dossie({ por_tipo: [{ tipo: 'texto', total: 120 }], por_origem: [{ origem: 'upload', total: 120 }] }),
      narrativa());
    assert.ok(!md.includes('pie title Mensagens por tipo'));
    assert.match(md, /mesmo tipo e da mesma origem/);
  });

  it('escapa aspas do nome do participante — quebrariam o parser do Mermaid', () => {
    const md = montarMarkdown(
      dossie({ por_participante: [
        { nome: 'Ana "A" Silva', mensagens: 70, participacao_pct: 58.3 },
        { nome: 'Bruno', mensagens: 50, participacao_pct: 41.7 }] }),
      narrativa());
    const pizza = (md.match(/```mermaid\npie title Participação[\s\S]*?```/) ?? [''])[0];
    assert.ok(pizza.length > 0);
    // Dentro do bloco, aspas só podem existir como delimitador do rótulo.
    for (const linha of pizza.split('\n').filter((l) => l.includes(' : '))) {
      assert.equal((linha.match(/"/g) ?? []).length, 2, `aspas sobrando em: ${linha}`);
    }
  });

  it('degrada sem dado sem quebrar a numeração', () => {
    const vazio = dossie({
      totais: { mensagens: 0, participantes: 0, dias_com_atividade: 0, media_por_dia: 0 },
      por_tipo: [], por_origem: [], por_participante: [], por_hora: [], por_dia: [],
    });
    const md = montarMarkdown(vazio, { resumo: 'Sem base.', alertas: [], recomendacoes: [] });
    assert.match(md, /## 1\. Indicadores/);
    assert.match(md, /## 6\. Alertas/);
    assert.ok(!md.includes('```mermaid'), 'não deve desenhar gráfico vazio');
  });

  it('neutraliza pipe no alerta — senão destrói a tabela Markdown', () => {
    const md = montarMarkdown(dossie(), narrativa({
      alertas: [{ titulo: 'a | b | c', explicacao: 'x | y', severidade: 'media' }],
    }));
    const linha = md.split('\n').find((l) => l.includes('🟡'))!;
    assert.ok(linha, 'a linha do alerta deve existir');
    // 3 colunas => 4 pipes. Se o pipe vindo do modelo vazasse, seriam 7.
    assert.equal((linha.match(/\|/g) ?? []).length, 4, `colunas a mais em: ${linha}`);
    assert.ok(!md.includes('a | b'), 'o pipe cru não pode sobreviver');
  });
});

describe('interpretarNarrativa', () => {
  it('lê JSON limpo', () => {
    const n = interpretarNarrativa(JSON.stringify({
      resumo: 'ok', alertas: [{ titulo: 't', explicacao: 'e', severidade: 'alta' }],
      recomendacoes: ['r'],
    }));
    assert.equal(n.resumo, 'ok');
    assert.equal(n.alertas[0].severidade, 'alta');
  });

  it('extrai o JSON quando o modelo embrulha em prosa e cerca de crase', () => {
    const n = interpretarNarrativa('Claro! Segue:\n```json\n{"resumo":"x","alertas":[],"recomendacoes":[]}\n```\nEspero ter ajudado.');
    assert.equal(n.resumo, 'x');
  });

  it('vira resumo quando não há JSON algum — não perde o trabalho do modelo', () => {
    const n = interpretarNarrativa('O grupo está estável.');
    assert.equal(n.resumo, 'O grupo está estável.');
    assert.deepEqual(n.alertas, []);
  });

  it('normaliza severidade inválida em vez de propagar para o template', () => {
    const n = interpretarNarrativa('{"resumo":"","alertas":[{"titulo":"t","severidade":"CRÍTICA"}],"recomendacoes":[]}');
    assert.equal(n.alertas[0].severidade, 'media');
  });

  it('descarta alerta sem título e limita recomendações a 3', () => {
    const n = interpretarNarrativa(JSON.stringify({
      resumo: '', alertas: [{ explicacao: 'órfã' }, { titulo: 'boa' }],
      recomendacoes: ['a', 'b', 'c', 'd', 'e'],
    }));
    assert.equal(n.alertas.length, 1);
    assert.equal(n.alertas[0].titulo, 'boa');
    assert.equal(n.recomendacoes.length, 3);
  });
});
