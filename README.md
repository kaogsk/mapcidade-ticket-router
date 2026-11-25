# MapCidade Ticket Router

Anonymized, from-scratch reconstruction of a real internal tool's architecture, built for a portfolio. Fictional data only ("MapCidade") — no real company, city, or infrastructure is represented here.

## English

### Problem

Municipal GIS helpdesks need to classify incoming tickets consistently and route them to available teams.

### Solution

The pipeline combines deterministic rules, SQLite full-text search and a pluggable classifier. Routing accounts for squad coverage, pauses and a human review queue.

### Stack

Node.js 22.13+, TypeScript, Express, SQLite FTS5, Vitest

### How to run

```sh
npm ci
npm test
npm run build
npm run lint
npm start
```

### Demo

Open http://127.0.0.1:4101 and preview one of three fictional tickets. The preview shows classification and routing. Set `POLLER_ENABLED=1` to exercise the engine against the in-memory helpdesk.

### What I learned

Ambiguous cases enter human review. Budget and duplicate-request controls limit classifier use. The demo serves a local preview UI and defaults to deterministic classification.

## Português

### Problema

Centrais de atendimento GIS precisam classificar chamados com consistência e encaminhá-los para equipes disponíveis.

### Solução

O pipeline combina regras determinísticas, busca textual no SQLite e um classificador intercambiável. O roteamento considera cobertura das equipes, pausas e revisão humana.

### Stack

Node.js 22.13+, TypeScript, Express, SQLite FTS5, Vitest

### Como rodar

Execute os comandos da seção em inglês a partir da raiz do projeto.

### Demo

Abra http://127.0.0.1:4101 e simule um dos três chamados fictícios. Defina `POLLER_ENABLED=1` para exercitar o motor com o helpdesk em memória.

### O que aprendi

Casos ambíguos seguem para revisão humana. Controles de orçamento e duplicidade limitam o uso do classificador. O demo oferece uma interface local de simulação e usa classificação determinística por padrão.

