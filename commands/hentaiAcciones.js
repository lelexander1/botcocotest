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
            console.log(`[Rule34] Buscando videos cortos o animaciones para la acción: ${command}`);
            
            // Buscamos priorizando formato MP4/WebM o contenido animado que WhatsApp reproduce fluidamente como GIF
            const response = await axios.get('https://api.rule34.xxx/index.php', {
                params: {
                    page: 'dapi',
                    s: 'post',
                    q: 'index',
                    tags: `${command} animated`,
                    limit: 100,
                    json: 1,
                    user_id: process.env.RULE34_USER_ID,
                    api_key: process.env.RULE34_API_KEY
                },
                timeout: 10000
            });

            const posts = response.data;

            if (posts && Array.isArray(posts) && posts.length > 0) {
                // Filtramos preferentemente videos cortos (.mp4 o .webm) ya que WhatsApp los reproduce perfectamente en bucle con gifPlayback
                const postsVideos = posts.filter(p => p.file_url && (p.file_url.toLowerCase().endsWith('.mp4') || p.file_url.toLowerCase().endsWith('.webm')));
                
                if (postsVideos.length > 0) {
                    const randomPost = postsVideos[Math.floor(Math.random() * postsVideos.length)];
                    const videoUrl = randomPost.file_url;
                    console.log(`[Rule34] Enviando video en bucle: ${videoUrl}`);

                    await sock.sendMessage(from, { 
                        video: { url: videoUrl }, 
                        gifPlayback: true,
                        caption: textoAccion,
                        mentions: mentions
                    }, { quoted: m });
                    
                    return true;
                }

                // Respaldo secundario si no hay mp4, buscando .gif tradicional
                const postsGifs = posts.filter(p => p.file_url && p.file_url.toLowerCase().endsWith('.gif'));
                if (postsGifs.length > 0) {
                    const randomGif = postsGifs[Math.floor(Math.random() * postsGifs.length)];
                    const gifUrl = randomGif.file_url;
                    console.log(`[Rule34] Enviando GIF: ${gifUrl}`);

                    await sock.sendMessage(from, { 
                        video: { url: gifUrl }, 
                        gifPlayback: true,
                        caption: textoAccion,
                        mentions: mentions
                    }, { quoted: m });
                    
                    return true;
                }
            }

            // Último respaldo general si la etiqueta animated no arrojó clips
            const responseFallback = await axios.get('https://api.rule34.xxx/index.php', {
                params: {
                    page: 'dapi',
                    s: 'post',
                    q: 'index',
                    tags: command,
                    limit: 50,
                    json: 1,
                    user_id: process.env.RULE34_USER_ID,
                    api_key: process.env.RULE34_API_KEY
                }
            });

            const postsFallback = responseFallback.data;
            if (postsFallback && Array.isArray(postsFallback) && postsFallback.length > 0) {
                const validosFb = postsFallback.filter(p => p.file_url && (p.file_url.endsWith('.mp4') || p.file_url.endsWith('.gif')));
                if (validosFb.length > 0) {
                    const randomFb = validosFb[Math.floor(Math.random() * validosFb.length)];
                    await sock.sendMessage(from, { 
                        video: { url: randomFb.file_url }, 
                        gifPlayback: true,
                        caption: textoAccion, 
                        mentions 
                    }, { quoted: m });
                    return true;
                }
            }

            await sock.sendMessage(from, { text: '❌ No se encontró contenido animado disponible para esta acción.', mentions }, { quoted: m });
            return true;

        } catch (err) {
            console.error('[Rule34 Error]:', err.message);
            await sock.sendMessage(from, { text: `❌ Error al conectar con Rule34: ${err.message}`, mentions }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };