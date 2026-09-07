const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');

// 1. Servidor HTTP básico para que UptimeRobot mantenga la app despierta en Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot de WhatsApp activo y funcionando 24/7!\n');
}).listen(PORT, () => {
    console.log(`Servidor HTTP escuchando en el puerto ${PORT}`);
});

// 2. Lógica de conexión a WhatsApp
async function connectToWhatsApp() {
    // La sesión se guardará en la carpeta 'auth_info_baileys'
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Intentando reconectar...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('¡Bot conectado exitosamente a WhatsApp!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Escucha de mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const messageType = Object.keys(m.message)[0];
        let body = '';

        if (messageType === 'conversation') {
            body = m.message.conversation;
        } else if (messageType === 'extendedTextMessage') {
            body = m.message.extendedTextMessage.text;
        }

        const prefix = '#';
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const from = m.key.remoteJid;

        console.log(`Comando recibido: ${command}`);

        // Comandos de prueba básicos
        if (command === 'ping' || command === 'p') {
            await sock.sendMessage(from, { text: '¡Pong! 🏓 El bot está en línea y funcionando.' }, { quoted: m });
        } else if (command === 'balance' || command === 'bal') {
            await sock.sendMessage(from, { text: '🪙 Tienes 1,500 coins en tu cuenta.' }, { quoted: m });
        }
    });
}

connectToWhatsApp();