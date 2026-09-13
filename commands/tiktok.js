const axios = require('axios');

async function handleCommand(ctx) {
    const { sock, m, from, args, command } = ctx;

    if (command === 'tiktok' || command === 'tt') {
        const urlVideo = args[0];

        if (!urlVideo) {
            await sock.sendMessage(from, { text: '⚠️ Debes proporcionar el enlace de un video de TikTok. Ej: *#tiktok https://www.tiktok.com/...*' }, { quoted: m });
            return true;
        }

        try {
            await sock.sendMessage(from, { text: '⏳ Procesando descarga de TikTok...' }, { quoted: m });

            const options = {
                method: 'GET',
                url: 'https://tiktok-api23.p.rapidapi.com/api/download/video',
                params: { url: urlVideo },
                headers: {
                    'x-rapidapi-host': 'tiktok-api23.p.rapidapi.com',
                    'x-rapidapi-key': '00e6b0a68dmshf78f953ff7c353dp1e9265jsna7bdd998cfea'
                }
            };

            const response = await axios.request(options);
            const data = response.data;

            // Extrae la URL directa del video (ajustable según la respuesta exacta de la API)
            const downloadUrl = data?.data?.play || data?.play || data?.videoUrl || data?.data?.hdplay; 

            if (downloadUrl) {
                await sock.sendMessage(from, { 
                    video: { url: downloadUrl }, 
                    caption: '🎬 Aquí tienes tu video de TikTok descargado vía RapidAPI.' 
                }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: '❌ No se pudo extraer el enlace de descarga del video.' }, { quoted: m });
            }

            return true;

        } catch (error) {
            console.error('Error con la API de TikTok:', error.message);
            await sock.sendMessage(from, { text: '❌ Ocurrió un error al intentar conectar con la API de TikTok.' }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };