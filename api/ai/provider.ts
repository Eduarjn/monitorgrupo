/**
 * whatsapp-monitor — Fase 5: a fronteira com a IA.
 *
 * TODA chamada de modelo do projeto passa por esta interface. É o único lugar
 * que sabe qual provedor está em uso — trocar OpenAI ↔ Claude é implementar
 * `AIProvider` de novo e mudar uma linha em `criarProvider()`.
 *
 * Existe também um `MockProvider` determinístico: ele permite testar blocos,
 * resumo e RAG inteiros sem chave e sem gastar token. Não é enfeite — é o que
 * torna a lógica testável em CI.
 */

// ------------------------------------------------------------------ contrato

export interface TrechoContexto {
  bloco_id: number;
  inicio_em: string;
  fim_em: string;
  texto: string;
}

export interface AIProvider {
  readonly nome: string;
  /** Dimensão do vetor — precisa casar com `blocos.embedding vector(N)`. */
  readonly dimensaoEmbedding: number;

  /** Resumo dos tópicos de um período. */
  summarize(texto: string, instrucao?: string): Promise<string>;

  /** Embeddings em lote (economiza chamadas). */
  embed(textos: string[]): Promise<number[][]>;

  /** Responde a pergunta USANDO SÓ os trechos recuperados. */
  answer(pergunta: string, contexto: TrechoContexto[]): Promise<string>;
}

// ------------------------------------------------------------------- custos
/**
 * Preços de referência (USD). Ficam aqui para o cálculo de estimativa não se
 * espalhar pelo código. Confirmar antes de faturar — tabela muda.
 */
export const PRECOS = {
  'text-embedding-3-small': { porMilhaoTokens: 0.02 },
  'gpt-4o-mini': { entradaPorMilhao: 0.15, saidaPorMilhao: 0.60 },
} as const;

/** Aproximação suficiente para estimativa: ~4 caracteres por token em pt-BR. */
export function estimarTokens(texto: string): number {
  return Math.ceil(texto.length / 4);
}

// -------------------------------------------------------------- prompt do RAG
/**
 * Regra central da busca: o modelo responde SÓ com o que foi recuperado. Sem
 * isso ele completa lacunas com invenção — num painel de gestão, inventar o que
 * a equipe disse é pior que não responder.
 */
export const PROMPT_RAG = `Você responde perguntas sobre o histórico de um grupo de WhatsApp.

Regras:
- Use EXCLUSIVAMENTE os trechos fornecidos. Não complete com conhecimento próprio.
- Se os trechos não contiverem a resposta, diga exatamente: "Não encontrei isso no histórico recuperado."
- Cite as datas dos trechos em que se baseou.
- Responda em português do Brasil, de forma direta.`;

export const PROMPT_RESUMO = `Resuma a conversa deste grupo de WhatsApp.

Regras:
- Liste os tópicos tratados, do mais relevante ao menos.
- Destaque decisões, pendências e quem ficou responsável por quê.
- Não invente nada que não esteja na conversa.
- Português do Brasil, formato de tópicos curtos.`;

// ------------------------------------------------------------------- OpenAI

export interface OpcoesOpenAI {
  apiKey: string;
  modeloTexto?: string;
  modeloEmbedding?: string;
  baseUrl?: string;
}

export class OpenAIProvider implements AIProvider {
  readonly nome = 'openai';
  readonly dimensaoEmbedding = 1536;   // text-embedding-3-small

  private readonly apiKey: string;
  private readonly modeloTexto: string;
  private readonly modeloEmbedding: string;
  private readonly baseUrl: string;

  constructor(o: OpcoesOpenAI) {
    if (!o.apiKey) throw new Error('OpenAIProvider exige apiKey.');
    this.apiKey = o.apiKey;
    this.modeloTexto = o.modeloTexto ?? 'gpt-4o-mini';
    this.modeloEmbedding = o.modeloEmbedding ?? 'text-embedding-3-small';
    this.baseUrl = o.baseUrl ?? 'https://api.openai.com/v1';
  }

