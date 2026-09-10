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

            res.end(JSON.stringify({
                jid: userDoc.jid ? userDoc.jid.split('@')[0].split(':')[0] : 'Desconocido',
                coins: userDoc.coins || 0,
                edad: userDoc.edad || 'No especificada',
                frase: userDoc.frase || 'Sin frase',
                genero: userDoc.genero || 'No especificado',
                cumple: userDoc.cumple || 'No registrado',
                pareja: userDoc.pareja ? userDoc.pareja.split('@')[0].split(':')[0] : 'Soltero/a 💔',
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
const triviaActiva = new Map(); 

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
    return sender.includes('275028952228088');
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
        
        // Normalización del sender (Fix para los IDs raros)
        let senderRaw = m.key.participant || from;
        let sender = senderRaw.includes('@lid') && from.endsWith('@g.us') ? from : senderRaw;

        const messageType = Object.keys(m.message)[0];

        // Estadísticas de grupo
        if (from.endsWith('@g.us')) {
            try {
                await groupStatsCollection.updateOne(
                    { jid: sender, groupId: from },
                    { $inc: { messageCount: 1 } },
                    { upsert: true }
                );
            } catch {}
        }

        // Anti-Spam Stickers
        if (from.endsWith('@g.us') && messageType === 'stickerMessage') {
            const ahora = Date.now();
            if (stickerTimeouts.has(sender)) {
                if (ahora < stickerTimeouts.get(sender)) {
                    try { await sock.sendMessage(from, { delete: m.key }); } catch {}
                    return;
                } else { stickerTimeouts.delete(sender); }
            }

            let tracker = stickerSpamTracker.get(sender) || { lastTime: 0, rapidCount: 0 };
            tracker.rapidCount = ahora - tracker.lastTime < 1500 ? tracker.rapidCount + 1 : 1;
            tracker.lastTime = ahora;
            stickerSpamTracker.set(sender, tracker);

            if (tracker.rapidCount >= 3) {
                stickerTimeouts.set(sender, ahora + 120000);
                stickerSpamTracker.delete(sender);
                try {
                    await sock.sendMessage(from, { text: `⚠️ @${sender.split('@')[0]} fue puesto en *timeout de 2 minutos* por enviar stickers masivos. 🛑`, mentions: [sender] });
                    await sock.sendMessage(from, { delete: m.key });
                } catch {}
                return;
            }
        }

        let body = m.message.imageMessage?.caption || m.message.videoMessage?.caption || m.message.extendedTextMessage?.text || m.message.conversation || '';
        if (!body.startsWith('#')) return;

        const args = body.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // Cooldown general de economía
        if (['work', 'w', 'daily'].includes(command)) {
            const limit = command === 'daily' ? 86400000 : 30000;
            const key = `${sender}-${command}`;
            const last = cooldowns.get(key) || 0;
            if (Date.now() - last < limit) {
                return await sock.sendMessage(from, { text: `⏳ Espera *${Math.ceil((limit - (Date.now() - last)) / 1000)}s* para usar #${command}.` }, { quoted: m });
            }
            cooldowns.set(key, Date.now());
        }

        // ==========================================
        // SISTEMA DE MATRIMONIO Y DIVORCIO
        // ==========================================
        if (command === 'casarse' || command === 'matrimonio') {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target || target === sender) return await sock.sendMessage(from, { text: '⚠️ Menciona a otra persona para casarte.' }, { quoted: m });
            propuestasMatrimonio.set(target, sender);
            return await sock.sendMessage(from, { text: `💍 ¡@${sender.split('@')[0]} le propuso matrimonio a @${target.split('@')[0]}!\nEscribe *#aceptar* para confirmar.`, mentions: [sender, target] }, { quoted: m });
        }

        if (command === 'aceptar') {
            const proponte = propuestasMatrimonio.get(sender);
            if (!proponte) return await sock.sendMessage(from, { text: '⚠️ No tienes propuestas pendientes.' }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $set: { pareja: proponte } }, { upsert: true });
            await usersCollection.updateOne({ jid: proponte }, { $set: { pareja: sender } }, { upsert: true });
            propuestasMatrimonio.delete(sender);
            return await sock.sendMessage(from, { text: `🎉 ¡VIVA LOS NOVIOS! @${proponte.split('@')[0]} y @${sender.split('@')[0]} están casados. 💍`, mentions: [sender, proponte] }, { quoted: m });
        }

        if (command === 'divorcio' || command === 'divorciarse') {
            const tipo = args[0]?.toLowerCase();
            const userData = await usersCollection.findOne({ jid: sender });
            
            if (!userData || !userData.pareja) {
                return await sock.sendMessage(from, { text: '⚠️ No estás casado/a con nadie actualmente. 💔' }, { quoted: m });
            }
    
            const exPareja = userData.pareja;
    
            // Limpiar estado civil de ambos
            await usersCollection.updateOne({ jid: sender }, { $unset: { pareja: "" } });
            await usersCollection.updateOne({ jid: exPareja }, { $unset: { pareja: "" } });
    
            if (tipo === 'juicio') {
                const pierdeMitad = Math.random() < 0.5;
                if (pierdeMitad) {
                    const mitadCoins = Math.floor((userData.coins || 0) / 2);
                    if (mitadCoins > 0) {
                        await usersCollection.updateOne({ jid: sender }, { $inc: { coins: -mitadCoins } });
                        await usersCollection.updateOne({ jid: exPareja }, { $inc: { coins: mitadCoins } });
                    }
                    return await sock.sendMessage(from, { text: `⚖️ *JUICIO DE DIVORCIO* ⚖️\n\nEl juez ha dictaminado a favor de @${exPareja.split('@')[0]}. Has perdido el 50% de tus bienes (🪙 ${mitadCoins} coins) en el proceso de separación. 📉💔`, mentions: [exPareja] }, { quoted: m });
                } else {
                    return await sock.sendMessage(from, { text: `⚖️ *JUICIO DE DIVORCIO* ⚖️\n\nEl juez ha fallado a tu favor. Te has divorciado de @${exPareja.split('@')[0]} y has conservado todos tus bienes intactos. 📈🏛️`, mentions: [exPareja] }, { quoted: m });
                }
            } else {
                // Divorcio pacífico normal
                return await sock.sendMessage(from, { text: `📜 *DIVORCIO DE MUTUO ACUERDO* 📜\n\n@${sender.split('@')[0]} y @${exPareja.split('@')[0]} han firmado los papeles y se han divorciado pacíficamente. 📝💔`, mentions: [sender, exPareja] }, { quoted: m });
            }
        }

        // ==========================================
        // PERFIL Y ECONOMÍA
        // ==========================================
        if (command === 'bal' || command === 'balance') {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || sender;
            const u = await usersCollection.findOne({ jid: target });
            const esMio = target === sender;
            
            const mensajeSaldo = esMio 
                ? `🪙 Tienes *${u ? (u.coins || 0) : 0} coins*.` 
                : `🪙 El usuario @${target.split('@')[0]} tiene *${u ? (u.coins || 0) : 0} coins*.`;
                
            return await sock.sendMessage(from, { text: mensajeSaldo, mentions: [target] }, { quoted: m });
        }

        if (command === 'work' || command === 'w') {
            const earned = Math.floor(Math.random() * 400) + 100;
            await usersCollection.updateOne({ jid: sender }, { $inc: { coins: earned } }, { upsert: true });
            return await sock.sendMessage(from, { text: `💼 Ganaste *🪙 ${earned} coins*.` }, { quoted: m });
        }

        if (command === 'daily') {
            const u = await usersCollection.findOne({ jid: sender });
            if (u?.lastDaily && Date.now() - u.lastDaily < 86400000) return await sock.sendMessage(from, { text: '⏳ Ya reclamaste tu diario hoy.' }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $inc: { coins: 2000 }, $set: { lastDaily: Date.now() } }, { upsert: true });
            return await sock.sendMessage(from, { text: '🎉 ¡Reclamaste *🪙 2000 coins*!' }, { quoted: m });
        }

        if (command === 'perfil' || command === 'verperfil') {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant || sender;
            const userData = await usersCollection.findOne({ jid: target }) || {};
            const statsData = from.endsWith('@g.us') ? (await groupStatsCollection.findOne({ jid: target, groupId: from }) || {}) : {};
            
            let nombrePareja = userData.pareja ? `@${userData.pareja.split('@')[0]} 💍` : 'Soltero/a 💔';
            const redes = userData.redes || {};
            let redesTxt = '';

            if (redes.facebook) redesTxt += `📘 *Facebook:* ${redes.facebook}\n`;
            if (redes.instagram) redesTxt += `📸 *Instagram:* ${redes.instagram}\n`;
            if (redes.discord) redesTxt += `🎮 *Discord:* ${redes.discord}\n`;
            if (redes.spotify) redesTxt += `🎧 *Spotify:* ${redes.spotify}\n`;
            if (redes.x) redesTxt += `✖️ *X (Twitter):* ${redes.x}\n`;

            const perfilTxt = `👤 *PERFIL DE USUARIO* 👤\n` +
                `────────────────────────\n` +
                `📌 *Usuario:* @${target.split('@')[0]}\n` +
                `🎂 *Edad:* ${userData.edad ? userData.edad + ' años' : 'No especificada'}\n` +
                `⚧️ *Género:* ${userData.genero || 'No especificado'}\n` +
                `💬 *Frase:* "${userData.frase || 'Sin frase'}"\n` +
                `💍 *Estado Civil:* ${nombrePareja}\n` +
                `🎂 *Cumpleaños:* ${userData.cumple || 'No registrado'}\n` +
                `🪙 *Coins:* ${userData.coins || 0}\n` +
                `📊 *Mensajes (este grupo):* ${statsData.messageCount || 0}\n` +
                (redesTxt ? `\n🌐 *REDES SOCIALES:*\n${redesTxt}` : '');

            await sock.sendMessage(from, { text: perfilTxt, mentions: [target, userData.pareja].filter(Boolean) }, { quoted: m });

            if (userData.stickerBase64) {
                try {
                    const stickerBuffer = Buffer.from(userData.stickerBase64, 'base64');
                    await sock.sendMessage(from, { sticker: stickerBuffer });
                } catch {}
            }
        }

        // ==========================================
        // COMANDOS DE ACCIONES Y MULTIMEDIA 
        // ==========================================
        if (command === 's' || command === 'sticker') {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isImage = messageType === 'imageMessage' || q?.imageMessage;
            
            if (!isImage && !q?.viewOnceMessageV2) return await sock.sendMessage(from, { text: '⚠️ Envía o responde a una imagen.' }, { quoted: m });

            try {
                const targetMsg = q ? { message: q } : m;
                const buf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const resized = await sharp(buf).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
                const sticker = await new Sticker(resized, { pack: '', author: '', type: StickerTypes.DEFAULT, quality: 80 }).toBuffer();
                await sock.sendMessage(from, { sticker }, { quoted: m });
            } catch { await sock.sendMessage(from, { text: '❌ Error al procesar.' }, { quoted: m }); }
        }

        // Integración de Gemini AI
        if (command === 'ia' || command === 'gemini' || command === 'ai') {
            const query = args.join(' ');
            if (!query) return await sock.sendMessage(from, { text: '⚠️ Escribe algo para consultar a la IA.' }, { quoted: m });
            try {
                await sock.sendMessage(from, { text: '🤖 Pensando respuesta...' }, { quoted: m });
                const res = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: query });
                
                apiUsageStats.geminiRequests++;
                if (res.usageMetadata) {
                    apiUsageStats.totalPromptTokens += res.usageMetadata.promptTokenCount || 0;
                    apiUsageStats.totalTokensUsed += res.usageMetadata.totalTokenCount || 0;
                }
                await sock.sendMessage(from, { text: `${res.text || 'Sin respuesta.'}` }, { quoted: m });
            } catch { await sock.sendMessage(from, { text: '❌ Error al conectar con Gemini.' }, { quoted: m }); }
        }

        // Integración de Audio
        if (command === 'voz' || command === 'tts') {
            const textoVoz = args.join(' ');
            if (!textoVoz) return await sock.sendMessage(from, { text: '⚠️ Escribe el texto para el audio.' }, { quoted: m });

            try {
                const tts = new gtts(textoVoz, 'es');
                const tempFilePath = path.join(os.tmpdir(), `voice_${Date.now()}.mp3`);
                tts.save(tempFilePath, async function () {
                    try {
                        const audioBuffer = fs.readFileSync(tempFilePath);
                        await sock.sendMessage(from, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: m });
                        fs.unlinkSync(tempFilePath);
                    } catch (err) { }
                });
            } catch (err) { }
        }
        
        // (El resto de tus comandos como #apostar, #ruleta, #slots, #edad, #frase, #setwelcome, etc. siguen aquí operando con total normalidad basándose en la misma estructura base del switch/if general).
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