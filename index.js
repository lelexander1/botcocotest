const { default: makeWASocket, DisconnectReason, downloadMediaMessage, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const { MongoClient } = require('mongodb');
const sharp = require('sharp');
const axios = require('axios');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const fs = require('fs');
const path = require('path');
const os = require('os');
const gtts = require('gtts');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. SERVIDOR HTTP Y API
// ==========================================
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url.startsWith('/api/perfil')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        try {
            const urlParams = new URL(req.url, `http://${req.headers.host}`);
            const queryUser = urlParams.searchParams.get('user')?.trim();

            if (!queryUser) {
                return res.end(JSON.stringify({ error: 'Ingresa un número de usuario válido' }));
            }

            const dbClient = new MongoClient(process.env.MONGODB_URI);
            await dbClient.connect();
            
            const userDoc = await dbClient.db('whatsapp_bot').collection('users').findOne({ 
                $or: [
                    { jid: { $regex: queryUser, $options: 'i' } },
                    { jid: { $regex: `${queryUser}@s.whatsapp.net`, $options: 'i' } }
                ]
            });
            
            await dbClient.close();

            if (!userDoc) {
                return res.end(JSON.stringify({ error: 'No se encontró un perfil registrado con ese número' }));
            }

            let parejasArray = userDoc.pareja || [];
            if (typeof parejasArray === 'string') parejasArray = [parejasArray];

            const saldoActual = userDoc.soles !== undefined ? userDoc.soles : (userDoc.coins || 0);

            res.end(JSON.stringify({
                jid: userDoc.jid ? userDoc.jid.split('@')[0].split(':')[0] : 'Desconocido',
                soles: saldoActual,
                edad: userDoc.edad || 'No especificada',
                frase: userDoc.frase || 'Sin frase',
                genero: userDoc.genero || 'No especificado',
                cumple: userDoc.cumple || 'No registrado',
                pareja: parejasArray.length > 0 ? parejasArray.map(p => p.split('@')[0].split(':')[0]).join(', ') : 'Soltero/a 💔',
                redes: userDoc.redes || {}
            }));
        } catch (e) {
            console.error('❌ Error en Web API /api/perfil:', e);
            res.end(JSON.stringify({ error: 'Error interno al consultar la base de datos' }));
        }
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>🤖 CocoBot Backend Activo</h1>'); 
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP corriendo en el puerto ${PORT}`);
    setInterval(async () => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        try { await axios.get(appUrl); } catch {}
    }, 3 * 60 * 1000);
});

// ==========================================
// 2. VARIABLES GLOBALES Y LISTAS
// ==========================================
const cooldowns = new Map();
const stickerSpamTracker = new Map(); 
const stickerTimeouts = new Map();     
const propuestasMatrimonio = new Map(); 
const encuestasDivorcio = new Map(); 
const juiciosActivos = new Map(); 
const triviaActiva = new Map(); 
const mutedUsers = new Map();

const apiUsageStats = {
    geminiRequests: 0, totalPromptTokens: 0,
    totalCandidatesTokens: 0, totalTokensUsed: 0, coinGeckoRequests: 0
};

const chistesPicantesList = [
    "Mi terapeuta dice que tengo problemas para dejar ir el pasado.\nMi ex dice que tengo problemas para dejar de escribirle a las 2am.",
    "El matrimonio es como un dispositivo Bluetooth: cuando ya está emparejado, se conecta automáticamente a los peores momentos posibles.",
    "Dicen que el dinero no compra la felicidad.\nTampoco compraba mi lealtad, pero aquí estamos, endeudado y sonriendo.",
    "A mi edad ya no tengo crisis existenciales, tengo suscripciones mensuales a ellas."
];

const verdadesList = [
    "¿Cuál fue la mentira más grande que le dijste a tu pareja para no verla?",
    "¿Cuál es el chat que borrarías si te quitaran el celular por 5 minutos?",
    "¿Cuál es la excusa más ridícula que usaste para cancelar un plan?",
    "¿Cuál fue tu ex más tóxico/a y por qué seguiste ahí igual?"
];

const retosList = [
    "Manda un audio cantando la primera canción que suene en tu playlist.",
    "Cambia tu foto de perfil por 1 hora a la foto más random de tu galería.",
    "Escribe \"te extraño\" a la última persona con la que hablaste antes de este grupo.",
    "Cuenta en voz (nota de voz) la historia más incómoda que te pasó en una cita."
];

const trivia18List = [
    { pregunta: "¿Cuál es la principal causa de resacas al día siguiente?", opciones: ["Deshidratación", "Falta de sueño", "Comer tarde", "Estrés"], correcta: 0 },
    { pregunta: "Según encuestas, ¿cuál es el motivo #1 de peleas en parejas jóvenes?", opciones: ["Dinero", "Celos", "Tareas del hogar", "Redes sociales"], correcta: 0 },
    { pregunta: "¿Qué edad se considera estadísticamente la 'crisis de los treinta'?", opciones: ["25-27", "30-33", "35-40", "20-22"], correcta: 1 }
];

// ==========================================
// 3. UTILIDADES
// ==========================================
async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const json = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne({ _id: id }, { $set: { data: json, updatedAt: new Date() } }, { upsert: true });
    };

    const readData = async (id) => {
        try {
            const res = await collection.findOne({ _id: id });
            return res ? JSON.parse(res.data, BufferJSON.reviver) : null;
        } catch { return null; }
    };

    const removeData = async (id) => {
        try { await collection.deleteOne({ _id: id }); } catch {}
    };

    try {
        const sieteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        await collection.deleteMany({ updatedAt: { $lt: sieteDiasAtras }, _id: { $ne: 'creds' } });
    } catch {}

    const creds = (await readData('creds')) || (initAuthCreds(), await writeData(initAuthCreds(), 'creds'), initAuthCreds());

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) data[id] = await readData(`${type}-${id}`);
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const cat of Object.keys(data)) {
                        for (const id of Object.keys(data[cat])) {
                            const val = data[cat][id], key = `${cat}-${id}`;
                            tasks.push(val ? writeData(val, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function obtenerGifAleatorio(query, backupUrl) {
    try {
        if (process.env.GIPHY_API_KEY) {
            const res = await axios.get(`https://api.giphy.com/v1/gifs/search?api_key=${process.env.GIPHY_API_KEY}&q=${query}&limit=15&rating=g`);
            const gifs = res.data.data;
            if (gifs.length > 0) {
                const url = gifs[Math.floor(Math.random() * gifs.length)].images.downsized_medium.url;
                const r = await axios.get(url, { responseType: 'arraybuffer' });
                return await sharp(Buffer.from(r.data), { animated: true }).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 50, effort: 2 }).toBuffer();
            }
        }
    } catch {}

    try {
        const r = await axios.get(backupUrl, { responseType: 'arraybuffer' });
        return await sharp(Buffer.from(r.data), { animated: true }).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 50, effort: 2 }).toBuffer();
    } catch { return null; }
}

function calcularDiasFaltantes(fechaStr) {
    if (!fechaStr) return 999;
    const [dia, mes] = fechaStr.split('/').map(Number);
    const hoyPeru = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
    let proximo = new Date(hoyPeru.getFullYear(), mes - 1, dia);

    if (proximo < hoyPeru && (proximo.getMonth() !== hoyPeru.getMonth() || proximo.getDate() !== hoyPeru.getDate())) {
        proximo.setFullYear(hoyPeru.getFullYear() + 1);
    }
    return Math.ceil((proximo - hoyPeru) / (1000 * 60 * 60 * 24));
}

function esOwner(sender) {
    return sender.includes('275028952228088') || sender.includes('51924876085');
}

