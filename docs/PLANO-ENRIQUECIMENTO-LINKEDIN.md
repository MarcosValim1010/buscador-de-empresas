# Plano de implementação — enriquecimento de empresas e profissionais

Data: 13/10/2026. Status: planejamento; nenhuma alteração funcional ou implantação realizada nesta etapa.

## 1. Escopo confirmado e decisões propostas

O usuário entra no CRM com o login existente, busca empresas, seleciona até **3 empresas**, encontra profissionais ligados a elas, consulta os resultados e baixa uma planilha pelo próprio CRM. Não haverá envio por e-mail nem um novo login para o cliente.

**Escolha confirmada pelo usuário:** buscar profissionais em geral, com filtro por cargo; não limitar a decisores.

Propostas para o piloto, configuráveis e ainda não decisões comerciais:

- Até 10 profissionais por empresa e até 30 por lote. Isso é um teto operacional, não uma promessa de encontrar essa quantidade ou todos os funcionários.
- Vínculos atuais como padrão; opção explícita para incluir anteriores, sempre identificados.
- Cargo opcional, permitindo vários termos com correspondência OU. Normalizar maiúsculas e acentos; sinônimos explícitos e editáveis, sem equiparar cargos diferentes silenciosamente.
- Cache de até 7 dias por conta e fonte, sujeito à licença da fonte. Mostrar a data real da coleta.
- Um trabalho ativo por conta e concorrência inicial de um navegador no worker, caso a fonte use navegador. Ajustar após medir capacidade e limites da fonte.
- Sem cobrança financeira no MVP. Preparar cotas e registro de consumo para planos pagos.

Fora do MVP: envio de mensagens, convites, disparos de e-mail, coleta de dados sensíveis, garantia de telefone/e-mail pessoal, busca irrestrita de todos os funcionários, pagamentos e importação de planilhas como entrada deste fluxo.

## 2. Mapeamento do CRM existente

| Área | Situação encontrada no código local | Mudança necessária |
| --- | --- | --- |
| Login | JWT, `accounts`, `account_users`, conta ativa e planos `trial`/`paid` | Reutilizar; identificar também o usuário executor e validar seu estado ativo |
| Busca | `frontend/src/pages/BuscarEmpresas.jsx`, filtros e paginação | Checkboxes, seleção persistente entre páginas e contador de até 3 |
| API | Express/PostgreSQL em `backend/server.js` | Rotas autenticadas de trabalhos, resultados e exportação |
| Identificação de sites | `enrichment_site`, indexada por `cnpj_basico` | Reaproveitar domínio e site confirmado como evidências |
| Links sociais | Worker de sites grava `company_contact`, inclusive `linkedin` | Separar `/company/`, `/in/` e links de compartilhamento; validar associação |
| Enriquecimento no CRM | Rota `/crm/enriquecimento` ainda é um placeholder | Histórico, progresso, revisão da empresa e profissionais |
| Exportação | ExcelJS e limite de linhas por conta | Exportação própria com abas Empresas e Profissionais |
| Execução em segundo plano | Worker de sites independente | Novo worker com fila durável, retomada e isolamento de recursos |

O `confidence=100` de um link encontrado no site não prova que uma página do LinkedIn corresponde ao CNPJ. O JWT atual identifica a conta, mas não o usuário individual. Os limites de exportação existentes também não equivalem a créditos de enriquecimento.

Esta inspeção foi do código local: disponibilidade de dados, capacidade dos servidores e estado de produção precisam ser verificados antes da implantação.

## 3. O papel real do repositório enviado

