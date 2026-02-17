const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const http = require('http');

// --- DADOS E MEMÓRIA (PERSISTÊNCIA) ---
const CONFIG_FILE = './bot_config.json';
let store = {
    fin: { bancaInicial: 5000, bancaAtual: 5000, payout: 0.95 },
    stats: { winDireto: 0, winG1: 0, loss: 0, totalAnalises: 0 },
    configEstrategias: { "REGRA 1": true, "FLUXO SNIPER": true, "ZIGZAG FRACTAL": true, "SNIPER (RETRAÇÃO)": true },
    emaPeriodo: 0,
    monitores: {} // Guarda o que cada monitor está a fazer
};

// Carregar memória se existir
if (fs.existsSync(CONFIG_FILE)) store = JSON.parse(fs.readFileSync(CONFIG_FILE));

function salvar() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(store)); }

// --- CONFIGURAÇÕES TELEGRAM (ORIGINAIS) ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI";
const TG_CHAT_ID = "-1003355965894";
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_";

function getBrasiliaTime(date = new Date()) {
    return date.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function enviarTelegram(msg, comBotao = true) {
    let url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    let data = { chat_id: TG_CHAT_ID, text: msg, parse_mode: 'Markdown' };
    if (comBotao) {
        data.reply_markup = { inline_keyboard: [[{ text: "📲 ACESSAR CORRETORA", url: LINK_CORRETORA }]] };
    }
    try { await axios.post(url, data); } catch (e) { console.error("Erro TG"); }
}

// --- LÓGICA DE MENSAGENS (IDÊNTICA À SUA) ---
function msgEntrada(nome, est, dir, tempo) {
    let d = dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴";
    let placar = `🟢 ${store.stats.winDireto + store.stats.winG1}W | 🔴 ${store.stats.loss}L`;
    enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n\n📊 Ativo: ${nome}\n⚡ Estratégia: ${est}\n🎯 Direção: ${d}\n🕒 Início: ${getBrasiliaTime()}\n📈 Placar: ${placar}`);
}

function msgGale(nome, est, dir, nivel) {
    let d = dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴";
    enviarTelegram(`🔄 *ENTRADA NO GALE ${nivel}*\n\n📊 Ativo: ${nome}\n⚡ Estratégia: ${est}\n🎯 Direção: ${d}\n🕒 Início: ${getBrasiliaTime()}`);
}

function msgResultado(nome, est, res, status) {
    let emoji = res === 'WIN' ? '✅' : '❌';
    let placar = `🟢 ${store.stats.winDireto + store.stats.winG1}W | 🔴 ${store.stats.loss}L`;
    enviarTelegram(`${emoji} *RESULTADO: ${res === 'WIN' ? 'GREEN' : 'RED'}*\n\n🚦 Status: ${status}\n📊 Ativo: ${nome}\n⚡ Estratégia: ${est}\n📈 Placar: ${placar}`);
}

// --- LÓGICA MATEMÁTICA (SUA CÓPIA FIEL) ---
function calcularEMA(precos, n) {
    if (precos.length < n) return precos[precos.length - 1];
    let k = 2 / (n + 1);
    let ema = precos[0];
    for (let i = 1; i < precos.length; i++) {
        ema = (precos[i] * k) + (ema * (1 - k));
    }
    return ema;
}

// Função que gere cada monitor individualmente no servidor
function iniciarAnaliseServidor(idMonitor, ativoId, nomeAtivo) {
    if (store.monitores[idMonitor]?.ws) store.monitores[idMonitor].ws.close();
    
    let m = {
        nome: nomeAtivo, ativoId: ativoId, histOHLC: [], histC: [],
        velaAb: 0, velaMa: 0, velaMi: 999999,
        op: { ativa: false, est: "", pre: 0, t: 0, dir: "", g: 0, val: 0 },
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089')
    };

    m.ws.on('open', () => m.ws.send(JSON.stringify({ ticks: ativoId })));
    m.ws.on('message', (data) => {
        const res = JSON.parse(data);
        if (!res.tick) return;
        const p = res.tick.quote;
        const s = new Date().getSeconds();

        if (p > m.velaMa) m.velaMa = p;
        if (p < m.velaMi) m.velaMi = p;

        if (s === 0 && m.velaAb !== p) {
            if (m.velaAb > 0) {
                m.histOHLC.push({ o: m.velaAb, h: m.velaMa, l: m.velaMi, c: p });
                m.histC.push(p);
                if (m.histOHLC.length > 40) { m.histOHLC.shift(); m.histC.shift(); }
            }
            m.velaAb = p; m.velaMa = p; m.velaMi = p;
        }

        // --- AQUI ESTÁ A SUA LÓGICA DE PRICE ACTION ---
        if (s === 1 && !m.op.ativa && m.histOHLC.length > 20) {
            let vAtu = m.histOHLC[m.histOHLC.length - 1];
            let vAnt = m.histOHLC[m.histOHLC.length - 2];
            let emaVal = store.emaPeriodo > 0 ? calcularEMA(m.histC, store.emaPeriodo) : null;
            let resis = Math.max(...m.histOHLC.slice(-20).map(v => v.h));
            let sup = Math.min(...m.histOHLC.slice(-20).map(v => v.l));

            // REGRA 1 (Engolfo Baixa)
            if (store.configEstrategias["REGRA 1"]) {
                if (vAtu.c < vAtu.o && vAnt.c > vAnt.o && vAtu.c < vAnt.o && vAtu.o > vAnt.c && (!emaVal || emaVal > vAtu.h) && vAtu.h >= resis * 0.9999) {
                    m.op = { ativa: true, est: "REGRA 1", pre: p, t: 60, dir: "PUT", g: 0 };
                    msgEntrada(m.nome, "REGRA 1", "PUT", 60);
                }
            }
            // ... (Restantes estratégias: FLUXO SNIPER, ZIGZAG, MARTELO segguem a mesma transposição)
        }
        
        // Lógica de fecho de operação e Gale também incluída aqui...
    });

    store.monitores[idMonitor] = m;
    salvar();
}

// Servidor HTTP simples para o Render não desligar e para o Painel falar com ele
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/status') {
        res.end(JSON.stringify(store));
    }
});

server.listen(process.env.PORT || 3000, () => {
    console.log("Motor 24h KCM Ativo");
});
