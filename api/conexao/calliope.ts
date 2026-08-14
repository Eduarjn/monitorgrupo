/**
 * Canal de saída — disparo de template (HSM) pelo Omnichannel Calliope.
 *
 * Por que o Calliope e não a Cloud API da Meta: a ERA já opera este canal, com
 * token emitido e template aprovado. O Embedded Signup entregaria a mesma
 * mensagem depois de semanas de verificação de negócio e App Review, e mexeria
 * no número comercial vivo (D7). Aqui o lembrete sai hoje.
 *
 * Este módulo só ENVIA. Não existe leitura de grupo por API — nem aqui, nem em
 * lugar nenhum oficialmente (D7).
 */

import { sanitizar } from './cripto.ts';

export interface ConfigCalliope {
  endpoint: string;     // https://chat1.myuc2b.com:1443/api/v1/template/send
  token: string;        // em claro, já decifrado — nunca logar
  remetente?: string;   // agent / attendance_id
  template: string;     // nome do template aprovado
  idioma?: string;      // pt_BR
  /** 1 abre conversa nova; 0 só envia o template. */
  abrirConversa?: boolean;
}

export interface ResultadoEnvio {
  ok: boolean;
  status: number;
  /** Já sanitizado: seguro para gravar em `detalhe` e para logar. */
  detalhe: unknown;
  erro?: string;
}

/** Erro de rede/timeout vira resultado, não exceção: a rotina não pode morrer por um destino ruim. */
export async function enviarTemplate(
  cfg: ConfigCalliope,
  destino: string,
  variaveis: string[],
  timeoutMs = 15_000,
): Promise<ResultadoEnvio> {
  const corpo: Record<string, unknown> = {
    number: destino,
    template_name: cfg.template,
    language: cfg.idioma ?? 'pt_BR',
    hsm_placeholders: variaveis,
    is_hsm: cfg.abrirConversa === false ? 0 : 1,
  };
  if (cfg.remetente) {
    corpo.agent = cfg.remetente;
    corpo.attendance_id = cfg.remetente;
  }

  const cancelar = AbortSignal.timeout(timeoutMs);
  try {
    const resp = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(corpo),
      signal: cancelar,
    });

    const texto = await resp.text();
    let dados: unknown;
    try { dados = JSON.parse(texto); } catch { dados = { resposta: texto.slice(0, 400) }; }

    // ⚠️ A API do Calliope responde sucesso quase sempre; o erro real vem da
    // Meta e aparece no histórico de templates da plataforma. Por isso HTTP 200
    // aqui NÃO garante entrega — só garante que o disparo foi aceito.
    return {
      ok: resp.ok,
      status: resp.status,
      detalhe: sanitizar(dados),
      erro: resp.ok ? undefined : `O Calliope respondeu HTTP ${resp.status}.`,
    };
  } catch (e) {
    const err = e as Error;
    const expirou = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      detalhe: { tipo: err.name },
      erro: expirou
        ? `O Calliope não respondeu em ${timeoutMs / 1000}s.`
        : 'Não foi possível falar com o Calliope. Confira o endereço da API.',
    };
  }
}

/**
 * Texto do lembrete. As variáveis entram na ordem do template aprovado na Meta
 * — trocar a ordem aqui quebra a mensagem sem gerar erro de API.
 *
 * Ordem: 1) nome do grupo  2) há quanto tempo sem coleta.
 */
export function variaveisDoLembrete(nomeGrupo: string, diasSemColeta: number | null): string[] {
  const tempo = diasSemColeta == null
    ? 'ainda sem nenhuma coleta'
    : diasSemColeta === 0 ? 'menos de um dia'
    : diasSemColeta === 1 ? '1 dia'
    : `${diasSemColeta} dias`;
  return [nomeGrupo, tempo];
}

/**
 * Teste de configuração sem gastar mensagem: confere que o endpoint responde e
 * que o token não é recusado. Um POST de template para um destino real cobraria
 * e incomodaria alguém.
 */
export async function testarConexao(cfg: ConfigCalliope, timeoutMs = 10_000): Promise<ResultadoEnvio> {
  try {
    const resp = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      // Sem `number`: a intenção é ser recusado por falta de destino, não enviar.
      body: JSON.stringify({ template_name: cfg.template, teste: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, status: resp.status, detalhe: {}, erro: 'O token foi recusado pelo Calliope.' };
    }
    if (resp.status >= 500) {
      return { ok: false, status: resp.status, detalhe: {}, erro: `O Calliope respondeu HTTP ${resp.status}.` };
    }
    // 400 aqui é bom sinal: o endpoint existe e autenticou, só faltou destino.
    return { ok: true, status: resp.status, detalhe: { alcancavel: true } };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false, status: 0, detalhe: { tipo: err.name },
      erro: err.name === 'TimeoutError'
        ? 'O Calliope não respondeu a tempo.'
        : 'Endereço inalcançável. Confira a URL da API.',
    };
  }
}
