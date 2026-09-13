const axios = require('axios');

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, groupsCollection } = ctx;

    // Tus comandos de interacción conectados a E-Hentai
    const accionesHentai = ['anal', 'paizuri', 'milf', 'tentacles', 'blowjob'];

    if (accionesHentai.includes(command)) {
        // Candado estricto de NSFW por grupo
        if (from.endsWith('@g.us') && groupsCollection) {
            const gData = await groupsCollection.findOne({ groupId: from });
            if (!gData?.nsfw) {
                await sock.sendMessage(from, { text: '❌ Este comando requiere que el modo NSFW esté activado en el grupo (*#nsfw on*).' }, { quoted: m });
                return true;
            }
        }

        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        
        if (!target) {
            await sock.sendMessage(from, { text: `⚠️ Debes mencionar a alguien para realizar esta acción. Ej: *#${command} @usuario*` }, { quoted: m });
            return true;
        }

        // Textos de interacción personalizados
        let textoAccion = '';
        if (command === 'anal') {
            textoAccion = `🔥 @${sender.split('@')[0]} le realizó un anal a @${target.split('@')[0]} 🥵🍑`;
        } else if (command === 'paizuri') {
            textoAccion = `🍈 @${sender.split('@')[0]} recibió un paizuri de parte de @${target.split('@')[0]} 👀💦`;
        } else if (command === 'milf') {
            textoAccion = `👩‍🦰 @${sender.split('@')[0]} está disfrutando con la MILF @${target.split('@')[0]} 🍷🔥`;
        } else if (command === 'tentacles') {
            textoAccion = `🐙 ¡Los tentáculos atraparon a @${target.split('@')[0]} por sorpresa! (Iniciado por @${sender.split('@')[0]}) 🌀`;
        } else if (command === 'blowjob') {
            textoAccion = `👅 @${sender.split('@')[0]} recibió un buen servicio de parte de @${target.split('@')[0]} 🤤`;
        }

        const mentions = [sender, target];

        try {
            // Mapeo de categorías usando la sintaxis de etiquetas exactas de E-Hentai (ej: f:anal$ o m:anal$)
            // Aquí puedes tener un conjunto de galerías seguras previamente verificadas para cada tag
            const bancoGaleriaPorTag = {
                'anal': [
                    { gid: 2231376, token: "a7584a5932" },
                    { gid: 2197090, token: "2f440c5f01" }
                ],
                'paizuri': [
                    { gid: 2924387, token: "aa28f4a72a" }
                ],
                'milf': [
                    { gid: 2043548, token: "bdb0cd9ec2" }
                ],
                'tentacles': [
                    { gid: 2231376, token: "a7584a5932" }
                ],
                'blowjob': [
                    { gid: 2197090, token: "2f440c5f01" }
                ]
            };

            const opcionesTag = bancoGaleriaPorTag[command] || bancoGaleriaPorTag['anal'];
            const seleccion = opcionesTag[Math.floor(Math.random() * opcionesTag.length)];

            // Petición oficial a la API de E-Hentai con el método gdata
            const metaPayload = {
                method: "gdata",
                gidlist: [[seleccion.gid, seleccion.token]],
                namespace: 1
            };

            const response = await axios.post('https://api.e-hentai.org/api.php', metaPayload, {
                headers: { 'Content-Type': 'application/json' }
            });

            const item = response.data.gmetadata?.[0];

            // Enviamos únicamente la imagen de portada y el texto de la acción (sin fuentes ni enlaces)
            if (item && item.thumb) {
                await sock.sendMessage(from, { 
                    image: { url: item.thumb }, 
                    caption: textoAccion,
                    mentions: mentions
                }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: textoAccion, mentions }, { quoted: m });
            }

            return true;

        } catch (err) {
            console.error('Error al conectar con la API de E-Hentai:', err.message);
            await sock.sendMessage(from, { text: textoAccion, mentions }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };