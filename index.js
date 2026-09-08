const { default: makeWASocket, DisconnectReason, downloadMediaMessage, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const { MongoClient } = require('mongodb');
const sharp = require('sharp');
const axios = require('axios');

// Servidor HTTP para Render y mecanismo anti-inactividad (Auto-ping)
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CocoBot optimizado 24/7 con Videos, Cumpleaños y Anuncios!\n');
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP corriendo en el puerto ${PORT}`);
    
    setInterval(() => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        http.get(appUrl, (res) => {}).on('error', (err) => {});
    }, 10 * 60 * 1000);
});

const cooldowns = new Map();

// Adaptador de sesión en MongoDB Atlas
async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const json = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne({ _id: id }, { $set: { data: json } }, { upsert: true });
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

async function connectToWhatsApp() {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db('whatsapp_bot');
    const sessionCollection = db.collection('session');
    const usersCollection = db.collection('users');
    
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
            
            // Iniciar tarea automática de medianoche en hora de Perú
            iniciarVerificadorCumpleaños(sock, usersCollection);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const sender = m.key.participant || from;
        const messageType = Object.keys(m.message)[0];

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

✨ *Utilidades, Stickers y Videos*
> '#s' - Convierte imagen en sticker
> '#toimg' - Sticker a imagen
> '#gif' o '#tovideo' - Convierte video a sticker animado
> '#del' - Borra mensaje citado

🎂 *Cumpleaños*
> '#cumple DD/MM' - Guarda tu fecha de cumpleaños.
> '#cumples' - Muestra la lista de cumpleaños registrados.

📢 *Administración (Privado)*
> '#anuncio [texto]' - Envía comunicado oficial (Alencito)

🪙 *Economía & 🎉 Diversión*
> '#bal', '#work', '#daily'
> '#hug', '#kiss', '#slap' [@usuario]`;

            await sock.sendMessage(from, { text: menuText }, { quoted: m });
        }

        // --- SISTEMA DE CUMPLEAÑOS ---
        if (command === 'cumple' || command === 'cumpleaños') {
            const fecha = args[0];
            const regexFecha = /^([0-2][0-9]|3[0-1])\/(0[1-9]|1[0-2])$/;

            if (!fecha || !regexFecha.test(fecha)) {
                return await sock.sendMessage(from, { text: '⚠️ Formato incorrecto. Debes usar el formato *DD/MM* (Ejemplo: *#cumple 25/08*).' }, { quoted: m });
            }

            await usersCollection.updateOne(
                { jid: sender }, 
                { $set: { cumple: fecha } }, 
                { upsert: true }
            );

            await sock.sendMessage(from, { text: `✅ ¡Listo! Tu cumpleaños el *${fecha}* ha sido guardado correctamente.` }, { quoted: m });
        }

        if (command === 'cumples' || command === 'listarcumples') {
            const allUsers = await usersCollection.find({ cumple: { $exists: true } }).toArray();

            if (allUsers.length === 0) {
                return await sock.sendMessage(from, { text: '📅 Aún no hay cumpleaños registrados. Usa *#cumple DD/MM* para registrar el tuyo.' }, { quoted: m });
            }

            let textoLista = '🎂 *LISTA DE CUMPLEAÑOS REGISTRADOS* 🎂\n\n';
            allUsers.forEach((user, index) => {
                const tagUser = user.jid.split('@')[0];
                textoLista += `${index + 1}. @${tagUser} ➡️ *${user.cumple}*\n`;
            });

            const mentions = allUsers.map(u => u.jid);
            await sock.sendMessage(from, { text: textoLista, mentions }, { quoted: m });
        }
        // ------------------------------

        // Stickers de Imágenes
        if (command === 's' || command === 'sticker') {
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isMedia = messageType === 'imageMessage';
            const isQuotedMedia = quotedMessage && quotedMessage.imageMessage;

            if (!isMedia && !isQuotedMedia) return;

            try {
                const mediaMsg = isMedia ? m : { message: quotedMessage };
                const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const stickerBuffer = await sharp(buffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 80 })
                    .toBuffer();

                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
            } catch (error) {}
        }

        // Conversión de Video a Sticker Animado con validación de tamaño
        if (command === 'tovideo' || command === 'vidtosgif' || command === 'gif') {
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isVideo = messageType === 'videoMessage';
            const isQuotedVideo = quotedMessage && quotedMessage.videoMessage;

            if (!isVideo && !isQuotedVideo) {
                return await sock.sendMessage(from, { text: '⚠️ Por favor, adjunta un video o responde a uno con el comando *#gif*.' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { text: '⏳ Procesando video...' }, { quoted: m });
                const mediaMsg = isVideo ? m : { message: quotedMessage };
                
                const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                // Límite de seguridad: 8 MB máximo para proteger la memoria de Render
                const maxSizeInBytes = 8 * 1024 * 1024; 
                if (buffer.length > maxSizeInBytes) {
                    return await sock.sendMessage(from, { text: '❌ El video es demasiado grande. Por favor, envía un video que pese menos de 8 MB para evitar errores de memoria.' }, { quoted: m });
                }

                const stickerBuffer = await sharp(buffer, { animated: true })
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 50, effort: 2 })
                    .toBuffer();

                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
            } catch (error) {
                console.error('Error al procesar el video:', error);
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al convertir el video. Es posible que el formato no sea compatible.' }, { quoted: m });
            }
        }

        // ToImg
        if (command === 'toimg' || command === 'img') {
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quotedMessage?.stickerMessage) return;

            try {
                const buffer = await downloadMediaMessage({ message: quotedMessage }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const imageBuffer = await sharp(buffer).png().toBuffer();
                await sock.sendMessage(from, { image: imageBuffer, caption: '✨ Convertido a imagen.' }, { quoted: m });
            } catch (error) {}
        }

        // Borrar mensaje (#del)
        if (command === 'del' || command === 'delete') {
            const contextInfo = m.message.extendedTextMessage?.contextInfo;
            if (!contextInfo || !contextInfo.stanzaId) {
                return await sock.sendMessage(from, { text: '⚠️ Responde al mensaje que deseas eliminar con *#del*.' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { delete: { remoteJid: from, id: contextInfo.stanzaId, participant: contextInfo.participant || m.key.participant } });
            } catch (error) {
                await sock.sendMessage(from, { text: '❌ Asegúrate de que el bot sea *Administrador*.' }, { quoted: m });
            }
        }

        // Anuncio
        if (command === 'anuncio') {
            const tuLidOSender = '275028952228088';
            const groupId = '120363422057355283@g.us'; 

            if (!sender.includes(tuLidOSender)) return;

            const anuncioTexto = args.join(' ');
            if (!anuncioTexto) return;

            try {
                await sock.sendMessage(groupId, { text: `📢 *ANUNCIO OFICIAL* 📢\n\n${anuncioTexto}` });
                await sock.sendMessage(from, { text: '✅ ¡Enviado!' }, { quoted: m });
            } catch (error) {}
        }

        // Economía
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

        // Interacciones GIF Animado
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

// Verificador automático estrictamente en hora de Perú (America/Lima) a las 00:00
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