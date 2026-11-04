# Ensaio do script de rollout de `cea8960`

Nada aqui tocou o Arch, os containers, o banco ou os segredos reais. Os cenários rodaram em uma VM sem Docker, em um PostgreSQL descartável.

## O que é real e o que é simulado

| Parte                              | No ensaio                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| Script                             | `deploy/rollout-cea8960.sh`, mudando só SHAs, origem, espaço mínimo e tempo de espera |
| Comandos SQL                       | Reais, em PostgreSQL real                                                             |
| Migrations 001 a 010               | Os arquivos reais                                                                     |
| Automação                          | O código real de `cea8960`, gravando em banco real, com varredura a cada 2 s          |
| Restauração                        | Cópia do banco por `CREATE DATABASE ... TEMPLATE`, não um backup real                 |
| Docker e Compose                   | **Simulados** (`simulador/docker.txt`)                                                |
| `deploy/catus.sh` e `deploy/g4.sh` | **Simulados**, aplicando a migration real                                             |
| HTTPS e fontes                     | **Simulados** (`simulador/curl.txt`)                                                  |

## Resultado

`resultados.txt`: 83 cenários, todos com o desfecho esperado.

| Grupo                            | Cenários | Conferido                                                          |
| -------------------------------- | -------- | ------------------------------------------------------------------ |
| Autorização e sucesso            | 5        | `check` não muda nada; sem a autorização, nada roda                |
| Preflight                        | 33       | Nenhum backup, nenhum update, nenhuma migration, checkout no lugar |
| Backup e restauração             | 7        | Nenhum update, nenhuma migration, checkout em `75a9c14`            |
| Depois do update                 | 22       | Para antes do G4                                                   |
| Depois do G4 e verificação final | 8        | Sem declarar sucesso                                               |
| Rollback                         | 9        | Inclui retomar um rollback interrompido                            |

## Ajustes feitos durante o ensaio

- **No script:** um rollback interrompido ficava sem saída, porque o checkout já estava em `75a9c14`. Agora ele retoma.
- **Nos cenários:** três expectativas estavam erradas, porque o script parava em uma verificação anterior, ou o simulador não retirava a fonte. O cenário de alertas instáveis dependia de tempo e passou a ser determinístico; foi reexecutado sozinho, com o mesmo script.
- **Uma rodada inválida:** o disco da VM encheu, e essa rodada foi descartada. O número acima vem da rodada completa seguinte.

## O que continua sem prova

O formato real de saída do Docker e do Compose, o tempo real de build e migração, o backup e a restauração reais e o G4 sobre a instalação real. `check` prova a parte de leitura no próprio Arch, sem alterar nada.
