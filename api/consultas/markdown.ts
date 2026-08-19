/**
 * Montagem do relatório em Markdown — estrutura FIXA, feita por código.
 *
 * Antes, o modelo decidia o layout a cada geração: às vezes vinha com tabela,
 * às vezes sem; às vezes o gráfico era `pie`, às vezes `xychart`; a ordem das
 * seções variava. Relatório que muda de forma toda semana não serve para
 * comparar semana com semana — e comparar é justamente para o que ele existe.
 *
 * Agora o esqueleto é determinístico: mesmas seções, mesma ordem, mesmos
 * gráficos, sempre. A IA escreve apenas os três blocos que exigem julgamento —
 * leitura executiva, alertas e recomendações — e recebe o dossiê já apurado.
 *
 * Efeito colateral que importa: nenhum número do relatório passa pelo modelo.
 * Não é mais preciso conferir depois, porque não há como divergir.
 */

import type { Dossie } from './relatorio.ts';

export interface Narrativa {
  resumo: string;
  alertas: Array<{ titulo: string; explicacao: string; severidade: 'alta' | 'media' | 'baixa' }>;
  recomendacoes: string[];
}

const br = (n: number) => n.toLocaleString('pt-BR');
/** Aspas quebram o parser do Mermaid; o rótulo é dado do usuário. */
const rotulo = (s: string, max = 28) =>
  s.replace(/["\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || 'sem nome';

const SEVERIDADE = { alta: '🔴 Alta', media: '🟡 Média', baixa: '⚪ Baixa' } as const;

/**
 * Célula de tabela. Pipe e quebra de linha encerram a coluna no Markdown —
 * um nome de participante com "|" quebraria a tabela inteira.
 *
 * A limpeza mora AQUI, e não em quem produz o texto: a restrição é do formato,
 * então qualquer caminho que chegue à tabela fica protegido, inclusive os que
 * não passam pela leitura da narrativa da IA.
 */
const celula = (s: unknown, max = 300) =>
  String(s ?? '').replace(/[|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Pizza de composição. Omitida quando há uma fatia só — não informa nada. */
function pizza(titulo: string, itens: Array<{ rotulo: string; valor: number }>): string {
  const uteis = itens.filter((i) => i.valor > 0);
  if (uteis.length < 2) return '';
  return ['```mermaid', `pie title ${rotulo(titulo, 60)}`,
    ...uteis.map((i) => `  "${rotulo(i.rotulo)}" : ${i.valor}`), '```', ''].join('\n');
}

/**
 * Série temporal. `xychart-beta` é recente e nem todo visualizador suporta,
 * então vai acompanhada de uma tabela com os mesmos números — o relatório
 * continua legível mesmo onde o gráfico não renderiza.
 */
function serie(titulo: string, itens: Array<{ rotulo: string; valor: number }>): string {
  if (itens.length < 2) return '';
  const max = Math.max(...itens.map((i) => i.valor));
  return ['```mermaid', 'xychart-beta', `  title "${rotulo(titulo, 60)}"`,
    `  x-axis [${itens.map((i) => `"${rotulo(i.rotulo, 12)}"`).join(', ')}]`,
    `  y-axis "mensagens" 0 --> ${max}`,
    `  bar [${itens.map((i) => i.valor).join(', ')}]`, '```', ''].join('\n');
}

export function montarMarkdown(d: Dossie, n: Narrativa): string {
  const p: string[] = [];
  const semDados = d.totais.mensagens === 0;

  p.push(`# Relatório executivo — ${celula(d.grupo, 80)}`, '');
  p.push(`**Nicho:** ${celula(d.nicho, 60)}  `);
  p.push(`**Período:** ${d.periodo.inicio} a ${d.periodo.fim} (${d.periodo.dias} dias)  `);
  p.push(`**Gerado em:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '');
  p.push('---', '');

  // ---- 1. Indicadores -----------------------------------------------------
  p.push('## 1. Indicadores', '');
  p.push('| Indicador | Valor |', '| :--- | ---: |');
  p.push(`| Mensagens no período | ${br(d.totais.mensagens)} |`);
  p.push(`| Participantes ativos | ${br(d.totais.participantes)} |`);
  p.push(`| Dias com atividade | ${br(d.totais.dias_com_atividade)} de ${d.periodo.dias} |`);
  p.push(`| Média por dia ativo | ${br(d.totais.media_por_dia)} |`);
  if (d.tempo_sem_atividade_h != null) {
    p.push(`| Sem atividade há | ${br(d.tempo_sem_atividade_h)} h |`);
  }
  p.push('');

  // ---- 2. Leitura executiva (IA) -----------------------------------------
  p.push('## 2. Leitura executiva', '');
  p.push(n.resumo?.trim() || '_Sem leitura disponível._', '');

  if (!semDados) {
    // ---- 3. Composição ----------------------------------------------------
    p.push('## 3. Composição das interações', '');
    const porTipo = pizza('Mensagens por tipo',
      d.por_tipo.map((t) => ({ rotulo: t.tipo, valor: t.total })));
    const porOrigem = pizza('Mensagens por origem',
      d.por_origem.map((o) => ({ rotulo: o.origem === 'captura' ? 'tempo real' : 'upload', valor: o.total })));
    p.push(porTipo || porOrigem ||
      `Todas as ${br(d.totais.mensagens)} mensagens são do mesmo tipo e da mesma origem.\n`);
    if (porTipo && porOrigem) p.push(porOrigem);

    // ---- 4. Participação --------------------------------------------------
    p.push('## 4. Desempenho por participante', '');
    if (d.por_participante.length) {
      p.push('| # | Participante | Mensagens | Participação |',
             '| ---: | :--- | ---: | ---: |');
      d.por_participante.forEach((x, i) => {
        p.push(`| ${i + 1} | ${celula(x.nome, 60)} | ${br(x.mensagens)} | ${x.participacao_pct}% |`);
      });
      p.push('');
      p.push(pizza('Participação por pessoa',
        d.por_participante.slice(0, 8).map((x) => ({ rotulo: x.nome, valor: x.mensagens }))));
    } else {
      p.push('_Sem participantes no período._', '');
    }

    // ---- 5. Distribuição no tempo ----------------------------------------
    p.push('## 5. Distribuição no tempo', '');
    p.push(serie('Mensagens por dia', d.por_dia.slice(-14).map((x) => ({ rotulo: x.dia.slice(5), valor: x.mensagens }))));
    p.push(serie('Mensagens por hora', d.por_hora.map((x) => ({ rotulo: x.hora, valor: x.mensagens }))));
    if (d.por_hora.length) {
      const pico = d.por_hora.reduce((a, b) => (b.mensagens > a.mensagens ? b : a));
      p.push(`Horário de maior movimento: **${pico.hora}**, com ${br(pico.mensagens)} mensagens.`, '');
    }
  }

  // ---- 6. Alertas (IA) ----------------------------------------------------
  p.push('## 6. Alertas', '');
  if (n.alertas?.length) {
    p.push('| Severidade | Alerta | Por quê |', '| :--- | :--- | :--- |');
    for (const a of n.alertas) {
      p.push(`| ${SEVERIDADE[a.severidade] ?? celula(a.severidade, 20)} | ${celula(a.titulo, 120)} | ${celula(a.explicacao)} |`);
    }
    p.push('');
  } else {
    p.push('_Nenhum alerta identificado no período._', '');
  }

  // Alertas que a própria plataforma gerou em tempo real, sem passar pela IA
  // do relatório — vêm da análise de janela quente e já foram conferidos.
  if (d.alertas.length) {
    p.push('### Alertas registrados pela plataforma', '');
    p.push('| Quando | Tipo | Severidade | Assunto | Estado |',
           '| :--- | :--- | ---: | :--- | :--- |');
    for (const a of d.alertas.slice(0, 10)) {
      p.push(`| ${celula(a.criado_em).slice(0, 16).replace('T', ' ')} | ${celula(a.tipo, 30)} | ${a.severidade} | ${celula(a.titulo, 120)} | ${celula(a.estado, 20)} |`);
    }
    p.push('');
  }

  // ---- 7. Recomendações (IA) ---------------------------------------------
  p.push('## 7. Recomendações', '');
  if (n.recomendacoes?.length) {
    n.recomendacoes.forEach((r, i) => p.push(`${i + 1}. ${celula(r)}`));
  } else {
    p.push('_Sem recomendações._');
  }
  p.push('');

  p.push('---', '');
  p.push('> Números apurados diretamente no banco de dados da plataforma ERA. ' +
         'As seções 2, 6 e 7 são interpretação por IA sobre esses mesmos números.', '');

  return p.filter((x) => x !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');
}