O projeto recebe uma URL individual de perfil e usa Puppeteer com sessão `li_at` para extrair informações estruturadas. Ele não entrega, sozinho, o fluxo CNPJ → empresa correta → lista de profissionais. [Repositório e documentação](https://github.com/josephlimtech/linkedin-profile-scraper-api).

O pacote declara Puppeteer `^4.0.1` e TypeScript `^3.9.6`. Isso justifica tratá-lo como referência legada, não como integração pronta; seu funcionamento atual não foi testado nesta etapa. [Dependências](https://raw.githubusercontent.com/josephlimtech/linkedin-profile-scraper-api/master/package.json).

O código registra opções e cookie em logs, utiliza seletores de página específicos e valida URLs de forma insuficiente para uma API pública. Antes de qualquer adaptação, remover logs de credenciais, reforçar a validação de destinos, atualizar dependências e testar a extração com páginas atuais. [Código-fonte inspecionado](https://raw.githubusercontent.com/josephlimtech/linkedin-profile-scraper-api/master/src/index.ts).

Os termos do LinkedIn restringem scraping e automação não autorizada, incluindo cópia de perfis. Ter um cookie ou limitar o lote a 3 empresas não elimina essa restrição. Validar a permissão da fonte e os direitos de armazenamento/exportação antes do piloto. [Contrato do LinkedIn, seção 8](https://www.linkedin.com/legal/user-agreement).

**Decisão técnica proposta:** desacoplar descoberta e extração por conectores. Primeiro testar uma fonte com acesso autorizado ou licenciado; um extrator próprio baseado no repositório pode ser uma implementação do conector, condicionado à permissão e à prova técnica. Não assumir que qualquer API oficial oferece busca irrestrita de funcionários ou que um fornecedor tem autorização apenas por comercializar dados.

## 4. Fluxo funcional

```text
Login → busca de empresas → seleção de até 3 → filtro de cargo
  → criação do trabalho → identificação da empresa no LinkedIn
  → revisão, se ambígua → descoberta de perfis → extração e validação
  → resultados por empresa → exportação no CRM
```

### 4.1 Seleção e abertura do trabalho

1. Adicionar seleção por CNPJ completo, preservada entre páginas. Mostrar uma lista dos selecionados e botão para limpar; ao alterar filtros, manter a lista explicitamente visível.
2. Bloquear a quarta seleção. Não criar “selecionar todos” para a base inteira.
3. Abrir modal com cargos, tipo de vínculo, limite de profissionais e resumo do consumo máximo previsto.
4. Backend valida de 1 a 3 CNPJs distintos, conta ativa, acesso à funcionalidade e saldo. Recarrega razão social, fantasia, município e domínio no banco, sem confiar nesses campos enviados pelo navegador.
5. Responder `202 Accepted` com identificador. O trabalho continua se o usuário fechar a página; a tela consulta o progresso a cada 3–5 segundos enquanto estiver aberta.

O limite de três é aplicado antes de agrupar matriz/filiais. CNPJs com a mesma raiz podem reutilizar a descoberta, mas a interface deve informar “resultado no nível da empresa/grupo; filial não confirmada”. Mesmo domínio ou nome parecido não autoriza consolidar raízes diferentes automaticamente.

### 4.2 Identificação da empresa

Ordem de evidências: link corporativo no site confirmado → busca empresarial na fonte selecionada → correspondência de domínio, nome, localização e identificador corporativo da fonte.

Guardar candidatos, evidências, confiança e método de confirmação. Domínios compartilhados por grupos e franquias exigem atenção. Homônimos, candidatos conflitantes ou somente coincidência de nome entram em `needs_review`, sem extrair pessoas automaticamente.

Na revisão, permitir escolher um candidato ou informar uma URL corporativa válida. A confirmação é registrada por conta/usuário; não altera silenciosamente o cadastro global. Ausência de empresa correspondente gera estado próprio, não erro genérico.

### 4.3 Descoberta dos profissionais

Contrato do conector:

- `resolveCompany({ names, domain, location })`: candidatos e evidências.
- `searchPeople({ companyId, titles, employmentScope, cursor, limit })`: URLs/IDs, evidência de vínculo, paginação e cobertura.
- `getProfile({ profileUrl })`: campos estruturados, origem, data e status da extração.

A descoberta usa o identificador corporativo confirmado, filtro de vínculo e, quando suportado, cargo na própria fonte. Depois verifica novamente o vínculo no perfil. Busca textual apenas pelo nome da empresa não é suficiente para confirmar emprego atual.

Se a fonte não filtrar cargo, aplicar o filtro localmente e continuar paginando até atingir o teto ou um orçamento de busca separado. Registrar quando esse orçamento é atingido; dez perfis inspecionados não equivalem a dez resultados compatíveis. Não prometer resultados exaustivos.

Sem uma fonte capaz de descobrir profissionais, o repositório de perfis não fecha o produto: a primeira fase deve detectar isso. Entrada manual de URLs pode servir ao teste técnico, mas não substitui a descoberta automática prometida no MVP.

### 4.4 Extração, qualidade e exibição

Para cada URL nova ou cache vencido, extrair somente nome, URL, título profissional, cargo na empresa selecionada, localização, empresa/URL corporativa, datas de vínculo, origem e data de coleta. Resumo profissional é opcional; histórico extenso, educação e habilidades ficam fora da primeira entrega.

Separar o título do perfil do cargo comprovado na experiência. Classificar vínculo como atual, anterior ou não confirmado, preservando a evidência. Não inferir atualidade apenas porque a data de término está ausente; dados ambíguos permanecem não confirmados. Não inventar cargo, contato ou empresa quando faltar informação.

Deduplicar pelo ID da fonte ou URL canônica, nunca só pelo nome. Um profissional pode ter vários vínculos; manter perfil e vínculo em entidades distintas.

Exibir progresso e falha por empresa, resultados parciais, cache reutilizado, motivo de interrupção e cobertura. Diferenciar “nenhum resultado encontrado” de sessão inválida, bloqueio da fonte, falha de parser e orçamento esgotado.

## 5. Dados, fila e APIs

Novas tabelas propostas, em migração aditiva:

| Entidade | Conteúdo principal |
| --- | --- |
| `linkedin_company_matches` | Conta, raiz/CNPJs relacionados, empresa da fonte, evidências e revisão |
| `enrichment_jobs` | Conta, usuário, filtros, limites, idempotência, status e datas |
| `enrichment_job_companies` | Empresas do lote, progresso, erro, cursor e cobertura |
| `professional_profiles` | Conta, fonte, ID/URL normalizada, dados mínimos e validade do cache |
| `professional_employments` | Perfil, empresa confirmada, cargo, datas e certeza do vínculo |
| `enrichment_job_results` | Associação ao lote e versão/snapshot do resultado exibido |
| `account_enrichment_limits` | Habilitação, teto por lote, cota por período e concorrência |
| `enrichment_usage_ledger` | Reservas, consumo, liberação e chave única contra duplicação |

Todas as entidades operacionais carregam `account_id`; consultas e relações devem impedir referências cruzadas entre contas. Dados derivados e confirmações serão isolados por conta no MVP. Chave de cache inclui fonte/versão e perfil; cache de descoberta inclui empresa, cargos, vínculo e cobertura/paginação.

Usar PostgreSQL como fila inicial, com aquisição transacional via `FOR UPDATE SKIP LOCKED`, lease, heartbeat e recuperação de tarefas abandonadas. Transações curtas: nunca segurar lock durante navegação externa. Executar retries apenas para falhas transitórias, com atraso progressivo e limite; sessão inválida ou desafio de acesso suspende o conector para intervenção, sem tentativas de contorno.

Estados por empresa: `queued`, `resolving`, `needs_review`, `discovering`, `extracting`, `completed`, `partial`, `no_results`, `blocked`, `failed`, `cancelled`. O estado agregado do lote deriva dos estados das empresas; uma falha não descarta resultados das demais.

Rotas propostas:

- `POST /api/enrichment/jobs`: criar com `Idempotency-Key`; mesma chave e corpo reaproveitam o trabalho, corpo diferente retorna conflito.
- `GET /api/enrichment/jobs` e `GET /api/enrichment/jobs/:id`: histórico e progresso.
- `POST /api/enrichment/jobs/:id/companies/:companyId/confirm`: confirmar associação pendente.
- `GET /api/enrichment/jobs/:id/results`: profissionais, filtros e paginação.
- `GET /api/enrichment/jobs/:id/export`: XLSX com abas Empresas e Profissionais, CNPJ como texto, vínculo, fonte e data.
- `POST /api/enrichment/jobs/:id/cancel`: cancelar tarefas ainda pendentes e liberar reserva não utilizada.
- `GET /api/enrichment/usage`: cotas e consumo da conta.

Cada rota verifica autenticação, usuário/conta ativos e propriedade do recurso. Não aceitar `account_id` do cliente como autorização. Preservar `/api/export` e a busca existentes.

## 6. Preparação para planos pagos

Proposta de unidade: um perfil novo ou atualizado com dados mínimos válidos por conta. Cache ainda válido e retry do mesmo item não consomem crédito novamente. Vários vínculos do mesmo perfil no mesmo lote não duplicam consumo.

Reservar o máximo autorizado ao criar o lote, consumir de maneira atômica conforme resultados válidos e liberar sobra ao terminar, falhar ou cancelar. Reservas expiram de maneira controlada para trabalhos abandonados. Registrar custos/requisições da fonte separadamente: fornecedores podem cobrar buscas e respostas sem resultado, diferentemente da regra comercial do CRM.

Os limites vêm do banco a cada operação relevante, sem confiar no plano gravado no JWT. Adicionar `userId` ao token e validação correspondente com estratégia de transição/relogin; não presumir que todos os usuários são administradores. Configuração de credenciais permanece operacional, sem tela pública de administração no MVP.

## 7. Segurança e operação

- Credenciais exclusivamente no servidor/gerenciador de segredos; nunca no frontend, Git, URL de requisição ou logs. Não pedir cookies pelo CRM.
- Se houver navegador, worker separado da API, com limites de memória/CPU, timeouts, fechamento garantido de páginas e sandbox compatível com o ambiente.
- Validar protocolo HTTPS, hostname real e tipos de caminho aceitos; aplicar regras a redirecionamentos e tráfego de saída, bloqueando rede privada/metadados. Não validar destino por simples substring `linkedin.com`.
- Minimizar dados, definir retenção, exclusão e acesso auditado antes do piloto. Verificar direitos de uso/exportação e requisitos de privacidade aplicáveis com o responsável pelo produto.
- Registrar IDs de trabalho, duração, quantidade, cache e código de erro; não conteúdo integral dos perfis nem segredos.
- Medir fila, sucesso da associação, qualidade de vínculo, latência, consumo, erros de sessão/parser e impacto no banco.

## 8. Ordem de implementação e arquivos

| Fase | Entrega | Arquivos principais | Critério de saída |
| --- | --- | --- | --- |
| 0 — Viabilidade | Selecionar/testar fonte de descoberta e extrator; confirmar permissões, limites e custos | `backend/enrichment/providers/`, fixtures e relatório de prova | Encontrar profissionais de empresas conhecidas, incluindo homônimo e empresa sem presença; medir qualidade e falhas |
| 1 — Fundação | Migração, cotas, jobs, isolamento de conta, autenticação do executor | `backend/enrichment-schema.sql`, `backend/auth.js`, `backend/server.js`, módulos `backend/enrichment/` | Testes de isolamento, idempotência e reserva concorrente aprovados |
| 2 — Interface inicial | Seleção, modal, histórico e revisão de identidade | `BuscarEmpresas.jsx`, `lib/api.js`, `App.jsx`, novas páginas/componentes | Até 3 empresas, revisão clara, consulta retomada após fechar a tela; fonte simulada nos testes |
| 3 — Coleta real | Conectores, fila/worker, vínculo, cache e retomada | `backend/linkedin-enrichment-worker.js`, módulos de descoberta/extração | Lote real completo ou parcial, sem perda/duplicação após reiniciar worker |
| 4 — Resultados | Lista filtrável por cargo/empresa/vínculo e XLSX | Novas páginas de enriquecimento e serviço de exportação | Tela e planilha reproduzem os mesmos resultados e evidências |
| 5 — Piloto | Flag por conta, métricas, teste ponta a ponta e implantação gradual | Configuração operacional e checklist | Critérios abaixo aprovados e CRM existente sem regressão |

Não adicionar Puppeteer ao processo HTTP nem executar extração durante a requisição de criação. Não é necessário introduzir Redis no primeiro ciclo. Escolha de máquina e capacidade do worker depende da medição na fase 0.

## 9. Critérios de aceite e implantação

- Cliente e servidor recusam quatro empresas; CNPJs inválidos/duplicados têm tratamento explícito.
- Conta A não consulta, confirma, cancela ou exporta recursos da conta B.
- Homônimos exigem revisão; matriz/filiais não produzem certeza falsa sobre local de trabalho.
- Filtro de cargo funciona com acentos/caixa, múltiplos termos e filtros vazios; cargo atual não é confundido com cargo passado.
- Sessão expirada, desafio de acesso, mudança de HTML e timeout não viram “zero profissionais”.
- Duplo clique, retries concorrentes e reinício do worker não duplicam jobs, vínculos ou consumo.
- Cancelamento e conclusão parcial liberam apenas saldo reservado não utilizado, inclusive em corrida com o worker.
- Resultados persistem após fechar o navegador; exportação preserva CNPJ, origem, data e estado do vínculo, sem fórmulas injetadas por textos externos.
- Login, filtros atuais, busca e exportação existente continuam funcionando; build frontend e testes backend aprovados.

Implantação: revisar mudanças existentes no worktree → backup e migração aditiva → API com flag desabilitada → worker configurado → frontend → habilitar somente conta piloto → validar o fluxo real e monitorar. Não modificar Caddy/roteamento sem necessidade comprovada. Rollback: desabilitar a flag e interromper novas tarefas, preservando dados e reconciliando reservas pendentes.

## 10. Pendências antes da coleta em produção

1. Selecionar a fonte capaz de **descobrir pessoas por empresa**, confirmar direitos de uso e disponibilizar acesso por canal seguro. Essa é a dependência principal.
2. Validar as propostas de 10 perfis por empresa, cache de 7 dias e regra de crédito; ajustar conforme custo real e produto.
3. Definir retenção e responsável pela revisão de correspondências ambíguas.

A preferência por profissionais em geral com filtro por cargo já está confirmada. A primeira implementação deve começar pela prova de descoberta + extração, pois a interface, isoladamente, não valida a viabilidade do fluxo.
