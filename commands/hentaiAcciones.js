const axios = require('axios');

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, groupsCollection } = ctx;

    const accionesRule34 = ['anal', 'paizuri', 'milf', 'tentacles', 'blowjob'];

    if (accionesRule34.includes(command)) {
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
            const randomPid = Math.floor(Math.random() * 20);

            // Leyendo las credenciales de forma segura desde las variables de entorno de Render
            const response = await axios.get('https://api.rule34.xxx/index.php', {
                params: {
                    page: 'dapi',
                    s: 'post',
                    q: 'index',
                    tags: command,
                    pid: randomPid,
                    limit: 100,
                    json: 1,
                    user_id: process.env.RULE34_USER_ID,
                    api_key: process.env.RULE34_API_KEY
                },
                timeout: 10000
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

            console.log('Rule34 autenticado no devolvió posts para la tag:', command);
            await sock.sendMessage(from, { text: '❌ No se encontró una imagen válida en este intento, prueba de nuevo.', mentions }, { quoted: m });
            return true;

        } catch (err) {
            console.error('Error detallado con API Key de Rule34:', err.message);
            await sock.sendMessage(from, { text: `❌ Error al conectar con Rule34: ${err.message}`, mentions }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };