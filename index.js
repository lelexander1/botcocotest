const { default: makeWASocket, DisconnectReason, downloadMediaMessage, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const { MongoClient } = require('mongodb');
const sharp = require('sharp');
const axios = require('axios');
const { Sticker, createSticker, StickerTypes } = require('wa-sticker-formatter');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const PORT = process.env.PORT || 3000;

// Servidor HTTP web para Render
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CocoBot 24/7 activo y blindado contra caídas!\n');
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP corriendo en el puerto ${PORT}`);
    
    // Auto-ping seguro usando axios para evitar el error de protocolo HTTPS en Render
    setInterval(async () => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        try {
            await axios.get(appUrl);
        } catch {}
    }, 3 * 60 * 1000);
});

const cooldowns = new Map();
const stickerSpamTracker = new Map(); 
const stickerTimeouts = new Map();     
const propuestasMatrimonio = new Map(); 

// Adaptador de sesión en MongoDB Atlas con purga automática de 7 días
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

// Obtener GIF animado aleatorio desde Giphy con respaldo
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
            console.log(`⚠️ Conexión cerrada (Código: ${statusCode}). Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        } else if (connection === 'open') {
            console.log('¡CocoBot conectado, en línea y blindado contra caídas!');
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
                    const msg = groupConfig?.welcome || `👋 ¡Bienvenido/a @${tag} al grupo *${mdata.subject}*! 🎉\nDisfruta tu estancia y revisa las reglas.`;
                    await sock.sendMessage(id, { text: msg, mentions: [user] });
                } else if (action === 'remove' || action === 'leave') {
                    const msg = groupConfig?.goodbye || `🚪 @${tag} ha dejado el grupo. ¡Hasta luego! 👋`;
                    await sock.sendMessage(id, { text: msg, mentions: [user] });
                    const stickerBye = await obtenerGifAleatorio('sad goodbye anime crying', 'https://media.giphy.com/media/7SF5scMBmlAFrg4uUs/giphy.gif');
                    if (stickerBye) await sock.sendMessage(id, { sticker: stickerBye });
                }
            }
        } catch (e) { console.error('Error en participantes:', e); }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const sender = m.key.participant || from;
        const messageType = Object.keys(m.message)[0];

        try {
            await usersCollection.updateOne(
                { jid: sender }, 
                { $inc: { messageCount: 1 }, $setOnInsert: { coins: 0 } }, 
                { upsert: true }
            );
        } catch {}

        // --- SISTEMA ANTISPAM DE STICKERS ---
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
                `🤖 *#ia [texto]*\n   ↳ Consulta preguntas a la Inteligencia Artificial.\n\n` +
                `🙃 *#si*\n   ↳ Envía la palabra a la IA para recibir una respuesta ingeniosa contraria (ej: un rotundo "No").\n\n` +
                `😂 *#chistes*\n   ↳ Envía un chiste corto de manera aleatoria.\n\n` +
                `🖼️ *#imagen [tema]*\n   ↳ Busca y envía una foto aleatoria de alta calidad.\n\n` +
                `📦 *#still [texto / ver / borrar]*\n   ↳ Tu banco personal de notas o frases guardadas.\n\n` +
                `👤 *#edad [núm], #frase [txt], #setsticker*\n   ↳ Configura tu edad, frase personal y sticker de perfil.\n\n` +
                `🔗 *#facebook, #instagram, #discord, #spotify, #x [link]*\n   ↳ Añade tus redes sociales a tu tarjeta de perfil.\n\n` +
                `👁️ *#perfil [@usuario]*\n   ↳ Muestra tu tarjeta de perfil con redes sociales y sticker ID.\n\n` +
                `⏰ *#recordatorio o #rec [tiempo/fecha] [mensaje]*\n   ↳ Programa un recordatorio privado o fecha exacta.\n\n` +
                `📢 *#recordatorio-grupo o #recg [tiempo/fecha] [mensaje]*\n   ↳ Programa un recordatorio que sonará para todo el grupo.\n\n` +
                `📋 *#misrecordatorios / #borrarrec [id]*\n   ↳ Administra tus recordatorios pendientes.\n\n` +
                `🎨 *#s / #gif / #toimg*\n   ↳ Crea stickers limpios (sin estirar ni marcas), videos animados o pasa stickers a foto.\n\n` +
                `🥷 *#kill [@usuario]*\n   ↳ Expulsa a un usuario con un GIF (Solo Admins).\n\n` +
                `📊 *#consumo / #topmsg / #lowmsg*\n   ↳ Muestra recursos del servidor y ranking de mensajes.\n\n` +
                `⚧️ *#genero [texto]*\n   ↳ Actualiza tu género libremente.\n\n` +
                `💍 *#casarse [@usuario] / #aceptar*\n   ↳ Propón matrimonio y cásate.\n\n` +
                `🎂 *#cumple DD/MM / #cumples*\n   ↳ Registra tu cumpleaños y consulta festejos.\n\n` +
                `⚙️ *#setwelcome / #setgoodbye / #untimeout*\n   ↳ Configura bienvenidas, despedidas y quita castigos.\n\n` +
                `🪙 *#bal / #work / #daily / #flip / #del / #anuncio*\n   ↳ Economía, juegos, moderación y anuncios a todos (ocultos).`;

            return await sock.sendMessage(from, { text: menu }, { quoted: m });
        }

        // --- NUEVO COMANDO #SI (PROCESADO POR IA CON RESPUESTA INGENIOSA / "NO") ---
        if (command === 'si') {
            try {
                const promptIa = "El usuario acaba de decir o invocar la palabra '#si'. Analiza esta palabra con sarcasmo o humor y respóndele de manera tajante, creativa o generando un concepto contrario como un rotundo 'No' o algo gracioso relacionado.";
                const res = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: promptIa });
                return await sock.sendMessage(from, { text: `🤖 *CocoBot IA*:\n\n${res.text || '¡No!'}` }, { quoted: m });
            } catch {
                return await sock.sendMessage(from, { text: '❌ ¡No!' }, { quoted: m });
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

        if (command === 'imagen' || command === 'imgsearch') {
            const query = args.join(' ');
            if (!query) return await sock.sendMessage(from, { text: '⚠️ Escribe qué imagen buscas. Ej: *#imagen paisajes* o *#imagen gatos*' }, { quoted: m });
            try {
                await sock.sendMessage(from, { text: '🔍 Buscando imagen...' }, { quoted: m });
                const imageUrl = `https://source.unsplash.com/featured/800x600/?${encodeURIComponent(query)}`;
                await sock.sendMessage(from, { image: { url: imageUrl }, caption: `🖼️ Resultado para: *${query}*` }, { quoted: m });
            } catch {
                await sock.sendMessage(from, { text: '❌ No se pudo obtener la imagen en este momento.' }, { quoted: m });
            }
        }

        if (command === 'still') {
            const subAction = args[0]?.toLowerCase();
            const textoBanco = args.join(' ');

            if (!subAction || subAction === 'ver' || subAction === 'lista') {
                const notas = await bankCollection.find({ userJid: sender }).toArray();
                if (notas.length === 0) {
                    return await sock.sendMessage(from, { text: '📭 Tu banco personal `#still` está vacío.\nAñade algo escribiendo: *#still [tu texto o nota]*' }, { quoted: m });
                }
                let txt = '📦 *TU BANCO PERSONAL (#STILL)* 📦\n\n';
                notas.forEach((n, idx) => {
                    txt += `${idx + 1}. ID: \`${n._id}\`\n   📝 "${n.content}"\n\n`;
                });
                txt += `💡 Usa *#still borrar [ID]* para eliminar una nota.`;
                return await sock.sendMessage(from, { text: txt }, { quoted: m });
            }

            if (subAction === 'borrar' || subAction === 'del') {
                const { ObjectId } = require('mongodb');
                const idNota = args[1];
                if (!idNota) return await sock.sendMessage(from, { text: '⚠️ Especifica el ID de la nota a borrar. Revisa tu lista con *#still ver*.' }, { quoted: m });
                try {
                    const res = await bankCollection.deleteOne({ _id: new ObjectId(idNota), userJid: sender });
                    if (res.deletedCount > 0) return await sock.sendMessage(from, { text: '✅ Nota eliminada de tu banco personal.' }, { quoted: m });
                    else return await sock.sendMessage(from, { text: '❌ No se encontró esa nota en tu banco.' }, { quoted: m });
                } catch {
                    return await sock.sendMessage(from, { text: '⚠️ ID de nota inválido.' }, { quoted: m });
                }
            }

            await bankCollection.insertOne({ userJid: sender, content: textoBanco, createdAt: new Date() });
            return await sock.sendMessage(from, { text: `✅ ¡Guardado en tu banco personal (#still) con éxito!\n📌 "${textoBanco}"` }, { quoted: m });
        }

        if (command === 'edad') {
            const edadNum = parseInt(args[0]);
            if (!edadNum || isNaN(edadNum) || edadNum <= 0 || edadNum > 120) {
                return await sock.sendMessage(from, { text: '⚠️ Por favor, indica una edad válida. Ej: *#edad 22*' }, { quoted: m });
            }
            await usersCollection.updateOne({ jid: sender }, { $set: { edad: edadNum } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ ¡Edad actualizada a *${edadNum} años*!` }, { quoted: m });
        }

        if (command === 'frase' || command === 'bio') {
            const fraseText = args.join(' ');
            if (!fraseText) return await sock.sendMessage(from, { text: '⚠️ Escribe tu frase personal. Ej: *#frase Sin miedo al éxito*' }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $set: { frase: fraseText } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ Frase de perfil actualizada correctamente.` }, { quoted: m });
        }

        if (['facebook', 'instagram', 'discord', 'spotify', 'x'].includes(command)) {
            const redLink = args.join(' ');
            if (!redLink) return await sock.sendMessage(from, { text: `⚠️ Escribe tu enlace o usuario de ${command}. Ej: *#${command} [enlace o usuario]*` }, { quoted: m });
            
            let campoRed = `redes.${command}`;
            await usersCollection.updateOne({ jid: sender }, { $set: { [campoRed]: redLink } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ Enlace de *${command.toUpperCase()}* guardado en tu perfil con éxito.` }, { quoted: m });
        }

        if (command === 'setsticker' || command === 'identidad') {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (messageType !== 'stickerMessage' && !q?.stickerMessage) {
                return await sock.sendMessage(from, { text: '⚠️ Responde a un sticker con el comando *#setsticker* para asociarlo a tu perfil.' }, { quoted: m });
            }
            try {
                const targetMsg = q ? { message: q } : m;
                const stickerBuf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const base64Sticker = stickerBuf.toString('base64');
                await usersCollection.updateOne({ jid: sender }, { $set: { stickerBase64: base64Sticker } }, { upsert: true });
                await sock.sendMessage(from, { text: '✅ ¡Sticker de identidad guardado en tu perfil con éxito!' }, { quoted: m });
            } catch {
                await sock.sendMessage(from, { text: '❌ Error al guardar el sticker.' }, { quoted: m });
            }
        }

        if (command === 'perfil' || command === 'verperfil') {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant || sender;
            const userData = await usersCollection.findOne({ jid: target }) || {};
            
            let nombrePareja = 'Soltero/a 💔';
            if (userData.pareja) {
                nombrePareja = `@${userData.pareja.split('@')[0]} 💍`;
            }

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
                `⚧️ *Género:* ${userData.genero ? userData.genero : 'No especificado'}\n` +
                `💬 *Frase:* "${userData.frase ? userData.frase : 'Sin frase'}"\n` +
                `💍 *Estado Civil:* ${nombrePareja}\n` +
                `🎂 *Cumpleaños:* ${userData.cumple ? userData.cumple : 'No registrado'}\n` +
                `🪙 *Coins:* ${userData.coins || 0}\n` +
                `📊 *Mensajes:* ${userData.messageCount || 0}\n` +
                (redesTxt ? `\n🌐 *REDES SOCIALES:*\n${redesTxt}` : '');

            await sock.sendMessage(from, { text: perfilTxt, mentions: [target, userData.pareja].filter(Boolean) }, { quoted: m });

            if (userData.stickerBase64) {
                try {
                    const stickerBuffer = Buffer.from(userData.stickerBase64, 'base64');
                    await sock.sendMessage(from, { sticker: stickerBuffer });
                } catch {}
            }
        }

        if (command === 'recordatorio' || command === 'rec' || command === 'recordatorio-grupo' || command === 'recg') {
            const esGrupal = command.includes('grupo') || command === 'recg';
            const destinoJid = esGrupal ? from : sender;

            if (esGrupal && !from.endsWith('@g.us')) {
                return await sock.sendMessage(from, { text: '⚠️ El comando de recordatorio grupal solo se puede usar dentro de un grupo.' }, { quoted: m });
            }

            const arg1 = args[0];
            const arg2 = args[1];

            if (!arg1 || !arg2) {
                return await sock.sendMessage(from, { 
                    text: '⚠️ Formato incorrecto.\n\n' +
                          '• *Por tiempo (ej: 10m, 2h):*\n  `#recordatorio 10m Reunión`\n' +
                          '• *Por fecha exacta (ej: 10/09 a las 15:30):*\n  `#recordatorio 10/09 15:30 Ir al doctor`\n' +
                          '• *Para todo el grupo:*\n  `#recg 1h Alerta general`' 
                }, { quoted: m });
            }

            let fechaEjecucion = null;
            let tiempoTextoMostrar = '';
            let mensajeRec = '';

            if (arg1.includes('/')) {
                const [dia, mes] = arg1.split('/').map(Number);
                const horaStr = arg2;
                
                if (!horaStr || !horaStr.includes(':')) {
                    return await sock.sendMessage(from, { text: '⚠️ Formato de hora inválido. Usa *HH:mm* (ej: 18:30).' }, { quoted: m });
                }

                const [hora, minuto] = horaStr.split(':').map(Number);
                const hoyPeru = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
                
                fechaEjecucion = new Date(hoyPeru.getFullYear(), mes - 1, dia, hora, minuto, 0);
                if (fechaEjecucion < hoyPeru) {
                    fechaEjecucion.setFullYear(hoyPeru.getFullYear() + 1);
                }

                tiempoTextoMostrar = `el ${arg1} a las ${arg2}`;
                mensajeRec = args.slice(2).join(' ');
            } else {
                const match = arg1.match(/^(\d+)([smh])$/);
                if (!match) {
                    return await sock.sendMessage(from, { text: '⚠️ Unidad de tiempo inválida. Usa *s*, *m*, *h* o una fecha *DD/MM*.' }, { quoted: m });
                }

                const cantidad = parseInt(match[1]);
                const unidad = match[2];
                let multiplicador = 1000;
                if (unidad === 'm') multiplicador = 60 * 1000;
                if (unidad === 'h') multiplicador = 60 * 60 * 1000;

                fechaEjecucion = new Date(Date.now() + cantidad * multiplicador);
                tiempoTextoMostrar = arg1;
                mensajeRec = args.slice(1).join(' ');
            }

            if (!mensajeRec) {
                return await sock.sendMessage(from, { text: '⚠️ Te faltó escribir el mensaje del recordatorio.' }, { quoted: m });
            }

            const resultado = await remindersCollection.insertOne({ 
                userJid: sender, 
                targetJid: destinoJid,
                isGroup: esGrupal,
                message: mensajeRec, 
                executeAt: fechaEjecucion, 
                createdAt: new Date() 
            });

            const tipoDestinoTxt = esGrupal ? 'en este grupo' : 'por mensaje privado';
            return await sock.sendMessage(from, { text: `✅ ¡Recordatorio programado con éxito!\nTe avisaré ${tipoDestinoTxt} ${tiempoTextoMostrar} (ID: \`${resultado.insertedId}\`).` }, { quoted: m });
        }

        if (command === 'kill' || command === 'ban') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Este comando solo se puede usar en grupos.' }, { quoted: m });
            try {
                const meta = await sock.groupMetadata(from);
                const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
                const botNumber = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
                
                const isSenderAdmin = admins.includes(sender) || sender.includes('275028952228088');
                const isBotAdmin = admins.includes(botNumber);

                if (!isSenderAdmin) return await sock.sendMessage(from, { text: '⚠️ Solo los administradores pueden usar este comando.' }, { quoted: m });
                if (!isBotAdmin) return await sock.sendMessage(from, { text: '❌ El bot necesita ser administrador del grupo para poder expulsar.' }, { quoted: m });

                const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant;
                if (!target) return await sock.sendMessage(from, { text: '⚠️ Menciona al usuario. Ej: *#kill @usuario*' }, { quoted: m });

                const stickerKill = await obtenerGifAleatorio('anime punch fight kick kickout', 'https://media.giphy.com/media/l1J9EdzfOSgfyfeLm/giphy.gif');
                await sock.sendMessage(from, { text: `💥 ¡Hasta la vista, @${target.split('@')[0]}! Has sido eliminado del grupo. 🚀`, mentions: [target] }, { quoted: m });
                if (stickerKill) await sock.sendMessage(from, { sticker: stickerKill });
                await sock.groupParticipantsUpdate(from, [target], 'remove');
            } catch {
                await sock.sendMessage(from, { text: '❌ No se pudo expulsar al usuario.' }, { quoted: m });
            }
        }

        if (command === 'consumo' || command === 'stats' || command === 'recursos') {
            if (!sender.includes('275028952228088')) {
                if (from.endsWith('@g.us')) {
                    const meta = await sock.groupMetadata(from);
                    const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
                    if (!admins.includes(sender)) return await sock.sendMessage(from, { text: '⚠️ Comando exclusivo para administradores.' }, { quoted: m });
                } else {
                    return await sock.sendMessage(from, { text: '⚠️ Comando exclusivo para administradores.' }, { quoted: m });
                }
            }

            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            const formatoMB = (bytes) => (bytes / (1024 * 1024)).toFixed(2) + ' MB';

            let mongoStatus = '🟢 Conectado (Óptimo)';
            let mongoLatencyMs = 0;
            const tStart = Date.now();
            try {
                await db.command({ ping: 1 });
                mongoLatencyMs = Date.now() - tStart;
            } catch {
                mongoStatus = '🔴 Desconectado';
            }

            const statsText = `📊 *MONITOREO DE RECURSOS - COCOBOT* 📊\n` +
                `────────────────────────\n` +
                `🖥️ *Hosting:* Render (Cloud Instance)\n` +
                `🧠 *Memoria RAM Usada:* ${formatoMB(usedMem)} / ${formatoMB(totalMem)}\n` +
                `⚡ *CPU Cores:* ${os.cpus().length} Núcleos\n` +
                `🗄️ *Base de Datos (MongoDB Atlas):*\n` +
                `   • Estado: ${mongoStatus}\n` +
                `   • Latencia API: ${mongoLatencyMs} ms\n` +
                `📈 *Límites del Plan:* \n` +
                `   • Límite RAM Render (Free): 512 MB\n` +
                `   • Límite DB MongoDB (M0 Free): 512 MB\n` +
                `⏱️ *Uptime:* ${(process.uptime() / 60).toFixed(1)} minutos\n`;

            return await sock.sendMessage(from, { text: statsText }, { quoted: m });
        }

        if (command === 'topmsg' || command === 'masactivos') {
            const topUsers = await usersCollection.find({ messageCount: { $exists: true } }).sort({ messageCount: -1 }).limit(5).toArray();
            if (topUsers.length === 0) return await sock.sendMessage(from, { text: '📊 Aún no hay registros de mensajes.' }, { quoted: m });

            let txt = '🏆 *TOP 5 - USUARIOS QUE MÁS ESCRIBEN* 🏆\n\n';
            topUsers.forEach((u, i) => {
                txt += `${i + 1}. @${u.jid.split('@')[0]} ➡️ *${u.messageCount || 0} mensajes*\n`;
            });
            return await sock.sendMessage(from, { text: txt, mentions: topUsers.map(u => u.jid) }, { quoted: m });
        }

        if (command === 'lowmsg' || command === 'menosactivos') {
            const lowUsers = await usersCollection.find({ messageCount: { $exists: true } }).sort({ messageCount: 1 }).limit(5).toArray();
            if (lowUsers.length === 0) return await sock.sendMessage(from, { text: '📊 Aún no hay registros de mensajes.' }, { quoted: m });

            let txt = '💤 *TOP 5 - USUARIOS QUE MENOS ESCRIBEN* 💤\n\n';
            lowUsers.forEach((u, i) => {
                txt += `${i + 1}. @${u.jid.split('@')[0]} ➡️ *${u.messageCount || 0} mensajes*\n`;
            });
            return await sock.sendMessage(from, { text: txt, mentions: lowUsers.map(u => u.jid) }, { quoted: m });
        }

        if (command === 'genero') {
            const generoTexto = args.join(' ');
            if (!generoTexto) return await sock.sendMessage(from, { text: '⚠️ Escribe tu género. Ej: *#genero masculino*, *#genero no binario*...' }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $set: { genero: generoTexto } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ Género actualizado a: *${generoTexto}*.` }, { quoted: m });
        }

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

        if (command === 'ia' || command === 'gemini' || command === 'ai') {
            const query = args.join(' ');
            if (!query) return await sock.sendMessage(from, { text: '⚠️ Escribe algo para consultar a la IA.' }, { quoted: m });
            try {
                await sock.sendMessage(from, { text: '🤖 Pensando respuesta...' }, { quoted: m });
                const res = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: query });
                await sock.sendMessage(from, { text: `${res.text || 'Sin respuesta.'}` }, { quoted: m });
            } catch { await sock.sendMessage(from, { text: '❌ Error al conectar con Gemini.' }, { quoted: m }); }
        }

        if (command === 'cumple' || command === 'cumpleaños') {
            const fecha = args[0];
            if (!/^([0-2][0-9]|3[0-1])\/(0[1-9]|1[0-2])$/.test(fecha)) return await sock.sendMessage(from, { text: '⚠️ Usa el formato *DD/MM*.' }, { quoted: m });
            await usersCollection.updateOne({ jid: sender }, { $set: { cumple: fecha } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ Cumpleaños el *${fecha}* guardado.` }, { quoted: m });
        }

        if (command === 'cumples' || command === 'listarcumples') {
            const all = await usersCollection.find({ cumple: { $exists: true } }).toArray();
            if (all.length === 0) return await sock.sendMessage(from, { text: '📅 No hay cumpleaños registrados.' }, { quoted: m });
            all.sort((a, b) => calcularDiasFaltantes(a.cumple) - calcularDiasFaltantes(b.cumple));
            let txt = '🎂 *PRÓXIMOS CUMPLEAÑOS* 🎂\n\n';
            all.forEach((u, i) => {
                const d = calcularDiasFaltantes(u.cumple);
                txt += `${i + 1}. @${u.jid.split('@')[0]} ➡️ *${u.cumple}* ${d === 0 ? '🎉 *¡Es hoy!*' : `(Faltan ${d} días)`}\n`;
            });
            await sock.sendMessage(from, { text: txt, mentions: all.map(u => u.jid) }, { quoted: m });
        }

        if (command === 'flip' || command === 'coin') {
            return await sock.sendMessage(from, { text: `El resultado es: ${Math.random() < 0.5 ? '🪙 *Cara* 🎉' : '🪙 *Cruz* 🦅'}` }, { quoted: m });
        }

        if (command === 'setwelcome' || command === 'setgoodbye') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Solo en grupos.' }, { quoted: m });
            const meta = await sock.groupMetadata(from);
            const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
            if (!admins.includes(sender) && !sender.includes('275028952228088')) return await sock.sendMessage(from, { text: '⚠️ Solo administradores.' }, { quoted: m });
            const text = args.join(' ');
            if (!text) return await sock.sendMessage(from, { text: '⚠️ Escribe el mensaje.' }, { quoted: m });
            await groupsCollection.updateOne({ groupId: from }, { $set: { [command === 'setwelcome' ? 'welcome' : 'goodbye']: text } }, { upsert: true });
            return await sock.sendMessage(from, { text: '✅ Configuración actualizada con éxito.' }, { quoted: m });
        }

        if (command === 'untimeout' || command === 'quitarbanco') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Solo en grupos.' }, { quoted: m });
            const meta = await sock.groupMetadata(from);
            const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
            if (!admins.includes(sender) && !sender.includes('275028952228088')) return await sock.sendMessage(from, { text: '⚠️ Solo administradores.' }, { quoted: m });
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) return await sock.sendMessage(from, { text: '⚠️ Menciona al usuario. Ej: *#untimeout @usuario*.' }, { quoted: m });
            if (stickerTimeouts.has(target)) {
                stickerTimeouts.delete(target);
                await sock.sendMessage(from, { text: `✅ Se retiró el timeout de stickers a @${target.split('@')[0]}.`, mentions: [target] }, { quoted: m });
            } else { await sock.sendMessage(from, { text: 'ℹ️ El usuario no tiene timeout activo.' }, { quoted: m }); }
        }

        if (command === 's' || command === 'sticker') {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isImage = messageType === 'imageMessage' || q?.imageMessage;
            const isViewOnce = messageType === 'viewOnceMessage' || messageType === 'viewOnceMessageV2' || q?.viewOnceMessage || q?.viewOnceMessageV2;

            if (!isImage && !isViewOnce) {
                return await sock.sendMessage(from, { text: '⚠️ Envía o responde a una imagen para convertirla en sticker.' }, { quoted: m });
            }

            try {
                const targetMsg = q ? { message: q } : m;
                const buf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                const resizedImageBuffer = await sharp(buf)
                    .resize(512, 512, {
                        fit: 'contain',
                        background: { r: 0, g: 0, b: 0, alpha: 0 }
                    })
                    .png()
                    .toBuffer();

                const sticker = new Sticker(resizedImageBuffer, {
                    pack: '',
                    author: '',
                    type: StickerTypes.DEFAULT,
                    quality: 80
                });

                const stickerBuffer = await sticker.toBuffer();
                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
            } catch {
                await sock.sendMessage(from, { text: '❌ No se pudo procesar la imagen.' }, { quoted: m });
            }
        }

        if (command === 'tovideo' || command === 'vidtosgif' || command === 'gif') {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isVideo = messageType === 'videoMessage' || q?.videoMessage;
            const isDocumentVideo = messageType === 'documentMessage' || q?.documentMessage;

            if (!isVideo && !isDocumentVideo) {
                return await sock.sendMessage(from, { text: '⚠️ Adjunta un video/GIF o responde a uno.' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { text: '⏳ Procesando video a sticker...' }, { quoted: m });
                const targetMsg = q ? { message: q } : m;
                const buf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                if (buf.length > 8 * 1024 * 1024) {
                    return await sock.sendMessage(from, { text: '❌ El archivo pesa más de 8 MB.' }, { quoted: m });
                }

                const sticker = new Sticker(buf, {
                    pack: '',
                    author: '',
                    type: StickerTypes.ANIMATED,
                    quality: 50,
                    fps: 15
                });

                const stickerBuffer = await sticker.toBuffer();
                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
            } catch {
                await sock.sendMessage(from, { text: '❌ Error al procesar el video a sticker animado.' }, { quoted: m });
            }
        }

        if (command === 'toimg' || command === 'img') {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (messageType !== 'stickerMessage' && !q?.stickerMessage) return await sock.sendMessage(from, { text: '⚠️ Envía o responde a un sticker.' }, { quoted: m });
            try {
                const buf = await downloadMediaMessage(messageType === 'stickerMessage' ? m : { message: q }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const image = await sharp(buf).png().toBuffer();
                await sock.sendMessage(from, { image, caption: '✨ Convertido a imagen.' }, { quoted: m });
            } catch { await sock.sendMessage(from, { text: '❌ Error al convertir.' }, { quoted: m }); }
        }

        if (command === 'del' || command === 'delete') {
            const info = m.message.extendedTextMessage?.contextInfo;
            if (!info?.stanzaId) return await sock.sendMessage(from, { text: '⚠️ Responde al mensaje a eliminar.' }, { quoted: m });
            try { await sock.sendMessage(from, { delete: { remoteJid: from, id: info.stanzaId, participant: info.participant || sender } }); } catch { await sock.sendMessage(from, { text: '❌ Asegúrate de que el bot sea administrador.' }, { quoted: m }); }
        }

        if (command === 'anuncio') {
            if (!sender.includes('275028952228088')) return;
            const text = args.join(' ');
            if (!text) return await sock.sendMessage(from, { text: '⚠️ Escribe el texto del anuncio.' }, { quoted: m });
            try {
                let mentions = [];
                let finalTxt = `📢 *ANUNCIO OFICIAL* 📢\n\n${text}`;
                if (from.endsWith('@g.us')) {
                    const meta = await sock.groupMetadata(from);
                    mentions = meta.participants.map(p => p.id);
                }
                await sock.sendMessage(from, { text: finalTxt, mentions });
                const sticker = await obtenerGifAleatorio('attention alert news announcement', 'https://media.giphy.com/media/xT9IgzoKnwFNmISR9I/giphy.gif');
                if (sticker) await sock.sendMessage(from, { sticker });
            } catch { await sock.sendMessage(from, { text: '❌ Error al enviar anuncio.' }, { quoted: m }); }
        }

        if (command === 'bal') {
            const u = await usersCollection.findOne({ jid: sender });
            return await sock.sendMessage(from, { text: `🪙 Tienes *${u ? u.coins : 0} coins*.` }, { quoted: m });
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

        if (['hug', 'kiss', 'slap'].includes(command)) {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) return await sock.sendMessage(from, { text: '⚠️ Menciona a alguien.' }, { quoted: m });
            const backups = { hug: 'https://media.giphy.com/media/od5H3PmEG5EVq/giphy.gif', kiss: 'https://media.giphy.com/media/G3va31oEEnIkM/giphy.gif', slap: 'https://media.giphy.com/media/Gf3AUz3eBNbTW/giphy.gif' };
            const actions = { hug: 'un abrazo 🫂', kiss: 'un beso 💋', slap: 'una bofetada 👋' };
            const sticker = await obtenerGifAleatorio(command, backups[command]);
            const caption = `@${sender.split('@')[0]} le dio ${actions[command]} @${target.split('@')[0]}! ✨`;
            await sock.sendMessage(from, { text: caption, mentions: [sender, target] }, { quoted: m });
            if (sticker) await sock.sendMessage(from, { sticker });
        }
    });
}

function iniciarVerificadorRecordatorios(sock, remindersCollection) {
    setInterval(async () => {
        try {
            const ahora = new Date();
            const pendientes = await remindersCollection.find({ executeAt: { $lte: ahora } }).toArray();

            for (const rec of pendientes) {
                try {
                    if (rec.isGroup) {
                        const meta = await sock.groupMetadata(rec.targetJid);
                        const mentions = meta.participants.map(p => p.id);
                        
                        await sock.sendMessage(rec.targetJid, { 
                            text: `⏰ *¡RECORDATORIO GRUPAL!* ⏰\n\n📌 *${rec.message}*`, 
                            mentions 
                        });
                    } else {
                        await sock.sendMessage(rec.targetJid, { 
                            text: `⏰ *¡RECORDATORIO!* ⏰\n\nDijiste que te recordara esto:\n📌 *${rec.message}*` 
                        });
                    }
                    
                    await remindersCollection.deleteOne({ _id: rec._id });
                } catch (err) {
                    console.error(`Error al enviar recordatorio:`, err);
                }
            }
        } catch (e) {
            console.error('Error en el verificador de recordatorios:', e);
        }
    }, 10 * 1000); 
}

function iniciarVerificadorCumpleaños(sock, usersCollection) {
    const groupId = '120363422057355283@g.us'; 
    let ultimoControl = {}; 

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

            if (h === '00' && min === '00' && ultimoControl !== controlKey) {
                ultimoControl = controlKey;
                const cumpleañeros = await usersCollection.find({ cumple: hoy }).toArray();
                for (let user of cumpleañeros) {
                    await sock.sendMessage(groupId, { 
                        text: `🎉 ¡MUY FELIZ CUMPLEAÑOS @${user.jid.split('@')[0]}! 🎂🥳\n\nDe parte de todos en el grupo te deseamos un día genial. ¡Disfrútalo al máximo! 🎁🎈`, 
                        mentions: [user.jid] 
                    });
                }
            }
        } catch (e) { console.error('Error en verificador:', e); }
    }, 30 * 1000); 
}

connectToWhatsApp();