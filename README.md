# Bomber Animals — protótipo HTML5

Protótipo jogável inspirado no loop clássico de arena com bombas, usando os sprites enviados.

## Rodar
Abra `index.html` em um navegador moderno. Para evitar restrições de alguns navegadores ao carregar assets locais, o ideal é servir a pasta:

```bash
python -m http.server 8080
```

e abrir `http://localhost:8080`.

## Controles
- Desktop: WASD ou setas
- Bomba: Espaço
- Mobile: D-pad e botão de bomba na tela

## Personagens atuais
- Cão — velocidade base 172, alcance 2, vida 3; começa com capacidade para 2 bombas.
- Gato — velocidade 205, alcance 2, vida 2; chuta bombas desde o início.
- Calopsita — velocidade 184, alcance 3, vida 2; atravessa bombas.

## Layout dos sprites de animais
Atlas otimizado: 8 colunas × 5 linhas, cada célula 96×96.

- linha 1: colunas 1–4 = baixo; 5–8 = cima
- linha 2: colunas 1–4 = esquerda; 5–8 = direita
- linha 3: mesmo padrão da linha 1 com bomba na mão
- linha 4: mesmo padrão da linha 2 com bomba na mão
- linha 5: morte, frames 1–6

## Layout do sprite da bomba
- linha 1: contagem/inchaço
- linha 2: esquerda (1–4), direita (5–8)
- linha 3: cima (1–4), baixo (5–8)
- linha 4: explosão
- linha 5: contagem da super bomba + efeito verde adicional em runtime

## Como adicionar outro animal
1. Coloque `assets/novoanimal.png` no mesmo layout 8×5.
2. Adicione o nome em `assetNames` no `game.js`.
3. Crie a entrada correspondente em `SPECIES`.

O motor lê animações por linha/coluna; portanto não precisa alterar o renderer para cada espécie.