  private async post<T>(caminho: string, corpo: unknown): Promise<T> {
    const resp = await fetch(this.baseUrl + caminho, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      throw new Error(`OpenAI ${caminho}: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
    }
    return resp.json() as Promise<T>;
  }

  async summarize(texto: string, instrucao = PROMPT_RESUMO): Promise<string> {
    const r = await this.post<{ choices: Array<{ message: { content: string } }> }>(
      '/chat/completions',
      {
        model: this.modeloTexto,
        messages: [
          { role: 'system', content: instrucao },
          { role: 'user', content: texto },
        ],
        temperature: 0.2,
      },
    );
    return r.choices[0]?.message?.content?.trim() ?? '';
  }

  async embed(textos: string[]): Promise<number[][]> {
    if (!textos.length) return [];
    const r = await this.post<{ data: Array<{ embedding: number[]; index: number }> }>(
      '/embeddings',
      { model: this.modeloEmbedding, input: textos },
    );
    // a API pode devolver fora de ordem; reordenar pelo index é obrigatório
    return r.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async answer(pergunta: string, contexto: TrechoContexto[]): Promise<string> {
    const trechos = contexto
      .map((c, i) => `[${i + 1}] ${c.inicio_em.slice(0, 16).replace('T', ' ')} — ${c.texto}`)
      .join('\n\n');
    return this.summarize(`Trechos recuperados:\n\n${trechos}\n\nPergunta: ${pergunta}`, PROMPT_RAG);
  }
}

// ------------------------------------------------------------------- Gemini

export interface OpcoesGemini {
  apiKey: string;
  modeloTexto?: string;
  modeloEmbedding?: string;
  baseUrl?: string;
}

/**
 * Google Gemini.
 *
 * Escolhido em 17/08/2026 por duas razões concretas, não por preferência:
 *
 * 1. `gemini-embedding-001` aceita `outputDimensionality`, e 1536 é um dos
 *    tamanhos recomendados — exatamente a dimensão que `blocos.embedding` já
 *    usa. Trocar de provedor não exige migração de coluna nem recriar o índice
 *    HNSW. Verificado contra a API real antes de escrever este código.
 * 2. Saída estruturada por schema JSON, que é o que a análise estilo Gong
 *    precisa (`api/ai/analise.ts`). O JSON vem sintaticamente válido por
 *    construção — os VALORES ainda são validados por `interpretarResposta`.
 */
export class GeminiProvider implements AIProvider {
  readonly nome = 'gemini';
  readonly dimensaoEmbedding = 1536;

  private readonly apiKey: string;
  private readonly modeloTexto: string;
  private readonly modeloEmbedding: string;
  private readonly baseUrl: string;

  constructor(o: OpcoesGemini) {
    if (!o.apiKey) throw new Error('GeminiProvider exige apiKey.');
    this.apiKey = o.apiKey;
    this.modeloTexto = o.modeloTexto ?? 'gemini-3.6-flash';
    this.modeloEmbedding = o.modeloEmbedding ?? 'gemini-embedding-001';
    this.baseUrl = o.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  /**
   * O 503 do Gemini é declaradamente temporário ("high demand"), e o 429 é o
   * teto do free tier se recompondo. Sem retentativa, um pico do Google faria
   * a análise daquela janela se perder para sempre — a rotina roda uma vez por
   * gatilho e não volta. Backoff exponencial, três tentativas.
   */
  private async post<T>(caminho: string, corpo: unknown, tentativa = 1): Promise<T> {
    const resp = await fetch(`${this.baseUrl}${caminho}`, {
      method: 'POST',
      // A chave vai no header, não na query string: em URL ela vaza para log de
      // proxy e histórico de shell.
      headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      const txt = (await resp.text()).slice(0, 300);
      const transitorio = resp.status === 503 || resp.status === 429 || resp.status >= 500;
      if (transitorio && tentativa < 3) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (tentativa - 1)));
        return this.post<T>(caminho, corpo, tentativa + 1);
      }
      if (resp.status === 429) throw new Error(`Gemini: limite de uso atingido (429). ${txt}`);
      if (resp.status === 503) throw new Error('Gemini está sobrecarregado. Tente de novo em alguns minutos.');
      throw new Error(`Gemini ${caminho}: HTTP ${resp.status} — ${txt}`);
    }
    return resp.json() as Promise<T>;
  }

  async summarize(texto: string, instrucao = PROMPT_RESUMO): Promise<string> {
    // A análise (analise.ts) manda um prompt que já pede JSON. Detectar isso
    // aqui permite ligar a saída estruturada sem mudar a interface de todos os
    // chamadores — que é o ponto da fronteira única de IA.
    const querJson = /Responda SOMENTE com JSON/i.test(instrucao);
    const r = await this.post<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }>(
      `/models/${this.modeloTexto}:generateContent`,
      {
        systemInstruction: { parts: [{ text: instrucao }] },
        contents: [{ role: 'user', parts: [{ text: texto }] }],
        generationConfig: {
          temperature: 0.2,
          ...(querJson ? { responseMimeType: 'application/json' } : {}),
        },
      },
    );
    return r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() ?? '';
  }

  async embed(textos: string[]): Promise<number[][]> {
    if (!textos.length) return [];
    // batchEmbedContents: uma chamada por lote em vez de uma por texto — o
    // /indexar de um grupo grande faria centenas de requisições sem isto.
    const r = await this.post<{ embeddings?: Array<{ values: number[] }> }>(
      `/models/${this.modeloEmbedding}:batchEmbedContents`,
      {
        requests: textos.map((t) => ({
          model: `models/${this.modeloEmbedding}`,
          content: { parts: [{ text: t }] },
          outputDimensionality: this.dimensaoEmbedding,
        })),
      },
    );
    const vetores = (r.embeddings ?? []).map((e) => e.values);
    if (vetores.length !== textos.length) {
      throw new Error(`Gemini devolveu ${vetores.length} embeddings para ${textos.length} textos.`);
    }
    // Falha alto em vez de gravar vetor de dimensão errada: a coluna é
    // vector(1536) e o erro do Postgres seria bem menos claro que este.
    const errada = vetores.find((v) => v.length !== this.dimensaoEmbedding);
    if (errada) {
      throw new Error(`Gemini devolveu embedding de ${errada.length} dimensões, esperado ${this.dimensaoEmbedding}.`);
    }
    return vetores;
  }

  async answer(pergunta: string, contexto: TrechoContexto[]): Promise<string> {
    const trechos = contexto
      .map((c, i) => `[${i + 1}] ${c.inicio_em.slice(0, 16).replace('T', ' ')} — ${c.texto}`)
      .join('\n\n');
    return this.summarize(`Trechos recuperados:\n\n${trechos}\n\nPergunta: ${pergunta}`, PROMPT_RAG);
  }
}

// --------------------------------------------------------------------- mock

/**
 * Provider determinístico para desenvolvimento e testes.
 *
 * O embedding é um "saco de palavras" projetado num vetor fixo por hash — não
 * tem semântica real, mas tem a propriedade que os testes precisam: textos que
 * compartilham palavras ficam próximos no cosseno. Isso valida o pipeline
 * (janelas, gravação, ORDER BY distância, citação das fontes) sem chave.
 */
export class MockProvider implements AIProvider {
  readonly nome = 'mock';
  readonly dimensaoEmbedding: number;
  public chamadas = { summarize: 0, embed: 0, answer: 0 };

  constructor(dimensao = 1536) {
    this.dimensaoEmbedding = dimensao;
  }

  async summarize(texto: string): Promise<string> {
    this.chamadas.summarize++;
    const linhas = texto.split('\n').filter((l) => l.trim()).length;
    return `[resumo simulado] ${linhas} linha(s), ${texto.length} caracteres.`;
  }

  async embed(textos: string[]): Promise<number[][]> {
    this.chamadas.embed++;
    return textos.map((t) => this.vetor(t));
  }

  async answer(pergunta: string, contexto: TrechoContexto[]): Promise<string> {
    this.chamadas.answer++;
    if (!contexto.length) return 'Não encontrei isso no histórico recuperado.';
    const datas = contexto.map((c) => c.inicio_em.slice(0, 10)).join(', ');
    return `[resposta simulada] "${pergunta}" — ${contexto.length} trecho(s) de ${datas}.`;
  }

  private vetor(texto: string): number[] {
    const v = new Array(this.dimensaoEmbedding).fill(0);
    for (const palavra of texto.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 2166136261;                                   // FNV-1a
      for (let i = 0; i < palavra.length; i++) {
        h ^= palavra.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[Math.abs(h) % this.dimensaoEmbedding] += 1;
    }
    const norma = Math.hypot(...v) || 1;                    // normaliza p/ cosseno
    return v.map((x) => x / norma);
  }
}

// ------------------------------------------------------------------- fábrica

/**
 * Sem chave nenhuma o projeto roda no mock — nunca quebra por falta de config.
 *
 * Gemini vem primeiro por ser o único que devolve embedding de 1536 dimensões
 * sem custo: trocar para ele não exige tocar em `blocos.embedding`.
 * `IA_PROVIDER` força um específico quando houver mais de uma chave presente.
 */
export function criarProvider(env: Record<string, string | undefined> = process.env): AIProvider {
  const forcado = (env.IA_PROVIDER ?? '').toLowerCase();

  if (forcado === 'mock') return new MockProvider();
  if ((forcado === 'gemini' || !forcado) && env.GEMINI_API_KEY) {
    return new GeminiProvider({ apiKey: env.GEMINI_API_KEY, modeloTexto: env.GEMINI_MODELO_TEXTO });
  }
  if ((forcado === 'openai' || !forcado) && env.OPENAI_API_KEY) {
    return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, modeloTexto: env.OPENAI_MODELO_TEXTO });
  }
  return new MockProvider();
}
