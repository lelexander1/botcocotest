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
            // Generamos un número de página (pid) aleatorio entre 0 y 50 para traer variedad de imágenes distintas
            const randomPid = Math.floor(Math.random() * 50);

            const response = await axios.get('https://api.rule34.xxx/index.php', {
                params: {
                    page: 'dapi',
                    s: 'post',
                    q: 'index',
                    tags: command,
                    pid: randomPid,
                    limit: 100,
                    json: 1
                },
                timeout: 10000 // Timeout de seguridad de 10 segundos
            });

            const posts = response.data;

            if (posts && Array.isArray(posts) && posts.length > 0) {
                // Filtramos imágenes válidas (excluyendo videos pesados webm/mp4)
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

            console.log('Rule34 no devolvió posts válidos para la página aleatoria del tag:', command);
            await sock.sendMessage(from, { text: '❌ No se encontró una imagen válida en este intento, prueba de nuevo.', mentions }, { quoted: m });
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