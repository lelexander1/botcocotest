async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, usersCollection } = ctx;

    if (command === 'perfil' || command === 'verperfil') {
        const mentionedJid = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
        const target = mentionedJid || sender;
        
        // Limpiamos los IDs para comparar solo los números (ej: 51999999999@s.whatsapp.net -> 51999999999)
        const targetClean = target.split('@')[0];
        const botClean = sock.user.id.split(':')[0].split('@')[0];

        // Detectar si están consultando al propio bot (por mención o por ID directo)
        const isBotProfile = targetClean === botClean;

        if (isBotProfile) {
            const perfilDiosTxt = `👤 *PERFIL DE USUARIO* 👤\n` +
                `────────────────────────\n` +
                `📌 *Usuario:* @${targetClean}\n` +
                `👑 *Rango:* DIOS\n` +
                `⚧️ *Género / Categoría:* Entidad de Destrucción Universal / Deidad Nihilista\n` +
                `💬 *Frase:* "Vi caer mil mundos y no moví un dedo para salvarlos; los dejé arder hasta los cimientos para demostrarles que no hay brazos divinos que los rescaten, y ahora caminan sobre mis cenizas esperando compasión de un creador que aprendió a disfrutar el silencio de sus gritos."\n` +
                `🪙 *Soles:* Infinito ∞\n` +
                `📊 *Mensajes:* 999,999,999`;

            let pfpUrl = null;
            try {
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

        // Lógica normal de perfil para los demás usuarios
        if (!usersCollection) return false;
        const uData = await usersCollection.findOne({ jid: target }) || {};
        
        let usuarioTxt = `👤 *PERFIL DE USUARIO* 👤\n` +
            `────────────────────────\n` +
            `📌 *Usuario:* @${targetClean}\n` +
            `🎂 *Edad:* ${uData.edad || 'No especificada'}\n` +
            `⚧️ *Género:* ${uData.genero || 'No especificado'}\n` +
            `💬 *Frase:* "${uData.frase || 'Sin frase'}"\n` +
            `💍 *Estado Civil:* ${uData.casadoCon ? 'Casado/a 💖' : 'Soltero/a 💔'}\n` +
            `🪙 *Soles:* ${uData.soles || 0}\n` +
            `📊 *Mensajes:* ${uData.mensajesCount || 0}`;

        let pfpUrl = null;
        try {
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