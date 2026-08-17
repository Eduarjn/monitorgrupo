import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, type Consentimento as Registro } from '../lib/api.ts';
import { Aviso, Botao, Card, Carregando, Titulo } from '../componentes/ui.tsx';

/**
 * Tela de LGPD. Não é enfeite: o registro é POR AVISO, com versão do texto e
 * base legal, porque "avisei uma vez" não se prova depois (risco 1.7).
 */

const MODELO = `Este grupo é monitorado pela ERA para fins de gestão.

As mensagens são armazenadas e analisadas por inteligência artificial para gerar \
resumos e estatísticas de atendimento. Nenhum conteúdo é compartilhado fora da \
empresa.

Você pode solicitar a exclusão das suas mensagens a qualquer momento pelo \
responsável do grupo.`;

export default function Consentimento({ grupo, grupoNome, podeGerir }: {
  grupo: number; grupoNome?: string; podeGerir: boolean;
}) {
  const [registros, setRegistros] = useState<Registro[] | null>(null);
  const [texto, setTexto] = useState(MODELO);
  const [versao, setVersao] = useState('v1');
  const [canal, setCanal] = useState('mensagem no grupo');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  const carregar = () =>
    api.consentimentos(grupo)
      .then((r) => setRegistros(r.consentimentos))
      .catch((e) => setErro((e as Error).message));

  useEffect(() => { setRegistros(null); carregar(); }, [grupo]);

  const registrar = async () => {
    setErro(''); setSalvando(true);
    try {
      await api.registrarConsentimento(grupo, { texto, versao_texto: versao, canal });
      await carregar();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="space-y-6">
      <Aviso>
        <div className="flex gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Os membros precisam ser avisados de que as conversas são analisadas por IA.
            Registre aqui o aviso enviado — com a data e o texto exato — para que fique
            comprovado o que foi comunicado e quando.
          </span>
        </div>
      </Aviso>

      {podeGerir && (
        <Card>
          {/* O nome do grupo no título não é enfeite: o aviso é gravado para o
              grupo do seletor do cabeçalho, e sem isso é fácil registrar no
              grupo errado sem perceber — foi o que aconteceu no primeiro uso. */}
          <Titulo sub="O texto abaixo é um modelo; ajuste antes de enviar ao grupo.">
            Registrar aviso para <span className="text-primary">{grupoNome ?? 'este grupo'}</span>
          </Titulo>
          <div className="space-y-3">
            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={8}
              className="w-full rounded-lg border border-border bg-white/5 p-3 text-sm outline-none
                         focus:border-primary/60 focus:ring-2 focus:ring-primary/25"
            />
            <div className="flex flex-wrap gap-3">
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">Versão</span>
                <input value={versao} onChange={(e) => setVersao(e.target.value)}
                       className="w-24 rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary/60" />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">Canal do aviso</span>
                <input value={canal} onChange={(e) => setCanal(e.target.value)}
                       className="w-56 rounded-lg border border-border bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary/60" />
              </label>
              <div className="flex items-end">
                <Botao onClick={registrar} disabled={salvando || !texto.trim()}>
                  {salvando ? 'Registrando…' : 'Registrar aviso'}
                </Botao>
              </div>
            </div>
            {erro && <Aviso tipo="erro">{erro}</Aviso>}
          </div>
        </Card>
      )}

      <Card>
        <Titulo sub="Histórico do que foi comunicado ao grupo.">Avisos registrados</Titulo>
        {!registros ? (
          <Carregando />
        ) : registros.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum aviso registrado ainda{podeGerir ? '.' : ' — peça ao gestor do grupo.'}
          </p>
        ) : (
          <div className="space-y-3">
            {registros.map((r) => (
              <div key={r.id} className="rounded-lg border border-border p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded bg-secondary px-2 py-0.5 font-medium">{r.versao_texto}</span>
                  <span>{new Date(r.consentido_em).toLocaleString('pt-BR')}</span>
                  <span>· base legal: {r.base_legal}</span>
                  {r.canal && <span>· via {r.canal}</span>}
                  {r.revogado_em && (
                    <span className="text-destructive">
                      · revogado em {new Date(r.revogado_em).toLocaleDateString('pt-BR')}
                    </span>
                  )}
                </div>
                <div className="whitespace-pre-wrap text-sm">{r.texto}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