// ==========================================
// 4. CONEXIÓN A WHATSAPP Y DB
// ==========================================
async function connectToWhatsApp() {
    let client;
    try {
        client = new MongoClient(process.env.MONGODB_URI);
        await client.connect();
    } catch (e) {
        console.error('Error al conectar a MongoDB, reintentando en 5s...', e);
        setTimeout(connectToWhatsApp, 5000);
        return;
    }

    const db = client.db('whatsapp_bot');
    const sessionCollection = db.collection('session');
    const usersCollection = db.collection('users');
    const groupsCollection = db.collection('groups');
    const remindersCollection = db.collection('reminders');
    const bankCollection = db.collection('user_bank');
    const groupStatsCollection = db.collection('group_stats');

    try {
        await groupStatsCollection.createIndex({ jid: 1, groupId: 1 }, { unique: true });
    } catch (e) {}

    console.log('📦 Conectado a MongoDB Atlas exitosamente');

    const { state, saveCreds } = await useMongoDBAuthState(sessionCollection);
    const sock = makeWASocket({ logger: pino({ level: 'silent' }), auth: state });

    if (!sock.authState.creds.registered && process.env.PHONE_NUMBER) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(process.env.PHONE_NUMBER.trim());
                console.log(`🔗 CÓDIGO DE VINCULACIÓN: ${code}`);
            } catch {}
        }, 5000);
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        } else if (connection === 'open') {
            console.log('¡CocoBot conectado y en línea!');
            iniciarVerificadorCumpleaños(sock, usersCollection);
            iniciarVerificadorRecordatorios(sock, remindersCollection);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        try {
            const mdata = await sock.groupMetadata(id);
            const groupConfig = await groupsCollection.findOne({ groupId: id });
            
            for (let user of participants) {
                const tag = user.split('@')[0];
                if (action === 'add') {
                    const msg = groupConfig?.welcome || `👋 ¡Bienvenido/a @${tag} al grupo *${mdata.subject}*! 🎉`;
                    await sock.sendMessage(id, { text: msg, mentions: [user] });
                } else if (action === 'remove' || action === 'leave') {
                    const msg = groupConfig?.goodbye || `🚪 @${tag} ha dejado el grupo. 👋`;
                    await sock.sendMessage(id, { text: msg, mentions: [user] });
                    const stickerBye = await obtenerGifAleatorio('sad goodbye anime crying', 'https://media.giphy.com/media/7SF5scMBmlAFrg4uUs/giphy.gif');
                    if (stickerBye) await sock.sendMessage(id, { sticker: stickerBye });
                }
            }
        } catch (e) {}
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        let sender = m.key.participant || from;
        
        // CORRECCIÓN: Separar billeteras eliminando los puertos de sesión pero conservando el número único
        if (sender.includes(':')) {
            sender = sender.split(':')[0] + sender.substring(sender.indexOf('@'));
        }

        const messageType = Object.keys(m.message)[0];

        // ==========================================
        // SISTEMA DE MUTEO INTERCEPTOR
        // ==========================================
        const muteKey = `${from}-${sender}`;
        if (mutedUsers.has(muteKey)) {
            const muteInfo = mutedUsers.get(muteKey);
            if (Date.now() < muteInfo.expireTime) {
                try { await sock.sendMessage(from, { delete: m.key }); } catch {}
                return;
            } else {
                mutedUsers.delete(muteKey);
            }
        }

        if (from.endsWith('@g.us')) {
            try {
                await groupStatsCollection.updateOne(
                    { jid: sender, groupId: from },
                    { $inc: { messageCount: 1 } },
                    { upsert: true }
                );
            } catch {}
        }

        if (from.endsWith('@g.us') && messageType === 'stickerMessage') {
            const ahora = Date.now();
            if (stickerTimeouts.has(sender)) {
                const tiempoFin = stickerTimeouts.get(sender);
                if (ahora < tiempoFin) {
                    try { await sock.sendMessage(from, { delete: m.key }); } catch {}
                    return;
                } else { stickerTimeouts.delete(sender); }
            }

            let tracker = stickerSpamTracker.get(sender) || { lastTime: 0, rapidCount: 0 };
            if (ahora - tracker.lastTime < 1500) tracker.rapidCount++;
            else tracker.rapidCount = 1;
            tracker.lastTime = ahora;
            stickerSpamTracker.set(sender, tracker);

            if (tracker.rapidCount >= 3) {
                const tiempoTimeout = ahora + 120000;
                stickerTimeouts.set(sender, tiempoTimeout);
                stickerSpamTracker.delete(sender);
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

        // ==========================================
        // 🔄 MIGRACIÓN AUTOMÁTICA (DE COINS A SOLES)
        // ==========================================
        const checkUser = await usersCollection.findOne({ jid: sender });
        if (checkUser && checkUser.coins !== undefined && checkUser.soles === undefined) {
            await usersCollection.updateOne({ jid: sender }, { $set: { soles: checkUser.coins }, $unset: { coins: "" } });
        }


        // ==========================================
        // COMANDO PRIVADO DE DEPOSITO (DEV)
        // ==========================================
        if (command === 'devsoles') {
            // 1. Bloqueo de seguridad absoluto: Si no eres tú, el bot ignora el comando
            if (!esOwner(sender)) return; 
            
            // 2. Validación de contraseña
            if (!body.includes('joko2026')) return; 
            
            const monto = parseInt(args[0]);

            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || sender;

            if (!monto || isNaN(monto)) {
                return await sock.sendMessage(from, { text: '⚠️ Usa: *#devsoles [monto] [@usuario opcional] joko2026*' }, { quoted: m });
            }
            
            await usersCollection.updateOne({ jid: target }, { $inc: { soles: monto } }, { upsert: true });
            
            const mensajeDev = target === sender 
                ? `💻 *MODO DEV* 💻\n\nSe han inyectado *🪙 ${monto} soles* a tu cuenta exitosamente.`
                : `💻 *MODO DEV* 💻\n\nSe han inyectado *🪙 ${monto} soles* a la cuenta secreta de @${target.split('@')[0]}.`;
                
            return await sock.sendMessage(from, { text: mensajeDev, mentions: [target] }, { quoted: m });
        }

        if (['work', 'w', 'daily'].includes(command)) {
            const limit = command === 'daily' ? 86400000 : 30000;
            const key = `${sender}-${command}`;
            const last = cooldowns.get(key) || 0;
            if (Date.now() - last < limit) {
                return await sock.sendMessage(from, { text: `⏳ Espera *${Math.ceil((limit - (Date.now() - last)) / 1000)}s* para usar #${command}.` }, { quoted: m });
            }
            cooldowns.set(key, Date.now());
        }

        if (command === 'ping' || command === 'p') {
            return await sock.sendMessage(from, { text: '¡Pong! 🏓 CocoBot activo y en línea.' }, { quoted: m });
        }

        if (command === 'menu' || command === 'help') {
            const menu = `⚡ *PANEL PRINCIPAL - CocoBot* ⚡\n` +
                `────────────────────────\n` +
                `👤 *Creado por:* Alencito/Gabo\n` +
                `🚀 *Estado:* Online 24/7 \n` +
                `────────────────────────\n\n` +
                `📌 *COMANDOS Y FUNCIONES:* \n\n` +
                `🤖 *#ia [texto]*\n   ↳ Consulta a la Inteligencia Artificial.\n\n` +
                `🎙️ *#voz [texto]*\n   ↳ Convierte texto a nota de voz.\n\n` +
                `🪙 *#crypto [moneda]*\n   ↳ Consulta precios de criptomonedas.\n\n` +
                `😂 *#chistes*\n   ↳ Envía un chiste corto.\n\n` +
                `🖼️ *#imagen [tema]*\n   ↳ Busca y envía una foto aleatoria.\n\n` +
                `📦 *#still [texto / ver / borrar]*\n   ↳ Tu banco personal de notas.\n\n` +
                `👤 *#edad, #frase, #setsticker*\n   ↳ Configura tu perfil.\n\n` +
                `🔗 *#facebook, #instagram, #discord, #spotify, #x [link]*\n   ↳ Añade redes sociales.\n\n` +
                `👁️ *#perfil [@usuario]*\n   ↳ Muestra tu tarjeta de perfil.\n\n` +
                `⏰ *#recordatorio o #recg [tiempo] [msj]*\n   ↳ Programa recordatorios.\n\n` +
                `🎨 *#s / #gif / #toimg*\n   ↳ Crea y convierte stickers.\n\n` +
                `💍 *#casarse [@usuario] / #aceptar*\n   ↳ Sistema de matrimonios.\n\n` +
                `💔 *#divorcio [@usuario] [normal/juicio/encuesta]*\n   ↳ Tipos de separación.\n\n` +
                `⚖️ *#juicio [@usuario] [monto] [motivo]*\n   ↳ Demanda a alguien para quitarle soles.\n\n` +
                `🎂 *#cumple DD/MM / #cumples*\n   ↳ Registra cumpleaños.\n\n` +
                `🪙 *#bal / #work / #daily / #flip / #apostar / #ruleta / #slots*\n   ↳ Economía y juegos.\n\n` +
                `💸 *#yapear [monto] [@usuario]*\n   ↳ Transfiere dinero a otra persona.\n\n` +
                `🛒 *#tienda / #comprar [item]*\n   ↳ Tienda exclusiva para gastar tus soles.\n\n` +
                `🔇 *#mutear [@us] [min] / #fianza*\n   ↳ Sistema de cárcel y fianzas (Solo Admins).\n\n` +
                `🗑️ *#del / #delete*\n   ↳ Responde a un mensaje para borrarlo.`;
            return await sock.sendMessage(from, { text: menu }, { quoted: m });
        }

        if (command === 'si') {
            try {
                const promptIa = "El usuario acaba de decir o invocar la palabra '#si'. Analiza esta palabra con sarcasmo o humor y respóndele de manera tajante, creativa o generando un concepto contrario como un rotundo 'No' o algo gracioso relacionado.";
                const res = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: promptIa });
                return await sock.sendMessage(from, { text: `${res.text || '¡No!'}` }, { quoted: m });
            } catch {
                return await sock.sendMessage(from, { text: '❌ ¡No!' }, { quoted: m });
            }
        }

        // ==========================================
        // COMANDO PARA BORRAR MENSAJES (#del)
        // ==========================================
        if (command === 'del' || command === 'delete') {
            const info = m.message.extendedTextMessage?.contextInfo;
            if (!info?.stanzaId) {
                return await sock.sendMessage(from, { text: '⚠️ Responde al mensaje que deseas eliminar con *#del*.' }, { quoted: m });
            }

            const botNumber = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
            const esMensajeDelBot = info.participant === botNumber || info.participant === sock.user.id;

            const keyParaBorrar = {
                remoteJid: from,
                id: info.stanzaId,
                fromMe: esMensajeDelBot,
                participant: info.participant
            };

            try { 
                await sock.sendMessage(from, { delete: keyParaBorrar }); 
            } catch (err) { 
                await sock.sendMessage(from, { text: '❌ No pude eliminar el mensaje. Si el mensaje es de otra persona, asegúrate de que tengo permisos de Administrador en el grupo.' }, { quoted: m }); 
            }
            return;
        }

        // ==========================================
        // SISTEMA DE JUICIOS / TRIBUNAL
        // ==========================================
        if (command === 'juicio' || command === 'demandar') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Los juicios solo proceden en grupos.' }, { quoted: m });
            if (juiciosActivos.has(from)) return await sock.sendMessage(from, { text: '⚠️ Ya hay un juicio activo en este grupo.' }, { quoted: m });

            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) return await sock.sendMessage(from, { text: '⚠️ Menciona al acusado. Ej: *#juicio @usuario 5000 por feo*' }, { quoted: m });
            if (target === sender) return await sock.sendMessage(from, { text: '⚠️ No te puedes demandar a ti mismo.' }, { quoted: m });

            const argsSinMencion = args.filter(a => !a.includes('@'));
            const montoDemanda = parseInt(argsSinMencion[0]);
            if (!montoDemanda || isNaN(montoDemanda) || montoDemanda <= 0) return await sock.sendMessage(from, { text: '⚠️ Indica un monto válido de indemnización. Ej: *#juicio @usuario 5000 motivo*' }, { quoted: m });

            const motivo = argsSinMencion.slice(1).join(' ') || 'Sin motivo especificado';

            juiciosActivos.set(from, {
                demandante: sender,
                demandado: target,
                monto: montoDemanda,
                votosSi: 0,
                votosNo: 0,
                votantes: new Set()
            });

            await sock.sendMessage(from, {
                text: `⚖️ *TRIBUNAL DE COCOBOT* ⚖️\n\n🧑‍⚖️ *Demandante:* @${sender.split('@')[0]}\n🛑 *Acusado:* @${target.split('@')[0]}\n💸 *Indemnización Solicitada:* ${montoDemanda} soles\n📄 *Motivo:* "${motivo}"\n\n👨‍⚖️ *El jurado (ustedes) decide:*\n👉 Escriban *#culpable* para que pague la indemnización.\n👉 Escriban *#inocente* para absolverlo de los cargos.\n\n⏱️ El veredicto se dictará en 5 minutos.`,
                mentions: [sender, target]
            }, { quoted: m });

            setTimeout(async () => {
                const juicio = juiciosActivos.get(from);
                if (!juicio) return;
                juiciosActivos.delete(from);

                if (juicio.votosSi > juicio.votosNo) {
                    await usersCollection.updateOne({ jid: juicio.demandado }, { $inc: { soles: -juicio.monto } });
                    await usersCollection.updateOne({ jid: juicio.demandante }, { $inc: { soles: juicio.monto } });
                    await sock.sendMessage(from, { text: `⚖️ *VEREDICTO FINAL* ⚖️\n\nCon ${juicio.votosSi} votos a favor y ${juicio.votosNo} en contra, el jurado declara a @${juicio.demandado.split('@')[0]} *CULPABLE*.\n\n🔨 Deberá transferir *🪙 ${juicio.monto} soles* a @${juicio.demandante.split('@')[0]} como indemnización.`, mentions: [juicio.demandado, juicio.demandante] });
                } else {
                    await sock.sendMessage(from, { text: `⚖️ *VEREDICTO FINAL* ⚖️\n\nCon ${juicio.votosNo} votos por la inocencia y solo ${juicio.votosSi} por la culpabilidad, @${juicio.demandado.split('@')[0]} es declarado *INOCENTE*.\n\n🔨 Caso cerrado. No se pagará indemnización.`, mentions: [juicio.demandado] });
                }
            }, 300000); // 5 minutos
            return;
        }

        if (command === 'culpable' || command === 'inocente') {
            const juicio = juiciosActivos.get(from);
            if (!juicio) return; 
            if (juicio.votantes.has(sender)) return await sock.sendMessage(from, { text: '⚠️ Ya emitiste tu voto como jurado.' }, { quoted: m });
            
            juicio.votantes.add(sender);
            if (command === 'culpable') juicio.votosSi++;
            if (command === 'inocente') juicio.votosNo++;
            
            return await sock.sendMessage(from, { text: `✅ Voto registrado. (Culpable: ${juicio.votosSi} | Inocente: ${juicio.votosNo})` }, { quoted: m });
        }

        // ==========================================
        // SISTEMA DE TIENDA Y TRANSFERENCIAS
        // ==========================================
        if (command === 'yapear' || command === 'transferir') {
            const montoTran = parseInt(args[0]);
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

            if (!montoTran || isNaN(montoTran) || montoTran <= 0) return await sock.sendMessage(from, { text: '⚠️ Indica un monto válido. Ej: *#yapear 1000 @usuario*' }, { quoted: m });
            if (!target || target === sender) return await sock.sendMessage(from, { text: '⚠️ Menciona a otra persona para yapearle.' }, { quoted: m });

            const uData = await usersCollection.findOne({ jid: sender });
            const misSoles = uData?.soles || 0;

            if (misSoles < montoTran) return await sock.sendMessage(from, { text: `❌ Saldo insuficiente. Tienes *🪙 ${misSoles} soles*.` }, { quoted: m });

            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: -montoTran } });
            await usersCollection.updateOne({ jid: target }, { $inc: { soles: montoTran } }, { upsert: true });

            const stickerYape = await obtenerGifAleatorio('money transfer pay', 'https://media.giphy.com/media/l0Ex6kAKAoFRsFh6M/giphy.gif');
            await sock.sendMessage(from, { text: `💸 *¡YAPE EXITOSO!*\n\n@${sender.split('@')[0]} le transfirió *🪙 ${montoTran} soles* a @${target.split('@')[0]}.`, mentions: [sender, target] }, { quoted: m });
            if (stickerYape) await sock.sendMessage(from, { sticker: stickerYape });
            return;
        }

        if (command === 'tienda') {
            const textoTienda = `🛒 *TIENDA COCOBOT* 🛒\n\n` +
                `1️⃣ *Admin Temporal (24h)* - 150,000 soles\n` +
                `   ↳ _Uso: #comprar admin_\n\n` +
                `2️⃣ *Silenciar Chat (10m)* - 80,000 soles\n` +
                `   ↳ _Uso: #comprar silencio_\n\n` +
                `💳 Consulta tu saldo con #bal`;
            return await sock.sendMessage(from, { text: textoTienda }, { quoted: m });
        }

        if (command === 'comprar') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ La tienda solo funciona en grupos.' }, { quoted: m });
            
            const item = args[0]?.toLowerCase();
            const uData = await usersCollection.findOne({ jid: sender });
            const misSoles = uData?.soles || 0;

            if (item === 'admin') {
                const costo = 150000;
                if (misSoles < costo) return await sock.sendMessage(from, { text: `❌ No tienes fondos suficientes. Cuesta ${costo} soles.` }, { quoted: m });
                
                await usersCollection.updateOne({ jid: sender }, { $inc: { soles: -costo } });
                await sock.groupParticipantsUpdate(from, [sender], 'promote');
                await sock.sendMessage(from, { text: `✅ ¡@${sender.split('@')[0]} compró ADMIN por 24 horas! 🛡️`, mentions: [sender] }, { quoted: m });
                
                setTimeout(async () => {
                    try { await sock.groupParticipantsUpdate(from, [sender], 'demote'); } catch {}
                }, 86400000);
                return;
            }

            if (item === 'silencio') {
                const costo = 80000;
                if (misSoles < costo) return await sock.sendMessage(from, { text: `❌ No tienes fondos suficientes. Cuesta ${costo} soles.` }, { quoted: m });
                
                await usersCollection.updateOne({ jid: sender }, { $inc: { soles: -costo } });
                await sock.groupSettingUpdate(from, 'announcement');
                await sock.sendMessage(from, { text: `🤫 @${sender.split('@')[0]} compró SILENCIO. El chat se cerró por 10 minutos.`, mentions: [sender] }, { quoted: m });
                
                setTimeout(async () => {
                    try {
                        await sock.groupSettingUpdate(from, 'not_announcement');
                        await sock.sendMessage(from, { text: `🔊 El tiempo de silencio terminó. ¡Ya pueden hablar!` });
                    } catch {}
                }, 600000);
                return;
            }

            return await sock.sendMessage(from, { text: '⚠️ Ítem no válido. Revisa las opciones con *#tienda*.' }, { quoted: m });
        }

        // ==========================================
        // SISTEMA DE CÁRCEL Y FIANZA
        // ==========================================
        if (command === 'mutear' || command === 'mute') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Solo grupos.' }, { quoted: m });
            const meta = await sock.groupMetadata(from);
            const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
            if (!admins.includes(sender) && !esOwner(sender)) return await sock.sendMessage(from, { text: '⚠️ Solo administradores pueden mutear.' }, { quoted: m });
            
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            const minutos = parseInt(args[1]) || 5; 
            if (!target) return await sock.sendMessage(from, { text: '⚠️ Menciona a quién silenciar. Ej: #mutear @usuario 10' }, { quoted: m });
            
            const bailAmount = minutos * 10000; 
            const expireTime = Date.now() + (minutos * 60000);
            
            mutedUsers.set(`${from}-${target}`, { expireTime, bailAmount, groupId: from });
            return await sock.sendMessage(from, { text: `🔇 @${target.split('@')[0]} ha sido silenciado por ${minutos} minutos.\n\n💸 *Fianza:* ${bailAmount} soles.\n(Puede pagarla desde cualquier grupo usando #fianza)`, mentions: [target] }, { quoted: m });
        }

        if (command === 'fianza' || command === 'pagarfianza') {
            let totalBail = 0;
            let muteKeysToRemove = [];
            
            for (const [key, info] of mutedUsers.entries()) {
                if (key.endsWith(`-${sender}`)) {
                    if (Date.now() < info.expireTime) {
                        totalBail += info.bailAmount;
                        muteKeysToRemove.push(key);
                    } else {
                        mutedUsers.delete(key);
                    }
                }
            }

            if (muteKeysToRemove.length === 0) return await sock.sendMessage(from, { text: '✅ No tienes ninguna fianza pendiente ni estás silenciado.' }, { quoted: m });

            const uData = await usersCollection.findOne({ jid: sender });
            const misSoles = uData?.soles || 0;

            if (misSoles < totalBail) {
                return await sock.sendMessage(from, { text: `❌ No tienes fondos para pagar tu fianza. Cuesta *🪙 ${totalBail} soles* y tienes *🪙 ${misSoles} soles*.` }, { quoted: m });
            }

            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: -totalBail } });
            muteKeysToRemove.forEach(k => mutedUsers.delete(k));

            return await sock.sendMessage(from, { text: `✅ Has pagado tu fianza de *🪙 ${totalBail} soles*.\n¡Ya puedes volver a hablar en los grupos donde estabas silenciado! 🎉` }, { quoted: m });
        }

        const accionesMap = {
            angry: { query: 'anime angry mad', action: 'está enojado/a 💢' },
            enojado: { query: 'anime angry mad', action: 'está enojado/a 💢' },
            bath: { query: 'anime bath chill', action: 'se fue a bañar 🛁' },
            bite: { query: 'anime bite', action: 'le dio un mordisco a' },
            bleh: { query: 'anime bleh tongue', action: 'saca la lengua 😛' },
            blush: { query: 'anime blush shy', action: 'se ha sonrojado 😳' },
            bored: { query: 'anime bored yawn', action: 'está aburrido/a 🥱' },
            aburrido: { query: 'anime bored yawn', action: 'está aburrido/a 🥱' },
            call: { query: 'anime phone call', action: 'está llamando a' },
            clap: { query: 'anime clap applause', action: 'está aplaudiendo 👏' },
            aplaudir: { query: 'anime clap applause', action: 'está aplaudiendo 👏' },
            coffee: { query: 'anime drinking coffee', action: 'está tomando un café ☕' },
            cafe: { query: 'anime drinking coffee', action: 'está tomando un café ☕' },
            cold: { query: 'anime cold shivering', action: 'tiene mucho frío 🥶' },
            cook: { query: 'anime cooking delicious', action: 'está cocinando algo delicioso 🍳' },
            cry: { query: 'anime crying tears', action: 'se puso a llorar 😭' },
            cuddle: { query: 'anime cuddle cute', action: 'se está acurrucando con' },
            dance: { query: 'anime dancing happy', action: 'se sacó los pasitos prohibidos 💃' },
            dramatic: { query: 'anime dramatic shock', action: 'está haciendo un drama total 🎭' },
            drama: { query: 'anime dramatic shock', action: 'está haciendo un drama total 🎭' },
            draw: { query: 'anime drawing art', action: 'se puso a dibujar 🎨' },
            drunk: { query: 'anime drunk dizzy', action: 'anda medio borracho/a 🍻' },
            eat: { query: 'anime eating food', action: 'está comiendo algo delicioso 🍜' },
            comer: { query: 'anime eating food', action: 'está comiendo algo delicioso 🍜' },
            facepalm: { query: 'anime facepalm', action: 'se dio una palmada en la cara 🤦' },
            gaming: { query: 'anime gaming gamer', action: 'se puso a jugar videojuegos 🎮' },
            greet: { query: 'anime waving hello hi', action: 'saluda alegremente a' },
            hi: { query: 'anime waving hello hi', action: 'saluda alegremente a' },
            happy: { query: 'anime happy jump joy', action: 'salta de felicidad 🎉' },
            feliz: { query: 'anime happy jump joy', action: 'salta de felicidad 🎉' },
            heat: { query: 'anime hot sweat summer', action: 'se está muriendo de calor 🥵' },
            hug: { query: 'anime hug warm', action: 'le dio un abrazo cálido a 🫂' },
            impregnate: { query: 'anime shock stare', action: 'dejó pensando seriamente a' },
            preg: { query: 'anime shock stare', action: 'dejó pensando seriamente a' },
            preñar: { query: 'anime shock stare', action: 'dejó pensando seriamente a' },
            jump: { query: 'anime jumping excited', action: 'está saltando de la emoción 🦘' },
            kill: { query: 'anime punch fight weapon', action: 'saca su arma y ataca a 🔪' },
            kiss: { query: 'anime kiss love', action: 'le dio un tierno beso a 💋' },
            muak: { query: 'anime kiss love', action: 'le dio un tierno beso a 💋' },
            kisscheek: { query: 'anime cheek kiss cute', action: 'le dio un beso en la mejilla a 😊' },
            beso: { query: 'anime cheek kiss cute', action: 'le dio un beso en la mejilla a 😊' },
            laugh: { query: 'anime laughing lol', action: 'se está reír y reír de' },
            lewd: { query: 'anime smug cheeky', action: 'tiene una mirada bastante traviesa 😏' },
            lick: { query: 'anime lick taste', action: 'le dio una lamida a 👅' },
            love: { query: 'anime in love hearts', action: 'se siente completamente enamorado/a ❤️' },
            amor: { query: 'anime in love hearts', action: 'se siente completamente enamorado/a ❤️' },
            nope: { query: 'anime nope deny headshake', action: 'se niega rotundamente a hacerlo 🙅' },
            pat: { query: 'anime headpat cute', action: 'le acaricia la cabeza suavemente a 🤲' },
            poke: { query: 'anime poke cheek', action: 'le está picando las costillas a 👉' },
            pout: { query: 'anime pout angry cute', action: 'está haciendo un puchero 😒' },
            psycho: { query: 'anime creepy yandere smile', action: 'tiene una sonrisa bastante psicópata 👁️👄👁️' },
            punch: { query: 'anime punch hit', action: 'le dio un fuerte puñetazo a 👊' },
            push: { query: 'anime push away', action: 'empujó lejos a' },
            run: { query: 'anime running fast escape', action: 'salió corriendo a toda velocidad 🏃' },
            sad: { query: 'anime sad depression', action: 'expresa mucha tristeza 🥀' },
            triste: { query: 'anime sad depression', action: 'expresa mucha tristeza 🥀' },
            scared: { query: 'anime scared shock fear', action: 'está temblando de miedo 😱' },
            scream: { query: 'anime screaming loud', action: 'soltó un grito al aire 🗣️' },
            seduce: { query: 'anime seduce wink charm', action: 'intentó seducir a' },
            shy: { query: 'anime shy nervous', action: 'siente muchísima timidez 🙈' },
            timido: { query: 'anime shy nervous', action: 'siente muchísima timidez 🙈' },
            sing: { query: 'anime singing microphone', action: 'se puso a cantar a pulmón herido 🎤' },
            slap: { query: 'anime slap angry', action: 'le dio una tremenda bofetada a 👋' },
            sleep: { query: 'anime sleeping tired zzz', action: 'se tumbó a dormir profundamente 💤' },
            smoke: { query: 'anime smoking chill', action: 'está fumando pensativamente 🚬' },
            spit: { query: 'anime spit disgust', action: 'escupió asqueado/a 💦' },
            escupir: { query: 'anime disgust spit', action: 'escupió asqueado/a 💦' },
            step: { query: 'anime step down', action: 'le pisó el pie a' },
            pisar: { query: 'anime step down', action: 'le pisó el pie a' },
            think: { query: 'anime thinking smart', action: 'se quedó pensando profundamente 🤔' },
            tickle: { query: 'anime tickle laugh', action: 'le está haciendo cosquillas sin parar a 🤲' },
            walk: { query: 'anime walking stroll', action: 'se fue a dar un paseo caminando 🚶' }
        };

        if (accionesMap[command]) {
            const config = accionesMap[command];
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            let caption;
            let mentions = [sender];

            if (target) {
                caption = `@${sender.split('@')[0]} ${config.action} @${target.split('@')[0]}! ✨`;
                mentions.push(target);
            } else {
                caption = `@${sender.split('@')[0]} ${config.action} ✨`;
            }

            const backupDefault = 'https://media.giphy.com/media/l1J9EdzfOSgfyfeLm/giphy.gif';
            const sticker = await obtenerGifAleatorio(config.query, backupDefault);
            if (sticker) {
                await sock.sendMessage(from, { text: caption, mentions }, { quoted: m });
                return await sock.sendMessage(from, { sticker });
            }
        }

        if (command === 'voz' || command === 'tts') {
            const textoVoz = args.join(' ');
            if (!textoVoz) return await sock.sendMessage(from, { text: '⚠️ Escribe el texto que deseas convertir a voz. Ej: *#voz Hola a todos*' }, { quoted: m });

            try {
                await sock.sendMessage(from, { text: '🎙️ Generando audio...' }, { quoted: m });
                const tts = new gtts(textoVoz, 'es');
                const tempFilePath = path.join(os.tmpdir(), `voice_${Date.now()}.mp3`);

                tts.save(tempFilePath, async function () {
                    try {
                        const audioBuffer = fs.readFileSync(tempFilePath);
                        await sock.sendMessage(from, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: m });
                        fs.unlinkSync(tempFilePath);
                    } catch (err) {
                        await sock.sendMessage(from, { text: '❌ No se pudo enviar el audio.' }, { quoted: m });
                    }
                });
            } catch (err) {
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al procesar el audio.' }, { quoted: m });
            }
        }

        if (command === 'crypto' || command === 'precio' || command === 'cripto') {
            const moneda = args[0]?.toLowerCase() || 'bitcoin';
            try {
                await sock.sendMessage(from, { text: `🔍 Consultando precio de *${moneda}*...` }, { quoted: m });
                const headers = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {};
                const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(moneda)}&vs_currencies=usd,eur&include_24hr_change=true`;
                const response = await axios.get(url, { headers });
                
                apiUsageStats.coinGeckoRequests++;
                const data = response.data;

                if (!data[moneda]) return await sock.sendMessage(from, { text: `❌ No se encontró información para "${moneda}".` }, { quoted: m });

                const precioUsd = data[moneda].usd;
                const precioEur = data[moneda].eur;
                const cambio24h = data[moneda].usd_24h_change?.toFixed(2) || 0;
                const iconoCambio = cambio24h >= 0 ? '📈 🟢' : '📉 🔴';

                const textoCrypto = `🪙 *PRECIO DE MERCADO: ${moneda.toUpperCase()}* 🪙\n` +
                    `────────────────────────\n` +
                    `💵 *USD:* $${precioUsd.toLocaleString()}\n` +
                    `💶 *EUR:* €${precioEur.toLocaleString()}\n` +
                    `${iconoCambio} *Cambio 24h:* ${cambio24h}%\n` +
                    `────────────────────────\n` +
                    `🌐 *Fuente:* CoinGecko API`;
                return await sock.sendMessage(from, { text: textoCrypto }, { quoted: m });
            } catch (err) {
                return await sock.sendMessage(from, { text: '❌ Error al consultar la API de CoinGecko.' }, { quoted: m });
            }
        }

        if (command === 'chistes' || command === 'chiste') {
            const chistesList = [
                "— Papá, papá, ¿qué se siente tener un hijo tan guapo, inteligente y perfecto?\n— No lo sé, hijo, pregúntale a tu abuelo.",
                "— ¡Camarero, camarero! Hay una mosca en mi sopa.\n— No se preocupe, caballero, nadará muy bien por ese precio.",
                "— ¿Por qué las focas miran siempre hacia arriba en los espectáculos?\n— Porque ahí están los focos.",
                "— Hola, ¿está Agustín?\n— No, estoy incomodísimo.",
                "— ¿Cuál es el colmo de un electricista?\n— No poder seguir corriente.",
                "— ¿Qué hace una abeja en el gimnasio?\n— ¡Zum-ba!"
            ];
            const chisteAleatorio = chistesList[Math.floor(Math.random() * chistesList.length)];
            return await sock.sendMessage(from, { text: `😂 *Chiste:* \n\n${chisteAleatorio}` }, { quoted: m });
        }

        if (command === 'chistenegro' || command === 'picante' || command === 'chistepicante') {
            const chistePicante = chistesPicantesList[Math.floor(Math.random() * chistesPicantesList.length)];
            return await sock.sendMessage(from, { text: `🌶️ *Humor +18:* \n\n${chistePicante}` }, { quoted: m });
        }

        if (command === 'vor' || command === 'verdadoreto') {
            const tipoElegido = args[0]?.toLowerCase();
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            let esVerdad;
            if (tipoElegido === 'verdad') esVerdad = true;
            else if (tipoElegido === 'reto') esVerdad = false;
            else esVerdad = Math.random() < 0.5;

            const item = esVerdad
                ? verdadesList[Math.floor(Math.random() * verdadesList.length)]
                : retosList[Math.floor(Math.random() * retosList.length)];

            const dirigidoA = target ? `@${target.split('@')[0]}` : `@${sender.split('@')[0]}`;
            const encabezado = esVerdad ? '🎯 *VERDAD*' : '🔥 *RETO*';

            return await sock.sendMessage(from, {
                text: `${encabezado} para ${dirigidoA}:\n\n${item}\n\n_Usa #vor de nuevo para otra ronda._`,
                mentions: [target || sender]
            }, { quoted: m });
        }

        if (command === 'r34' || command === 'rule34') {
            const queryTag = args.join('_');
            if (!queryTag) {
                return await sock.sendMessage(from, { text: '⚠️ Escribe qué etiqueta deseas buscar. Ej: *#r34 cat_girl*' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { text: '🔍 Buscando en la API...' }, { quoted: m });

                const urlApi = `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&tags=${encodeURIComponent(queryTag)}&json=1`;
                const respuesta = await axios.get(urlApi);
                const posts = respuesta.data;

                if (!posts || posts.length === 0) {
                    return await sock.sendMessage(from, { text: `❌ No se encontraron resultados para: "${queryTag}".` }, { quoted: m });
                }

                // Filtramos solo los posts que tengan una URL de imagen real
                const postsValidos = posts.filter(p => p.file_url || p.sample_url || p.image);
                if (postsValidos.length === 0) {
                    return await sock.sendMessage(from, { text: `❌ Los resultados encontrados no tienen imágenes disponibles.` }, { quoted: m });
                }

                // Seleccionamos uno válido al azar
                const postAleatorio = postsValidos[Math.floor(Math.random() * postsValidos.length)];
                
                // Mapeamos las propiedades posibles de la API
                const mediaUrl = postAleatorio.file_url || postAleatorio.sample_url || `https://img.rule34.xxx//images/${postAleatorio.directory}/${postAleatorio.image}`;

                const esVideo = mediaUrl.endsWith('.webm') || mediaUrl.endsWith('.mp4');

                if (esVideo) {
                    await sock.sendMessage(from, { 
                        video: { url: mediaUrl }, 
                        caption: `🔞 *Resultado:* ${queryTag}` 
                    }, { quoted: m });
                } else {
                    await sock.sendMessage(from, { 
                        image: { url: mediaUrl }, 
                        caption: `🔞 *Resultado:* ${queryTag}` 
                    }, { quoted: m });
                }

            } catch (err) {
                console.error('Error en R34:', err);
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al procesar la solicitud de la API.' }, { quoted: m });
            }
            return;
        }

        if (command === 'trivia18') {
            const preguntaTrivia = trivia18List[Math.floor(Math.random() * trivia18List.length)];
            const letras = ['A', 'B', 'C', 'D'];
            let textoOpciones = '';
            preguntaTrivia.opciones.forEach((op, idx) => { textoOpciones += `${letras[idx]}) ${op}\n`; });

            triviaActiva.set(from, { correctaIndex: preguntaTrivia.correcta, letras, expira: Date.now() + 30000 });

            setTimeout(() => {
                const activa = triviaActiva.get(from);
                if (activa && activa.expira <= Date.now() + 1) triviaActiva.delete(from);
            }, 30000);

            return await sock.sendMessage(from, {
                text: `🧠 *TRIVIA +18* 🧠\n\n${preguntaTrivia.pregunta}\n\n${textoOpciones}\n⏱️ Tienes 30s. Responde con *#trivia [letra]*`
            }, { quoted: m });
        }

        if (command === 'trivia') {
            const activa = triviaActiva.get(from);
            if (!activa) return await sock.sendMessage(from, { text: '⚠️ No hay trivia activa. Inicia una con *#trivia18*.' }, { quoted: m });
            if (Date.now() > activa.expira) {
                triviaActiva.delete(from);
                return await sock.sendMessage(from, { text: '⏱️ El tiempo para responder ya se acabó.' }, { quoted: m });
            }
            const respuestaLetra = args[0]?.toUpperCase();
            const idxRespuesta = activa.letras.indexOf(respuestaLetra);
            if (idxRespuesta === -1) return await sock.sendMessage(from, { text: '⚠️ Responde con una letra válida. Ej: *#trivia A*' }, { quoted: m });

            triviaActiva.delete(from);
            if (idxRespuesta === activa.correctaIndex) {
                const premio = 150;
                await usersCollection.updateOne({ jid: sender }, { $inc: { soles: premio } }, { upsert: true });
                return await sock.sendMessage(from, { text: `✅ ¡Correcto! Ganaste *🪙 ${premio} soles*.` }, { quoted: m });
            } else {
                return await sock.sendMessage(from, { text: `❌ Incorrecto. La respuesta correcta era *${activa.letras[activa.correctaIndex]}*.` }, { quoted: m });
            }
        }

        if (command === 'apostar' || command === 'apuesta') {
            const montoApuesta = parseInt(args[0]);
            const eleccion = args[1]?.toLowerCase();
            if (!montoApuesta || isNaN(montoApuesta) || montoApuesta <= 0) return await sock.sendMessage(from, { text: '⚠️ Formato: *#apostar [monto] [cara/cruz]*' }, { quoted: m });
            if (!['cara', 'cruz'].includes(eleccion)) return await sock.sendMessage(from, { text: '⚠️ Elige *cara* o *cruz*. Ej: *#apostar 100 cara*' }, { quoted: m });
            
            const uApuesta = await usersCollection.findOne({ jid: sender });
            const saldoActual = uApuesta?.soles || 0;
            if (saldoActual < montoApuesta) return await sock.sendMessage(from, { text: `❌ No tienes suficientes soles. Tu saldo es *🪙 ${saldoActual}*.` }, { quoted: m });

            const resultadoMoneda = Math.random() < 0.5 ? 'cara' : 'cruz';
            const gano = resultadoMoneda === eleccion;
            const cambioSoles = gano ? montoApuesta : -montoApuesta;
            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: cambioSoles } });

            const textoResultado = gano
                ? `🎉 ¡Salió *${resultadoMoneda}*! Ganaste *🪙 ${montoApuesta} soles*.`
                : `😢 Salió *${resultadoMoneda}*. Perdiste *🪙 ${montoApuesta} soles*.`;
            return await sock.sendMessage(from, { text: textoResultado }, { quoted: m });
        }

        if (command === 'ruleta') {
            const montoRuleta = parseInt(args[0]);
            const colorElegido = args[1]?.toLowerCase();
            if (!montoRuleta || isNaN(montoRuleta) || montoRuleta <= 0) return await sock.sendMessage(from, { text: '⚠️ Formato: *#ruleta [monto] [rojo/negro/verde]*' }, { quoted: m });
            if (!['rojo', 'negro', 'verde'].includes(colorElegido)) return await sock.sendMessage(from, { text: '⚠️ Elige *rojo*, *negro* o *verde*.' }, { quoted: m });
            
            const uRuleta = await usersCollection.findOne({ jid: sender });
            const saldoRuleta = uRuleta?.soles || 0;
            if (saldoRuleta < montoRuleta) return await sock.sendMessage(from, { text: `❌ No tienes suficientes soles.` }, { quoted: m });

            const numeroSalido = Math.floor(Math.random() * 37);
            let colorSalido = 'verde';
            if (numeroSalido !== 0) colorSalido = (numeroSalido % 2 === 0) ? 'negro' : 'rojo';

            let multiplicador = 0;
            if (colorSalido === colorElegido) multiplicador = colorSalido === 'verde' ? 14 : 2;
            const cambioRuleta = multiplicador > 0 ? montoRuleta * (multiplicador - 1) : -montoRuleta;
            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: cambioRuleta } });

            const textoRuleta = multiplicador > 0
                ? `🎡 Salió *${numeroSalido} (${colorSalido})*. ¡Ganaste *🪙 ${cambioRuleta} soles*!`
                : `🎡 Salió *${numeroSalido} (${colorSalido})*. Perdiste *🪙 ${montoRuleta} soles*.`;
            return await sock.sendMessage(from, { text: textoRuleta }, { quoted: m });
        }

        if (command === 'slots' || command === 'tragamonedas') {
            const montoSlots = parseInt(args[0]);
            if (!montoSlots || isNaN(montoSlots) || montoSlots <= 0) return await sock.sendMessage(from, { text: '⚠️ Formato: *#slots [monto]*' }, { quoted: m });
            
            const uSlots = await usersCollection.findOne({ jid: sender });
            const saldoSlots = uSlots?.soles || 0;
            if (saldoSlots < montoSlots) return await sock.sendMessage(from, { text: `❌ No tienes suficientes soles.` }, { quoted: m });

            const simbolos = ['🍒', '🍋', '🔔', '💎', '⭐'];
            const tirada = [0, 0, 0].map(() => simbolos[Math.floor(Math.random() * simbolos.length)]);
            const lineaTexto = tirada.join(' | ');

            let multiplicadorSlots = 0;
            if (tirada[0] === tirada[1] && tirada[1] === tirada[2]) {
                multiplicadorSlots = tirada[0] === '💎' ? 10 : 5;
            } else if (tirada[0] === tirada[1] || tirada[1] === tirada[2] || tirada[0] === tirada[2]) {
                multiplicadorSlots = 1.5;
            }

            const cambioSlots = multiplicadorSlots > 0 ? Math.round(montoSlots * (multiplicadorSlots - 1)) : -montoSlots;
            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: cambioSlots } });

            const textoSlots = multiplicadorSlots > 0
                ? `🎰 [ ${lineaTexto} ]\n¡Ganaste *🪙 ${cambioSlots} soles*!`
                : `🎰 [ ${lineaTexto} ]\nPerdiste *🪙 ${montoSlots} soles*.`;
            return await sock.sendMessage(from, { text: textoSlots }, { quoted: m });
        }

        if (command === 'imagen' || command === 'imgsearch') {
            const query = args.join(' ');
            if (!query) return await sock.sendMessage(from, { text: '⚠️ Escribe qué imagen buscas. Ej: *#imagen paisajes*' }, { quoted: m });
            try {
                await sock.sendMessage(from, { text: '🔍 Buscando imagen...' }, { quoted: m });
                const imageUrl = `https://picsum.photos/800/600?random=${Math.random()}`;
                await sock.sendMessage(from, { image: { url: imageUrl }, caption: `🖼️ Resultado para: *${query}*` }, { quoted: m });
            } catch {
                await sock.sendMessage(from, { text: '❌ No se pudo obtener la imagen.' }, { quoted: m });
            }
        }

        if (command === 'still') {
            const subAction = args[0]?.toLowerCase();
            const textoBanco = args.join(' ');

            if (!subAction || subAction === 'ver' || subAction === 'lista') {
                const notas = await bankCollection.find({ userJid: sender }).toArray();
                if (notas.length === 0) return await sock.sendMessage(from, { text: '📭 Tu banco personal `#still` está vacío.' }, { quoted: m });
                let txt = '📦 *TU BANCO PERSONAL (#STILL)* 📦\n\n';
                notas.forEach((n, idx) => { txt += `${idx + 1}. ID: \`${n._id}\`\n   📝 "${n.content}"\n\n`; });
                txt += `💡 Usa *#still borrar [ID]* para eliminar una nota.`;
                return await sock.sendMessage(from, { text: txt }, { quoted: m });
            }

            if (subAction === 'borrar' || subAction === 'del') {
                const { ObjectId } = require('mongodb');
                const idNota = args[1];
                if (!idNota) return await sock.sendMessage(from, { text: '⚠️ Especifica el ID de la nota.' }, { quoted: m });
                try {
                    const res = await bankCollection.deleteOne({ _id: new ObjectId(idNota), userJid: sender });
                    if (res.deletedCount > 0) return await sock.sendMessage(from, { text: '✅ Nota eliminada.' }, { quoted: m });
                    else return await sock.sendMessage(from, { text: '❌ No se encontró esa nota.' }, { quoted: m });
                } catch { return await sock.sendMessage(from, { text: '⚠️ ID inválido.' }, { quoted: m }); }
            }
            await bankCollection.insertOne({ userJid: sender, content: textoBanco, createdAt: new Date() });
            return await sock.sendMessage(from, { text: `✅ ¡Guardado con éxito!\n📌 "${textoBanco}"` }, { quoted: m });
        }

        if (command === 'edad') {
            const edadNum = parseInt(args[0]);
            if (!edadNum || isNaN(edadNum)) return await sock.sendMessage(from, { text: '⚠️ Indica una edad válida.' }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $set: { edad: edadNum } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ ¡Edad actualizada a *${edadNum} años*!` }, { quoted: m });
        }

        if (command === 'frase' || command === 'bio') {
            const fraseText = args.join(' ');
            if (!fraseText) return await sock.sendMessage(from, { text: '⚠️ Escribe tu frase personal.' }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $set: { frase: fraseText } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ Frase de perfil actualizada correctamente.` }, { quoted: m });
        }

        if (['facebook', 'instagram', 'discord', 'spotify', 'x'].includes(command)) {
            const redLink = args.join(' ');
            if (!redLink) return await sock.sendMessage(from, { text: `⚠️ Escribe tu enlace de ${command}.` }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $set: { [`redes.${command}`]: redLink } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ Enlace de *${command.toUpperCase()}* guardado con éxito.` }, { quoted: m });
        }

        if (command === 'setsticker' || command === 'identidad') {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (messageType !== 'stickerMessage' && !q?.stickerMessage) return await sock.sendMessage(from, { text: '⚠️ Responde a un sticker.' }, { quoted: m });
            try {
                const targetMsg = q ? { message: q } : m;
                const stickerBuf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                await usersCollection.updateOne({ jid: sender }, { $set: { stickerBase64: stickerBuf.toString('base64') } }, { upsert: true });
                await sock.sendMessage(from, { text: '✅ ¡Sticker guardado con éxito!' }, { quoted: m });
            } catch { await sock.sendMessage(from, { text: '❌ Error al guardar el sticker.' }, { quoted: m }); }
        }

        if (command === 'perfil' || command === 'verperfil') {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant || sender;
            const uData = await usersCollection.findOne({ jid: target }) || {};
            const statsData = from.endsWith('@g.us') ? (await groupStatsCollection.findOne({ jid: target, groupId: from }) || {}) : {};
            
            let parejas = uData.pareja || [];
            if (typeof parejas === 'string') parejas = [parejas];
            let nombrePareja = parejas.length > 0 ? parejas.map(p => `@${p.split('@')[0]} 💍`).join(', ') : 'Soltero/a 💔';

            const redes = uData.redes || {};
            let redesTxt = '';
            if (redes.facebook) redesTxt += `📘 *Facebook:* ${redes.facebook}\n`;
            if (redes.instagram) redesTxt += `📸 *Instagram:* ${redes.instagram}\n`;
            if (redes.discord) redesTxt += `🎮 *Discord:* ${redes.discord}\n`;
            if (redes.spotify) redesTxt += `🎧 *Spotify:* ${redes.spotify}\n`;
            if (redes.x) redesTxt += `✖️ *X:* ${redes.x}\n`;

            const perfilTxt = `👤 *PERFIL DE USUARIO* 👤\n` +
                `────────────────────────\n` +
                `📌 *Usuario:* @${target.split('@')[0]}\n` +
                `🎂 *Edad:* ${uData.edad ? uData.edad + ' años' : 'No especificada'}\n` +
                `⚧️ *Género:* ${uData.genero || 'No especificado'}\n` +
                `💬 *Frase:* "${uData.frase || 'Sin frase'}"\n` +
                `💍 *Estado Civil:* ${nombrePareja}\n` +
                `🎂 *Cumpleaños:* ${uData.cumple || 'No registrado'}\n` +
                `🪙 *Soles:* ${uData.soles || 0}\n` +
                `📊 *Mensajes:* ${statsData.messageCount || 0}\n` +
                (redesTxt ? `\n🌐 *REDES SOCIALES:*\n${redesTxt}` : '');

            await sock.sendMessage(from, { text: perfilTxt, mentions: [target, ...parejas].filter(Boolean) }, { quoted: m });
            if (uData.stickerBase64) {
                try { await sock.sendMessage(from, { sticker: Buffer.from(uData.stickerBase64, 'base64') }); } catch {}
            }
        }

        if (command === 'recordatorio' || command === 'rec' || command === 'recordatorio-grupo' || command === 'recg') {
            const esGrupal = command.includes('grupo') || command === 'recg';
            const destinoJid = esGrupal ? from : sender;
            if (esGrupal && !from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Comando de grupo.' }, { quoted: m });
            const arg1 = args[0];
            const arg2 = args[1];

            if (!arg1 || !arg2) return await sock.sendMessage(from, { text: '⚠️ Formato incorrecto. Ej: `#rec 10m Mensaje` o `#recg 10/09 15:30 Mensaje`' }, { quoted: m });

            let fechaEjecucion = null;
            let tiempoTextoMostrar = '';
            let mensajeRec = '';

            if (arg1.includes('/')) {
                const [dia, mes] = arg1.split('/').map(Number);
                const horaStr = arg2;
                if (!horaStr || !horaStr.includes(':')) return await sock.sendMessage(from, { text: '⚠️ Formato de hora inválido.' }, { quoted: m });
                const [hora, minuto] = horaStr.split(':').map(Number);
                const hoyPeru = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
                fechaEjecucion = new Date(hoyPeru.getFullYear(), mes - 1, dia, hora, minuto, 0);
                if (fechaEjecucion < hoyPeru) fechaEjecucion.setFullYear(hoyPeru.getFullYear() + 1);
                tiempoTextoMostrar = `el ${arg1} a las ${arg2}`;
                mensajeRec = args.slice(2).join(' ');
            } else {
                const match = arg1.match(/^(\d+)([smh])$/);
                if (!match) return await sock.sendMessage(from, { text: '⚠️ Unidad de tiempo inválida.' }, { quoted: m });
                const cantidad = parseInt(match[1]);
                const unidad = match[2];
                let multiplicador = 1000;
                if (unidad === 'm') multiplicador = 60 * 1000;
                if (unidad === 'h') multiplicador = 60 * 60 * 1000;
                fechaEjecucion = new Date(Date.now() + cantidad * multiplicador);
                tiempoTextoMostrar = arg1;
                mensajeRec = args.slice(1).join(' ');
            }

            if (!mensajeRec) return await sock.sendMessage(from, { text: '⚠️ Faltó el mensaje.' }, { quoted: m });

            const resultado = await remindersCollection.insertOne({ 
                userJid: sender, targetJid: destinoJid, isGroup: esGrupal, message: mensajeRec, executeAt: fechaEjecucion, createdAt: new Date() 
            });

            return await sock.sendMessage(from, { text: `✅ ¡Recordatorio programado! Te avisaré ${tiempoTextoMostrar} (ID: \`${resultado.insertedId}\`).` }, { quoted: m });
        }

        if (command === 'kill' || command === 'ban') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Solo grupos.' }, { quoted: m });
            try {
                const meta = await sock.groupMetadata(from);
                const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
                const botNumber = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
                
                if (!admins.includes(sender) && !esOwner(sender)) return await sock.sendMessage(from, { text: '⚠️ Solo administradores.' }, { quoted: m });
                if (!admins.includes(botNumber)) return await sock.sendMessage(from, { text: '❌ El bot necesita ser admin.' }, { quoted: m });

                const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant;
                if (!target) return await sock.sendMessage(from, { text: '⚠️ Menciona al usuario.' }, { quoted: m });

                const stickerKill = await obtenerGifAleatorio('anime punch fight kick kickout', 'https://media.giphy.com/media/l1J9EdzfOSgfyfeLm/giphy.gif');
                await sock.sendMessage(from, { text: `💥 ¡Hasta la vista, @${target.split('@')[0]}!`, mentions: [target] }, { quoted: m });
                if (stickerKill) await sock.sendMessage(from, { sticker: stickerKill });
                await sock.groupParticipantsUpdate(from, [target], 'remove');
            } catch { await sock.sendMessage(from, { text: '❌ No se pudo expulsar.' }, { quoted: m }); }
        }

        if (command === 'consumo' || command === 'stats' || command === 'recursos') {
            if (!esOwner(sender)) return;
            const memUsadaByBot = process.memoryUsage().rss / (1024 * 1024);
            const statsText = `📊 *MONITOREO DE RECURSOS - COCOBOT* 📊\n` +
                `────────────────────────\n` +
                `🖥️ *Hosting:* Render (Cloud Free Tier)\n` +
                `🧠 *RAM Usada (Bot Node.js):* ${memUsadaByBot.toFixed(2)} MB\n` +
                `⚡ *CPU Cores:* ${os.cpus().length} Núcleos\n` +
                `⏱️ *Uptime:* ${(process.uptime() / 60).toFixed(1)} minutos\n`;
            return await sock.sendMessage(from, { text: statsText }, { quoted: m });
        }

        if (command === 'tokens' || command === 'apistats' || command === 'usoapis') {
            if (!esOwner(sender)) return;
            const reporteTokens = `📊 *REPORTE DE CONSUMO DE APIS* 📊\n` +
                `🤖 *Gemini AI:* Peticiones: \`${apiUsageStats.geminiRequests}\` | Tokens Totales: \`${apiUsageStats.totalTokensUsed}\`\n` +
                `🪙 *CoinGecko:* Peticiones: \`${apiUsageStats.coinGeckoRequests}\``;
            return await sock.sendMessage(from, { text: reporteTokens }, { quoted: m });
        }

        if (command === 'topmsg' || command === 'masactivos') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Solo grupos.' }, { quoted: m });
            const topUsers = await groupStatsCollection.find({ groupId: from, messageCount: { $exists: true } }).sort({ messageCount: -1 }).limit(5).toArray();
            if (topUsers.length === 0) return await sock.sendMessage(from, { text: '📊 Aún no hay registros.' }, { quoted: m });
            let txt = '🏆 *TOP 5 - USUARIOS QUE MÁS ESCRIBEN* 🏆\n\n';
            topUsers.forEach((u, i) => { txt += `${i + 1}. @${u.jid.split('@')[0]} ➡️ *${u.messageCount || 0} mensajes*\n`; });
            return await sock.sendMessage(from, { text: txt, mentions: topUsers.map(u => u.jid) }, { quoted: m });
        }

        if (command === 'lowmsg' || command === 'menosactivos') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Solo grupos.' }, { quoted: m });
            const lowUsers = await groupStatsCollection.find({ groupId: from, messageCount: { $exists: true } }).sort({ messageCount: 1 }).limit(5).toArray();
            if (lowUsers.length === 0) return await sock.sendMessage(from, { text: '📊 Aún no hay registros.' }, { quoted: m });
            let txt = '💤 *TOP 5 - USUARIOS QUE MENOS ESCRIBEN* 💤\n\n';
            lowUsers.forEach((u, i) => { txt += `${i + 1}. @${u.jid.split('@')[0]} ➡️ *${u.messageCount || 0} mensajes*\n`; });
            return await sock.sendMessage(from, { text: txt, mentions: lowUsers.map(u => u.jid) }, { quoted: m });
        }

        if (command === 'genero') {
            const generoTexto = args.join(' ');
            if (!generoTexto) return await sock.sendMessage(from, { text: '⚠️ Escribe tu género.' }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $set: { genero: generoTexto } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ Género actualizado a: *${generoTexto}*.` }, { quoted: m });
        }

        if (command === 'casarse' || command === 'matrimonio') {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target || target === sender) return await sock.sendMessage(from, { text: '⚠️ Menciona a otra persona para casarte.' }, { quoted: m });
            
            const uData = await usersCollection.findOne({ jid: sender });
            const parejas = Array.isArray(uData?.pareja) ? uData.pareja : (uData?.pareja ? [uData.pareja] : []);
            
            if (parejas.includes(target)) return await sock.sendMessage(from, { text: '⚠️ Ya estás casado/a con esa persona.' }, { quoted: m });

            propuestasMatrimonio.set(target, sender);
            return await sock.sendMessage(from, { text: `💍 ¡@${sender.split('@')[0]} le propuso matrimonio a @${target.split('@')[0]}!\nEscribe *#aceptar* para confirmar.`, mentions: [sender, target] }, { quoted: m });
        }

        if (command === 'aceptar') {
            const proponte = propuestasMatrimonio.get(sender);
            if (!proponte) return await sock.sendMessage(from, { text: '⚠️ No tienes propuestas pendientes.' }, { quoted: m });
            
            await usersCollection.updateOne({ jid: sender }, { $addToSet: { pareja: proponte } }, { upsert: true });
            await usersCollection.updateOne({ jid: proponte }, { $addToSet: { pareja: sender } }, { upsert: true });
            
            propuestasMatrimonio.delete(sender);
            return await sock.sendMessage(from, { text: `🎉 ¡VIVA LOS NOVIOS! @${proponte.split('@')[0]} y @${sender.split('@')[0]} están casados. 💍`, mentions: [sender, proponte] }, { quoted: m });
        }

        if (command === 'bal' || command === 'balance') {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || sender;
            const u = await usersCollection.findOne({ jid: target });
            const esMio = target === sender;
            const mensajeSaldo = esMio 
                ? `🪙 Tienes *${u ? (u.soles || 0) : 0} soles*.` 
                : `🪙 El usuario @${target.split('@')[0]} tiene *${u ? (u.soles || 0) : 0} soles*.`;
            return await sock.sendMessage(from, { text: mensajeSaldo, mentions: [target] }, { quoted: m });
        }

        if (command === 'work' || command === 'w') {
            const earned = Math.floor(Math.random() * 400) + 100;
            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: earned } }, { upsert: true });
            return await sock.sendMessage(from, { text: `💼 Trabajaste duro y ganaste *🪙 ${earned} soles*.` }, { quoted: m });
        }

        if (command === 'daily') {
            const u = await usersCollection.findOne({ jid: sender });
            if (u?.lastDaily && Date.now() - u.lastDaily < 86400000) return await sock.sendMessage(from, { text: '⏳ Ya reclamaste tu recompensa diaria.' }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $inc: { soles: 2000 }, $set: { lastDaily: Date.now() } }, { upsert: true });
            return await sock.sendMessage(from, { text: '🎉 ¡Reclamaste tu recompensa diaria de *🪙 2000 soles*!' }, { quoted: m });
        }
    });
}

