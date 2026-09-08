const { default: makeWASocket, DisconnectReason, downloadMediaMessage, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const { MongoClient } = require('mongodb');
const sharp = require('sharp');

// Servidor HTTP para Render y mecanismo anti-inactividad (Auto-ping)
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('CocoBot activo 24/7 con MongoDB, Sharp, Cooldown y Anuncios!\n');
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP corriendo en el puerto ${PORT}`);
    
    setInterval(() => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        http.get(appUrl, (res) => {
            console.log(`🔄 Auto-ping ejecutado. Código de estado: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error('⚠️ Error en el auto-ping:', err.message);
        });
    }, 10 * 60 * 1000);
});

// Memoria temporal para los Cooldowns en grupos y chats privados
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
    
    console.log('📦 Conectado exitosamente a MongoDB Atlas');

    const { state, saveCreds } = await useMongoDBAuthState(sessionCollection);

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = process.env.PHONE_NUMBER;
        if (!phoneNumber) {
            console.log('⚠️ Falta configurar la variable PHONE_NUMBER en Render.');
            return;
        }

        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber.trim());
                console.log(`\n========================================`);
                console.log(`🔗 TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log(`========================================\n`);
            } catch (error) {
                console.error('Error al generar el código:', error);
            }
        }, 5000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('¡Conectado a WhatsApp exitosamente!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const sender = m.key.participant || from;
        const messageType = Object.keys(m.message)[0];

        // Extracción robusta del cuerpo del mensaje (incluye captions en imágenes y videos)
        let body = '';
        if (messageType === 'conversation') {
            body = m.message.conversation;
        } else if (messageType === 'extendedTextMessage') {
            body = m.message.extendedTextMessage.text;
        } else if (messageType === 'imageMessage') {
            body = m.message.imageMessage.caption || '';
        } else if (messageType === 'videoMessage') {
            body = m.message.videoMessage.caption || '';
        } else {
            body = m.message.imageMessage?.caption || 
                   m.message.videoMessage?.caption || 
                   m.message.extendedTextMessage?.text || 
                   m.message.conversation || '';
        }

        const prefix = '#';
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // Control de Cooldown anti-spam para comandos de economía en grupos
        if (['work', 'w', 'daily'].includes(command)) {
            const cooldownTime = command === 'daily' ? 24 * 60 * 60 * 1000 : 30 * 1000;
            const userCooldownKey = `${sender}-${command}`;
            const lastTime = cooldowns.get(userCooldownKey) || 0;
            const now = Date.now();

            if (now - lastTime < cooldownTime) {
                const timeLeft = Math.ceil((cooldownTime - (now - lastTime)) / 1000);
                const timeMessage = command === 'daily' 
                    ? '⏳ Ya reclamaste tu recompensa diaria. Vuelve mañana.' 
                    : `⏳ Debes esperar *${timeLeft} segundos* antes de volver a usar #${command}.`;
                
                return await sock.sendMessage(from, { text: timeMessage }, { quoted: m });
            }
            cooldowns.set(userCooldownKey, now);
        }

        // 1. Comando #ping
        if (command === 'ping' || command === 'p') {
            await sock.sendMessage(from, { text: '¡Pong! 🏓 CocoBot activo y en línea.' }, { quoted: m });
        }

        // 2. Comando #menu
        if (command === 'menu' || command === 'help' || command === 'commands') {
            const menuText = 
`⚡ *PANEL PRINCIPAL - CocoBot* ⚡
────────────────────────
👤 *Creado por:* Alencito
🚀 *Estado:* Online 24/7
────────────────────────
 
📌 *COMANDOS DISPONIBLES:*

✨ *Utilidades y Stickers*
> '#s' o '#sticker' - Convierte una imagen en sticker.
> '#toimg' - Convierte un sticker en imagen (respondiendo al sticker).

📢 *Administración (Privado)*
> '#anuncio [texto]' - Envía un comunicado oficial al grupo (Alencito).

🪙 *Economía*
> '#bal' - Revisa tus coins actuales.
> '#work' - Trabaja para ganar coins (Cooldown: 30s).
> '#daily' - Reclama tu recompensa diaria.

🎉 *Interacción y Diversión*
> '#hug' [@mención] - Dale un abrazo a alguien (con imagen).
> '#kiss' [@mención] - Dale un beso a alguien (con imagen).
> '#slap' [@mención] - Dale una bofetada a alguien (con imagen).

🌐 *Sistema*
> '#ping' - Mide el estado del bot.`;

            await sock.sendMessage(from, { text: menuText }, { quoted: m });
        }

        // 3. Comando de Stickers (#s) con Sharp
        if (command === 's' || command === 'sticker') {
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isMedia = messageType === 'imageMessage' || messageType === 'videoMessage';
            const isQuotedMedia = quotedMessage && (quotedMessage.imageMessage || quotedMessage.videoMessage);

            if (!isMedia && !isQuotedMedia) {
                return await sock.sendMessage(from, { text: '⚠️ Por favor, adjunta una imagen con el texto #s o responde a una foto con #s.' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { text: '⏳ Creando sticker...' }, { quoted: m });
                const mediaMsg = isMedia ? m : { message: quotedMessage };
                const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                const stickerBuffer = await sharp(buffer)
                    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                    .webp({ quality: 80 })
                    .toBuffer();

                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });
            } catch (error) {
                console.error('Error al crear el sticker:', error);
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al procesar el sticker.' }, { quoted: m });
            }
        }

        // 4. Comando #toimg (Sticker a Imagen)
        if (command === 'toimg' || command === 'img') {
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isQuotedSticker = quotedMessage && quotedMessage.stickerMessage;

            if (!isQuotedSticker) {
                return await sock.sendMessage(from, { text: '⚠️ Por favor, responde a un sticker con el comando *#toimg* para convertirlo en imagen.' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { text: '⏳ Convirtiendo sticker a imagen...' }, { quoted: m });
                const mediaMsg = { message: quotedMessage };
                const buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });

                const imageBuffer = await sharp(buffer)
                    .png()
                    .toBuffer();

                await sock.sendMessage(from, { image: imageBuffer, caption: '✨ Aquí tienes tu imagen convertida desde el sticker.' }, { quoted: m });
            } catch (error) {
                console.error('Error al convertir sticker a imagen:', error);
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al convertir el sticker a imagen.' }, { quoted: m });
            }
        }

        // 5. Comando #anuncio (Validación optimizada para Alencito)
        if (command === 'anuncio' || command === 'broadcast') {
            const tuNumeroJid = '51924876085'; 
            const groupId = '120363422057355283@g.us'; 

            if (!sender.includes(tuNumeroJid)) {
                return await sock.sendMessage(from, { text: '⚠️ No tienes permisos para usar este comando.' }, { quoted: m });
            }

            const anuncioTexto = args.join(' ');
            if (!anuncioTexto) {
                return await sock.sendMessage(from, { text: '⚠️ Escribe el mensaje que deseas enviar al grupo (ej: #anuncio Hola a todos).' }, { quoted: m });
            }

            try {
                await sock.sendMessage(groupId, { text: `📢 *ANUNCIO OFICIAL* 📢\n\n${anuncioTexto}` });
                await sock.sendMessage(from, { text: '✅ ¡Anuncio enviado al grupo correctamente!' }, { quoted: m });
            } catch (error) {
                console.error('Error al enviar el anuncio:', error);
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al enviar el anuncio al grupo.' }, { quoted: m });
            }
        }

        // 6. Economía: #bal
        if (command === 'bal' || command === 'balance') {
            let user = await usersCollection.findOne({ jid: sender });
            const coins = user ? user.coins : 0;
            await sock.sendMessage(from, { text: `🪙 Tienes *${coins} coins* en tu cuenta.` }, { quoted: m });
        }

        // 7. Economía: #work
        if (command === 'work' || command === 'w') {
            let user = await usersCollection.findOne({ jid: sender });
            const earned = Math.floor(Math.random() * 500) + 100;

            if (!user) {
                await usersCollection.insertOne({ jid: sender, coins: earned });
            } else {
                await usersCollection.updateOne({ jid: sender }, { $inc: { coins: earned } });
            }

            await sock.sendMessage(from, { text: `💼 Trabajaste duro y ganaste *🪙 ${earned} coins*.` }, { quoted: m });
        }

        // 8. Economía: #daily
        if (command === 'daily') {
            let user = await usersCollection.findOne({ jid: sender });
            const reward = 2000;

            if (!user) {
                await usersCollection.insertOne({ jid: sender, coins: reward, lastDaily: Date.now() });
            } else {
                const now = Date.now();
                const last = user.lastDaily || 0;
                if (now - last < 24 * 60 * 60 * 1000) {
                    return await sock.sendMessage(from, { text: '⏳ Ya reclamaste tu recompensa diaria. Vuelve mañana.' }, { quoted: m });
                }
                await usersCollection.updateOne({ jid: sender }, { $inc: { coins: reward }, $set: { lastDaily: now } });
            }

            await sock.sendMessage(from, { text: `🎉 ¡Reclamaste tu recompensa diaria de *🪙 ${reward} coins*!` }, { quoted: m });
        }

        // 9. Reacciones con imágenes aleatorias (#hug, #kiss, #slap)
        if (['hug', 'kiss', 'slap'].includes(command)) {
            const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            
            if (!target) {
                return await sock.sendMessage(from, { text: `⚠️ Debes mencionar a alguien para usar este comando (ej: #${command} @usuario).` }, { quoted: m });
            }

            // Listas de imágenes aleatorias seguras (GIFs/Imágenes temáticas de anime/reacciones)
            const mediaList = {
                hug: [
                    'https://media.giphy.com/media/od5H3PmEG5EVq/giphy.gif',
                    'https://media.giphy.com/media/IRUb7GTCaPU8E/giphy.gif',
                    'https://media.giphy.com/media/wnsgren9NtITS/giphy.gif'
                ],
                kiss: [
                    'https://media.giphy.com/media/G3va31oEEnIkM/giphy.gif',
                    'https://media.giphy.com/media/wANk38K6Wp3wDri6rC/giphy.gif',
                    'https://media.giphy.com/media/wQmXrcw3Qxrq8/giphy.gif'
                ],
                slap: [
                    'https://media.giphy.com/media/Gf3AUz3eBNbTW/giphy.gif',
                    'https://media.giphy.com/media/3oKZISG9A6iJ8RSwAU/giphy.gif',
                    'https://media.giphy.com/media/xUPGcx4qh3aEPkMc1O/giphy.gif'
                ]
            };

            const actionsText = {
                hug: 'le dio un tierno abrazo 🫂 a',
                kiss: 'le dio un apasionado beso 💋 a',
                slap: 'le dio una fuerte bofetada 👋 a'
            };

            // Seleccionar una imagen aleatoria de la lista correspondiente
            const randomImage = mediaList[command][Math.floor(Math.random() * mediaList[command].length)];
            const textResponse = `@${sender.split('@')[0]} ${actionsText[command]} @${target.split('@')[0]}! ✨`;

            await sock.sendMessage(from, { 
                image: { url: randomImage }, 
                caption: textResponse, 
                mentions: [sender, target] 
            }, { quoted: m });
        }
    });
}

connectToWhatsApp();