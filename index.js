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

// Servidor HTTP optimizado con auto-ping interno para evitar suspensiones en Render
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CocoBot 24/7 activo y blindado contra caídas!\n');
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP corriendo en el puerto ${PORT}`);
    setInterval(() => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        http.get(appUrl, () => {}).on('error', () => {});
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

        // --- CONTADOR AUTOMÁTICO DE MENSAJES PARA #TOPMSG Y #LOWMSG ---
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

        // --- COMANDOS BÁSICOS & MENÚ ---
        if (command === 'ping' || command === 'p') {
            return await sock.sendMessage(from, { text: '¡Pong! 🏓 CocoBot activo y en línea.' }, { quoted: m });
        }

        if (command === 'menu' || command === 'help') {
            const menu = `⚡ *PANEL PRINCIPAL - CocoBot* ⚡\n────────────────────────\n👤 *Creado por:* Alencito\n🚀 *Estado:* Online 24/7 (Anti-caídas)\n────────────────────────\n\n📌 *COMANDOS:* \n> '#ia [texto]' \n> '#recordatorio [tiempo] [mensaje]' \n> '#misrecordatorios', '#borrarrec [id]' \n> '#s', '#gif', '#toimg', '#kill [@usuario]' \n> '#consumo' o '#stats' (Admin) \n> '#topmsg', '#lowmsg' \n> '#genero', '#casarse', '#aceptar', '#perfil' \n> '#cumple DD/MM', '#cumples' \n> '#setwelcome', '#setgoodbye', '#untimeout' \n> '#flip', '#del', '#anuncio', '#bal', '#work', '#daily'`;
            return await sock.sendMessage(from, { text: menu }, { quoted: m });
        }

        // --- COMANDO #KILL (EXPULSAR USUARIO CON GIF) ---
        if (command === 'kill' || command === 'ban') {
            if (!from.endsWith('@g.us')) return await sock.sendMessage(from, { text: '⚠️ Este comando solo se puede usar en grupos.' }, { quoted: m });
            const meta = await sock.groupMetadata(from);
            const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
            const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const isBotAdmin = admins.includes(botNumber);

            if (!admins.includes(sender) && !sender.includes('275028952228088')) {
                return await sock.sendMessage(from, { text: '⚠️ Solo los administradores pueden usar este comando.' }, { quoted: m });
            }
            if (!isBotAdmin) {
                return await sock.sendMessage(from, { text: '❌ Necesito ser administrador del grupo para poder expulsar usuarios.' }, { quoted: m });
            }

            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant;
            if (!target) {
                return await sock.sendMessage(from, { text: '⚠️ Menciona o responde al usuario que deseas eliminar. Ej: *#kill @usuario*' }, { quoted: m });
            }

            try {
                const stickerKill = await obtenerGifAleatorio('anime punch fight kick kickout', 'https://media.giphy.com/media/l1J9EdzfOSgfyfeLm/giphy.gif');
                await sock.sendMessage(from, { text: `💥 ¡Hasta la vista, @${target.split('@')[0]}! Has sido eliminado del grupo. 🚀`, mentions: [target] }, { quoted: m });
                if (stickerKill) await sock.sendMessage(from, { sticker: stickerKill });
                await sock.groupParticipantsUpdate(from, [target], 'remove');
            } catch (e) {
                await sock.sendMessage(from, { text: '❌ No se pudo expulsar al usuario.' }, { quoted: m });
            }
        }

        // --- COMANDO DE CONSUMO Y ESTADÍSTICAS DEL SERVIDOR (SOLO ADMINS) ---
        if (command === 'consumo' || command === 'stats' || command === 'recursos') {
            if (!sender.includes('275028952228088')) {
                // Verificar si es admin en caso de grupo, o restringir al creador
                if (from.endsWith('@g.us')) {
                    const meta = await sock.groupMetadata(from);
                    const admins = meta.participants.filter(p => p.admin !== null).map(p => p.id);
                    if (!admins.includes(sender)) {
                        return await sock.sendMessage(from, { text: '⚠️ Este comando de consumo de recursos y API es exclusivo para administradores.' }, { quoted: m });
                    }
                } else {
                    return await sock.sendMessage(from, { text: '⚠️ Este comando solo puede ser ejecutado por administradores.' }, { quoted: m });
                }
            }

            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            const formatoMB = (bytes) => (bytes / (1024 * 1024)).toFixed(2) + ' MB';

            // Estadísticas de disco de la instancia
            let diskInfo = 'No disponible';
            try {
                const statsFs = fs.statSync(process.cwd());
                diskInfo = 'Activo en sistema de archivos temporal/persistente';
            } catch {}

            // Probar latencia de MongoDB
            let mongoStatus = '🟢 Conectado (Óptimo)';
            let mongoLatencyMs = 0;
            const tStart = Date.now();
            try {
                await db.command({ ping: 1 });
                mongoLatencyMs = Date.now() - tStart;
            } catch {
                mongoStatus = '🔴 Desconectado o con fallas';
            }

            const statsText = `📊 *MONITOREO DE RECURSOS - COCOBOT* 📊\n` +
                `────────────────────────\n` +
                `🖥️ *Servidor / Hosting:* Render (Instancia Cloud)\n` +
                `🧠 *Memoria RAM Usada:* ${formatoMB(usedMem)} / ${formatoMB(totalMem)}\n` +
                `💾 *Espacio de Disco:* ${diskInfo}\n` +
                `⚡ *CPU Cores:* ${os.cpus().length} Núcleos (${os.cpus()[0].model.trim()})\n` +
                `🗄️ *Base de Datos (MongoDB Atlas):*\n` +
                `   • Estado: ${mongoStatus}\n` +
                `   • Latencia API: ${mongoLatencyMs} ms\n` +
                `📈 *Límites del Plan:* \n` +
                `   • Límite RAM Render (Free): 512 MB\n` +
                `   • Límite DB MongoDB (M0 Free): 512 MB de almacenamiento\n` +
                `   • Límite Ancho de Banda: Ilimitado (Uso razonable)\n` +
                `⏱️ *Tiempo en línea (Uptime):* ${(process.uptime() / 60).toFixed(1)} minutos\n`;

            return await sock.sendMessage(from, { text: statsText }, { quoted: m });
        }

        // --- COMANDOS DE MENSAJES (#TOPMSG Y #LOWMSG) ---
        if (command === 'topmsg' || command === 'masactivos') {
            const topUsers = await usersCollection.find({ messageCount: { $exists: true } }).sort({ messageCount: -1 }).limit(5).toArray();
            if (topUsers.length === 0) return await sock.sendMessage(from, { text: '📊 Aún no hay registros de mensajes.' }, { quoted: m });

            let txt = '🏆 *TOP 5 - USUARIOS QUE MÁS ESCRIBEN* 🏆\n\n';
            topUsers.forEach((u, i) => {
                txt += `${i + 1}. @${u.jid.split('@')[0]} ➡️ *${u.messageCount || 0} mensajes*\n`;
            });
            return await sock.sendMessage(from, { text: txt, mentions: topUsers.map(u => u.jid) }, { quoted: m });
        }

        if (command === 'lowmsg' || command === 'menosactivos' || command === 'inactivos') {
            const lowUsers = await usersCollection.find({ messageCount: { $exists: true } }).sort({ messageCount: 1 }).limit(5).toArray();
            if (lowUsers.length === 0) return await sock.sendMessage(from, { text: '📊 Aún no hay registros de mensajes.' }, { quoted: m });

            let txt = '💤 *TOP 5 - USUARIOS QUE MENOS ESCRIBEN* 💤\n\n';
            lowUsers.forEach((u, i) => {
                txt += `${i + 1}. @${u.jid.split('@')[0]} ➡️ *${u.messageCount || 0} mensajes*\n`;
            });
            return await sock.sendMessage(from, { text: txt, mentions: lowUsers.map(u => u.jid) }, { quoted: m });
        }

        // --- SISTEMA DE RECORDATORIOS PRIVADOS ---
        if (command === 'recordatorio' || command === 'rec') {
            const tiempoStr = args[0];
            const mensajeRec = args.slice(1).join(' ');

            if (!tiempoStr || !mensajeRec) {
                return await sock.sendMessage(from, { text: '⚠️ Formato incorrecto.\nUsa: *#recordatorio [tiempo] [mensaje]*\nEjemplo: *#recordatorio 10m Reunión con el equipo*' }, { quoted: m });
            }

            const match = tiempoStr.match(/^(\d+)([smh])$/);
            if (!match) {
                return await sock.sendMessage(from, { text: '⚠️ Unidad de tiempo inválida. Usa *s* (segundos), *m* (minutos) u *h* (horas).' }, { quoted: m });
            }

            const cantidad = parseInt(match[1]);
            const unidad = match[2];
            let multiplicador = 1000;
            if (unidad === 'm') multiplicador = 60 * 1000;
            if (unidad === 'h') multiplicador = 60 * 60 * 1000;

            const fechaEjecucion = new Date(Date.now() + cantidad * multiplicador);
            const resultado = await remindersCollection.insertOne({ userJid: sender, message: mensajeRec, executeAt: fechaEjecucion, createdAt: new Date() });
            return await sock.sendMessage(from, { text: `✅ ¡Recordatorio programado con éxito!\nTe enviaré un mensaje privado en *${tiempoStr}* (ID: \`${resultado.insertedId}\`).` }, { quoted: m });
        }

        if (command === 'misrecordatorios') {
            const misRecs = await remindersCollection.find({ userJid: sender }).toArray();
            if (misRecs.length === 0) return await sock.sendMessage(from, { text: '📭 No tienes ningún recordatorio pendiente.' }, { quoted: m });

            let txt = '⏰ *TUS RECORDATORIOS PENDIENTES* ⏰\n\n';
            misRecs.forEach((r, idx) => {
                const tiempoFaltante = Math.max(0, Math.ceil((new Date(r.executeAt) - Date.now()) / 1000 / 60));
                txt += `${idx + 1}. *ID:* \`${r._id}\`\n   📌 "${r.message}"\n   ⏳ En aprox. ${tiempoFaltante} minuto(s)\n\n`;
            });
            txt += `💡 Usa *#borrarrec [ID]* para eliminar uno.`;
            return await sock.sendMessage(from, { text: txt }, { quoted: m });
        }

        if (command === 'borrarrec') {
            const { ObjectId } = require('mongodb');
            const idInput = args[0];
            if (!idInput) return await sock.sendMessage(from, { text: '⚠️ Especifica el ID del recordatorio. Usa *#misrecordatorios* para verlos.' }, { quoted: m });

            try {
                const eliminado = await remindersCollection.deleteOne({ _id: new ObjectId(idInput), userJid: sender });
                if (eliminado.deletedCount > 0) return await sock.sendMessage(from, { text: '✅ Recordatorio eliminado correctamente.' }, { quoted: m });
                else return await sock.sendMessage(from, { text: '❌ No se encontró ningún recordatorio con ese ID asociado a tu cuenta.' }, { quoted: m });
            } catch {
                return await sock.sendMessage(from, { text: '⚠️ El ID proporcionado no es válido.' }, { quoted: m });
            }
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

        // --- MODERACIÓN DE GRUPO ---
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

        // --- MULTIMEDIA & STICKERS (SOPORTE PARA IMÁGENES NORMALES Y VIEW ONCE) ---
        if (command === 's' || command === 'sticker') {
            const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            
            // Detección mejorada de imágenes normales y mensajes citados
            const isImage = messageType === 'imageMessage' || q?.imageMessage;
            const isViewOnce = messageType === 'viewOnceMessage' || messageType === 'viewOnceMessageV2' || q?.viewOnceMessage || q?.viewOnceMessageV2;

            if (!isImage && !isViewOnce) {
                return await sock.sendMessage(from, { text: '⚠️ Envía o responde a una imagen (o foto de una sola vez) para convertirla en sticker.' }, { quoted: m });
            }

            try {
                let targetMsg = m;
                if (q) {
                    targetMsg = { message: q };
                }

                const buf = await downloadMediaMessage(targetMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const sticker = await sharp(buf).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toBuffer();
                await sock.sendMessage(from, { sticker }, { quoted: m });
            } catch (err) {
                console.error('Error procesando sticker:', err);
                await sock.sendMessage(from, { text: '❌ No se pudo procesar la imagen (Nota: WhatsApp restringe descargas directas de algunas fotos cifradas de "Ver una vez" por seguridad).' }, { quoted: m });
            }
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

function iniciarVerificadorRecordatorios(sock, remindersCollection) {
    setInterval(async () => {
        try {
            const ahora = new Date();
            const pendientes = await remindersCollection.find({ executeAt: { $lte: ahora } }).toArray();

            for (const rec of pendientes) {
                try {
                    await sock.sendMessage(rec.userJid, { text: `⏰ *¡RECORDATORIO!* ⏰\n\nDijiste que te recordara esto:\n📌 *${rec.message}*` });
                    await remindersCollection.deleteOne({ _id: rec._id });
                } catch (err) {
                    console.error(`Error al enviar recordatorio a ${rec.userJid}:`, err);
                }
            }
        } catch (e) {
            console.error('Error en el verificador de recordatorios:', e);
        }
    }, 10 * 1000); 
}

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