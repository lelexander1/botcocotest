const axios = require('axios');

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, groupsCollection } = ctx;

    // Comandos habilitados para usar la API de Rule34
    const accionesRule34 = ['anal', 'paizuri', 'milf', 'tentacles', 'blowjob'];

    if (accionesRule34.includes(command)) {
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

        // Textos personalizados con la estructura que pediste
        let textoAccion = '';
        if (command === 'anal') {
            textoAccion = `🔥 @${sender.split('@')[0]} realizó un anal a @${target.split('@')[0]} 🥵🍑`;
        } else if (command === 'paizuri') {
            textoAccion = `🍈 @${sender.split('@')[0]} recibió un paizuri de parte de @${target.split('@')[0]} 👀💦`;
        } else if (command === 'milf') {
            textoAccion = `👩‍🦰 @${sender.split('@')[0]} está disfrutando con la MILF @${target.split('@')[0]} 🍷🔥`;
        } else if (command === 'tentacles') {
            textoAccion = `🐙 ¡Los tentáculos atraparon a @${target.split('@')[0]} por sorpresa! (Iniciado por @${sender.split('@')[0]}) 🌀`;
        } else if (command === 'blowjob') {
            textoAccion = `👅 @${sender.split('@')[0]} recibió un servicio de @${target.split('@')[0]} 🤤`;
        }

        const mentions = [sender, target];

        try {
            // Petición a la API de Rule34 usando el endpoint oficial de posts filtrando por tags (ej. tag anal)
            const response = await axios.get('https://api.rule34.xxx/index.php', {
                params: {
                    page: 'dapi',
                    s: 'post',
                    q: 'index',
                    tags: command, // Usa directamente el nombre del comando como etiqueta (ej. 'anal')
                    limit: 50,     // Trae un lote de hasta 50 resultados para elegir uno al azar
                    json: 1
                }
            });

            const posts = response.data;

            if (posts && Array.isArray(posts) && posts.length > 0) {
                // Filtramos solo los elementos que tengan una URL de imagen válida y descartamos videos pesados si se prefiere imagen pura
                const postsValidos = posts.filter(p => p.file_url && !p.file_url.endsWith('.webm') && !p.file_url.endsWith('.mp4'));
                
                if (postsValidos.length > 0) {
                    // Selecciona un post al azar de los resultados obtenidos
                    const randomPost = postsValidos[Math.floor(Math.random() * postsValidos.length)];
                    const imageUrl = randomPost.file_url;

                    await sock.sendMessage(from, { 
                        image: { url: imageUrl }, 
                        caption: textoAccion,
                        mentions: mentions
                    }, { quoted: m });
                    
                    return true;
                }
            }

            // Si por alguna razón no devuelve posts válidos
            await sock.sendMessage(from, { text: textoAccion, mentions }, { quoted: m });
            return true;

        } catch (err) {
            console.error('Error al conectar con la API de Rule34:', err.message);
            await sock.sendMessage(from, { text: textoAccion, mentions }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };