const axios = require('axios');

const VT_API_KEY = process.env.VT_API_KEY;

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command } = ctx;

    if (command === 'virustotal' || command === 'vt') {
        // Unimos todo y quitamos cualquier espacio o salto de línea que el chat agregue al pegar
        const query = args.join('').replace(/\s+/g, '');

        if (!query) {
            await sock.sendMessage(from, { text: '⚠️ Debes proporcionar un enlace o un Hash para analizar.' }, { quoted: m });
            return true;
        }

        if (!VT_API_KEY) {
            await sock.sendMessage(from, { text: '❌ La API Key de VirusTotal no está configurada en las variables de entorno de Render.' }, { quoted: m });
            return true;
        }

        await sock.sendMessage(from, { text: `🔍 Consultando en los motores de VirusTotal, espera un momento...` }, { quoted: m });

        try {
            let endpoint = '';
            let tipoAnalisis = '';

            const esHash = /^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$/.test(query);

            if (esHash) {
                tipoAnalisis = 'Hash de Archivo';
                endpoint = `https://www.virustotal.com/api/v3/files/${query}`;
            } else {
                tipoAnalisis = 'URL';
                const encodedUrl = Buffer.from(query)
                    .toString('base64')
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/, '');
                endpoint = `https://www.virustotal.com/api/v3/urls/${encodedUrl}`;
            }
            
            const response = await axios.get(endpoint, {
                headers: { 'x-apikey': VT_API_KEY }
            });

            const attributes = response.data.data.attributes;
            const stats = attributes.last_analysis_stats || attributes.total_votes;
            
            const malicious = stats.malicious || 0;
            const suspicious = stats.suspicious || 0;
            const harmless = stats.harmless || 0;
            const undetected = stats.undetected || 0;

            let resultadoTxt = `🛡️ *REPORTE DE VIRUSTOTAL* 🛡️\n\n`;
            resultadoTxt += `🔎 *Tipo:* ${tipoAnalisis}\n`;
            resultadoTxt += `📌 *Consulta:* ${query}\n`;
            if (attributes.file_name) resultadoTxt += `📂 *Archivo:* ${attributes.file_name}\n`;
            resultadoTxt += `────────────────────────\n`;
            resultadoTxt += `🔴 Maliciosos: *${malicious}*\n`;
            resultadoTxt += `🟠 Sospechosos: *${suspicious}*\n`;
            resultadoTxt += `🟢 Seguros / Inofensivos: *${harmless}*\n`;
            resultadoTxt += `⚪ No detectados: *${undetected}*\n\n`;

            if (malicious > 0 || suspicious > 0) {
                resultadoTxt += `⚠️ *¡ALERTA! Este elemento muestra indicios de amenaza o malware.*`;
            } else {
                resultadoTxt += `✅ *Limpio según los motores de análisis de seguridad.*`;
            }

            await sock.sendMessage(from, { text: resultadoTxt }, { quoted: m });
            return true;

        } catch (err) {
            console.error('Error detallado de VirusTotal:', err.response?.data || err.message);
            await sock.sendMessage(from, { text: '❌ No se encontró el registro en la base de datos de VirusTotal o el formato no es válido.' }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };