const { default: makeWASocket, DisconnectReason, downloadMediaMessage, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const { MongoClient } = require('mongodb');
const sharp = require('sharp');
const axios = require('axios'); // Asegúrate de tener axios instalado o usa fetch nativo

// Servidor HTTP para Render y mecanismo anti-inactividad (Auto-ping)
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CocoBot optimizado 24/7!\n');
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP corriendo en el puerto ${PORT}`);
    
    setInterval(() => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        http.get(appUrl, (res) => {
            // Logs limpios para no saturar Render
        }).on('error', (err) => {});
    }, 10 * 60 * 1000);
});

const cooldowns = new Map();

// Adaptador de sesión en MongoDB Atlas optimizado
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
    
    console.log('📦 Conectado a MongoDB Atlas de forma eficiente');

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
            console.log('¡CocoBot conectado exitosamente!');
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

        // Control de Cooldown
        if (['work', 'w', 'daily'].includes(command)) {
            const cooldownTime = command === 'daily' ? 24 * 60 * 60 * 1000 : 30 * 1000;
            const userCooldownKey = `${sender}-${command}`;
            const lastTime = cooldowns.get(userCooldownKey) || 0;
            const now = Date.now();

            if (now - lastTime < cooldownTime) {
                const timeLeft = Math.ceil((cooldownTime - (now - lastTime)) / 1000);
                const timeMessage = command === 'daily' 
                    ? '⏳ Ya reclamaste tu recompensa diaria. Vuelve mañana.' 
                    : `⏳ Espera *${timeLeft}s* para usar #${command}.`;
                
                return await sock.sendMessage(from, { text: timeMessage }, { quoted: m });
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
✨ '#s' - Crear sticker
> '#toimg' - Sticker a imagen
📢 '#anuncio' - Enviar comunicado
🪙 '#bal' / '#work' / '#daily' - Economía
🎉 '#hug' / '#kiss' / '#slap' - Interacción`;

            await sock.sendMessage(from, { text: menuText }, { quoted: m });
        }

        // Stickers
        if (command === 's' || command === 'sticker') {
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isMedia = messageType === 'imageMessage' || messageType === 'videoMessage';
            const isQuotedMedia = quotedMessage && (quotedMessage.imageMessage || quotedMessage.videoMessage);

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

        // Interacciones con Giphy API (o respaldos directos seguros)
        if (['hug', 'kiss', 'slap'].includes(command)) {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) return await sock.sendMessage(from, { text: '⚠️ Menciona a alguien.' }, { quoted: m });

            let mediaUrl = '';
            try {
                // Si tienes configurada tu API Key de Giphy gratuita en Render:
                const apiKey = process.env.GIPHY_API_KEY;
                if (apiKey) {
                    const res = await axios.get(`https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${command}&limit=10&rating=g`);
                    const gifs = res.data.data;
                    if (gifs.length > 0) {
                        const randomGif = gifs[Math.floor(Math.random() * gifs.length)];
                        mediaUrl = randomGif.images.original.url;
                    }
                }
            } catch (e) {}

            // Lista de respaldo fija por si no usas API Key de Giphy
            const backups = {
                hug: 'https://media.giphy.com/media/od5H3PmEG5EVq/giphy.gif',
                kiss: 'https://media.giphy.com/media/G3va31oEEnIkM/giphy.gif',
                slap: 'https://media.giphy.com/media/Gf3AUz3eBNbTW/giphy.gif'
            };

            const finalMedia = mediaUrl || backups[command];
            const actionsText = { hug: 'un abrazo 🫂', kiss: 'un beso 💋', slap: 'una bofetada 👋' };

            await sock.sendMessage(from, { 
                image: { url: finalMedia }, 
                caption: `@${sender.split('@')[0]} le dio ${actionsText[command]} a @${target.split('@')[0]}! ✨`, 
                mentions: [sender, target] 
            }, { quoted: m });
        }
    });
}

connectToWhatsApp();