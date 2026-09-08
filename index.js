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
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CocoBot avanzado con Timeout de stickers activo 24/7!\n');
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP corriendo en el puerto ${PORT}`);
    
    setInterval(() => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        http.get(appUrl, (res) => {}).on('error', (err) => {});
    }, 5 * 60 * 1000);
});

const cooldowns = new Map();
const stickerSpamTracker = new Map(); // { senderJid: { count, firstTime } }
const stickerTimeouts = new Map();     // { senderJid: timestampFinTimeout }
const propuestasMatrimonio = new Map(); 

async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const json = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne({ _id: id }, { $set: { data: json, updatedAt: new Date() } }, { upsert: true });
    };

    const readData = async (id) => {
        try {
            const result = await collection.findOne({ _id: id });
            if (result) return JSON.parse(result.data, BufferJSON.reviver);
            return null;
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try { await collection.deleteOne({ _id: id }); } catch (error) {}
    };

    try {
        const sieteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        await collection.deleteMany({ 
            updatedAt: { $lt: sieteDiasAtras }, 
            _id: { $ne: 'creds' } 
        });
    } catch (e) {}

    const creds = (await readData('creds')) || (initAuthCreds(), await writeData(initAuthCreds(), 'creds'), initAuthCreds());

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        let value = await readData(`${type}-${id}`);
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(value, key));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function convertirVideoAStickerAnimado(videoBuffer) {
    const tempInputPath = path.join(os.tmpdir(), `input_${Date.now()}.mp4`);
    const tempOutputPath = path.join(os.tmpdir(), `output_${Date.now()}.webp`);

    fs.writeFileSync(tempInputPath, videoBuffer);

    return new Promise((resolve, reject) => {
        ffmpeg(tempInputPath)
            .fps(15)
            .size('512x512')
            .outputOptions([
                '-vcodec libwebp',
                '-lossless 0',
                '-q:v 50',
                '-loop 0',
                '-preset default',
                '-an',
                '-vsync 0',
                '-t 8'
            ])
            .toFormat('webp')
            .save(tempOutputPath)
            .on('end', () => {
                try {
                    const webpBuffer = fs.readFileSync(tempOutputPath);
                    fs.unlinkSync(tempInputPath);
                    fs.unlinkSync(tempOutputPath);
                    resolve(webpBuffer);
                } catch (e) {
                    reject(e);
                }
            })
            .on('error', (err) => {
                try {
                    if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
                    if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
                } catch (e) {}
                reject(err);
            });
    });
}

async function obtenerGifAleatorio(queryTematica, urlRespaldoFijo) {
    try {
        const apiKey = process.env.GIPHY_API_KEY;
        if (apiKey) {
            const res = await axios.get(`https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${queryTematica}&limit=15&rating=g`);
            const gifs = res.data.data;
            if (gifs.length > 0) {
                const randomGif = gifs[Math.floor(Math.random() * gifs.length)];
                const gifUrl = randomGif.images.downsized_medium.url;
                
                const response = await axios.get(gifUrl, { responseType: 'arraybuffer' });
                return await sharp(Buffer.from(response.data), { animated: true })
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 50, effort: 2 })
                    .toBuffer();
            }
        }
    } catch (e) {}

    try {
        const response = await axios.get(urlRespaldoFijo, { responseType: 'arraybuffer' });
        return await sharp(Buffer.from(response.data), { animated: true })
            .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 50, effort: 2 })
            .toBuffer();
    } catch (err) {
        return null;
    }
}

function calcularDiasFaltantes(fechaStr) {
    if (!fechaStr) return 999;
    const [dia, mes] = fechaStr.split('/').map(Number);

    const ahoraStr = new Date().toLocaleString("en-US", { timeZone: "America/Lima" });
    const hoyPeru = new Date(ahoraStr);
    
    let anioActual = hoyPeru.getFullYear();
    let proximoCumple = new Date(anioActual, mes - 1, dia);

    if (proximoCumple < hoyPeru && (proximoCumple.getMonth() !== hoyPeru.getMonth() || proximoCumple.getDate() !== hoyPeru.getDate())) {
        proximoCumple.setFullYear(anioActual + 1);
    }

    const diferenciaMs = proximoCumple - hoyPeru;
    return Math.ceil(diferenciaMs / (1000 * 60 * 60 * 24));
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

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = process.env.PHONE_NUMBER;
        if (!phoneNumber) return;

        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber.trim());
                console.log(`🔗 CÓDIGO DE VINCULACIÓN: ${code}`);
            } catch (error) {}
        }, 5000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('¡CocoBot conectado y listo!');
            iniciarVerificadorCumpleaños(sock, usersCollection);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('group-participants.update', async (anu) => {
        try {
            const mdata = await sock.groupMetadata(anu.id);
            const participants = anu.participants;
            let groupConfig = await groupsCollection.findOne({ groupId: anu.id });
            
            for (let user of participants) {
                const userTag = user.split('@')[0];
                
                if (anu.action === 'add') {
                    let welcomeMsg = groupConfig?.welcome || `👋 ¡Bienvenido/a @${userTag} al grupo *${mdata.subject}*! 🎉\nDisfruta tu estancia y revisa las reglas.`;
                    await sock.sendMessage(anu.id, { text: welcomeMsg, mentions: [user] });
                } 
                else if (anu.action === 'remove' || anu.action === 'leave') {
                    let goodbyeMsg = groupConfig?.goodbye || `🚪 @${userTag} ha dejado el grupo. ¡Hasta luego! 👋`;
                    await sock.sendMessage(anu.id, { text: goodbyeMsg, mentions: [user] });
                    
                    const stickerBye = await obtenerGifAleatorio('sad goodbye anime crying', 'https://media.giphy.com/media/7SF5scMBmlAFrg4uUs/giphy.gif');
                    if (stickerBye) {
                        await sock.sendMessage(anu.id, { sticker: stickerBye });
                    }
                }
            }
        } catch (e) {
            console.error('Error en el evento de participantes:', e);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const sender = m.key.participant || from;
        const messageType = Object.keys(m.message)[0];

        // --- SISTEMA ANTISPAM DE STICKERS CON TIMEOUT ---
        if (from.endsWith('@g.us') && messageType === 'stickerMessage') {
            const ahora = Date.now();

            // 1. Validar si el usuario ya está silenciado (en timeout) para enviar stickers
            if (stickerTimeouts.has(sender)) {
                const tiempoFin = stickerTimeouts.get(sender);
                if (ahora < tiempoFin) {
                    try {
                        await sock.sendMessage(from, { delete: m.key }); // Borra el sticker inmediatamente
                    } catch (err) {}
                    return; // Ignora por completo el mensaje
                } else {
                    stickerTimeouts.delete(sender); // Expiró el timeout
                }
            }

            // 2. Conteo de stickers enviados en ráfaga (ej: más de 5 stickers en menos de 6 segundos)
            if (!stickerSpamTracker.has(sender)) {
                stickerSpamTracker.set(sender, { count: 1, firstTime: ahora });
            } else {
                let tracker = stickerSpamTracker.get(sender);
                if (ahora - tracker.firstTime < 6000) { // Ventana de 6 segundos
                    tracker.count++;
                    if (tracker.count >= 5) { // Si pasa de 5 stickers seguidos
                        const tiempoTimeout = ahora + (2 * 60 * 1000); // 2 minutos de castigo sin stickers
                        stickerTimeouts.set(sender, tiempoTimeout);
                        stickerSpamTracker.delete(sender);

                        await sock.sendMessage(from, { 
                            text: `⚠️ @${sender.split('@')[0]} ha recibido un *timeout de 2 minutos* sin poder enviar stickers por hacer spam. 🛑\n(Un administrador puede usar *#untimeout @usuario* para quitarle el castigo).`, 
                            mentions: [sender] 
                        });

                        try { await sock.sendMessage(from, { delete: m.key }); } catch (e) {}
                        return;
                    }
                } else {
                    stickerSpamTracker.set(sender, { count: 1, firstTime: ahora });
                }
            }
        }

        let body = m.message.imageMessage?.caption || 
                   m.message.videoMessage?.caption || 
                   m.message.extendedTextMessage?.text || 
                   m.message.conversation || '';

        const prefix = '#';
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // Cooldown economía
        if (['work', 'w', 'daily'].includes(command)) {
            const cooldownTime = command === 'daily' ? 24 * 60 * 60 * 1000 : 30 * 1000;
            const userCooldownKey = `${sender}-${command}`;
            const lastTime = cooldowns.get(userCooldownKey) || 0;
            const now = Date.now();

            if (now - lastTime < cooldownTime) {
                const timeLeft = Math.ceil((cooldownTime - (now - lastTime)) / 1000);
                return await sock.sendMessage(from, { text: `⏳ Espera *${timeLeft}s* para usar #${command}.` }, { quoted: m });
            }
            cooldowns.set(userCooldownKey, now);
        }

        if (command === 'ping' || command === 'p') {
            await sock.sendMessage(from, { text: '¡Pong! 🏓 CocoBot activo y en línea.' }, { quoted: m });
        }

        if (command === 'menu' || command === 'help') {
            const menuText = 
`⚡ *PANEL PRINCIPAL - CocoBot* ⚡
────────────────────────
👤 *Creado por:* Alencito
🚀 *Estado:* Online 24/7
────────────────────────
 
📌 *COMANDOS DISPONIBLES:*

🧠 *Inteligencia Artificial*
> '#ia [pregunta]' - Consulta a Gemini AI.

👤 *Perfil y Matrimonios*
> '#genero [hombre/mujer/cosa nombre]' - Establece tu género.
> '#casarse @usuario' - Propón matrimonio.
> '#aceptar' - Acepta una propuesta pendiente.
> '#perfil [@usuario]' - Muestra la foto de perfil.

✨ *Stickers, Videos y Juegos*
> '#s' - Imagen a sticker
> '#gif' o '#tovideo' - Video a sticker animado
> '#toimg' - Sticker a imagen (Acepta citados)
> '#del' - Borra mensaje citado
> '#flip' - Lanza una moneda

🎂 *Cumpleaños (Permanentes)*
> '#cumple DD/MM' - Guarda tu fecha.
> '#cumples' - Lista y días faltantes.

⚙️ *Configuración y Moderación (Admin)*
> '#setwelcome [texto]' - Mensaje de bienvenida.
> '#setgoodbye [texto]' - Mensaje de despedida.
> '#untimeout @usuario' - Quita el baneo de stickers a alguien.

📢 *Administración*
> '#anuncio [texto]' - Envía comunicado tageando a todos.`;

            await sock.sendMessage(from, { text: menuText }, { quoted: m });
        }

        // --- COMANDO DE ADMINISTRADOR PARA QUITAR TIMEOUT ---
        if (command === 'untimeout' || command === 'quitarbanco') {
            if (!from.endsWith('@g.us')) {
                return await sock.sendMessage(from, { text: '⚠️ Este comando solo se usa en grupos.' }, { quoted: m });
            }

            const groupMetadata = await sock.groupMetadata(from);
            const admins = groupMetadata.participants.filter(p => p.admin !== null).map(p => p.id);
            const tuLidOSender = '275028952228088';

            if (!admins.includes(sender) && !sender.includes(tuLidOSender)) {
                return await sock.sendMessage(from, { text: '⚠️ Solo los administradores pueden quitar el timeout.' }, { quoted: m });
            }

            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) {
                return await sock.sendMessage(from, { text: '⚠️ Debes mencionar al usuario. Ejemplo: *#untimeout @usuario*' }, { quoted: m });
            }

            if (stickerTimeouts.has(target)) {
                stickerTimeouts.delete(target);
                const tagTarget = target.split('@')[0];
                await sock.sendMessage(from, { text: `✅ Se le ha retirado el timeout de stickers a @${tagTarget}. Ya puede volver a enviar stickers.`, mentions: [target] }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: 'ℹ️ Este usuario no tiene ningún timeout de stickers activo.' }, { quoted: m });
            }
        }

        if (command === 'genero') {
            const tipo = args[0]?.toLowerCase();
            if (!['hombre', 'mujer', 'cosa'].includes(tipo)) {
                return await sock.sendMessage(from, { text: '⚠️ Debes especificar: *hombre*, *mujer* o *cosa*.\nEjemplo: *#genero cosa tostadora*' }, { quoted: m });
            }

            let detalleGenero = tipo;
            if (tipo === 'cosa') {
                const nombreCosa = args.slice(1).join(' ');
                if (!nombreCosa) {
                    return await sock.sendMessage(from, { text: '⚠️ Debes ponerle un nombre si eres una cosa.\nEjemplo: *#genero cosa refrigeradora*' }, { quoted: m });
                }
                detalleGenero = `cosa: ${nombreCosa}`;
            }

            await usersCollection.updateOne(
                { jid: sender },
                { $set: { genero: detalleGenero } },
                { upsert: true }
            );

            await sock.sendMessage(from, { text: `✅ ¡Género actualizado a: *${detalleGenero}*!` }, { quoted: m });
        }

        if (command === 'casarse' || command === 'matrimonio') {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) {
                return await sock.sendMessage(from, { text: '⚠️ Debes mencionar a la persona: *#casarse @usuario*' }, { quoted: m });
            }
            if (target === sender) {
                return await sock.sendMessage(from, { text: '⚠️ No puedes casarte contigo mismo.' }, { quoted: m });
            }

            propuestasMatrimonio.set(target, sender);
            const tagTarget = target.split('@')[0];
            const tagSender = sender.split('@')[0];

            await sock.sendMessage(from, { 
                text: `💍 ¡@${tagSender} le ha pedido matrimonio a @${tagTarget}!\n\nEscribe *#aceptar* para aceptar la propuesta.`, 
                mentions: [sender, target] 
            }, { quoted: m });
        }

        if (command === 'aceptar') {
            const parejaProponte = propuestasMatrimonio.get(sender);
            if (!parejaProponte) {
                return await sock.sendMessage(from, { text: '⚠️ No tienes ninguna propuesta pendiente.' }, { quoted: m });
            }

            await usersCollection.updateOne({ jid: sender }, { $set: { pareja: parejaProponte } }, { upsert: true });
            await usersCollection.updateOne({ jid: parejaProponte }, { $set: { pareja: sender } }, { upsert: true });
            propuestasMatrimonio.delete(sender);

            const tagSender = sender.split('@')[0];
            const tagPareja = parejaProponte.split('@')[0];

            await sock.sendMessage(from, { 
                text: `🎉 ¡VIVA LOS NOVIOS! 🥂\n\n@${tagPareja} y @${tagSender} están casados oficialmente. 💍✨`, 
                mentions: [sender, parejaProponte] 
            }, { quoted: m });
        }

        if (command === 'perfil' || command === 'verfoto') {
            let targetUser = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                             m.message.extendedTextMessage?.contextInfo?.participant || 
                             sender;

            try {
                let ppUrl;
                try {
                    ppUrl = await sock.profilePictureUrl(targetUser, 'image');
                } catch {
                    ppUrl = 'https://i.imgur.com/7A2b2nP.jpeg';
                }

                const tagTarget = targetUser.split('@')[0];
                await sock.sendMessage(from, { 
                    image: { url: ppUrl }, 
                    caption: `📸 Foto de perfil de @${tagTarget}`, 
                    mentions: [targetUser] 
                }, { quoted: m });
            } catch (err) {
                await sock.sendMessage(from, { text: '❌ No se pudo obtener la foto de perfil.' }, { quoted: m });
            }
        }

        if (command === 'ia' || command === 'gemini' || command === 'ai') {
            const promptTexto = args.join(' ');
            if (!promptTexto) {
                return await sock.sendMessage(from, { text: '⚠️ Escribe algo para consultarle a la IA.' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { text: '🤖 Pensando respuesta...' }, { quoted: m });

                const response = await ai.models.generateContent({
                    model: 'gemini-3.6-flash',
                    contents: promptTexto,
                });

                const respuestaIA = response.text || 'Lo siento, no pude procesar una respuesta.';
                await sock.sendMessage(from, { text: `🤖 *Gemini IA*:\n\n${respuestaIA}` }, { quoted: m });
            } catch (error) {
                console.error('Error al consultar Gemini:', error);
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al conectar con la Inteligencia Artificial.' }, { quoted: m });
            }
        }

        if (command === 'cumple' || command === 'cumpleaños') {
            const fecha = args[0];
            const regexFecha = /^([0-2][0-9]|3[0-1])\/(0[1-9]|1[0-2])$/;

            if (!fecha || !regexFecha.test(fecha)) {
                return await sock.sendMessage(from, { text: '⚠️ Usa el formato *DD/MM* (Ej: *#cumple 25/08*).' }, { quoted: m });
            }

            await usersCollection.updateOne({ jid: sender }, { $set: { cumple: fecha } }, { upsert: true });
            await sock.sendMessage(from, { text: `✅ ¡Tu cumpleaños el *${fecha}* ha sido guardado!` }, { quoted: m });
        }

        if (command === 'cumples' || command === 'listarcumples') {
            const allUsers = await usersCollection.find({ cumple: { $exists: true } }).toArray();

            if (allUsers.length === 0) {
                return await sock.sendMessage(from, { text: '📅 No hay cumpleaños registrados.' }, { quoted: m });
            }

            allUsers.sort((a, b) => calcularDiasFaltantes(a.cumple) - calcularDiasFaltantes(b.cumple));

            let textoLista = '🎂 *LISTA DE CUMPLEAÑOS Y PRÓXIMOS* 🎂\n\n';
            allUsers.forEach((user, index) => {
                const tagUser = user.jid.split('@')[0];
                const dias = calcularDiasFaltantes(user.cumple);
                const textoDias = dias === 0 ? '🎉 *¡Es hoy!*' : `(Faltan ${dias} días)`;
                textoLista += `${index + 1}. @${tagUser} ➡️ *${user.cumple}* ${textoDias}\n`;
            });

            const mentions = allUsers.map(u => u.jid);
            await sock.sendMessage(from, { text: textoLista, mentions }, { quoted: m });
        }

        if (command === 'flip' || command === 'coin') {
            const resultado = Math.random() < 0.5 ? '🪙 *Cara* 🎉' : '🪙 *Cruz* 🦅';
            await sock.sendMessage(from, { text: `El resultado es: ${resultado}` }, { quoted: m });
        }

        if (command === 'setwelcome' || command === 'setgoodbye') {
            if (!from.endsWith('@g.us')) {
                return await sock.sendMessage(from, { text: '⚠️ Solo en grupos.' }, { quoted: m });
            }

            const groupMetadata = await sock.groupMetadata(from);
            const admins = groupMetadata.participants.filter(p => p.admin !== null).map(p => p.id);
            const tuLidOSender = '275028952228088';

            if (!admins.includes(sender) && !sender.includes(tuLidOSender)) {
                return await sock.sendMessage(from, { text: '⚠️ Solo administradores.' }, { quoted: m });
            }

            const nuevoTexto = args.join(' ');
            if (!nuevoTexto) {
                return await sock.sendMessage(from, { text: '⚠️ Escribe el mensaje.' }, { quoted: m });
            }

            const campoAActualizar = command === 'setwelcome' ? 'welcome' : 'goodbye';
            await groupsCollection.updateOne(
                { groupId: from },
                { $set: { [campoAActualizar]: nuevoTexto } },
                { upsert: true }
            );

            await sock.sendMessage(from, { text: `✅ ¡Actualizado con éxito!` }, { quoted: m });
        }

        if (command === 's' || command === 'sticker') {
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isMedia = messageType === 'imageMessage';
            const isQuotedMedia = quotedMessage && quotedMessage.imageMessage;

            if (!isMedia && !isQuotedMedia) {
                return await sock.sendMessage(from, { text: '⚠️ Envía una imagen o responde a una.' }, { quoted: m });
            }

            try {
                const mediaMsg = isMedia ? m : { message: quotedMessage };
                const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const stickerBuffer = await sharp(buffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 80 })
                    .toBuffer();

                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ Error al procesar.' }, { quoted: m });
            }
        }

        if (command === 'tovideo' || command === 'vidtosgif' || command === 'gif') {
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isVideo = messageType === 'videoMessage';
            const isQuotedVideo = quotedMessage && quotedMessage.videoMessage;

            if (!isVideo && !isQuotedVideo) {
                return await sock.sendMessage(from, { text: '⚠️ Adjunta un video o responde a uno.' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { text: '⏳ Convirtiendo video...' }, { quoted: m });
                const mediaMsg = isVideo ? m : { message: quotedMessage };
                
                const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                if (buffer.length > 6 * 1024 * 1024) {
                    return await sock.sendMessage(from, { text: '❌ El video pesa más de 6 MB.' }, { quoted: m });
                }

                const stickerBuffer = await convertirVideoAStickerAnimado(buffer);
                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ Error al procesar el video.' }, { quoted: m });
            }
        }

        if (command === 'toimg' || command === 'img') {
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isSticker = messageType === 'stickerMessage';
            const isQuotedSticker = quotedMessage && quotedMessage.stickerMessage;

            if (!isSticker && !isQuotedSticker) {
                return await sock.sendMessage(from, { text: '⚠️ Envía un sticker o responde a uno.' }, { quoted: m });
            }

            try {
                const mediaMsg = isSticker ? m : { message: quotedMessage };
                const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const imageBuffer = await sharp(buffer).png().toBuffer();
                await sock.sendMessage(from, { image: imageBuffer, caption: '✨ Convertido a imagen.' }, { quoted: m });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ Error al convertir.' }, { quoted: m });
            }
        }

        if (command === 'del' || command === 'delete') {
            const contextInfo = m.message.extendedTextMessage?.contextInfo;
            if (!contextInfo || !contextInfo.stanzaId) {
                return await sock.sendMessage(from, { text: '⚠️ Responde al mensaje que deseas eliminar.' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { delete: { remoteJid: from, id: contextInfo.stanzaId, participant: contextInfo.participant || m.key.participant } });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ Asegúrate de que el bot sea administrador.' }, { quoted: m });
            }
        }

        if (command === 'anuncio') {
            const tuLidOSender = '275028952228088';
            if (!sender.includes(tuLidOSender)) return;

            const anuncioTexto = args.join(' ');
            if (!anuncioTexto) {
                return await sock.sendMessage(from, { text: '⚠️ Escribe el texto del anuncio.' }, { quoted: m });
            }

            try {
                let mentionsList = [];
                let textoFinal = `📢 *ANUNCIO OFICIAL* 📢\n\n${anuncioTexto}\n\n`;

                if (from.endsWith('@g.us')) {
                    const groupMeta = await sock.groupMetadata(from);
                    mentionsList = groupMeta.participants.map(p => p.id);
                    groupMeta.participants.forEach(p => {
                        textoFinal += `@${p.id.split('@')[0]} `;
                    });
                }

                await sock.sendMessage(from, { text: textoFinal, mentions: mentionsList });
                
                const stickerAnuncio = await obtenerGifAleatorio('attention alert news announcement', 'https://media.giphy.com/media/xT9IgzoKnwFNmISR9I/giphy.gif');
                if (stickerAnuncio) {
                    await sock.sendMessage(from, { sticker: stickerAnuncio });
                }

                await sock.sendMessage(from, { text: '✅ ¡Anuncio enviado!' }, { quoted: m });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ Error al enviar anuncio.' }, { quoted: m });
            }
        }

        if (command === 'bal') {
            let user = await usersCollection.findOne({ jid: sender });
            await sock.sendMessage(from, { text: `🪙 Tienes *${user ? user.coins : 0} coins*.` }, { quoted: m });
        }

        if (command === 'work' || command === 'w') {
            let user = await usersCollection.findOne({ jid: sender });
            const earned = Math.floor(Math.random() * 400) + 100;
            await usersCollection.updateOne({ jid: sender }, { $inc: { coins: earned } }, { upsert: true });
            await sock.sendMessage(from, { text: `💼 Ganaste *🪙 ${earned} coins*.` }, { quoted: m });
        }

        if (command === 'daily') {
            let user = await usersCollection.findOne({ jid: sender });
            const now = Date.now();
            if (user?.lastDaily && now - user.lastDaily < 86400000) {
                return await sock.sendMessage(from, { text: '⏳ Ya reclamaste tu diario hoy.' }, { quoted: m });
            }
            await usersCollection.updateOne({ jid: sender }, { $inc: { coins: 2000 }, $set: { lastDaily: now } }, { upsert: true });
            await sock.sendMessage(from, { text: `🎉 ¡Reclamaste *🪙 2000 coins*!` }, { quoted: m });
        }

        if (['hug', 'kiss', 'slap'].includes(command)) {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) return await sock.sendMessage(from, { text: '⚠️ Menciona a alguien.' }, { quoted: m });

            let mediaUrl = '';
            try {
                const apiKey = process.env.GIPHY_API_KEY;
                if (apiKey) {
                    const res = await axios.get(`https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${command}&limit=10&rating=g`);
                    const gifs = res.data.data;
                    if (gifs.length > 0) {
                        mediaUrl = gifs[Math.floor(Math.random() * gifs.length)].images.downsized_medium.url;
                    }
                }
            } catch (e) {}

            const backups = {
                hug: 'https://media.giphy.com/media/od5H3PmEG5EVq/giphy.gif',
                kiss: 'https://media.giphy.com/media/G3va31oEEnIkM/giphy.gif',
                slap: 'https://media.giphy.com/media/Gf3AUz3eBNbTW/giphy.gif'
            };

            const finalMedia = mediaUrl || backups[command];
            const actionsText = { hug: 'un abrazo 🫂', kiss: 'un beso 💋', slap: 'una bofetada 👋' };
            const captionText = `@${sender.split('@')[0]} le dio ${actionsText[command]} @${target.split('@')[0]}! ✨`;

            try {
                const response = await axios.get(finalMedia, { responseType: 'arraybuffer' });
                const stickerBuffer = await sharp(Buffer.from(response.data), { animated: true })
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 50, effort: 2 })
                    .toBuffer();

                await sock.sendMessage(from, { text: captionText, mentions: [sender, target] }, { quoted: m });
                await sock.sendMessage(from, { sticker: stickerBuffer });
            } catch (error) {
                await sock.sendMessage(from, { text: captionText, mentions: [sender, target] }, { quoted: m });
            }
        }
    });
}

function iniciarVerificadorCumpleaños(sock, usersCollection) {
    const groupId = '120363422057355283@g.us'; 
    let ultimoDiaFelicitado = ''; 

    setInterval(async () => {
        try {
            const ahora = new Date();
            const opcionesFecha = { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
            const formatter = new Intl.DateTimeFormat('es-PE', opcionesFecha);
            const partes = formatter.formatToParts(ahora);
            
            let dia = '', mes = '', hora = '', minuto = '';
            partes.forEach(p => {
                if (p.type === 'day') dia = p.value;
                if (p.type === 'month') mes = p.value;
                if (p.type === 'hour') hora = p.value;
                if (p.type === 'minute') minuto = p.value;
            });

            const fechaHoy = `${dia}/${mes}`;
            const claveControl = `${fechaHoy}-${hora}:${minuto}`;

            if (hora === '00' && minuto === '00' && ultimoDiaFelicitado !== claveControl) {
                ultimoDiaFelicitado = claveControl;
                const cumpleañeros = await usersCollection.find({ cumple: fechaHoy }).toArray();

                if (cumpleañeros.length > 0) {
                    for (let user of cumpleañeros) {
                        const tagUser = user.jid.split('@')[0];
                        const mensajeFelicitacion = `🎉 ¡MUY FELIZ CUMPLEAÑOS @${tagUser}! 🎂🥳\n\nDe parte de todos en el grupo te deseamos un día genial. ¡Que lo disfrutes al máximo! 🎁🎈`;
                        
                        await sock.sendMessage(groupId, { 
                            text: mensajeFelicitacion, 
                            mentions: [user.jid] 
                        });
                    }
                }
            }
        } catch (err) {
            console.error('Error en el verificador de cumpleaños:', err);
        }
    }, 30 * 1000); 
}

connectToWhatsApp();