const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const readline = require('readline');

// Servidor HTTP para Render y UptimeRobot
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot activo 24/7!\n');
}).listen(PORT);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // Desactivamos el QR visual
        auth: state
    });

    // Si no está registrado, pedirá el número para darte un código de vinculación por texto
    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('Escribe tu número de WhatsApp con código de país (ej: 51912345678): ');
        setTimeout(async () => {
            let code = await sock.requestPairingCode(phoneNumber.trim());
            console.log(`Tu código de vinculación es: ${code}`);
        }, 3000);
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