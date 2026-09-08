const { default: makeWASocket, DisconnectReason, downloadMediaMessage, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const { MongoClient } = require('mongodb');
const sharp = require('sharp');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegInstaller);
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const PORT = process.env.PORT || 3000;

// Servidor HTTP optimizado con mecanismo anti-inactividad (Auto-ping cada 5 min)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CocoBot optimizado 24/7 activo!\n');
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP corriendo en el puerto ${PORT}`);
    setInterval(() => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        http.get(appUrl, () => {}).on('error', () => {});
    }, 5 * 60 * 1000);
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

// Conversión robusta de video a sticker animado
async function convertirVideoAStickerAnimado(videoBuffer) {
    const tempIn = path.join(os.tmpdir(), `in_${Date.now()}.mp4`);
    const tempOut = path.join(os.tmpdir(), `out_${Date.now()}.webp`);
    fs.writeFileSync(tempIn, videoBuffer);

    return new Promise((resolve, reject) => {
        ffmpeg(tempIn)
            .fps(15).size('512x512')
            .outputOptions(['-vcodec libwebp', '-lossless 0', '-q:v 50', '-loop 0', '-preset default', '-an', '-vsync 0', '-t 8'])
            .toFormat('webp').save(tempOut)
            .on('end', () => {
                try {
                    const buf = fs.readFileSync(tempOut);
                    fs.unlinkSync(tempIn); fs.unlinkSync(tempOut);
                    resolve(buf);
                } catch (e) { reject(e); }
            })
            .on('error', (err) => {
                try { if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn); if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch {}
                reject(err);
            });
    });
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

// Cálculo de días faltantes para cumpleaños en zona horaria de Perú
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
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db('whatsapp_bot');
    const sessionCollection = db.collection('session');
    const usersCollection = db.collection('users');
    const groupsCollection = db.collection('groups');
    
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
            if ((lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('¡CocoBot conectado y listo!');
            iniciarVerificadorCumpleaños(sock, usersCollection);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Eventos de bienvenida y despedida automatizados
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

        // --- ANTISPAM STICKERS & TIMEOUT ---
        if (from.endsWith('@g.us') && messageType === 'stickerMessage') {
            const ahora = Date.now();
            if (stickerTimeouts.has(sender) && ahora < stickerTimeouts.get(sender)) {
                try { await sock.sendMessage(from, { delete: m.key }); } catch {}
                return;
            } else if (stickerTimeouts.has(sender)) { stickerTimeouts.delete(sender); }

            let tracker = stickerSpamTracker.get(sender) || { count: 0, firstTime: ahora };
            if (ahora - tracker.firstTime < 8000) {
                tracker.count++;
                if (tracker.count >= 5) {
                    stickerTimeouts.set(sender, ahora + 120000);
                    stickerSpamTracker.delete(sender);
                    await sock.sendMessage(from, { text: `⚠️ @${sender.split('@')[0]} recibió un *timeout de 2 minutos* sin poder enviar stickers por spam. 🛑`, mentions: [sender] });
                    try { await sock.sendMessage(from, { delete: m.key }); } catch {}
                    return;
                }
            } else { tracker = { count: 1, firstTime: ahora }; }
            stickerSpamTracker.set(sender, tracker);
        }

        let body = m.message.imageMessage?.caption || m.message.videoMessage?.caption || m.message.extendedTextMessage?.text || m.message.conversation || '';
        if (!body.startsWith('#')) return;

        const args = body.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // Control de Cooldowns de Economía
        if (['work', 'w', 'daily'].includes(command)) {
            const limit = command === 'daily' ? 86400000 : 30000;
            const key = `${sender}-${command}`;
            const last = cooldowns.get(key) || 0;
            if (Date.now() - last < limit) {
                return await sock.sendMessage(from, { text: `⏳ Espera *${Math.ceil((limit - (Date.now() - last)) / 1000)}s* para usar #${command}.` }, { quoted: m });
            }
            cooldowns.set(key, Date.now());
        }

        // --- COMANDOS BÁSICOS ---
        if (command === 'ping' || command === 'p') {
            return await sock.sendMessage(from, { text: '¡Pong! 🏓 CocoBot activo y en línea.' }, { quoted: m });
        }

        if (command === 'menu' || command === 'help') {
            const menu = `⚡ *PANEL PRINCIPAL - CocoBot* ⚡\n────────────────────────\n👤 *Creado por:* Alencito\n🚀 *Estado:* Online 24/7 (Optimizado)\n────────────────────────\n\n📌 *COMANDOS:* \n> '#ia [texto]' \n> '#s', '#gif', '#toimg' \n> '#genero', '#casarse', '#aceptar', '#perfil' \n> '#cumple DD/MM', '#cumples' \n> '#setwelcome', '#setgoodbye', '#untimeout' \n> '#flip', '#del', '#anuncio', '#bal', '#work', '#daily'`;
            return await sock.sendMessage(from, { text: menu }, { quoted: m });
        }

        // --- GÉNERO ---
        if (command === 'genero') {
            const tipo = args[0]?.toLowerCase();
            if (!['hombre', 'mujer', 'cosa'].includes(tipo)) return await sock.sendMessage(from, { text: '⚠️ Usa: *hombre*, *mujer* o *cosa [nombre]*.' }, { quoted: m });
            let val = tipo;
            if (tipo === 'cosa') {
                const nombre = args.slice(1).join(' ');
                if (!nombre) return await sock.sendMessage(from, { text: '⚠️ Ponle un nombre a la cosa. Ej: *#genero cosa tostadora*.' }, { quoted: m });
                val = `cosa: ${nombre}`;
            }
            await usersCollection.updateOne({ jid: sender }, { $set: { genero: val } }, { upsert: true });
            return await sock.sendMessage(from, { text: `✅ Género actualizado a: *${val}*.` }, { quoted: m });
        }

        // --- MATRIMONIOS ---
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

        // --- PERFIL ---
        if (command === 'perfil' || command === 'verfoto') {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant || sender;
            try {
                const url = await sock.profilePictureUrl(target, 'image').catch(() => 'https://i.imgur.com/7A2b2nP.jpeg');
                await sock.sendMessage(from, { image: { url }, caption: `📸 Foto de perfil de @${target.split('@')[0]}`, mentions: [target] }, { quoted: m });
            } catch { await sock.sendMessage(from, { text: '❌ No se pudo obtener la foto.' }, { quoted: m }); }
        }

        // --- INTELIGENCIA ARTIFICIAL (GEMINI) ---
        if (command === 'ia' || command === 'gemini' || command === 'ai') {
            const query = args.join(' ');
            if (!query) return await sock.sendMessage(from, { text: '⚠️ Escribe algo para consultar a la IA.' }, { quoted: m });
            try {
                await sock.sendMessage(from, { text: '🤖 Pensando respuesta...' }, { quoted: m });
                const res = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: query });
                await sock.sendMessage(from, { text: `🤖 *Gemini IA*:\n\n${res.text || 'Sin respuesta.'}` }, { quoted: m });
            } catch { await sock.sendMessage(from, { text: '❌ Error al conectar con Gemini.' }, { quoted: m }); }
        }

        // --- CUMPLEAÑOS ---
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

        // --- FLIP / MONEDA ---
        if (command === 'flip' || command === 'coin') {
            return await sock.sendMessage(from, { text: `El resultado es: ${Math.random() < 0.5 ? '🪙 *Cara* 🎉' : '🪙 *Cruz* 🦅'}` }, { quoted: m });
        }

        // --- CONFIGURACIÓN DE GRUPO & MODERACIÓN ---
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

        // --- MULTIMEDIA & STICKERS ---
        if (command === 's' || command === 'sticker') {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (messageType !== 'imageMessage' && !q?.imageMessage) return await sock.sendMessage(from, { text: '⚠️ Envía o responde a una imagen.' }, { quoted: m });
            try {
                const buf = await downloadMediaMessage(messageType === 'imageMessage' ? m : { message: q }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const sticker = await sharp(buf).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toBuffer();
                await sock.sendMessage(from, { sticker }, { quoted: m });
            } catch { await sock.sendMessage(from, { text: '❌ Error al procesar imagen.' }, { quoted: m }); }
        }

        if (command === 'tovideo' || command === 'vidtosgif' || command === 'gif') {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (messageType !== 'videoMessage' && !q?.videoMessage) return await sock.sendMessage(from, { text: '⚠️ Adjunta un video o responde a uno.' }, { quoted: m });
            try {
                await sock.sendMessage(from, { text: '⏳ Convirtiendo video...' }, { quoted: m });
                const buf = await downloadMediaMessage(messageType === 'videoMessage' ? m : { message: q }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                if (buf.length > 6 * 1024 * 1024) return await sock.sendMessage(from, { text: '❌ El video pesa más de 6 MB.' }, { quoted: m });
                const sticker = await convertirVideoAStickerAnimado(buf);
                await sock.sendMessage(from, { sticker }, { quoted: m });
            } catch { await sock.sendMessage(from, { text: '❌ Error al procesar el video.' }, { quoted: m }); }
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

        // --- ANUNCIOS ---
        if (command === 'anuncio') {
            if (!sender.includes('275028952228088')) return;
            const text = args.join(' ');
            if (!text) return await sock.sendMessage(from, { text: '⚠️ Escribe el texto del anuncio.' }, { quoted: m });
            try {
                let mentions = [];
                let finalTxt = `📢 *ANUNCIO OFICIAL* 📢\n\n${text}\n\n`;
                if (from.endsWith('@g.us')) {
                    const meta = await sock.groupMetadata(from);
                    mentions = meta.participants.map(p => p.id);
                    meta.participants.forEach(p => finalTxt += `@${p.id.split('@')[0]} `);
                }
                await sock.sendMessage(from, { text: finalTxt, mentions });
                const sticker = await obtenerGifAleatorio('attention alert news announcement', 'https://media.giphy.com/media/xT9IgzoKnwFNmISR9I/giphy.gif');
                if (sticker) await sock.sendMessage(from, { sticker });
            } catch { await sock.sendMessage(from, { text: '❌ Error al enviar anuncio.' }, { quoted: m }); }
        }

        // --- ECONOMÍA ---
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

        // --- INTERACCIONES (HUG, KISS, SLAP) ---
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

// Verificador automático de cumpleaños en zona horaria de Perú a las 00:00
function iniciarVerificadorCumpleaños(sock, usersCollection) {
    const groupId = '120363422057355283@g.us'; 
    let ultimoControl = ''; 

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