const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');

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
        printQRInTerminal: true, // Activamos para que dibuje el QR en los logs
        auth: state
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Si Baileys genera un código QR, se mostrará en texto ASCII en los registros de Render
        if (qr) {
            console.log('--- ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP ---');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('¡Conectado a WhatsApp exitosamente mediante QR!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        const body = m.message.conversation || m.message.extendedTextMessage?.text || '';
        
        if (body.startsWith('#ping') || body.startsWith('#p')) {
            await sock.sendMessage(m.key.remoteJid, { text: '¡Pong! 🏓 Bot activo.' }, { quoted: m });
        }
    });
}

connectToWhatsApp();