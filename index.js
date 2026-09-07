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
        printQRInTerminal: false,
        auth: state
    });

    if (!sock.authState.creds.registered) {
        // Toma el número directamente de las variables de entorno de Render
        const phoneNumber = process.env.PHONE_NUMBER; 
        if (!phoneNumber) {
            console.log('¡Error! Debes configurar la variable de entorno PHONE_NUMBER en Render con tu número (ej: 51912345678).');
            return;
        }
        
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber.trim());
                console.log(`\n========================================`);
                console.log(`TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
                console.log(`========================================\n`);
            } catch (error) {
                console.error('Error al solicitar el código de emparejamiento:', error);
            }
        }, 4000);
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
        const body = m.message.conversation || m.message.extendedTextMessage?.text || '';
        
        if (body.startsWith('#ping') || body.startsWith('#p')) {
            await sock.sendMessage(m.key.remoteJid, { text: '¡Pong! 🏓 Bot activo.' }, { quoted: m });
        }
    });
}

connectToWhatsApp();