// ==========================================
// 5. FUNCIONES PROGRAMADAS
// ==========================================
function iniciarVerificadorRecordatorios(sock, remindersCollection) {
    setInterval(async () => {
        try {
            const ahora = new Date();
            const pendientes = await remindersCollection.find({ executeAt: { $lte: ahora } }).toArray();

            for (const rec of pendientes) {
                try {
                    const txt = rec.isGroup ? `⏰ *¡RECORDATORIO GRUPAL!* ⏰\n\n📌 *${rec.message}*` : `⏰ *¡RECORDATORIO!* ⏰\n\n📌 *${rec.message}*`;
                    const options = rec.isGroup ? { mentions: (await sock.groupMetadata(rec.targetJid)).participants.map(p => p.id) } : {};
                    await sock.sendMessage(rec.targetJid, { text: txt, ...options });
                    await remindersCollection.deleteOne({ _id: rec._id });
                } catch (err) {}
            }
        } catch (e) {}
    }, 10 * 1000); 
}

function iniciarVerificadorCumpleaños(sock, usersCollection) {
    const groupId = '120363422057355283@g.us'; 
    let ultimoControlEnviado = null;

    setInterval(async () => {
        try {
            const ahora = new Date();
            const formatter = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
            const parts = formatter.formatToParts(ahora);
            let d = '', m = '', h = '', min = '';
            parts.forEach(p => {
                if (p.type === 'day') d = p.value;
                if (p.type === 'month') m = p.value;
                if (p.type === 'hour') h = p.value;
                if (p.type === 'minute') min = p.value;
            });

            const hoy = `${d}/${m}`;
            const controlKey = `${hoy}-${h}:${min}`;

            if (h === '00' && min === '00' && ultimoControlEnviado !== controlKey) {
                ultimoControlEnviado = controlKey;
                const cumpleañeros = await usersCollection.find({ cumple: hoy }).toArray();
                for (let user of cumpleañeros) {
                    await sock.sendMessage(groupId, { 
                        text: `🎉 ¡MUY FELIZ CUMPLEAÑOS @${user.jid.split('@')[0]}! 🎂🥳\n\nDe parte de todos en el grupo te deseamos un día genial. ¡Disfrútalo al máximo! 🎁🎈`, 
                        mentions: [user.jid] 
                    });
                }
            }
        } catch (e) {}
    }, 30 * 1000); 
}

connectToWhatsApp();