const axios = require('axios');

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, groupsCollection } = ctx;

    // Puedes agregar más comandos aquí fácilmente en el futuro
    const accionesHentai = ['anal', 'paizuri', 'milf', 'tentacles'];

    if (accionesHentai.includes(command)) {
        // 1. Candado estricto de NSFW por grupo
        if (from.endsWith('@g.us') && groupsCollection) {
            const gData = await groupsCollection.findOne({ groupId: from });
            if (!gData?.nsfw) {
                await sock.sendMessage(from, { text: '❌ Este comando requiere que el modo NSFW esté activado en el grupo (*#nsfw on*).' }, { quoted: m });
                return true;
            }
        }

        // 2. Detección de la persona mencionada
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        
        if (!target) {
            await sock.sendMessage(from, { text: `⚠️ Debes mencionar a alguien para realizar esta acción. Ej: *#${command} @usuario*` }, { quoted: m });
            return true;
        }

        let textoAccion = '';
        if (command === 'anal') {
            textoAccion = `🔥 @${sender.split('@')[0]} le realizó un anal a @${target.split('@')[0]} 🥵🍑`;
        } else if (command === 'paizuri') {
            textoAccion = `🍈 @${sender.split('@')[0]} recibió un paizuri de parte de @${target.split('@')[0]} 👀💦`;
        } else if (command === 'milf') {
            textoAccion = `👩‍🦰 @${sender.split('@')[0]} está disfrutando con la MILF @${target.split('@')[0]} 🍷🔥`;
        } else if (command === 'tentacles') {
            textoAccion = `🐙 ¡Los tentáculos atraparon a @${target.split('@')[0]} por sorpresa! (Iniciado por @${sender.split('@')[0]}) 🌀`;
        }

        const mentions = [sender, target];

        try {
            // 3. Consultamos la API oficial de E-Hentai usando una galería de respaldo o búsqueda por tag
            // (Usamos un conjunto de IDs seguros de ejemplo por categoría para garantizar que la imagen cargue al instante)
            const galeriasEjemplo = {
                'anal': { gid: 2231376, token: "a7584a5932" },
                'paizuri': { gid: 2231376, token: "a7584a5932" },
                'milf': { gid: 2231376, token: "a7584a5932" },
                'tentacles': { gid: 2231376, token: "a7584a5932" }
            };

            const seleccion = galeriasEjemplo[command] || { gid: 2231376, token: "a7584a5932" };

            const metaPayload = {
                method: "gdata",
                gidlist: [[seleccion.gid, seleccion.token]],
                namespace: 1
            };

            const response = await axios.post('https://api.e-hentai.org/api.php', metaPayload, {
                headers: { 'Content-Type': 'application/json' }
            });

            const item = response.data.gmetadata?.[0];
            let caption = `${textoAccion}\n\n`;

            if (item && !item.error) {
                caption += `📖 *Fuente:* ${item.title}\n`;
                caption += `🔗 *Ver más:* https://e-hentai.org/g/${item.gid}/${item.token}/`;
            }

            // 4. Enviamos la imagen obtenida de la API junto con el texto y las menciones legales de WhatsApp
            if (item && item.thumb) {
                await sock.sendMessage(from, { 
                    image: { url: item.thumb }, 
                    caption: caption,
                    mentions: mentions
                }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: caption, mentions }, { quoted: m });
            }

            return true;

        } catch (err) {
            console.error('Error al obtener imagen de E-Hentai:', err.message);
            await sock.sendMessage(from, { text: textoAccion, mentions }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };