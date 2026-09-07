const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

// Servidor HTTP para Render y UptimeRobot
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot activo 24/7!\n');
}).listen(PORT);

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

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

    // Procesamiento de mensajes y comandos
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        const messageType = Object.keys(m.message)[0];

        // Obtener el texto del mensaje (puede venir en texto plano o dentro de un archivo multimedia como leyenda)
        let body = '';
        if (messageType === 'conversation') {
            body = m.message.conversation;
        } else if (messageType === 'extendedTextMessage') {
            body = m.message.extendedTextMessage.text;
        } else if (messageType === 'imageMessage') {
            body = m.message.imageMessage.caption || '';
        } else if (messageType === 'videoMessage') {
            body = m.message.videoMessage.caption || '';
        }

        const prefix = '#';
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // Comando #ping
        if (command === 'ping' || command === 'p') {
            await sock.sendMessage(from, { text: '¡Pong! 🏓 Bot activo.' }, { quoted: m });
        }

        // Comando de Stickers (#s o #sticker)
        if (command === 's' || command === 'sticker') {
            // Verificar si el mensaje actual contiene una imagen/video o si está citando un mensaje con multimedia
            const quotedMessage = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            const isMedia = messageType === 'imageMessage' || messageType === 'videoMessage';
            const isQuotedMedia = quotedMessage && (quotedMessage.imageMessage || quotedMessage.videoMessage);

            if (!isMedia && !isQuotedMedia) {
                return await sock.sendMessage(from, { text: '⚠️ Envía una imagen o video con el comando #s, o responde a una imagen con #s.' }, { quoted: m });
            }

            try {
                await sock.sendMessage(from, { text: '⏳ Creando sticker...' }, { quoted: m });

                // Descargar el archivo multimedia del mensaje
                const mediaMsg = isMedia ? m : { message: quotedMessage };
                const buffer = await downloadMediaMessage(
                    mediaMsg,
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }) }
                );

                // Crear el sticker con la librería
                const sticker = new Sticker(buffer, {
                    pack: 'Cocobot (Prem-Bot)', // Nombre del pack
                    author: 'LightningNeko',      // Autor por defecto
                    type: StickerTypes.FULL,
                    categories: ['🤩', '🎉'],
                    id: '12345',
                    quality: 50,
                });

                const stickerBuffer = await sticker.toBuffer();

                // Enviar el sticker resultante al chat
                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: m });

            } catch (error) {
                console.error('Error al crear el sticker:', error);
                await sock.sendMessage(from, { text: '❌ Ocurrió un error al procesar el sticker.' }, { quoted: m });
            }
        }
    });
}

connectToWhatsApp();