const http = require('http');
const axios = require('axios');
const pino = require('pino');
const { MongoClient } = require('mongodb');
const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleGenAI } = require('@google/genai');

const { useMongoDBAuthState, obtenerGifAleatorio, calcularDiasFaltantes, esOwner } = require('./commands/utilidades');
const { createState, handleMessage } = require('./handlers/messageHandler');

const PORT = process.env.PORT || 3000;
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const state = createState();

// ==========================================
// SERVIDOR HTTP Y API
// ==========================================
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204); res.end(); return;
    }

    if (req.url.startsWith('/api/perfil')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        try {
            const urlParams = new URL(req.url, `http://${req.headers.host}`);
            const queryUser = urlParams.searchParams.get('user')?.trim();

            if (!queryUser) return res.end(JSON.stringify({ error: 'Ingresa un número de usuario válido' }));

            const dbClient = new MongoClient(process.env.MONGODB_URI);
            await dbClient.connect();
            const userDoc = await dbClient.db('whatsapp_bot').collection('users').findOne({
                $or: [
                    { jid: { $regex: queryUser, $options: 'i' } },
                    { jid: { $regex: `${queryUser}@s.whatsapp.net`, $options: 'i' } }
                ]
            });
            await dbClient.close();

            if (!userDoc) return res.end(JSON.stringify({ error: 'No se encontró un perfil registrado' }));

            let parejasArray = userDoc.pareja || [];
            if (typeof parejasArray === 'string') parejasArray = [parejasArray];

            res.end(JSON.stringify({
                jid: userDoc.jid ? userDoc.jid.split('@')[0].split(':')[0] : 'Desconocido',
                soles: userDoc.soles !== undefined ? userDoc.soles : (userDoc.coins || 0),
                edad: userDoc.edad || 'No especificada',
                frase: userDoc.frase || 'Sin frase',
                genero: userDoc.genero || 'No especificado',
                cumple: userDoc.cumple || 'No registrado',
                pareja: parejasArray.length > 0 ? parejasArray.map(p => p.split('@')[0].split(':')[0]).join(', ') : 'Soltero/a 💔',
                redes: userDoc.redes || {}
            }));
        } catch (e) {
            console.error('❌ Error API:', e);
            res.end(JSON.stringify({ error: 'Error interno' }));
        }
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>🤖 CocoBot Backend Activo</h1>');
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP corriendo en el puerto ${PORT}`);
    setInterval(async () => {
        const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        try { await axios.get(appUrl); } catch {}
    }, 3 * 60 * 1000);
});

// ==========================================
// CONEXIÓN A WHATSAPP + MONGODB
// ==========================================
async function connectToWhatsApp() {
    let client;
    try {
        client = new MongoClient(process.env.MONGODB_URI);
        await client.connect();
    } catch (e) {
        console.error('Error al conectar a MongoDB, reintentando...', e);
        setTimeout(connectToWhatsApp, 5000);
        return;
    }

    const db = client.db('whatsapp_bot');
    const collections = {
        session: db.collection('session'),
        users: db.collection('users'),
        groups: db.collection('groups'),
        reminders: db.collection('reminders'),
        bank: db.collection('user_bank'),
        groupStats: db.collection('group_stats')
    };

    try { await collections.groupStats.createIndex({ jid: 1, groupId: 1 }, { unique: true }); } catch {}

    console.log('📦 Conectado a MongoDB Atlas exitosamente');

    const { state: authState, saveCreds } = await useMongoDBAuthState(collections.session);
    const sock = makeWASocket({ logger: pino({ level: 'silent' }), auth: authState });

    if (!sock.authState.creds.registered && process.env.PHONE_NUMBER) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(process.env.PHONE_NUMBER.trim());
                console.log(`🔗 CÓDIGO DE VINCULACIÓN: ${code}`);
            } catch {}
        }, 5000);
    }

    const deps = {
        axios,
        sharp: require('sharp'),
        pino,
        Sticker: require('wa-sticker-formatter').Sticker,
        StickerTypes: require('wa-sticker-formatter').StickerTypes,
        gtts: require('gtts'),
        fs: require('fs'),
        path: require('path'),
        os: require('os'),
        downloadMediaMessage: require('@whiskeysockets/baileys').downloadMediaMessage,
        ai,
        obtenerGifAleatorio,
        calcularDiasFaltantes
    };

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        } else if (connection === 'open') {
            console.log('¡CocoBot conectado y en línea!');
            iniciarVerificadorCumpleaños(sock, collections.users);
            iniciarVerificadorRecordatorios(sock, collections.reminders);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
        try {
            const mdata = await sock.groupMetadata(id);
            const groupConfig = await collections.groups.findOne({ groupId: id });
            
            for (let user of participants) {
                const tag = user.split('@')[0];
                if (action === 'add') {
                    const msg = groupConfig?.welcome || `👋 ¡Bienvenido/a @${tag} al grupo *${mdata.subject}*! 🎉`;
                    await sock.sendMessage(id, { text: msg, mentions: [user] });
                } else if (action === 'remove' || action === 'leave') {
                    const msg = groupConfig?.goodbye || `🚪 @${tag} ha dejado el grupo. 👋`;
                    await sock.sendMessage(id, { text: msg, mentions: [user] });
                    const stickerBye = await obtenerGifAleatorio('sad goodbye anime crying', 'https://media.giphy.com/media/7SF5scMBmlAFrg4uUs/giphy.gif');
                    if (stickerBye) await sock.sendMessage(id, { sticker: stickerBye });
                }
            }
        } catch {}
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const from = m.key.remoteJid;
        let sender = m.key.participant || from;
        
        if (sender.includes(':')) sender = sender.split(':')[0] + sender.substring(sender.indexOf('@'));

        await handleMessage({
            m, sock, from, sender, 
            usersCollection: collections.users,
            groupsCollection: collections.groups,
            remindersCollection: collections.reminders,
            bankCollection: collections.bank,
            groupStatsCollection: collections.groupStats,
            state, esOwner, deps
        });
    });
}

function iniciarVerificadorRecordatorios(sock, remindersCollection) {
    setInterval(async () => {
        try {
            const ahora = new Date();
            const pendientes = await remindersCollection.find({ executeAt: { $lte: ahora } }).toArray();
            for (const rec of pendientes) {
                try {
                    const txt = rec.isGroup ? `⏰ *¡RECORDATORIO GRUPAL!* ⏰\n\n📌 *${rec.message}*` : `⏰ *¡RECORDATORIO!* ⏰\n\n📌 *${rec.message}*`;
                    const options = rec.isGroup ? { mentions: (await sock.groupMetadata(rec.targetJid)).participants.map(p => p.id) } : {};
                    await sock.sendMessage(rec.targetJid, { text: txt, ...options });
                    await remindersCollection.deleteOne({ _id: rec._id });
                } catch {}
            }
        } catch {}
    }, 10 * 1000); 
}

function iniciarVerificadorCumpleaños(sock, usersCollection) {
    const groupId = '120363422057355283@g.us'; 
    let ultimoControlEnviado = null;

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

            if (h === '00' && min === '00' && ultimoControlEnviado !== controlKey) {
                ultimoControlEnviado = controlKey;
                const cumpleañeros = await usersCollection.find({ cumple: hoy }).toArray();
                for (let user of cumpleañeros) {
                    await sock.sendMessage(groupId, { 
                        text: `🎉 ¡MUY FELIZ CUMPLEAÑOS @${user.jid.split('@')[0]}! 🎂🥳\n\nDe parte de todos en el grupo te deseamos un día genial. ¡Disfrútalo al máximo! 🎁🎈`, 
                        mentions: [user.jid] 
                    });
                }
            }
        } catch {}
    }, 30 * 1000); 
}

connectToWhatsApp();