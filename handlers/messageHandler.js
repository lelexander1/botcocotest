const economia = require('../commands/economia');
const moderacion = require('../commands/moderacion');
const ia = require('../commands/ia');
const utilidades = require('../commands/utilidades');
const tiktok = require('../commands/tiktok');
const hentaiAcciones = require('../commands/hentaiAcciones'); // <--- 1. Importado aquí

function createState() {
    return {
        cooldowns: new Map(),
        stickerSpamTracker: new Map(),
        stickerTimeouts: new Map(),
        propuestasMatrimonio: new Map(),
        encuestasDivorcio: new Map(),
        juiciosActivos: new Map(),
        triviaActiva: new Map(),
        mutedUsers: new Map(),
        chatHistoriales: new Map(),
        nsfwHabilitado: true,
        apiUsageStats: {
            geminiRequests: 0, totalPromptTokens: 0,
            totalCandidatesTokens: 0, totalTokensUsed: 0, coinGeckoRequests: 0
        },
        chistesPicantesList: [
            "Mi terapeuta dice que tengo problemas para dejar ir el pasado.\nMi ex dice que tengo problemas para dejar de escribirle a las 2am.",
            "El matrimonio es como un dispositivo Bluetooth: cuando ya está emparejado, se conecta automáticamente a los peores momentos posibles.",
            "Dicen que el dinero no compra la felicidad.\nTampoco compraba mi lealtad, pero aquí estamos, endeudado y sonriendo.",
            "A mi edad ya no tengo crisis existenciales, tengo suscripciones mensuales a ellas."
        ],
        verdadesList: [
            "¿Cuál fue la mentira más grande que le dijste a tu pareja para no verla?",
            "¿Cuál es el chat que borrarías si te quitaran el celular por 5 minutos?",
            "¿Cuál es la excusa más ridícula que usaste para cancelar un plan?",
            "¿Cuál fue tu ex más tóxico/a y por qué seguiste ahí igual?"
        ],
        retosList: [
            "Manda un audio cantando la primera canción que suene en tu playlist.",
            "Cambia tu foto de perfil por 1 hora a la foto más random de tu galería.",
            "Escribe \"te extraño\" a la última persona con la que hablaste antes de este grupo.",
            "Cuenta en voz (nota de voz) la historia más incómoda que te pasó en una cita."
        ],
        trivia18List: [
            { pregunta: "¿Cuál es la principal causa de resacas al día siguiente?", opciones: ["Deshidratación", "Falta de sueño", "Comer tarde", "Estrés"], correcta: 0 },
            { pregunta: "Según encuestas, ¿cuál es el motivo #1 de peleas en parejas jóvenes?", opciones: ["Dinero", "Celos", "Tareas del hogar", "Redes sociales"], correcta: 0 },
            { pregunta: "¿Qué edad se considera estadísticamente la 'crisis de los treinta'?", opciones: ["25-27", "30-33", "35-40", "20-22"], correcta: 1 }
        ]
    };
}

async function handleMessage(ctx) {
    const { m, sock, from, sender, usersCollection, groupStatsCollection, state, deps, esOwner } = ctx;
    const messageType = Object.keys(m.message)[0];

    // SISTEMA DE MUTEO
    const muteKey = `${from}-${sender}`;
    if (state.mutedUsers.has(muteKey)) {
        const muteInfo = state.mutedUsers.get(muteKey);
        if (Date.now() < muteInfo.expireTime) {
            try { await sock.sendMessage(from, { delete: m.key }); } catch {}
            return;
        } else {
            state.mutedUsers.delete(muteKey);
        }
    }

    // STATS DE GRUPO
    if (from.endsWith('@g.us')) {
        try {
            await groupStatsCollection.updateOne(
                { jid: sender, groupId: from },
                { $inc: { messageCount: 1 } },
                { upsert: true }
            );
        } catch {}
    }

    // ANTI-SPAM DE STICKERS
    if (from.endsWith('@g.us') && messageType === 'stickerMessage') {
        const ahora = Date.now();
        if (state.stickerTimeouts.has(sender)) {
            const tiempoFin = state.stickerTimeouts.get(sender);
            if (ahora < tiempoFin) {
                try { await sock.sendMessage(from, { delete: m.key }); } catch {}
                return;
            } else { state.stickerTimeouts.delete(sender); }
        }

        let tracker = state.stickerSpamTracker.get(sender) || { lastTime: 0, rapidCount: 0 };
        if (ahora - tracker.lastTime < 1500) tracker.rapidCount++;
        else tracker.rapidCount = 1;
        
        tracker.lastTime = ahora;
        state.stickerSpamTracker.set(sender, tracker);

        if (tracker.rapidCount >= 3) {
            state.stickerTimeouts.set(sender, ahora + 120000);
            state.stickerSpamTracker.delete(sender);
            try {
                await sock.sendMessage(from, { text: `⚠️ @${sender.split('@')[0]} fue puesto en *timeout de 2 minutos* por enviar stickers en ráfaga masiva. 🛑`, mentions: [sender] });
                await sock.sendMessage(from, { delete: m.key });
            } catch {}
            return;
        }
    }

    let body = m.message.imageMessage?.caption || m.message.videoMessage?.caption || m.message.extendedTextMessage?.text || m.message.conversation || '';
    if (!body.startsWith('#')) return;

    const args = body.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // MIGRACIÓN COINS -> SOLES
    try {
        const checkUser = await usersCollection.findOne({ jid: sender });
        if (checkUser && checkUser.coins !== undefined && checkUser.soles === undefined) {
            await usersCollection.updateOne({ jid: sender }, { $set: { soles: checkUser.coins }, $unset: { coins: "" } });
        }
    } catch {}

    const commandCtx = { ...ctx, body, args, command, messageType };

    // ORDEN DE EJECUCIÓN DE COMANDOS (Añadido hentaiAcciones al final)
    const handlers = [economia, moderacion, ia, utilidades, hentaiAcciones, tiktok];

    for (const handler of handlers) {
        try {
            const handled = await handler.handleCommand(commandCtx);
            if (handled) return; 
        } catch (error) {
            console.error(`❌ Error en comando #${command}:`, error);
        }
    }
}

module.exports = { createState, handleMessage };