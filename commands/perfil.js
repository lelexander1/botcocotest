async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, usersCollection } = ctx;

    if (command === 'perfil' || command === 'verperfil') {
        const target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || m.message.extendedTextMessage?.contextInfo?.participant || sender;
        
        // Detectar si están consultando el perfil del propio bot
        const isBotProfile = target === sock.user.id || target.includes(sock.user.id.split(':')[0]);

        if (isBotProfile) {
            const perfilDiosTxt = `👤 *PERFIL DE USUARIO* 👤\n` +
                `────────────────────────\n` +
                `📌 *Usuario:* @${target.split('@')[0]}\n` +
                `👑 *Rango:* DIOS\n` +
                `⚧️ *Género / Categoría:* Entidad de Destrucción Universal / Deidad Nihilista\n` +
                `💬 *Frase:* "Vi caer mil mundos y no moví un dedo para salvarlos; los dejé arder hasta los cimientos para demostrarles que no hay brazos divinos que los rescaten, y ahora caminan sobre mis cenizas esperando compasión de un creador que aprendió a disfrutar el silencio de sus gritos."\n` +
                `🪙 *Soles:* Infinito ∞\n` +
                `📊 *Mensajes:* 999,999,999`;

            let pfpUrl = null;
            try {
                // Intenta obtener la foto de perfil actual de WhatsApp
                pfpUrl = await sock.profilePictureUrl(target, 'image').catch(() => null);
            } catch (err) {
                pfpUrl = null;
            }

            if (pfpUrl) {
                await sock.sendMessage(from, { image: { url: pfpUrl }, caption: perfilDiosTxt, mentions: [target] }, { quoted: m });
            } else {
                await sock.sendMessage(from, { text: perfilDiosTxt, mentions: [target] }, { quoted: m });
            }
            return true;
        }

        // Lógica normal de perfil para los usuarios comunes
        if (!usersCollection) return false;
        const uData = await usersCollection.findOne({ jid: target }) || {};
        
        let usuarioTxt = `👤 *PERFIL DE USUARIO* 👤\n` +
            `────────────────────────\n` +
            `📌 *Usuario:* @${target.split('@')[0]}\n` +
            `🎂 *Edad:* ${uData.edad || 'No especificada'}\n` +
            `⚧️ *Género:* ${uData.genero || 'No especificado'}\n` +
            `💬 *Frase:* "${uData.frase || 'Sin frase'}"\n` +
            `💍 *Estado Civil:* ${uData.casadoCon ? 'Casado/a 💖' : 'Soltero/a 💔'}\n` +
            `🪙 *Soles:* ${uData.soles || 0}\n` +
            `📊 *Mensajes:* ${uData.mensajesCount || 0}`;

        let pfpUrl = null;
        try {
            // Intenta obtener la foto de perfil actual de WhatsApp del usuario
            pfpUrl = await sock.profilePictureUrl(target, 'image').catch(() => null);
        } catch (err) {
            pfpUrl = null;
        }

        if (pfpUrl) {
            await sock.sendMessage(from, { image: { url: pfpUrl }, caption: usuarioTxt, mentions: [target] }, { quoted: m });
        } else {
            await sock.sendMessage(from, { text: usuarioTxt, mentions: [target] }, { quoted: m });
        }
        return true;
    }

    return false;
}

module.exports = { handleCommand };