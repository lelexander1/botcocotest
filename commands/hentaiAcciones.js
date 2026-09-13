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
            // Mapeo con filtros de popularidad/puntuación para asegurar que la API devuelva resultados válidos
            const tagsMap = {
                'anal': 'anal score:>=5',
                'paizuri': 'paizuri score:>=5',
                'milf': 'milf score:>=5',
                'tentacles': 'tentacles score:>=5',
                'blowjob': 'blowjob score:>=5'
            };

            const queryTag = tagsMap[command] || command;

            const response = await axios.get('https://api.rule34.xxx/index.php', {
                params: {
                    page: 'dapi',
                    s: 'post',
                    q: 'index',
                    tags: queryTag,
                    limit: 100,
                    json: 1
                }
            });

            const posts = response.data;

            if (posts && Array.isArray(posts) && posts.length > 0) {
                
                const postsValidos = posts.filter(p => p.file_url && !p.file_url.endsWith('.webm') && !p.file_url.endsWith('.mp4'));
                
                if (postsValidos.length > 0) {

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

            // Si no hay posts válidos, avísanos por consola en lugar de enviar solo texto sin imagen
            console.log('Rule34 no devolvió posts válidos para la tag:', queryTag);
            await sock.sendMessage(from, { text: '❌ No se encontró una imagen válida para esta acción.', mentions }, { quoted: m });
            return true;

        } catch (err) {
            console.error('Error detallado en Rule34:', err.message);
            await sock.sendMessage(from, { text: `❌ Error al conectar con Rule34: ${err.message}`, mentions }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };