const axios = require('axios');

const VT_API_KEY = process.env.VT_API_KEY;

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command } = ctx;

    if (command === 'virustotal' || command === 'vt') {
        const queryUrl = args[0];

        if (!queryUrl) {
            await sock.sendMessage(from, { text: '⚠️ Debes proporcionar un enlace para analizar.\nEjemplo: *#vt https://ejemplo.com*' }, { quoted: m });
            return true;
        }

        await sock.sendMessage(from, { text: `🔍 Analizando URL en VirusTotal, por favor espera un momento...` }, { quoted: m });

        try {
            // Codificación Base64 URL-safe obligatoria para la API v3 de VirusTotal
            const encodedUrl = Buffer.from(queryUrl)
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');
            
            const response = await axios.get(`https://www.virustotal.com/api/v3/urls/${encodedUrl}`, {
                headers: { 'x-apikey': VT_API_KEY }
            });

            const stats = response.data.data.attributes.last_analysis_stats;
            const malicious = stats.malicious || 0;
            const suspicious = stats.suspicious || 0;
            const harmless = stats.harmless || 0;
            const undetected = stats.undetected || 0;

            let resultadoTxt = `🛡️ *REPORTE DE VIRUSTOTAL* 🛡️\n\n`;
            resultadoTxt += `🔗 *URL:* ${queryUrl}\n`;
            resultadoTxt += `────────────────────────\n`;
            resultadoTxt += `🔴 Maliciosos: *${malicious}*\n`;
            resultadoTxt += `🟠 Sospechosos: *${suspicious}*\n`;
            resultadoTxt += `🟢 Seguros / Inofensivos: *${harmless}*\n`;
            resultadoTxt += `⚪ No detectados: *${undetected}*\n\n`;

            if (malicious > 0 || suspicious > 0) {
                resultadoTxt += `⚠️ *¡ALERTA! Este enlace muestra indicios de peligro o malware.*`;
            } else {
                resultadoTxt += `✅ *El enlace parece seguro según los motores de análisis.*`;
            }

            await sock.sendMessage(from, { text: resultadoTxt }, { quoted: m });
            return true;

        } catch (err) {
            console.error('Error detallado de VirusTotal:', err.response?.data || err.message);
            await sock.sendMessage(from, { text: '❌ Ocurrió un error al consultar la API de VirusTotal o la URL no está registrada en su base de datos.' }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };